#!/usr/bin/env python3
"""
Scrape CAD property data from public ArcGIS Map/FeatureServer endpoints
(no browser automation).

Default profile is Bexar CAD (TrueAutomation mapSearch → PAMapSearch).
Other counties pass --map-server / layer ids (e.g. Calhoun BIS FeatureServer).

Stage-1 default is **bulk** mode: paginate the entire property layer
(``where=1=1``) into ``__ALL__.csv``, keeping each feature's neighborhood
code as a row attribute when present. Use ``--mode by-hood`` for the legacy
per-neighborhood scrape (resume/debug).

On errors: exponential backoff, then quit after consecutive failures so a
block/rate-limit does not thrash the server.
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


def _data_path(*parts: str) -> Path:
    base = Path(os.environ.get("DATA_DIR", "data"))
    return base.joinpath(*parts)

# Defaults = Bexar; overridden in main() from CLI / env
CID = 110
MAP_SEARCH_ORIGIN = "https://bexar.trueautomation.com"
MAP_SERVER = "https://maps.bcad.org/arcgis/rest/services/PAMapSearch/MapServer"
HOOD_TABLE_ID = 8  # map_neighborhood_vw (hood_cd, hood_name); -1 = derive from props
PROP_TABLE_ID = 9  # web_map_property
PROP_ID_FIELD = "pacs_prop_id"
HOOD_FILTER_FIELD = "hood_cd"
# Synthetic hood codes when the property layer has no usable neighborhood values
ALL_PARCELS_HOOD = "__ALL__"
UNASSIGNED_HOOD = "__UNASSIGNED__"
# Path separators in hood codes (e.g. Bandera "DF/WW/KER") must not create nested folders.
_HOOD_SLASH_TOKEN = "__SLASH__"


def hood_file_stem(hood_cd: str) -> str:
    """Flat filesystem stem for a hood code (no directories)."""
    return (
        str(hood_cd)
        .replace("\\", _HOOD_SLASH_TOKEN)
        .replace("/", _HOOD_SLASH_TOKEN)
    )


def hood_cd_from_stem(stem: str) -> str:
    return str(stem).replace(_HOOD_SLASH_TOKEN, "/")
SETUP_URL = f"{MAP_SEARCH_ORIGIN}/mapSearch/api/{CID}/setup.json"

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

DEFAULT_DELAY = 0.75
DEFAULT_PAGE_SIZE = 0  # 0 = use each layer's maxRecordCount (often 2000)
DEFAULT_MAX_RETRIES = 5
DEFAULT_MAX_CONSECUTIVE_FAILURES = 3
DEFAULT_MAX_DELAY = 120.0
DEFAULT_BACKOFF_MULTIPLIER = 2.0

# Map UI Export caps at 1000 — we still mark hoods above this, but export all rows.
OVER_1000_MARK = 1000

# Scrape unit: bulk = whole layer → __ALL__.csv; by-hood = one CSV per neighborhood.
MODE_BULK = "bulk"
MODE_BY_HOOD = "by-hood"

# HTTP statuses that usually mean "slow down or stop"
BLOCK_STATUSES = {403, 429, 502, 503, 504}

log = logging.getLogger("bexar-scraper")


class ScrapeAbort(Exception):
    """Raised when the scraper should stop the whole run."""


class RequestFailed(Exception):
    """A single HTTP/ArcGIS request failed after retries."""

    def __init__(self, message: str, *, blocked: bool = False, status: int | None = None):
        super().__init__(message)
        self.blocked = blocked
        self.status = status


class AdaptiveGuard:
    """Tracks failures, stretches delay, and aborts when the server looks hostile."""

    def __init__(
        self,
        *,
        base_delay: float,
        max_delay: float,
        backoff_multiplier: float,
        max_consecutive_failures: int,
        quit_on_block: bool,
    ) -> None:
        self.base_delay = base_delay
        self.current_delay = base_delay
        self.max_delay = max_delay
        self.backoff_multiplier = backoff_multiplier
        self.max_consecutive_failures = max_consecutive_failures
        self.quit_on_block = quit_on_block
        self.consecutive_failures = 0
        self.total_failures = 0
        self.total_successes = 0

    def sleep(self, extra: float = 0.0) -> None:
        wait = self.current_delay + extra + random.uniform(0, 0.35)
        time.sleep(wait)

    def record_success(self) -> None:
        self.consecutive_failures = 0
        self.total_successes += 1
        # Ease back toward the base delay after a clean request
        if self.current_delay > self.base_delay:
            recovered = max(self.base_delay, self.current_delay / self.backoff_multiplier)
            if recovered != self.current_delay:
                log.info("Recovering delay: %.2fs → %.2fs", self.current_delay, recovered)
            self.current_delay = recovered

    def record_failure(self, exc: BaseException) -> None:
        self.consecutive_failures += 1
        self.total_failures += 1
        blocked = isinstance(exc, RequestFailed) and exc.blocked

        prev = self.current_delay
        self.current_delay = min(self.max_delay, max(self.base_delay, self.current_delay) * self.backoff_multiplier)
        log.warning(
            "Failure %s/%s consecutive (total failures=%s). Delay %.2fs → %.2fs. Cause: %s",
            self.consecutive_failures,
            self.max_consecutive_failures,
            self.total_failures,
            prev,
            self.current_delay,
            exc,
        )

        if blocked and self.quit_on_block:
            raise ScrapeAbort(
                f"Likely blocked/rate-limited (status={getattr(exc, 'status', None)}): {exc}"
            )

        if self.consecutive_failures >= self.max_consecutive_failures:
            raise ScrapeAbort(
                f"Aborting after {self.consecutive_failures} consecutive failures "
                f"(last error: {exc})"
            )

        # Cool down before the next neighborhood
        cool = min(self.max_delay, self.current_delay)
        log.warning("Cooling down %.1fs before next neighborhood…", cool)
        time.sleep(cool)


def _is_blocked_http(exc: BaseException) -> tuple[bool, int | None]:
    if isinstance(exc, urllib.error.HTTPError):
        return exc.code in BLOCK_STATUSES, exc.code
    return False, None


def http_get_json(url: str, *, max_retries: int, timeout: float = 120.0) -> dict[str, Any]:
    return http_json(url, max_retries=max_retries, timeout=timeout)


def http_json(
    url: str,
    *,
    max_retries: int,
    timeout: float = 120.0,
    form: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """GET ``url``, or POST ``application/x-www-form-urlencoded`` when ``form`` is set."""
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json,text/javascript,*/*;q=0.01",
        "Referer": f"{MAP_SEARCH_ORIGIN}/",
        "Origin": MAP_SEARCH_ORIGIN,
    }
    body: bytes | None = None
    if form is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"
        body = urllib.parse.urlencode(form).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method="POST" if body else "GET")
    last_err: Exception | None = None
    last_blocked = False
    last_status: int | None = None
    log_url = url if len(url) < 180 else url[:177] + "…"

    for attempt in range(1, max_retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
            return json.loads(raw.decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_err = exc
            blocked, status = _is_blocked_http(exc)
            last_blocked = blocked or last_blocked
            last_status = status if status is not None else last_status
            # Hard block statuses: fail the request sooner so the guard can abort
            if blocked and attempt >= 2:
                break
            wait = min(60.0, (2 ** (attempt - 1)) + random.uniform(0, 0.5))
            log.warning(
                "Request failed (attempt %s/%s)%s: %s — sleeping %.1fs",
                attempt,
                max_retries,
                f" [HTTP {status}]" if status else "",
                exc,
                wait,
            )
            time.sleep(wait)
            # Rebuild Request — urllib may not allow reuse after failure
            req = urllib.request.Request(
                url, data=body, headers=headers, method="POST" if body else "GET"
            )

    raise RequestFailed(
        f"Failed after retries: {log_url} ({last_err})",
        blocked=last_blocked,
        status=last_status,
    ) from last_err


def query_layer(
    layer_id: int,
    *,
    where: str = "1=1",
    max_retries: int,
    out_fields: str = "*",
    return_geometry: bool = False,
    order_by: str | None = None,
    result_offset: int | None = None,
    result_record_count: int | None = None,
    return_count_only: bool = False,
    return_distinct: bool = False,
    return_ids_only: bool = False,
    object_ids: list[int] | None = None,
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "where": where,
        "f": "json",
    }
    if return_count_only:
        params["returnCountOnly"] = "true"
    elif return_ids_only:
        params["returnIdsOnly"] = "true"
    else:
        params["outFields"] = out_fields
        params["returnGeometry"] = "true" if return_geometry else "false"
        if return_distinct:
            params["returnDistinctValues"] = "true"
        if order_by:
            params["orderByFields"] = order_by
        if result_offset is not None:
            params["resultOffset"] = result_offset
        if result_record_count is not None:
            params["resultRecordCount"] = result_record_count
        if object_ids is not None:
            params["objectIds"] = ",".join(str(int(x)) for x in object_ids)

    endpoint = f"{MAP_SERVER}/{layer_id}/query"
    # Large objectIds lists blow past GET URL limits (proxies often answer 404).
    if object_ids is not None:
        data = http_json(endpoint, form=params, max_retries=max_retries)
    else:
        url = endpoint + "?" + urllib.parse.urlencode(params)
        data = http_json(url, max_retries=max_retries)
    if data.get("error"):
        # ArcGIS sometimes returns HTTP 200 with an error payload
        err = data["error"]
        code = err.get("code") if isinstance(err, dict) else None
        blocked = code in BLOCK_STATUSES
        raise RequestFailed(f"ArcGIS error: {err}", blocked=blocked, status=code)
    return data


# Cached per MAP_SERVER + layer id: maxRecordCount / objectIdField
_LAYER_INFO_CACHE: dict[str, dict[str, Any]] = {}

_NUMERIC_FIELD_TYPES = frozenset(
    {
        "esriFieldTypeSmallInteger",
        "esriFieldTypeInteger",
        "esriFieldTypeSingle",
        "esriFieldTypeDouble",
        "esriFieldTypeOID",
        "esriFieldTypeBigInteger",
    }
)


def resolve_field_name(requested: str, field_names: list[str]) -> str:
    """Match a configured field to the layer's actual name.

    Pandai / joined layers often expose ``CountyCADWeb.DBO.Accounts.Location_Code``
    while cad_sources stores the short suffix ``Location_Code``.
    """
    req = str(requested or "").strip()
    if not req:
        return req
    names = [str(n) for n in field_names if n]
    if req in names:
        return req
    # Exact case-insensitive
    lower = {n.lower(): n for n in names}
    if req.lower() in lower:
        return lower[req.lower()]
    # Suffix match: ".Location_Code" or endswith "Location_Code"
    suffix = req.lower()
    matches = [
        n
        for n in names
        if n.lower() == suffix or n.lower().endswith("." + suffix)
    ]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        # Prefer Accounts.* over TaxParcels.* for Account/Location_Code
        accounts = [m for m in matches if ".Accounts." in m or m.startswith("DBO.Accounts.")]
        if len(accounts) == 1:
            return accounts[0]
        log.warning(
            "Ambiguous field %r matches %s — using %s",
            req,
            matches,
            matches[0],
        )
        return matches[0]
    return req


def is_hoodless_mode() -> bool:
    """True when county has no neighborhood field — export entire layer as __ALL__."""
    return HOOD_FILTER_FIELD in ("", ALL_PARCELS_HOOD, "__NONE__", "none")


def hood_field_type() -> str | None:
    """ArcGIS field type for HOOD_FILTER_FIELD, if known from layer metadata."""
    if is_hoodless_mode():
        return None
    info = _LAYER_INFO_CACHE.get(f"{MAP_SERVER}|{PROP_TABLE_ID}") or {}
    types = info.get("fieldTypes") or {}
    return types.get(HOOD_FILTER_FIELD) or types.get(str(HOOD_FILTER_FIELD).lower())


def hood_field_is_numeric() -> bool:
    """True when neighborhood codes are stored as numbers (e.g. HCAD nh_cd Double)."""
    return hood_field_type() in _NUMERIC_FIELD_TYPES


def format_hood_cd(raw: Any) -> str:
    """Normalize a hood attribute to a stable string key for filenames / filters."""
    if raw is None:
        return ""
    if isinstance(raw, bool):
        return str(raw)
    if isinstance(raw, int):
        return str(raw)
    if isinstance(raw, float):
        if raw.is_integer():
            return str(int(raw))
        return format(raw, ".10g")
    text = str(raw).strip()
    if not text:
        return ""
    # Distinct queries sometimes stringify doubles as "7120.0"
    if hood_field_is_numeric():
        try:
            num = float(text)
            if num.is_integer():
                return str(int(num))
            return format(num, ".10g")
        except ValueError:
            pass
    return text


def hood_present_where() -> str:
    """WHERE clause selecting parcels that have a neighborhood code."""
    if hood_field_is_numeric():
        return f"{HOOD_FILTER_FIELD} IS NOT NULL"
    return f"{HOOD_FILTER_FIELD} IS NOT NULL AND {HOOD_FILTER_FIELD} <> ''"


def hood_blank_where() -> str:
    """WHERE clause selecting parcels with no neighborhood code."""
    if hood_field_is_numeric():
        return f"{HOOD_FILTER_FIELD} IS NULL"
    return f"({HOOD_FILTER_FIELD} IS NULL OR {HOOD_FILTER_FIELD} = '')"


def hood_equals_where(hood_cd: str) -> str:
    """Exact-match WHERE for one neighborhood code (numeric vs string aware)."""
    safe = hood_cd.replace("'", "''")
    if hood_field_is_numeric():
        try:
            num = float(hood_cd)
            if num.is_integer():
                return f"{HOOD_FILTER_FIELD} = {int(num)}"
            return f"{HOOD_FILTER_FIELD} = {format(num, '.10g')}"
        except ValueError:
            pass
    return f"{HOOD_FILTER_FIELD} = '{safe}'"


def resolve_runtime_fields(layer_id: int, *, max_retries: int) -> None:
    """Rewrite PROP_ID_FIELD / HOOD_FILTER_FIELD to match layer schema."""
    global PROP_ID_FIELD, HOOD_FILTER_FIELD
    info = get_layer_info(layer_id, max_retries=max_retries)
    names = list(info.get("fieldNames") or [])
    if not names:
        return
    new_prop = resolve_field_name(PROP_ID_FIELD, names)
    new_hood = (
        HOOD_FILTER_FIELD
        if is_hoodless_mode()
        else resolve_field_name(HOOD_FILTER_FIELD, names)
    )
    if new_prop != PROP_ID_FIELD or new_hood != HOOD_FILTER_FIELD:
        log.info(
            "Resolved fields: hood %r → %r ; prop_id %r → %r",
            HOOD_FILTER_FIELD,
            new_hood,
            PROP_ID_FIELD,
            new_prop,
        )
    PROP_ID_FIELD = new_prop
    HOOD_FILTER_FIELD = new_hood


def pick_object_id_field(
    *,
    declared: str | None,
    field_names: list[str],
    fields: list[dict[str, Any]],
) -> str | None:
    """Choose OBJECTID field for pagination / OID windows.

    Joined Pandai CAD layers expose both TaxParcels.OBJECTID and Accounts.OBJECTID.
    Windowing on TaxParcels often returns empty Accounts.* attributes (Clay, etc.),
    so prefer Accounts.OBJECTID whenever it exists.
    """
    accounts = [
        n for n in field_names if n.upper().endswith("ACCOUNTS.OBJECTID")
    ]
    if accounts:
        return accounts[0]

    if declared:
        return declared

    oid_typed = [
        str(f["name"])
        for f in fields
        if f.get("type") == "esriFieldTypeOID" and f.get("name")
    ]
    if oid_typed:
        return oid_typed[0]

    tax = [n for n in field_names if n.upper().endswith("TAXPARCELS.OBJECTID")]
    if tax:
        return tax[0]

    any_oid = [
        n
        for n in field_names
        if n.upper().endswith(".OBJECTID") or n.upper() == "OBJECTID"
    ]
    return any_oid[0] if any_oid else None


def bulk_layer_where() -> str:
    """WHERE for full-layer (__ALL__) scrape/count.

    When paging on Accounts.OBJECTID, restrict to rows that have an account so
    counts match exported rows and TaxParcels-only shells are skipped.
    """
    info = _LAYER_INFO_CACHE.get(f"{MAP_SERVER}|{PROP_TABLE_ID}") or {}
    oid = str(info.get("objectIdField") or "")
    if oid.upper().endswith("ACCOUNTS.OBJECTID"):
        return f"{oid} IS NOT NULL"
    return "1=1"


def get_layer_info(layer_id: int, *, max_retries: int) -> dict[str, Any]:
    """Fetch ArcGIS layer metadata (maxRecordCount, objectIdField, pagination)."""
    cache_key = f"{MAP_SERVER}|{layer_id}"
    cached = _LAYER_INFO_CACHE.get(cache_key)
    if cached is not None:
        return cached

    url = f"{MAP_SERVER}/{layer_id}?f=json"
    data = http_get_json(url, max_retries=max_retries)
    if data.get("error"):
        err = data["error"]
        code = err.get("code") if isinstance(err, dict) else None
        blocked = code in BLOCK_STATUSES
        raise RequestFailed(f"ArcGIS layer info error: {err}", blocked=blocked, status=code)

    max_records = int(data.get("maxRecordCount") or 0) or 1000
    declared_oid = str(data.get("objectIdField") or "").strip() or None
    fields = data.get("fields") or []
    field_names = [str(f.get("name") or "") for f in fields if f.get("name")]
    field_types: dict[str, str] = {}
    for f in fields:
        name = str(f.get("name") or "").strip()
        ftype = str(f.get("type") or "").strip()
        if name and ftype:
            field_types[name] = ftype
            field_types[name.lower()] = ftype

    object_id_field = pick_object_id_field(
        declared=declared_oid,
        field_names=field_names,
        fields=fields,
    )

    adv = data.get("advancedQueryCapabilities") or {}
    supports_pagination = adv.get("supportsPagination")
    if supports_pagination is None:
        supports_pagination = bool(data.get("supportsPagination", True))

    info = {
        "maxRecordCount": max_records,
        "objectIdField": object_id_field,
        "name": data.get("name"),
        "fieldNames": field_names,
        "fieldTypes": field_types,
        "supportsPagination": bool(supports_pagination),
        "supportsDistinct": bool(adv.get("supportsDistinct", True)),
        "supportsOrderBy": bool(adv.get("supportsOrderBy", True)),
    }
    _LAYER_INFO_CACHE[cache_key] = info
    log.info(
        "Layer %s maxRecordCount=%s objectIdField=%s pagination=%s",
        layer_id,
        max_records,
        object_id_field or "(none)",
        info["supportsPagination"],
    )
    return info


def _feature_oid(feat: dict[str, Any], object_id_field: str) -> int | None:
    attrs = feat.get("attributes") or {}
    raw = attrs.get(object_id_field)
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def fetch_object_ids(
    layer_id: int,
    *,
    where: str,
    max_retries: int,
) -> list[int]:
    """Return all OBJECTIDs for a where clause (Pandai-safe; no resultOffset)."""
    data = query_layer(
        layer_id,
        where=where,
        return_ids_only=True,
        max_retries=max_retries,
    )
    raw = data.get("objectIds") or []
    out: list[int] = []
    for x in raw:
        try:
            out.append(int(x))
        except (TypeError, ValueError):
            continue
    return out


def fetch_features_by_object_id_batches(
    layer_id: int,
    *,
    ids: list[int],
    out_fields: str,
    max_retries: int,
    batch_size: int = 1000,
):
    """Yield feature lists for ``ids`` via POST objectIds queries.

    Retries a batch with a smaller chunk size on failure instead of aborting.
    """
    if not ids:
        return
    chunk = max(1, min(int(batch_size or 1000), 1000))
    i = 0
    while i < len(ids):
        batch_ids = ids[i : i + chunk]
        try:
            data = query_layer(
                layer_id,
                where="1=1",
                out_fields=out_fields,
                return_geometry=False,
                object_ids=batch_ids,
                max_retries=max_retries,
            )
            batch = data.get("features") or []
            yield batch, len(ids), i + len(batch_ids)
            i += len(batch_ids)
        except RequestFailed as exc:
            if chunk <= 25:
                raise RequestFailed(
                    f"objectIds batch failed at offset {i} (chunk={chunk}): {exc}",
                    blocked=exc.blocked,
                    status=exc.status,
                ) from exc
            new_chunk = max(25, chunk // 2)
            log.warning(
                "objectIds batch of %s failed (%s) — retrying with chunk=%s",
                chunk,
                exc,
                new_chunk,
            )
            chunk = new_chunk


def fetch_features_via_object_ids(
    layer_id: int,
    *,
    where: str,
    out_fields: str,
    max_retries: int,
    batch_size: int = 1000,
    return_distinct: bool = False,
) -> list[dict[str, Any]]:
    """Fetch all features by returnIdsOnly + objectIds batches.

    Prefer this over OID ``> last`` windows on Pandai layers: those windows often
    stop early or return TaxParcels shells without Accounts.* attributes.
    """
    if return_distinct:
        # Distinct values can't be fetched via objectIds; caller should not use this.
        raise RequestFailed("objectIds fetch does not support returnDistinctValues")

    ids = fetch_object_ids(layer_id, where=where, max_retries=max_retries)
    if not ids:
        return []

    chunk = max(1, min(int(batch_size or 1000), 1000))
    log.info(
        "  objectIds fetch: %s ids in batches of %s (POST)",
        f"{len(ids):,}",
        chunk,
    )
    features: list[dict[str, Any]] = []
    for batch, total, done in fetch_features_by_object_id_batches(
        layer_id,
        ids=ids,
        out_fields=out_fields,
        max_retries=max_retries,
        batch_size=chunk,
    ):
        features.extend(batch)
        if done == total or done % (chunk * 5) < chunk:
            log.info(
                "  objectIds progress: %s / %s",
                f"{len(features):,}",
                f"{total:,}",
            )
    return features


def iter_features_via_object_ids(
    layer_id: int,
    *,
    where: str,
    out_fields: str,
    max_retries: int,
    batch_size: int = 1000,
):
    """Yield feature batches via returnIdsOnly + objectIds (memory-friendly)."""
    ids = fetch_object_ids(layer_id, where=where, max_retries=max_retries)
    chunk = max(1, min(int(batch_size or 1000), 1000))
    log.info(
        "  streaming objectIds: %s ids in batches of %s (POST)",
        f"{len(ids):,}",
        chunk,
    )
    yield from fetch_features_by_object_id_batches(
        layer_id,
        ids=ids,
        out_fields=out_fields,
        max_retries=max_retries,
        batch_size=chunk,
    )


def fetch_features_oid_window(
    layer_id: int,
    *,
    where: str,
    out_fields: str,
    object_id_field: str,
    max_retries: int,
    return_distinct: bool = False,
) -> list[dict[str, Any]]:
    """Paginate via ``objectId > last`` windows when resultOffset is unsupported.

    Used for Pritchard & Abbott pandai MapServers (supportsPagination=false).
    Prefer ``fetch_features_via_object_ids`` when possible — OID windows can stop
    early or return empty Accounts.* joins on some counties (e.g. Clay).
    """
    # Always request the OID field so windowing can advance.
    fields = [f.strip() for f in str(out_fields).split(",") if f.strip()]
    if out_fields.strip() == "*":
        page_fields = "*"
    else:
        if object_id_field not in fields:
            fields.insert(0, object_id_field)
        page_fields = ",".join(fields)

    def _page(oid_field: str, last: int | None) -> tuple[list[dict[str, Any]], bool]:
        page_where = where
        if last is not None:
            page_where = f"({where}) AND {oid_field} > {last}"
        data = query_layer(
            layer_id,
            where=page_where,
            out_fields=page_fields,
            return_geometry=False,
            order_by=None,  # pandai often rejects orderBy
            return_distinct=return_distinct,
            max_retries=max_retries,
        )
        batch = data.get("features") or []
        exceeded = data.get("exceededTransferLimit") is True
        return batch, exceeded

    def _batch_has_account_attrs(batch: list[dict[str, Any]]) -> bool:
        for feat in batch[:20]:
            attrs = feat.get("attributes") or {}
            for key, val in attrs.items():
                k = str(key)
                if not k.upper().endswith("ACCOUNTS.ACCOUNT") and k.upper() != "ACCOUNT":
                    continue
                if val is not None and str(val).strip():
                    return True
        return False

    active_oid = object_id_field
    features: list[dict[str, Any]] = []
    last_oid: int | None = None
    pages = 0
    switched_to_accounts = False

    while True:
        batch, exceeded = _page(active_oid, last_oid)
        pages += 1
        if not batch:
            break

        # First page on a joined layer: if Accounts.* are empty, switch OID field.
        if (
            pages == 1
            and not switched_to_accounts
            and not active_oid.upper().endswith("ACCOUNTS.OBJECTID")
        ):
            info = _LAYER_INFO_CACHE.get(f"{MAP_SERVER}|{layer_id}") or {}
            names = info.get("fieldNames") or []
            accounts_oids = [
                n for n in names if str(n).upper().endswith("ACCOUNTS.OBJECTID")
            ]
            schema_has_account = any(
                str(n).upper().endswith("ACCOUNTS.ACCOUNT") or str(n).upper() == "ACCOUNT"
                for n in names
            )
            if accounts_oids and schema_has_account and not _batch_has_account_attrs(batch):
                log.warning(
                    "OID-window via %s returned no Accounts.* attributes — "
                    "retrying with %s",
                    active_oid,
                    accounts_oids[0],
                )
                active_oid = accounts_oids[0]
                info["objectIdField"] = active_oid
                switched_to_accounts = True
                features = []
                last_oid = None
                pages = 0
                continue

        features.extend(batch)
        oids = [_feature_oid(f, active_oid) for f in batch]
        oids_ok = [o for o in oids if o is not None]
        if not oids_ok:
            log.warning(
                "OID-window page missing %s values — stopping after %s features",
                active_oid,
                len(features),
            )
            break
        next_oid = max(oids_ok)
        if last_oid is not None and next_oid <= last_oid:
            log.warning("OID-window did not advance (last=%s) — stopping", last_oid)
            break
        last_oid = next_oid
        if not exceeded:
            break
        if pages > 500:
            log.error(
                "OID-window safety stop after %s pages (%s features)",
                pages,
                len(features),
            )
            break
    return features


def fetch_features_no_offset(
    layer_id: int,
    *,
    where: str,
    out_fields: str,
    object_id_field: str,
    max_retries: int,
    batch_size: int = 500,
) -> list[dict[str, Any]]:
    """Fetch all features when resultOffset is unsupported.

    Prefer returnIdsOnly + objectIds batches (correct for Pandai joins like Clay).
    Fall back to OID ``> last`` windows if objectIds fetch fails.
    """
    try:
        return fetch_features_via_object_ids(
            layer_id,
            where=where,
            out_fields=out_fields,
            max_retries=max_retries,
            batch_size=batch_size,
        )
    except RequestFailed as exc:
        log.warning(
            "objectIds fetch failed (%s) — falling back to OID-window (%s)",
            exc,
            object_id_field,
        )
        return fetch_features_oid_window(
            layer_id,
            where=where,
            out_fields=out_fields,
            object_id_field=object_id_field,
            max_retries=max_retries,
            return_distinct=False,
        )


def clamp_page_size(requested: int | None, max_record_count: int) -> int:
    """
    Pick an ArcGIS resultRecordCount.

    requested <= 0 or None → use the layer's maxRecordCount (often 2000+).
    Otherwise never request more than the layer will return in one page.
    """
    cap = max(1, int(max_record_count or 1000))
    if requested is None or int(requested) <= 0:
        return cap
    return min(max(1, int(requested)), cap)


def count_blank_hood_parcels(max_retries: int) -> int:
    """Parcels whose neighborhood filter field is NULL or empty string."""
    return int(
        query_layer(
            PROP_TABLE_ID,
            where=hood_blank_where(),
            return_count_only=True,
            max_retries=max_retries,
        ).get("count")
        or 0
    )


def maybe_append_unassigned(
    hoods: list[dict[str, str]], max_retries: int
) -> list[dict[str, str]]:
    """Ensure blank-hood parcels are covered by the synthetic __UNASSIGNED__ bucket."""
    if any(h.get("hood_cd") == UNASSIGNED_HOOD for h in hoods):
        return hoods
    blank = count_blank_hood_parcels(max_retries)
    if blank <= 0:
        return hoods
    log.info(
        "Adding %s for %s parcels with blank %s",
        UNASSIGNED_HOOD,
        blank,
        HOOD_FILTER_FIELD,
    )
    hoods.append({"hood_cd": UNASSIGNED_HOOD, "hood_name": "Unassigned"})
    return hoods


def fetch_all_features(
    layer_id: int,
    *,
    where: str,
    out_fields: str,
    max_retries: int,
    order_by: str | None = None,
    return_distinct: bool = False,
    page_size: int | None = None,
) -> list[dict[str, Any]]:
    """Paginate an ArcGIS query until all features are collected.

    Honors exceededTransferLimit and clamps page size to layer maxRecordCount
    so distinct-hood discovery (and large hood layers) are not truncated.

    Falls back to objectId-window pagination when the layer rejects resultOffset
    (common on pandai MapServers with supportsPagination=false).
    """
    layer_info = get_layer_info(layer_id, max_retries=max_retries)
    effective_page = clamp_page_size(
        page_size or DEFAULT_PAGE_SIZE, layer_info["maxRecordCount"]
    )
    object_id_field = layer_info.get("objectIdField")
    use_offset = bool(layer_info.get("supportsPagination", True))

    # Stable ordering is required for offset pagination of distinct values.
    effective_order = order_by
    if use_offset and not effective_order:
        if return_distinct:
            # Distinct pages must be ordered by the distinct field itself.
            first_field = str(out_fields).split(",")[0].strip()
            effective_order = f"{first_field} ASC" if first_field and first_field != "*" else None
        elif object_id_field:
            effective_order = f"{object_id_field} ASC"

    if not use_offset:
        if not object_id_field:
            raise RequestFailed(
                "Layer does not support pagination and has no objectIdField "
                "for OID-window fallback"
            )
        # Distinct is usually unsupported on these layers — collect unique values
        # by scanning all rows instead.
        if return_distinct:
            log.info(
                "Layer pagination disabled — scanning all rows for distinct %s via OID windows",
                out_fields,
            )
            scanned = fetch_features_no_offset(
                layer_id,
                where=where,
                out_fields=out_fields if out_fields != "*" else object_id_field,
                object_id_field=object_id_field,
                max_retries=max_retries,
            )
            # Dedupe by out field value(s)
            field = str(out_fields).split(",")[0].strip()
            seen: set[str] = set()
            unique: list[dict[str, Any]] = []
            for feat in scanned:
                attrs = feat.get("attributes") or {}
                key = str(attrs.get(field) or "").strip()
                if not key or key in seen:
                    continue
                seen.add(key)
                unique.append({"attributes": {field: key}})
            return unique
        return fetch_features_no_offset(
            layer_id,
            where=where,
            out_fields=out_fields,
            object_id_field=object_id_field,
            max_retries=max_retries,
        )

    features: list[dict[str, Any]] = []
    offset = 0
    pages = 0
    while True:
        try:
            data = query_layer(
                layer_id,
                where=where,
                out_fields=out_fields,
                return_geometry=False,
                order_by=effective_order,
                result_offset=offset,
                result_record_count=effective_page,
                return_distinct=return_distinct,
                max_retries=max_retries,
            )
        except RequestFailed as exc:
            msg = str(exc).lower()
            if object_id_field and (
                "pagination is not supported" in msg or "invalid or missing input" in msg
            ):
                log.warning(
                    "Offset pagination failed (%s) — falling back to OID windows",
                    exc,
                )
                # Remember for later calls on this layer
                layer_info["supportsPagination"] = False
                return fetch_all_features(
                    layer_id,
                    where=where,
                    out_fields=out_fields,
                    max_retries=max_retries,
                    order_by=None,
                    return_distinct=return_distinct,
                    page_size=page_size,
                )
            raise
        batch = data.get("features") or []
        exceeded = data.get("exceededTransferLimit") is True
        pages += 1
        if not batch:
            break
        features.extend(batch)
        got = len(batch)
        if not exceeded and got < effective_page:
            break
        offset += got
        if pages > 500:
            log.error(
                "Feature pagination safety stop after %s pages (%s features)",
                pages,
                len(features),
            )
            break
    return features


def fetch_neighborhoods(max_retries: int) -> list[dict[str, str]]:
    """Load neighborhood codes/names from hood layer, or distinct hood_cd on props."""
    if is_hoodless_mode():
        total = int(
            query_layer(
                PROP_TABLE_ID,
                where="1=1",
                return_count_only=True,
                max_retries=max_retries,
            ).get("count")
            or 0
        )
        if total <= 0:
            return []
        log.info(
            "Hoodless mode (%s) — exporting entire layer (%s parcels) as %s",
            HOOD_FILTER_FIELD or "(empty)",
            total,
            ALL_PARCELS_HOOD,
        )
        return [{"hood_cd": ALL_PARCELS_HOOD, "hood_name": "All parcels"}]

    if HOOD_TABLE_ID is not None and HOOD_TABLE_ID >= 0:
        feats = fetch_all_features(
            HOOD_TABLE_ID,
            where="1=1",
            out_fields="hood_cd,hood_name",
            order_by="hood_cd ASC",
            max_retries=max_retries,
        )
        hoods: list[dict[str, str]] = []
        seen: set[str] = set()
        for feat in feats:
            attrs = feat.get("attributes") or {}
            hood_cd = str(attrs.get("hood_cd") or "").strip()
            hood_name = str(attrs.get("hood_name") or "").strip()
            if not hood_cd or hood_cd in seen:
                continue
            seen.add(hood_cd)
            hoods.append({"hood_cd": hood_cd, "hood_name": hood_name or hood_cd})
        hoods.sort(key=lambda h: h["hood_cd"])
        # Hood layers omit blank codes — still export parcels with no neighborhood.
        return maybe_append_unassigned(hoods, max_retries)

    # No dedicated hood layer — paginate distinct codes from the property layer.
    # A single distinct query is capped at maxRecordCount (e.g. El Paso 2000),
    # which previously truncated neighborhoods.json to ~2001 including __UNASSIGNED__.
    # Numeric hood fields (e.g. Harris HCAD nh_cd Double) reject `<> ''` comparisons.
    feats = fetch_all_features(
        PROP_TABLE_ID,
        where=hood_present_where(),
        out_fields=HOOD_FILTER_FIELD,
        order_by=f"{HOOD_FILTER_FIELD} ASC",
        return_distinct=True,
        max_retries=max_retries,
    )
    hoods = []
    seen: set[str] = set()
    for feat in feats:
        attrs = feat.get("attributes") or {}
        hood_cd = format_hood_cd(attrs.get(HOOD_FILTER_FIELD))
        if not hood_cd or hood_cd in seen:
            continue
        seen.add(hood_cd)
        hoods.append({"hood_cd": hood_cd, "hood_name": hood_cd})
    hoods.sort(key=lambda h: h["hood_cd"])
    log.info(
        "Distinct %s discovery returned %s neighborhoods (paginated)%s",
        HOOD_FILTER_FIELD,
        len(hoods),
        f" [{hood_field_type()}]" if hood_field_type() else "",
    )

    total = int(
        query_layer(
            PROP_TABLE_ID,
            where="1=1",
            return_count_only=True,
            max_retries=max_retries,
        ).get("count")
        or 0
    )

    if not hoods:
        if total <= 0:
            return []
        log.warning(
            "No distinct %s values on %s parcels — exporting entire layer as %s",
            HOOD_FILTER_FIELD,
            total,
            ALL_PARCELS_HOOD,
        )
        return [{"hood_cd": ALL_PARCELS_HOOD, "hood_name": "All parcels"}]

    return maybe_append_unassigned(hoods, max_retries)


def hood_where(hood_cd: str) -> str:
    if hood_cd == ALL_PARCELS_HOOD:
        return bulk_layer_where()
    if hood_cd == UNASSIGNED_HOOD:
        return hood_blank_where()
    # Exact match only — LIKE 'X%' wrongly matches longer codes (YR2-RA1 → YR2-RA10).
    return hood_equals_where(hood_cd)


def count_properties_for_hood(hood_cd: str, *, max_retries: int) -> int:
    data = query_layer(
        PROP_TABLE_ID,
        where=hood_where(hood_cd),
        return_count_only=True,
        max_retries=max_retries,
    )
    return int(data.get("count") or 0)


def _blank(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s if s else None


def _attr_suffix(attrs: dict[str, Any], suffix: str) -> Any:
    """Return first attribute whose last path segment equals ``suffix``.

    Pandai layers use DBO-qualified names (``…Accounts.Owner_Name``). Matching the
    last segment avoids false hits like ``Owner_Name`` when looking up ``Name``.
    """
    if suffix in attrs:
        return attrs.get(suffix)
    for key, val in attrs.items():
        k = str(key)
        if k == suffix or k.rsplit(".", 1)[-1] == suffix:
            return val
    return None


def _attr_path_endswith(attrs: dict[str, Any], *tails: str) -> Any:
    """Return first attribute whose key equals or ends with one of ``tails``."""
    for tail in tails:
        if tail in attrs:
            return attrs.get(tail)
        needle = "." + tail if not tail.startswith(".") else tail
        for key, val in attrs.items():
            k = str(key)
            if k == tail or k.endswith(needle):
                return val
    return None


def compose_situs(attrs: dict[str, Any]) -> str | None:
    if _blank(attrs.get("situs")):
        return _blank(attrs.get("situs"))
    if _blank(attrs.get("SITUS")):
        return _blank(attrs.get("SITUS"))
    if _blank(attrs.get("Situs")):
        return _blank(attrs.get("Situs"))
    if _blank(attrs.get("SITEADDRESS")):
        return _blank(attrs.get("SITEADDRESS"))
    if _blank(attrs.get("PropertyAddress")):
        return _blank(attrs.get("PropertyAddress"))
    if _blank(attrs.get("situsConcat")):
        return _blank(attrs.get("situsConcat"))
    if _blank(attrs.get("situsConcatShort")):
        return _blank(attrs.get("situsConcatShort"))
    situs_display = _blank(attrs.get("situs_display"))
    if situs_display:
        return " ".join(situs_display.split())
    # Harris-style situs parts (site_str_num / site_str_name / site_city / site_zip)
    site_num = (
        _blank(attrs.get("site_num"))
        or _blank(attrs.get("site_addr_num"))
        or _blank(attrs.get("site_str_num"))
        or _blank(attrs.get("SiteNumber"))
    )
    site_name = _blank(attrs.get("site_str_name")) or _blank(attrs.get("site_street_name"))
    if site_num or site_name:
        site_parts = [
            site_num,
            _blank(attrs.get("site_str_pfx")) or _blank(attrs.get("site_str_prefx")),
            site_name,
            _blank(attrs.get("site_str_sfx")) or _blank(attrs.get("site_str_sufix")),
        ]
        street = " ".join(p for p in site_parts if p)
        city = _blank(attrs.get("site_city")) or _blank(attrs.get("mail_city"))
        zipc = _blank(attrs.get("site_zip")) or _blank(attrs.get("mail_zip"))
        tail = ", ".join(p for p in [city, zipc] if p)
        if street and tail:
            return f"{street}, {tail}"
        if street:
            return street
    parts = [
        _blank(attrs.get("situs_num"))
        or _blank(attrs.get("SITUS_NUM"))
        or _blank(_attr_suffix(attrs, "Prop_Street_Number")),
        _blank(attrs.get("situs_street_prefx"))
        or _blank(attrs.get("STREET_PREFIX"))
        or _blank(attrs.get("situsStreetPrefix"))
        or _blank(_attr_suffix(attrs, "Prop_Street_Dir")),
        _blank(attrs.get("situs_street"))
        or _blank(attrs.get("STREET"))
        or _blank(attrs.get("situsStreetName"))
        or _blank(_attr_suffix(attrs, "Prop_Street")),
        _blank(attrs.get("situs_street_sufix"))
        or _blank(attrs.get("situsStreetSuffix"))
        or _blank(_attr_suffix(attrs, "Prop_Street_Suffix")),
    ]
    street = " ".join(p for p in parts if p)
    unit = _blank(attrs.get("situsUnit")) or _blank(attrs.get("UNIT"))
    if street and unit:
        street = f"{street} {unit}"
    city = (
        _blank(attrs.get("situs_city"))
        or _blank(attrs.get("situsCity"))
        or _blank(_attr_suffix(attrs, "Prop_City"))
    )
    state = (
        _blank(attrs.get("situs_state"))
        or _blank(attrs.get("situsState"))
        or _blank(_attr_suffix(attrs, "Prop_State"))
    )
    zipc = (
        _blank(attrs.get("situs_zip"))
        or _blank(attrs.get("situsZip"))
        or _blank(attrs.get("zip"))
        or _blank(_attr_suffix(attrs, "Prop_Zip5"))
    )
    tail = ", ".join(p for p in [city, " ".join(p for p in [state, zipc] if p)] if p)
    if street and tail:
        return f"{street}, {tail}"
    return street or tail or None


def _first(*vals: Any) -> Any:
    for v in vals:
        if v is None:
            continue
        if isinstance(v, str) and not v.strip():
            continue
        return v
    return None


def _is_na_token(v: Any) -> bool:
    """True for blank / literal N/A placeholders some CAD layers publish."""
    if v is None:
        return True
    if isinstance(v, str):
        s = v.strip()
        return (not s) or s.upper() in ("N/A", "NA", "NULL", "-")
    return False


def _first_value(*vals: Any) -> Any:
    """Like ``_first``, but also skip literal N/A / NA / - tokens."""
    for v in vals:
        if _is_na_token(v):
            continue
        return v
    return None


def _first_id(*vals: Any) -> Any:
    """Like ``_first``, but treat numeric/string ``0`` as missing (empty GIS shells)."""
    for v in vals:
        if v is None:
            continue
        if isinstance(v, bool):
            return v
        if isinstance(v, (int, float)) and v == 0:
            continue
        if isinstance(v, str):
            s = v.strip()
            if not s or s in ("0", "0.0") or s.upper() in ("N/A", "NA", "NULL", "-"):
                continue
            return s
        return v
    return None


def _row_has_property_signal(row: dict[str, Any]) -> bool:
    """False for blank ArcGIS shells (no id/owner/situs/legal/value)."""
    for key in ("pacs_prop_id", "geo_id", "owner_name", "situs", "legal_desc", "hood_cd"):
        val = row.get(key)
        if val is None:
            continue
        if isinstance(val, (int, float)) and val == 0:
            continue
        if isinstance(val, str) and not val.strip():
            continue
        if isinstance(val, str) and val.strip() in ("0", "0.0"):
            continue
        return True
    appraised = row.get("appraised_val")
    if appraised not in (None, "", 0, "0") and not _is_na_token(appraised):
        return True
    return False


def offset_page_looks_like_shells(features: list[dict[str, Any]]) -> bool:
    """True when an offset page has features but almost no useful parcel attrs.

    Some layers (Collin early OBJECTIDs; historically Williamson) return geometry
    shells on resultOffset paging while objectIds POST returns full attributes.
    """
    if not features:
        return False
    useful = 0
    for feat in features:
        attrs = feat.get("attributes") or {}
        # Fast raw signal: configured prop id / common owner fields before normalize.
        raw_id = _first_id(
            attrs.get(PROP_ID_FIELD),
            attrs.get("prop_id"),
            attrs.get("propID"),
            attrs.get("PropertyID"),
            attrs.get("PROP_ID"),
            attrs.get("HCAD_NUM"),
            attrs.get("PROPNUMBER"),
            attrs.get("PIN"),
        )
        raw_owner = _first(
            attrs.get("owner_name"),
            attrs.get("owner_name_1"),
            attrs.get("py_owner_name"),
            attrs.get("file_as_name"),
            attrs.get("ownerName"),
            attrs.get("OwnerName"),
            attrs.get("OWNERNAME"),
            attrs.get("OWNERNME1"),
            attrs.get("OName"),
            attrs.get("PartyName"),
        )
        if raw_id or raw_owner:
            useful += 1
            continue
        if _row_has_property_signal(normalize_property_attrs(attrs)):
            useful += 1
    ratio = useful / len(features)
    # "Almost none" — Collin offset-0 is ~1% useful; healthy pages are >>10%.
    return ratio < 0.1


def _compose_legal(attrs: dict[str, Any]) -> str | None:
    legal = _first(
        attrs.get("legal_desc"),
        attrs.get("legalDescription"),
        attrs.get("LegalDescription"),
        attrs.get("LEGAL_DESC"),
        attrs.get("LEGAL"),
        attrs.get("PRPRTYDSCRP"),
        attrs.get("legal_dscr_1"),
        attrs.get("legal_dscr"),
    )
    if legal is not None:
        base = _blank(legal) if isinstance(legal, str) else legal
        extra = _blank(attrs.get("legal_dscr_2"))
        if base and extra:
            return f"{base} {extra}"
        return base
    chunks = [
        attrs.get("legal_desc"),
        attrs.get("legal_desc2"),
        attrs.get("legal_desc3"),
        attrs.get("legal_dscr_1"),
        attrs.get("legal_dscr_2"),
        _attr_suffix(attrs, "Legal1"),
        _attr_suffix(attrs, "Legal2"),
        _attr_suffix(attrs, "Legal3"),
        _attr_suffix(attrs, "Legal4"),
    ]
    joined = " ".join(str(c).strip() for c in chunks if c is not None and str(c).strip())
    return joined or None


def _as_number(val: Any) -> float | None:
    if val is None:
        return None
    if isinstance(val, bool):
        return None
    if isinstance(val, (int, float)):
        return float(val)
    if isinstance(val, str):
        s = val.strip().replace(",", "")
        if not s or s.upper() in ("N/A", "NA", "NULL", "-"):
            return None
        try:
            return float(s)
        except ValueError:
            return None
    return None


def _sum_land_imprv(attrs: dict[str, Any]) -> float | None:
    """BIS layers sometimes leave market null but populate land_val + imprv_val."""
    land = _as_number(
        _first_value(
            attrs.get("land_val"),
            attrs.get("land_value"),
            attrs.get("LNDVALUE"),
            attrs.get("LANDVALUE"),
            attrs.get("currValLand"),
            attrs.get("prevValLand"),
        )
    )
    imprv = _as_number(
        _first_value(
            attrs.get("imprv_val"),
            attrs.get("impr_value"),
            attrs.get("bld_value"),
            attrs.get("IMPVALUE"),
            attrs.get("currValImprv"),
            attrs.get("prevValImprv"),
        )
    )
    if land is None and imprv is None:
        return None
    total = (land or 0.0) + (imprv or 0.0)
    return total if total > 0 else None


def _bis_owner_name(attrs: dict[str, Any]) -> Any:
    """BIS FeatureServers often put owner in bare ``Name`` (not TaxParcels.Name)."""
    name = attrs.get("Name") or attrs.get("NAME")
    if name is None or (isinstance(name, str) and not name.strip()):
        return None
    # Prefer when other account fields are present (avoids geometry-label Names).
    signal = any(
        attrs.get(k) not in (None, "")
        for k in ("market", "legal_desc", "prop_id", "geo_id", "hood_cd", "owner_tax_yr")
    )
    if signal:
        return name
    # Jefferson-style: Name + market/legal_desc aliases already checked; also allow
    # when prop_id_text / file_as_name schema neighbors exist.
    if any(k in attrs for k in ("prop_id", "prop_id_text", "geo_id", "market", "imprv_val")):
        return name
    return None


def normalize_property_attrs(attrs: dict[str, Any]) -> dict[str, Any]:
    """Map county-specific ArcGIS fields onto the CSV schema importCsv expects."""
    prop_id = _first_id(
        attrs.get(PROP_ID_FIELD),
        attrs.get("pacs_prop_id"),
        attrs.get("prop_id"),
        attrs.get("propID"),
        attrs.get("PROP_ID"),
        attrs.get("pid"),
        attrs.get("LOWPARCELID"),
        attrs.get("PARCELID"),
        attrs.get("Account"),
        _attr_suffix(attrs, "Account"),
    )

    owner = _first(
        attrs.get("owner_name"),
        attrs.get("owner_name_1"),
        attrs.get("py_owner_name"),
        attrs.get("file_as_name"),
        attrs.get("ownerName"),
        attrs.get("OwnerName"),
        attrs.get("OWNERNAME"),
        attrs.get("OWNERNME1"),
        attrs.get("OName"),
        attrs.get("PartyName"),
        attrs.get("Owner_Name"),
        _attr_suffix(attrs, "Owner_Name"),
        _bis_owner_name(attrs),
    )
    owner2 = _blank(attrs.get("OWNERNME2")) or _blank(attrs.get("owner_name_2"))
    if owner and owner2:
        owner = f"{owner} / {owner2}"

    # Collin AGOL publishes currVal* as null until preliminary values go live;
    # prevVal* (certified prior year) stays populated — prefer curr, fall back to prev.
    has_curr_val = any(
        attrs.get(k) not in (None, "")
        for k in (
            "currValAppraised",
            "currValMarket",
            "currValAssessed",
            "currValLand",
            "currValImprv",
        )
    )
    has_prev_val = any(
        attrs.get(k) not in (None, "")
        for k in (
            "prevValAppraised",
            "prevValMarket",
            "prevValAssessed",
            "prevValLand",
            "prevValImprv",
        )
    )

    prop_val_yr = _first_id(
        attrs.get("prop_val_yr"),
        attrs.get("owner_tax_yr"),
        attrs.get("currValYear") if has_curr_val else None,
        attrs.get("prevValYear") if has_prev_val and not has_curr_val else None,
        attrs.get("propYear") if has_curr_val or has_prev_val else None,
        attrs.get("currValYear"),
        attrs.get("prevValYear"),
        attrs.get("propYear"),
        attrs.get("REVALYR"),
    )

    appraised = _first_value(
        attrs.get("appraised_val"),
        attrs.get("market"),
        attrs.get("market_value"),
        attrs.get("MarketValue"),
        attrs.get("TOTALVALUE"),
        attrs.get("TotalValue"),
        attrs.get("total_appraised_val"),
        attrs.get("total_market_val"),
        attrs.get("tax_value"),
        attrs.get("tax_val"),  # CAMA.io
        attrs.get("bxcm_val"),
        attrs.get("cap_val"),
        attrs.get("adj_cap_val"),
        attrs.get("VAL26TOT"),
        attrs.get("currValAppraised"),
        attrs.get("currValMarket"),
        attrs.get("currValAssessed"),
        attrs.get("prevValAppraised"),
        attrs.get("prevValMarket"),
        attrs.get("prevValAssessed"),
        attrs.get("CNTASSDVAL"),  # DCAD current market
        attrs.get("PRVASSDVAL"),
        attrs.get("Market_Value"),
        _attr_suffix(attrs, "Market_Value"),
    )
    # Treat literal N/A as missing so land+imprv / other fallbacks can apply.
    if _is_na_token(appraised):
        appraised = None
    if appraised is None or (isinstance(appraised, (int, float)) and appraised == 0):
        land_imprv = _sum_land_imprv(attrs)
        if land_imprv is not None:
            appraised = land_imprv

    hood_cd = _blank(
        _first(
            attrs.get(HOOD_FILTER_FIELD),
            attrs.get("hood_cd"),
            attrs.get("nbhdCode"),
            attrs.get("NBHD"),
            attrs.get("NGHBRHDCD"),
            attrs.get("Location_Code"),
            _attr_suffix(attrs, "Location_Code"),
        )
    )
    hood_name = _blank(attrs.get("hood_name")) or hood_cd

    # geo_id: string parcel / geo identifier (DCAD PARCELID, pandai TaxParcels.Name)
    geo_id = _first_id(
        attrs.get("geo_id"),
        attrs.get("geoID"),
        attrs.get("GeoID"),
        attrs.get("PARCELID"),
        attrs.get("ParcelId"),
        _attr_path_endswith(attrs, "TaxParcels.Name"),
        attrs.get("LOWPARCELID"),
        prop_id,
    )

    return {
        "pacs_prop_id": prop_id,
        "prop_val_yr": prop_val_yr,
        "geo_id": geo_id,
        "prop_type_cd": _first(
            attrs.get("prop_type_cd"),
            attrs.get("propType"),
            attrs.get("PROP_TYPE"),
            attrs.get("CLASSCD"),
            attrs.get("USECD"),
            _attr_suffix(attrs, "Primary_Category_Code"),
        ),
        "prop_type_desc": _blank(
            _first(
                attrs.get("prop_type_desc"),
                attrs.get("propType"),
                attrs.get("PROP_TYPE"),
                attrs.get("CLASSDSCRP"),
                attrs.get("USEDSCRP"),
                _attr_suffix(attrs, "Primary_Category_Code"),
            )
        ),
        "dba_name": _first(
            attrs.get("dba_name"),
            attrs.get("dbaName"),
            attrs.get("dba"),
            attrs.get("DBA1"),
        ),
        "appraised_val": appraised,
        "abs_subdv_cd": _first(
            attrs.get("abs_subdv_cd"),
            attrs.get("legalAbsSubCode"),
            attrs.get("CNVYNAME"),
            _attr_suffix(attrs, "Abstract_Subdiv"),
        ),
        "mapsco": _first(attrs.get("mapsco"), attrs.get("MAPGRID")),
        "map_id": _first(attrs.get("map_id"), attrs.get("mapID")),
        "agent_cd": _first(attrs.get("agent_cd"), attrs.get("taxAgentID")),
        "hood_cd": hood_cd,
        "hood_name": hood_name,
        "owner_name": owner,
        "owner_id": _first(
            attrs.get("owner_id"),
            attrs.get("ownerID"),
            _attr_suffix(attrs, "Owner_Id"),
        ),
        "addr_line1": _first(
            attrs.get("addr_line1"),
            attrs.get("ownerAddrLine1"),
            attrs.get("mail_addr_1"),
            attrs.get("PSTLADDRESS"),
            _attr_suffix(attrs, "Mailing_Address_Street"),
        ),
        "addr_line2": _first(
            attrs.get("addr_line2"),
            attrs.get("ownerAddrLine2"),
            attrs.get("mail_addr_2"),
            _attr_suffix(attrs, "Mailing_Address_Overflow"),
        ),
        "addr_line3": attrs.get("addr_line3"),
        "addr_city": _first(
            attrs.get("addr_city"),
            attrs.get("ownerAddrCity"),
            attrs.get("mail_city"),
            attrs.get("PSTLCITY"),
            _attr_suffix(attrs, "Mailing_Address_City"),
        ),
        "addr_state": _first(
            attrs.get("addr_state"),
            attrs.get("ownerAddrState"),
            attrs.get("mail_state"),
            attrs.get("PSTLSTATE"),
            _attr_suffix(attrs, "Mailing_Address_State"),
        ),
        "addr_zip": _first(
            attrs.get("addr_zip"),
            attrs.get("ownerAddrZip"),
            attrs.get("mail_zip"),
            attrs.get("PSTLZIP5"),
            attrs.get("zip"),
            _attr_suffix(attrs, "Mailing_Address_Zip5"),
        ),
        "addr_country": _first(attrs.get("addr_country"), attrs.get("ownerAddrCountry")),
        "pct_ownership": _first(
            attrs.get("pct_ownership"),
            _attr_suffix(attrs, "Interest"),
        ),
        "exemptions": _first(attrs.get("exemptions"), attrs.get("exemptCodes")),
        "state_cd": _first(
            attrs.get("state_cd"),
            attrs.get("STATE_CD"),
            attrs.get("propCategoryCode"),
            _attr_suffix(attrs, "Primary_Category_Code"),
        ),
        "legal_desc": _compose_legal(attrs),
        "situs": compose_situs(attrs),
        "jurisdictions": _first(
            attrs.get("jurisdictions"),
            attrs.get("entityCodes"),
            attrs.get("Entities"),
            attrs.get("SCHLTXCD"),
            attrs.get("CVTTXCD"),
        ),
        "land_val": _first_value(
            attrs.get("land_val"),
            attrs.get("land_value"),
            attrs.get("currValLand"),
            attrs.get("prevValLand"),
            attrs.get("LNDVALUE"),
            attrs.get("LANDVALUE"),
        ),
        "imprv_val": _first_value(
            attrs.get("imprv_val"),
            attrs.get("impr_value"),
            attrs.get("bld_value"),
            attrs.get("currValImprv"),
            attrs.get("prevValImprv"),
            attrs.get("IMPVALUE"),
        ),
        "market": _first_value(
            attrs.get("market"),
            attrs.get("MarketValue"),
            attrs.get("TOTALVALUE"),
            attrs.get("TotalValue"),
            attrs.get("total_market_val"),
            attrs.get("currValMarket"),
            attrs.get("prevValMarket"),
            attrs.get("CNTASSDVAL"),
            attrs.get("tax_val"),
            _attr_suffix(attrs, "Market_Value"),
        ),
        "school": _first(attrs.get("school"), attrs.get("SCHLDSCRP")),
        "city": attrs.get("city"),
        "county": attrs.get("county"),
    }


def materialize_feature_rows(
    features: list[dict[str, Any]],
    *,
    batch_hood_cd: str,
) -> list[dict[str, Any]]:
    """Normalize ArcGIS features; keep per-parcel hood when bulk-scraping as __ALL__."""
    rows: list[dict[str, Any]] = []
    bulk = batch_hood_cd == ALL_PARCELS_HOOD
    for feat in features:
        row = normalize_property_attrs(feat.get("attributes") or {})
        if not _row_has_property_signal(row):
            # Collin/AGOL (and similar) include blank geometry shells with PROP_ID=0.
            continue
        if bulk:
            # Preserve real neighborhood codes from the layer; only fill blanks.
            if not row.get("hood_cd"):
                row["hood_cd"] = None
            if not row.get("hood_name") and row.get("hood_cd"):
                row["hood_name"] = row["hood_cd"]
        else:
            if not row.get("hood_cd"):
                row["hood_cd"] = batch_hood_cd
            if not row.get("hood_name"):
                row["hood_name"] = batch_hood_cd
        rows.append(row)
    return rows


def fetch_properties_for_hood(
    hood_cd: str,
    *,
    page_size: int,
    guard: AdaptiveGuard,
    max_retries: int,
    max_rows: int = 0,
) -> dict[str, Any]:
    """Fetch all properties for a neighborhood via paginated ArcGIS queries.

    Critical: ArcGIS often caps a page at layer maxRecordCount and sets
    exceededTransferLimit=true even when fewer rows than requested were returned.
    Stopping on ``len(features) < page_size`` alone truncates large hoods
    (e.g. El Paso JS83800000 stopped at 2000 of 8794).

    Layers with supportsPagination=false (pandai) use objectId-window paging.
    """
    where = hood_where(hood_cd)
    total_available = count_properties_for_hood(hood_cd, max_retries=max_retries)
    guard.record_success()

    layer_info = get_layer_info(PROP_TABLE_ID, max_retries=max_retries)
    guard.record_success()
    effective_page = clamp_page_size(page_size, layer_info["maxRecordCount"])
    if page_size is None or int(page_size or 0) <= 0:
        log.info(
            "  using layer max page size %s (maxRecordCount)",
            effective_page,
        )
    elif effective_page != int(page_size):
        log.info(
            "  clamping page size %s → %s (layer maxRecordCount)",
            page_size,
            effective_page,
        )

    object_id_field = layer_info.get("objectIdField")
    use_offset = bool(layer_info.get("supportsPagination", True))
    over_1000 = total_available > OVER_1000_MARK

    def _materialize(features: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return materialize_feature_rows(features, batch_hood_cd=hood_cd)

    if not use_offset:
        if not object_id_field:
            raise RequestFailed(
                f"Cannot page hood {hood_cd}: no pagination and no objectIdField"
            )
        log.info("  using objectIds / OID-window pagination (%s)", object_id_field)
        features = fetch_features_no_offset(
            PROP_TABLE_ID,
            where=where,
            out_fields="*",
            object_id_field=object_id_field,
            max_retries=max_retries,
            batch_size=effective_page or 500,
        )
        guard.record_success()
        rows = _materialize(features)
        if max_rows and max_rows > 0:
            rows = rows[:max_rows]
        truncated = total_available > 0 and len(rows) < total_available
        if truncated:
            log.warning(
                "  TRUNCATED pagination for %s: exported %s of %s",
                hood_cd,
                len(rows),
                total_available,
            )
        return {
            "rows": rows,
            "total_available": total_available,
            "exported": len(rows),
            "over_1000": over_1000,
            "truncated": truncated,
        }

    # ObjectID pagination is the most reliable ArcGIS strategy when available.
    order_by = (
        f"{object_id_field} ASC"
        if object_id_field
        else f"{PROP_ID_FIELD} ASC"
    )

    def _via_object_ids() -> dict[str, Any]:
        """Prefer POST objectIds when offset pages are attribute shells."""
        log.info("  using objectIds POST streaming (offset page was shells)")
        features = fetch_features_via_object_ids(
            PROP_TABLE_ID,
            where=where,
            out_fields="*",
            max_retries=max_retries,
            batch_size=effective_page or 1000,
        )
        guard.record_success()
        oid_rows = _materialize(features)
        if max_rows and max_rows > 0:
            oid_rows = oid_rows[:max_rows]
        truncated_oid = total_available > 0 and len(oid_rows) < total_available
        if truncated_oid:
            log.warning(
                "  TRUNCATED pagination for %s: exported %s of %s",
                hood_cd,
                len(oid_rows),
                total_available,
            )
        return {
            "rows": oid_rows,
            "total_available": total_available,
            "exported": len(oid_rows),
            "over_1000": over_1000,
            "truncated": truncated_oid,
        }

    rows: list[dict[str, Any]] = []
    offset = 0
    pages = 0
    probed_shells = False
    while True:
        try:
            data = query_layer(
                PROP_TABLE_ID,
                where=where,
                out_fields="*",
                return_geometry=False,
                order_by=order_by,
                result_offset=offset,
                result_record_count=effective_page,
                max_retries=max_retries,
            )
        except RequestFailed as exc:
            msg = str(exc).lower()
            if object_id_field and (
                "pagination is not supported" in msg or "invalid or missing input" in msg
            ):
                log.warning(
                    "  offset pagination failed — switching to OID windows: %s",
                    exc,
                )
                layer_info["supportsPagination"] = False
                return fetch_properties_for_hood(
                    hood_cd,
                    page_size=page_size,
                    guard=guard,
                    max_retries=max_retries,
                    max_rows=max_rows,
                )
            raise
        guard.record_success()
        features = data.get("features") or []
        exceeded = data.get("exceededTransferLimit") is True
        pages += 1
        if not features:
            if exceeded:
                log.warning(
                    "  empty page with exceededTransferLimit at offset=%s — stopping",
                    offset,
                )
            break

        if not probed_shells:
            probed_shells = True
            if offset_page_looks_like_shells(features):
                log.warning(
                    "  offset page looks like attribute shells "
                    "(%s features, sparse prop-id/owner) — switching to objectIds",
                    len(features),
                )
                return _via_object_ids()

        rows.extend(_materialize(features))
        got = len(features)
        if max_rows and max_rows > 0 and len(rows) >= max_rows:
            rows = rows[:max_rows]
            log.info(
                "  page %s: exported %s / %s (+%s this page)",
                pages,
                len(rows),
                total_available or "?",
                got,
            )
            break

        log.info(
            "  page %s: exported %s / %s (+%s this page)",
            pages,
            len(rows),
            total_available or "?",
            got,
        )
        # Continue while the server says more rows remain, even if this page
        # was shorter than requested (maxRecordCount clamp / payload limits).
        if not exceeded and got < effective_page:
            break
        if not exceeded and got == 0:
            break
        offset += got
        # Safety: if count is known and we've collected them all, stop.
        if total_available > 0 and len(rows) >= total_available:
            break
        # Guard against runaway loops if the server keeps repeating a page.
        if pages > max(2, (total_available // max(1, effective_page)) + 5):
            log.error(
                "  pagination safety stop after %s pages (got %s/%s)",
                pages,
                len(rows),
                total_available,
            )
            break
        guard.sleep(extra=0.0)

    truncated = total_available > 0 and len(rows) < total_available
    if truncated:
        log.warning(
            "  TRUNCATED pagination for %s: exported %s of %s "
            "(exceededTransferLimit / page clamp issue — re-run with --force)",
            hood_cd,
            len(rows),
            total_available,
        )

    return {
        "rows": rows,
        "total_available": total_available,
        "exported": len(rows),
        "over_1000": over_1000,
        "truncated": truncated,
    }


def export_properties_to_csv(
    path: Path,
    *,
    hood_cd: str,
    page_size: int,
    guard: AdaptiveGuard,
    max_retries: int,
    max_rows: int = 0,
) -> dict[str, Any]:
    """Paginate a layer query and stream rows to CSV (memory-safe for bulk county pulls)."""
    where = hood_where(hood_cd)
    total_available = count_properties_for_hood(hood_cd, max_retries=max_retries)
    guard.record_success()

    layer_info = get_layer_info(PROP_TABLE_ID, max_retries=max_retries)
    guard.record_success()
    effective_page = clamp_page_size(page_size, layer_info["maxRecordCount"])
    if page_size is None or int(page_size or 0) <= 0:
        log.info(
            "  using layer max page size %s (maxRecordCount)",
            effective_page,
        )
    elif effective_page != int(page_size):
        log.info(
            "  clamping page size %s → %s (layer maxRecordCount)",
            page_size,
            effective_page,
        )

    object_id_field = layer_info.get("objectIdField")
    use_offset = bool(layer_info.get("supportsPagination", True))
    over_1000 = total_available > OVER_1000_MARK
    target = total_available
    if max_rows and max_rows > 0:
        target = min(total_available, max_rows) if total_available > 0 else max_rows
        log.info("  bulk row cap: %s (layer reports %s)", max_rows, total_available)

    path.parent.mkdir(parents=True, exist_ok=True)
    exported = 0
    pages = 0
    writer: csv.DictWriter | None = None
    fieldnames: list[str] | None = None

    def _write_page(features: list[dict[str, Any]]) -> int:
        nonlocal writer, fieldnames, exported
        rows = materialize_feature_rows(features, batch_hood_cd=hood_cd)
        if max_rows and max_rows > 0:
            remain = max_rows - exported
            if remain <= 0:
                return 0
            rows = rows[:remain]
        if not rows:
            return 0
        if writer is None:
            fieldnames = list(rows[0].keys())
            fh = path.open("w", newline="", encoding="utf-8")
            writer = csv.DictWriter(fh, fieldnames=fieldnames, extrasaction="ignore")
            writer.writeheader()
            # stash file handle on writer for close
            writer._pt_fh = fh  # type: ignore[attr-defined]
        assert writer is not None
        for row in rows:
            writer.writerow({k: ("" if v is None else v) for k, v in row.items()})
        exported += len(rows)
        return len(rows)

    try:
        if not use_offset:
            if not object_id_field:
                raise RequestFailed(
                    f"Cannot page hood {hood_cd}: no pagination and no objectIdField"
                )
            log.info("  streaming via objectIds pagination (POST batches)")
            for batch, total_ids, done in iter_features_via_object_ids(
                PROP_TABLE_ID,
                where=where,
                out_fields="*",
                max_retries=max_retries,
                batch_size=1000,
            ):
                pages += 1
                wrote = _write_page(batch)
                guard.record_success()
                if wrote:
                    log.info(
                        "  page %s: exported %s / %s (+%s this page)",
                        pages,
                        exported,
                        total_ids or target or total_available or "?",
                        wrote,
                    )
                if max_rows and max_rows > 0 and exported >= max_rows:
                    break
                if done < total_ids:
                    guard.sleep(extra=0.0)
        else:
            order_by = (
                f"{object_id_field} ASC"
                if object_id_field
                else f"{PROP_ID_FIELD} ASC"
            )
            offset = 0
            probed_shells = False
            log.info(
                "  streaming offset pagination (page=%s, total≈%s)",
                effective_page,
                total_available or "?",
            )
            while True:
                try:
                    data = query_layer(
                        PROP_TABLE_ID,
                        where=where,
                        out_fields="*",
                        return_geometry=False,
                        order_by=order_by,
                        result_offset=offset,
                        result_record_count=effective_page,
                        max_retries=max_retries,
                    )
                except RequestFailed as exc:
                    msg = str(exc).lower()
                    if object_id_field and (
                        "pagination is not supported" in msg
                        or "invalid or missing input" in msg
                    ):
                        log.warning(
                            "  offset pagination failed — switching to OID windows: %s",
                            exc,
                        )
                        layer_info["supportsPagination"] = False
                        if writer is not None:
                            fh = getattr(writer, "_pt_fh", None)
                            if fh:
                                fh.close()
                            writer = None
                            if path.exists():
                                path.unlink()
                        return export_properties_to_csv(
                            path,
                            hood_cd=hood_cd,
                            page_size=page_size,
                            guard=guard,
                            max_retries=max_retries,
                            max_rows=max_rows,
                        )
                    raise
                guard.record_success()
                features = data.get("features") or []
                exceeded = data.get("exceededTransferLimit") is True
                pages += 1
                if not features:
                    break

                if not probed_shells:
                    probed_shells = True
                    if offset_page_looks_like_shells(features):
                        log.warning(
                            "  offset page looks like attribute shells "
                            "(%s features, sparse prop-id/owner) — "
                            "switching to objectIds POST stream",
                            len(features),
                        )
                        # Prefer objectIds over OID-window for shell recovery.
                        for batch, total_ids, done in iter_features_via_object_ids(
                            PROP_TABLE_ID,
                            where=where,
                            out_fields="*",
                            max_retries=max_retries,
                            batch_size=1000,
                        ):
                            pages += 1
                            wrote = _write_page(batch)
                            guard.record_success()
                            if wrote:
                                log.info(
                                    "  page %s: exported %s / %s (+%s this page)",
                                    pages,
                                    exported,
                                    total_ids or target or total_available or "?",
                                    wrote,
                                )
                            if max_rows and max_rows > 0 and exported >= max_rows:
                                break
                            if done < total_ids:
                                guard.sleep(extra=0.0)
                        break

                wrote = _write_page(features)
                if wrote:
                    log.info(
                        "  page %s: exported %s / %s (+%s this page)",
                        pages,
                        exported,
                        target or total_available or "?",
                        wrote,
                    )
                if max_rows and max_rows > 0 and exported >= max_rows:
                    break
                got = len(features)
                if not exceeded and got < effective_page:
                    break
                offset += got
                if total_available > 0 and exported >= total_available:
                    break
                if pages > max(2, (total_available // max(1, effective_page)) + 5):
                    log.error(
                        "  pagination safety stop after %s pages (got %s/%s)",
                        pages,
                        exported,
                        total_available,
                    )
                    break
                if wrote:
                    guard.sleep(extra=0.0)
    finally:
        if writer is not None:
            fh = getattr(writer, "_pt_fh", None)
            if fh:
                fh.close()

    if exported == 0:
        path.write_text("", encoding="utf-8")

    truncated = total_available > 0 and exported < total_available and not (
        max_rows and max_rows > 0 and exported >= max_rows
    )
    if truncated:
        log.warning(
            "  TRUNCATED stream for %s: exported %s of %s",
            hood_cd,
            exported,
            total_available,
        )
    elif max_rows and max_rows > 0 and total_available > max_rows:
        log.info(
            "  stopped at --limit %s of %s available (test/partial bulk run)",
            exported,
            total_available,
        )

    return {
        "rows": None,  # streamed — not held in memory
        "total_available": total_available,
        "exported": exported,
        "over_1000": over_1000,
        "truncated": truncated,
    }


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return

    fieldnames: list[str] = list(rows[0].keys())
    seen = set(fieldnames)
    for row in rows[1:]:
        for key in row:
            if key not in seen:
                fieldnames.append(key)
                seen.add(key)

    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({k: ("" if v is None else v) for k, v in row.items()})


def write_hood_meta(path: Path, *, hood_cd: str, hood_name: str, result: dict[str, Any]) -> None:
    """Sidecar next to the CSV so over-1000 hoods are visible in the folder."""
    meta = {
        "hood_cd": hood_cd,
        "hood_name": hood_name,
        "total_available": result["total_available"],
        "exported": result["exported"],
        "over_1000": result["over_1000"],
        "truncated": result["truncated"],
        "marks": [],
    }
    if result["over_1000"]:
        meta["marks"].append(f"OVER_{OVER_1000_MARK}_FULL_EXPORT")
    if result.get("truncated"):
        meta["marks"].append("TRUNCATED_EXPORT")
    path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")


def touch_over_1000_marker(out_dir: Path, hood_cd: str, *, total: int, exported: int) -> Path:
    """Marker file so oversized hoods stand out (full export still written)."""
    marker = out_dir / f"{hood_file_stem(hood_cd)}.OVER_1000"
    marker.write_text(
        f"Neighborhood {hood_cd} has {total} parcels (over {OVER_1000_MARK}). "
        f"Full export written: {exported} rows.\n",
        encoding="utf-8",
    )
    return marker


def append_report_row(report_path: Path, row: dict[str, Any]) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "hood_cd",
        "hood_name",
        "total_available",
        "exported",
        "over_1000",
        "truncated",
        "csv_file",
        "meta_file",
        "marker_file",
    ]
    write_header = not report_path.exists()
    with report_path.open("a", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        if write_header:
            writer.writeheader()
        writer.writerow(row)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Scrape Bexar CAD map search neighborhoods into [hood_cd].csv files"
    )
    p.add_argument(
        "--out-dir",
        type=Path,
        default=Path(os.environ["CSV_DIR"]) if os.environ.get("CSV_DIR") else _data_path("csv"),
        help="Directory for [id].csv files (default: data/csv or CSV_DIR / DATA_DIR)",
    )
    p.add_argument(
        "--processed-dir",
        type=Path,
        default=(
            Path(os.environ["PROCESSED_DIR"])
            if os.environ.get("PROCESSED_DIR")
            else _data_path("processed")
        ),
        help="Skip hoods already imported here (default: data/processed or PROCESSED_DIR)",
    )
    p.add_argument(
        "--index",
        type=Path,
        default=_data_path("neighborhoods.json"),
        help="Path to write neighborhood index JSON",
    )
    p.add_argument("--delay", type=float, default=DEFAULT_DELAY, help="Base delay between requests (seconds)")
    p.add_argument(
        "--max-delay",
        type=float,
        default=DEFAULT_MAX_DELAY,
        help="Ceiling for adaptive backoff delay (seconds)",
    )
    p.add_argument(
        "--backoff",
        type=float,
        default=DEFAULT_BACKOFF_MULTIPLIER,
        help="Multiply current delay by this after each failure",
    )
    p.add_argument(
        "--max-consecutive-failures",
        type=int,
        default=DEFAULT_MAX_CONSECUTIVE_FAILURES,
        help="Quit after this many neighborhood failures in a row",
    )
    p.add_argument(
        "--no-quit-on-block",
        action="store_true",
        help="Do not immediately quit on HTTP 403/429/5xx (still backs off / consecutive-fail quit)",
    )
    p.add_argument("--retries", type=int, default=DEFAULT_MAX_RETRIES, help="Per-request retry count")
    p.add_argument(
        "--page-size",
        type=int,
        default=DEFAULT_PAGE_SIZE,
        help="ArcGIS resultRecordCount per page (0=use layer maxRecordCount, often 2000)",
    )
    p.add_argument(
        "--mode",
        choices=(MODE_BULK, MODE_BY_HOOD),
        default=MODE_BULK,
        help=(
            "bulk (default): paginate entire property layer into __ALL__.csv; "
            "by-hood: one CSV per neighborhood (legacy resume/debug)"
        ),
    )
    p.add_argument(
        "--limit",
        type=int,
        default=0,
        help="bulk: max property rows (0=all); by-hood: max neighborhoods (0=all)",
    )
    p.add_argument("--hood", action="append", default=[], help="Only scrape this hood_cd (repeatable; implies by-hood)")
    p.add_argument(
        "--force",
        action="store_true",
        help="Re-download even if [id].csv exists in out-dir or processed-dir",
    )
    p.add_argument("--skip-empty", action="store_true", help="Do not write CSV when a neighborhood has 0 properties")
    p.add_argument(
        "--map-server",
        default=os.environ.get("MAP_SERVER") or MAP_SERVER,
        help="ArcGIS MapServer or FeatureServer root URL",
    )
    p.add_argument(
        "--map-origin",
        default=os.environ.get("MAP_ORIGIN") or MAP_SEARCH_ORIGIN,
        help="HTTP Origin/Referer host for ArcGIS requests",
    )
    p.add_argument("--cid", type=int, default=int(os.environ.get("MAP_CID") or CID), help="TrueAutomation client id (optional)")
    p.add_argument(
        "--hood-layer",
        type=int,
        default=int(os.environ["HOOD_LAYER"]) if os.environ.get("HOOD_LAYER") is not None else HOOD_TABLE_ID,
        help="Neighborhood layer id (-1 = distinct hood_cd from property layer)",
    )
    p.add_argument(
        "--prop-layer",
        type=int,
        default=int(os.environ.get("PROP_LAYER") or PROP_TABLE_ID),
        help="Properties layer id",
    )
    p.add_argument(
        "--prop-id-field",
        default=os.environ.get("PROP_ID_FIELD") or PROP_ID_FIELD,
        help="Property id field name on the layer (normalized to pacs_prop_id in CSV)",
    )
    p.add_argument(
        "--hood-field",
        default=os.environ.get("HOOD_FILTER_FIELD") or HOOD_FILTER_FIELD,
        help="Neighborhood code field name",
    )
    p.add_argument(
        "--skip-setup",
        action="store_true",
        help="Do not fetch TrueAutomation setup.json (use for non-mapSearch counties)",
    )
    p.add_argument("-v", "--verbose", action="store_true")
    return p.parse_args(argv)


def apply_runtime_config(args: argparse.Namespace) -> None:
    global CID, MAP_SEARCH_ORIGIN, MAP_SERVER, HOOD_TABLE_ID, PROP_TABLE_ID
    global PROP_ID_FIELD, HOOD_FILTER_FIELD, SETUP_URL
    CID = int(args.cid)
    MAP_SEARCH_ORIGIN = str(args.map_origin).rstrip("/")
    MAP_SERVER = str(args.map_server).rstrip("/")
    HOOD_TABLE_ID = int(args.hood_layer)
    PROP_TABLE_ID = int(args.prop_layer)
    PROP_ID_FIELD = str(args.prop_id_field)
    HOOD_FILTER_FIELD = str(args.hood_field)
    SETUP_URL = f"{MAP_SEARCH_ORIGIN}/mapSearch/api/{CID}/setup.json"


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    apply_runtime_config(args)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    guard = AdaptiveGuard(
        base_delay=args.delay,
        max_delay=args.max_delay,
        backoff_multiplier=args.backoff,
        max_consecutive_failures=args.max_consecutive_failures,
        quit_on_block=not args.no_quit_on_block,
    )

    log.info("Source origin: %s (cid=%s)", MAP_SEARCH_ORIGIN, CID)
    log.info("Map server: %s", MAP_SERVER)
    try:
        resolve_runtime_fields(PROP_TABLE_ID, max_retries=args.retries)
    except RequestFailed as exc:
        log.warning("Could not resolve layer fields (continuing with configured names): %s", exc)
    log.info(
        "Layers: hood=%s prop=%s id_field=%s hood_field=%s mode=%s",
        HOOD_TABLE_ID,
        PROP_TABLE_ID,
        PROP_ID_FIELD,
        HOOD_FILTER_FIELD,
        args.mode,
    )
    log.info(
        "Guard: base_delay=%.2fs max_delay=%.2fs backoff=%.1fx quit_after=%s consecutive, quit_on_block=%s",
        args.delay,
        args.max_delay,
        args.backoff,
        args.max_consecutive_failures,
        not args.no_quit_on_block,
    )

    if not args.skip_setup:
        try:
            setup = http_get_json(SETUP_URL, max_retries=args.retries)
            cfg = setup[0] if isinstance(setup, list) else setup
            log.info("Map name: %s", cfg.get("mapName"))
            log.debug("Configured mapServiceURL: %s", cfg.get("mapServiceURL"))
        except Exception as exc:  # noqa: BLE001 — informational only
            log.warning("Could not load setup.json (continuing): %s", exc)

    # Explicit --hood list forces by-hood mode for those codes.
    mode = args.mode
    if args.hood and mode == MODE_BULK:
        log.info("Hood filter provided — switching to by-hood mode")
        mode = MODE_BY_HOOD

    if mode == MODE_BULK:
        log.info("Bulk mode — exporting entire property layer as %s", ALL_PARCELS_HOOD)
        # Ensure layer info (and Accounts OID preference) is cached before count/where.
        try:
            get_layer_info(PROP_TABLE_ID, max_retries=args.retries)
        except RequestFailed as exc:
            log.error("Could not load layer info: %s", exc)
            return 2
        try:
            parcel_total = int(
                query_layer(
                    PROP_TABLE_ID,
                    where=bulk_layer_where(),
                    return_count_only=True,
                    max_retries=args.retries,
                ).get("count")
                or 0
            )
        except RequestFailed as exc:
            log.error("Could not count parcels: %s", exc)
            return 2
        if parcel_total <= 0:
            log.error("Property layer returned 0 parcels")
            return 2
        log.info("Layer reports %s parcels", parcel_total)
        hoods = [{"hood_cd": ALL_PARCELS_HOOD, "hood_name": "All parcels"}]
    else:
        log.info("Fetching neighborhood list…")
        try:
            hoods = fetch_neighborhoods(args.retries)
        except RequestFailed as exc:
            log.error("Could not load neighborhoods: %s", exc)
            return 2
        log.info("Found %s neighborhoods", len(hoods))

    args.index.parent.mkdir(parents=True, exist_ok=True)
    args.index.write_text(json.dumps(hoods, indent=2), encoding="utf-8")
    log.info("Wrote index → %s", args.index)

    if args.hood:
        wanted = {h.strip() for h in args.hood}
        hoods = [h for h in hoods if h["hood_cd"] in wanted]
        missing = wanted - {h["hood_cd"] for h in hoods}
        if missing:
            log.warning("Unknown hood_cd(s): %s", ", ".join(sorted(missing)))

    if mode == MODE_BY_HOOD and args.limit and args.limit > 0:
        hoods = hoods[: args.limit]

    args.out_dir.mkdir(parents=True, exist_ok=True)
    report_path = Path(args.out_dir.parent / "scrape_report.csv")
    over_report_path = Path(args.out_dir.parent / "over_1000_report.csv")
    # Fresh run appends; truncate reports when starting from scratch with --force and no hood filter
    if args.force and not args.hood and report_path.exists():
        report_path.unlink()
    if args.force and not args.hood and over_report_path.exists():
        over_report_path.unlink()

    total = len(hoods)
    scraped = skipped = failed = over_1000_count = 0
    aborted = False
    bulk_row_limit = args.limit if mode == MODE_BULK else 0

    try:
        for i, hood in enumerate(hoods, start=1):
            hood_cd = hood["hood_cd"]
            hood_name = hood["hood_name"]
            stem = hood_file_stem(hood_cd)
            out_path = args.out_dir / f"{stem}.csv"
            processed_path = args.processed_dir / f"{stem}.csv"
            meta_path = args.out_dir / f"{stem}.meta.json"
            marker_path = args.out_dir / f"{stem}.OVER_1000"
            # Legacy mistake: hood codes with "/" were written as nested paths.
            legacy_out = args.out_dir.joinpath(*Path(hood_cd).parts).with_suffix(".csv") if "/" in hood_cd or "\\" in hood_cd else None
            legacy_processed = (
                args.processed_dir.joinpath(*Path(hood_cd).parts).with_suffix(".csv")
                if "/" in hood_cd or "\\" in hood_cd
                else None
            )

            if not args.force:
                if out_path.exists():
                    log.info("[%s/%s] skip existing %s", i, total, out_path)
                    skipped += 1
                    continue
                if processed_path.exists():
                    log.info(
                        "[%s/%s] skip already imported %s",
                        i,
                        total,
                        processed_path,
                    )
                    skipped += 1
                    continue
                if legacy_out and legacy_out.exists():
                    log.info(
                        "[%s/%s] flattening legacy nested CSV %s → %s",
                        i,
                        total,
                        legacy_out,
                        out_path,
                    )
                    out_path.parent.mkdir(parents=True, exist_ok=True)
                    legacy_out.replace(out_path)
                    legacy_meta = Path(str(legacy_out)[: -len(".csv")] + ".meta.json")
                    if legacy_meta.exists():
                        legacy_meta.replace(meta_path)
                    legacy_marker = Path(str(legacy_out)[: -len(".csv")] + ".OVER_1000")
                    if legacy_marker.exists():
                        legacy_marker.replace(marker_path)
                    skipped += 1
                    continue
                if legacy_processed and legacy_processed.exists():
                    log.info(
                        "[%s/%s] skip already imported legacy nested %s",
                        i,
                        total,
                        legacy_processed,
                    )
                    skipped += 1
                    continue

            log.info("[%s/%s] %s — %s (delay=%.2fs)", i, total, hood_cd, hood_name, guard.current_delay)
            try:
                guard.sleep()
                if mode == MODE_BULK or hood_cd == ALL_PARCELS_HOOD:
                    result = export_properties_to_csv(
                        out_path,
                        hood_cd=hood_cd,
                        page_size=args.page_size,
                        guard=guard,
                        max_retries=args.retries,
                        max_rows=bulk_row_limit,
                    )
                    if result["exported"] == 0 and args.skip_empty:
                        log.info("  0 properties — skipped write")
                        scraped += 1
                        continue
                else:
                    result = fetch_properties_for_hood(
                        hood_cd,
                        page_size=args.page_size,
                        guard=guard,
                        max_retries=args.retries,
                    )
                    rows = result["rows"]

                    if not rows and args.skip_empty:
                        log.info("  0 properties — skipped write")
                        scraped += 1
                        continue

                    write_csv(out_path, rows)

                write_hood_meta(meta_path, hood_cd=hood_cd, hood_name=hood_name, result=result)

                marker_name = ""
                if result["over_1000"] or result["truncated"]:
                    if result["over_1000"]:
                        over_1000_count += 1
                    touch_over_1000_marker(
                        args.out_dir,
                        hood_cd,
                        total=result["total_available"],
                        exported=result["exported"],
                    )
                    marker_name = marker_path.name
                    if result["truncated"]:
                        log.warning(
                            "  INCOMPLETE: %s parcels available — only wrote %s rows",
                            result["total_available"],
                            result["exported"],
                        )
                    else:
                        log.warning(
                            "  OVER 1000: %s parcels — full export wrote %s rows (exceeds map UI limit)",
                            result["total_available"],
                            result["exported"],
                        )
                    append_report_row(
                        over_report_path,
                        {
                            "hood_cd": hood_cd,
                            "hood_name": hood_name,
                            "total_available": result["total_available"],
                            "exported": result["exported"],
                            "over_1000": result["over_1000"],
                            "truncated": result["truncated"],
                            "csv_file": out_path.name,
                            "meta_file": meta_path.name,
                            "marker_file": marker_name,
                        },
                    )
                elif marker_path.exists():
                    marker_path.unlink()

                append_report_row(
                    report_path,
                    {
                        "hood_cd": hood_cd,
                        "hood_name": hood_name,
                        "total_available": result["total_available"],
                        "exported": result["exported"],
                        "over_1000": result["over_1000"],
                        "truncated": result["truncated"],
                        "csv_file": out_path.name,
                        "meta_file": meta_path.name,
                        "marker_file": marker_name,
                    },
                )

                log.info(
                    "  wrote %s/%s rows → %s",
                    result["exported"],
                    result["total_available"],
                    out_path,
                )
                scraped += 1
            except ScrapeAbort:
                raise
            except Exception as exc:  # noqa: BLE001 — counted by guard; may abort
                failed += 1
                log.error("  FAILED %s: %s", hood_cd, exc)
                guard.record_failure(exc)
    except ScrapeAbort as exc:
        aborted = True
        log.error("STOPPED: %s", exc)
        log.error(
            "Progress preserved. Re-run the same command to resume (existing CSVs are skipped)."
        )

    log.info(
        "Done%s. scraped=%s skipped=%s failed=%s over_1000=%s total=%s delay_final=%.2fs",
        " (aborted)" if aborted else "",
        scraped,
        skipped,
        failed,
        over_1000_count,
        total,
        guard.current_delay,
    )
    if aborted:
        return 3
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
