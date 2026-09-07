#!/usr/bin/env python3
"""
Scrape CAD neighborhood property data from public ArcGIS Map/FeatureServer
endpoints (no browser automation).

Default profile is Bexar CAD (TrueAutomation mapSearch → PAMapSearch).
Other counties pass --map-server / layer ids (e.g. Calhoun BIS FeatureServer).

Exports every parcel in each neighborhood (paginated). Neighborhoods with
more than 1000 parcels are still marked for visibility.

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
DEFAULT_PAGE_SIZE = 1000
DEFAULT_MAX_RETRIES = 5
DEFAULT_MAX_CONSECUTIVE_FAILURES = 3
DEFAULT_MAX_DELAY = 120.0
DEFAULT_BACKOFF_MULTIPLIER = 2.0

# Map UI Export caps at 1000 — we still mark hoods above this, but export all rows.
OVER_1000_MARK = 1000

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
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json,text/javascript,*/*;q=0.01",
            "Referer": f"{MAP_SEARCH_ORIGIN}/",
            "Origin": MAP_SEARCH_ORIGIN,
        },
    )
    last_err: Exception | None = None
    last_blocked = False
    last_status: int | None = None

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

    raise RequestFailed(
        f"Failed after retries: {url} ({last_err})",
        blocked=last_blocked,
        status=last_status,
    ) from last_err


def query_layer(
    layer_id: int,
    *,
    where: str,
    max_retries: int,
    out_fields: str = "*",
    return_geometry: bool = False,
    order_by: str | None = None,
    result_offset: int | None = None,
    result_record_count: int | None = None,
    return_count_only: bool = False,
    return_distinct: bool = False,
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "where": where,
        "f": "json",
    }
    if return_count_only:
        params["returnCountOnly"] = "true"
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

    url = f"{MAP_SERVER}/{layer_id}/query?" + urllib.parse.urlencode(params)
    data = http_get_json(url, max_retries=max_retries)
    if data.get("error"):
        # ArcGIS sometimes returns HTTP 200 with an error payload
        err = data["error"]
        code = err.get("code") if isinstance(err, dict) else None
        blocked = code in BLOCK_STATUSES
        raise RequestFailed(f"ArcGIS error: {err}", blocked=blocked, status=code)
    return data


# Cached per MAP_SERVER + layer id: maxRecordCount / objectIdField
_LAYER_INFO_CACHE: dict[str, dict[str, Any]] = {}


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

    max_records = int(data.get("maxRecordCount") or 0) or DEFAULT_PAGE_SIZE
    object_id_field = str(data.get("objectIdField") or "").strip() or None
    fields = data.get("fields") or []
    field_names = [str(f.get("name") or "") for f in fields if f.get("name")]
    if not object_id_field:
        for f in fields:
            if f.get("type") == "esriFieldTypeOID" and f.get("name"):
                object_id_field = str(f["name"])
                break
    if not object_id_field:
        # Joined pandai layers: prefer TaxParcels.OBJECTID over Accounts.OBJECTID
        tax = [n for n in field_names if n.upper().endswith("TAXPARCELS.OBJECTID")]
        any_oid = [n for n in field_names if n.upper().endswith(".OBJECTID") or n.upper() == "OBJECTID"]
        object_id_field = (tax[0] if tax else None) or (any_oid[0] if any_oid else None)

    adv = data.get("advancedQueryCapabilities") or {}
    supports_pagination = adv.get("supportsPagination")
    if supports_pagination is None:
        supports_pagination = bool(data.get("supportsPagination", True))

    info = {
        "maxRecordCount": max_records,
        "objectIdField": object_id_field,
        "name": data.get("name"),
        "fieldNames": field_names,
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
    """
    # Always request the OID field so windowing can advance.
    fields = [f.strip() for f in str(out_fields).split(",") if f.strip()]
    if out_fields.strip() == "*":
        page_fields = "*"
    else:
        if object_id_field not in fields:
            fields.insert(0, object_id_field)
        page_fields = ",".join(fields)

    features: list[dict[str, Any]] = []
    last_oid: int | None = None
    pages = 0
    while True:
        page_where = where
        if last_oid is not None:
            page_where = f"({where}) AND {object_id_field} > {last_oid}"
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
        pages += 1
        if not batch:
            break
        features.extend(batch)
        oids = [_feature_oid(f, object_id_field) for f in batch]
        oids_ok = [o for o in oids if o is not None]
        if not oids_ok:
            log.warning(
                "OID-window page missing %s values — stopping after %s features",
                object_id_field,
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


def clamp_page_size(requested: int, max_record_count: int) -> int:
    """Never request more than the layer will return in one page."""
    req = max(1, int(requested or DEFAULT_PAGE_SIZE))
    cap = max(1, int(max_record_count or DEFAULT_PAGE_SIZE))
    return min(req, cap)


def count_blank_hood_parcels(max_retries: int) -> int:
    """Parcels whose neighborhood filter field is NULL or empty string."""
    return int(
        query_layer(
            PROP_TABLE_ID,
            where=f"({HOOD_FILTER_FIELD} IS NULL OR {HOOD_FILTER_FIELD} = '')",
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
            scanned = fetch_features_oid_window(
                layer_id,
                where=where,
                out_fields=out_fields if out_fields != "*" else object_id_field,
                object_id_field=object_id_field,
                max_retries=max_retries,
                return_distinct=False,
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
        return fetch_features_oid_window(
            layer_id,
            where=where,
            out_fields=out_fields,
            object_id_field=object_id_field,
            max_retries=max_retries,
            return_distinct=False,
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
    feats = fetch_all_features(
        PROP_TABLE_ID,
        where=f"{HOOD_FILTER_FIELD} IS NOT NULL AND {HOOD_FILTER_FIELD} <> ''",
        out_fields=HOOD_FILTER_FIELD,
        order_by=f"{HOOD_FILTER_FIELD} ASC",
        return_distinct=True,
        max_retries=max_retries,
    )
    hoods = []
    seen: set[str] = set()
    for feat in feats:
        attrs = feat.get("attributes") or {}
        hood_cd = str(attrs.get(HOOD_FILTER_FIELD) or "").strip()
        if not hood_cd or hood_cd in seen:
            continue
        seen.add(hood_cd)
        hoods.append({"hood_cd": hood_cd, "hood_name": hood_cd})
    hoods.sort(key=lambda h: h["hood_cd"])
    log.info(
        "Distinct %s discovery returned %s neighborhoods (paginated)",
        HOOD_FILTER_FIELD,
        len(hoods),
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
        return "1=1"
    if hood_cd == UNASSIGNED_HOOD:
        return f"({HOOD_FILTER_FIELD} IS NULL OR {HOOD_FILTER_FIELD} = '')"
    safe = hood_cd.replace("'", "''")
    # Exact match only — LIKE 'X%' wrongly matches longer codes (YR2-RA1 → YR2-RA10).
    return f"{HOOD_FILTER_FIELD} = '{safe}'"


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
    """Return first attribute whose key equals or ends with ``.suffix``."""
    if suffix in attrs:
        return attrs.get(suffix)
    needle = "." + suffix
    for key, val in attrs.items():
        if str(key).endswith(needle) or str(key) == suffix:
            return val
    return None


def compose_situs(attrs: dict[str, Any]) -> str | None:
    if _blank(attrs.get("situs")):
        return _blank(attrs.get("situs"))
    if _blank(attrs.get("situsConcat")):
        return _blank(attrs.get("situsConcat"))
    if _blank(attrs.get("situsConcatShort")):
        return _blank(attrs.get("situsConcatShort"))
    parts = [
        _blank(attrs.get("situs_num")) or _blank(attrs.get("SITUS_NUM")),
        _blank(attrs.get("situs_street_prefx"))
        or _blank(attrs.get("STREET_PREFIX"))
        or _blank(attrs.get("situsStreetPrefix")),
        _blank(attrs.get("situs_street"))
        or _blank(attrs.get("STREET"))
        or _blank(attrs.get("situsStreetName")),
        _blank(attrs.get("situs_street_sufix")) or _blank(attrs.get("situsStreetSuffix")),
    ]
    street = " ".join(p for p in parts if p)
    unit = _blank(attrs.get("situsUnit"))
    if street and unit:
        street = f"{street} {unit}"
    city = _blank(attrs.get("situs_city")) or _blank(attrs.get("situsCity"))
    state = _blank(attrs.get("situs_state")) or _blank(attrs.get("situsState"))
    zipc = (
        _blank(attrs.get("situs_zip"))
        or _blank(attrs.get("situsZip"))
        or _blank(attrs.get("zip"))
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


def normalize_property_attrs(attrs: dict[str, Any]) -> dict[str, Any]:
    """Map county-specific ArcGIS fields onto the CSV schema importCsv expects."""
    prop_id = _first(
        attrs.get(PROP_ID_FIELD),
        attrs.get("pacs_prop_id"),
        attrs.get("prop_id"),
        attrs.get("propID"),
        attrs.get("PROP_ID"),
        attrs.get("pid"),
        attrs.get("Account"),
        _attr_suffix(attrs, "Account"),
    )

    owner = _first(
        attrs.get("owner_name"),
        attrs.get("file_as_name"),
        attrs.get("ownerName"),
        attrs.get("NAME"),
        attrs.get("Owner_Name"),
        _attr_suffix(attrs, "Owner_Name"),
    )

    prop_val_yr = _first(
        attrs.get("prop_val_yr"),
        attrs.get("owner_tax_yr"),
        attrs.get("propYear"),
        attrs.get("currValYear"),
    )

    appraised = _first(
        attrs.get("appraised_val"),
        attrs.get("market"),
        attrs.get("currValAppraised"),
        attrs.get("currValMarket"),
        attrs.get("currValAssessed"),
        attrs.get("Market_Value"),
        _attr_suffix(attrs, "Market_Value"),
    )

    hood_cd = _blank(
        _first(
            attrs.get(HOOD_FILTER_FIELD),
            attrs.get("hood_cd"),
            attrs.get("nbhdCode"),
            attrs.get("NBHD"),
            attrs.get("Location_Code"),
            _attr_suffix(attrs, "Location_Code"),
        )
    )
    hood_name = _blank(attrs.get("hood_name")) or hood_cd

    legal = _first(
        attrs.get("legal_desc"),
        attrs.get("legalDescription"),
        attrs.get("LEGAL_DESC"),
    )
    if legal is None:
        chunks = [attrs.get("legal_desc"), attrs.get("legal_desc2"), attrs.get("legal_desc3")]
        legal = " ".join(str(c) for c in chunks if c) or None

    return {
        "pacs_prop_id": prop_id,
        "prop_val_yr": prop_val_yr,
        "geo_id": _first(attrs.get("geo_id"), attrs.get("geoID"), attrs.get("GeoID")),
        "prop_type_cd": _first(attrs.get("prop_type_cd"), attrs.get("propType"), attrs.get("PROP_TYPE")),
        "prop_type_desc": _first(
            attrs.get("prop_type_desc"),
            attrs.get("propType"),
            attrs.get("PROP_TYPE"),
        ),
        "dba_name": _first(attrs.get("dba_name"), attrs.get("dbaName"), attrs.get("dba")),
        "appraised_val": appraised,
        "abs_subdv_cd": _first(
            attrs.get("abs_subdv_cd"),
            attrs.get("legalAbsSubCode"),
        ),
        "mapsco": attrs.get("mapsco"),
        "map_id": _first(attrs.get("map_id"), attrs.get("mapID")),
        "agent_cd": _first(attrs.get("agent_cd"), attrs.get("taxAgentID")),
        "hood_cd": hood_cd,
        "hood_name": hood_name,
        "owner_name": owner,
        "owner_id": _first(attrs.get("owner_id"), attrs.get("ownerID")),
        "addr_line1": _first(attrs.get("addr_line1"), attrs.get("ownerAddrLine1")),
        "addr_line2": _first(attrs.get("addr_line2"), attrs.get("ownerAddrLine2")),
        "addr_line3": attrs.get("addr_line3"),
        "addr_city": _first(attrs.get("addr_city"), attrs.get("ownerAddrCity")),
        "addr_state": _first(attrs.get("addr_state"), attrs.get("ownerAddrState")),
        "addr_zip": _first(attrs.get("addr_zip"), attrs.get("ownerAddrZip"), attrs.get("zip")),
        "addr_country": _first(attrs.get("addr_country"), attrs.get("ownerAddrCountry")),
        "pct_ownership": attrs.get("pct_ownership"),
        "exemptions": _first(attrs.get("exemptions"), attrs.get("exemptCodes")),
        "state_cd": _first(attrs.get("state_cd"), attrs.get("STATE_CD"), attrs.get("propCategoryCode")),
        "legal_desc": legal,
        "situs": compose_situs(attrs),
        "jurisdictions": _first(
            attrs.get("jurisdictions"),
            attrs.get("entityCodes"),
            attrs.get("Entities"),
        ),
        "land_val": _first(attrs.get("land_val"), attrs.get("currValLand")),
        "imprv_val": _first(attrs.get("imprv_val"), attrs.get("currValImprv")),
        "market": _first(attrs.get("market"), attrs.get("currValMarket")),
        "school": attrs.get("school"),
        "city": attrs.get("city"),
        "county": attrs.get("county"),
    }


def fetch_properties_for_hood(
    hood_cd: str,
    *,
    page_size: int,
    guard: AdaptiveGuard,
    max_retries: int,
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
    if effective_page != page_size:
        log.info(
            "  clamping page size %s → %s (layer maxRecordCount)",
            page_size,
            effective_page,
        )

    object_id_field = layer_info.get("objectIdField")
    use_offset = bool(layer_info.get("supportsPagination", True))
    over_1000 = total_available > OVER_1000_MARK

    def _materialize(features: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for feat in features:
            row = normalize_property_attrs(feat.get("attributes") or {})
            # Keep CSV/import keyed to the hood batch we queried (null hood_cd counties).
            if not row.get("hood_cd"):
                row["hood_cd"] = hood_cd
            if not row.get("hood_name"):
                row["hood_name"] = hood_cd
            rows.append(row)
        return rows

    if not use_offset:
        if not object_id_field:
            raise RequestFailed(
                f"Cannot page hood {hood_cd}: no pagination and no objectIdField"
            )
        log.info("  using OID-window pagination (%s)", object_id_field)
        features = fetch_features_oid_window(
            PROP_TABLE_ID,
            where=where,
            out_fields="*",
            object_id_field=object_id_field,
            max_retries=max_retries,
        )
        guard.record_success()
        rows = _materialize(features)
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

    rows: list[dict[str, Any]] = []
    offset = 0
    pages = 0
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
        rows.extend(_materialize(features))

        got = len(features)
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
    p.add_argument("--page-size", type=int, default=DEFAULT_PAGE_SIZE, help="ArcGIS page size")
    p.add_argument("--limit", type=int, default=0, help="Only process first N neighborhoods (0 = all)")
    p.add_argument("--hood", action="append", default=[], help="Only scrape this hood_cd (repeatable)")
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
        "Layers: hood=%s prop=%s id_field=%s hood_field=%s",
        HOOD_TABLE_ID,
        PROP_TABLE_ID,
        PROP_ID_FIELD,
        HOOD_FILTER_FIELD,
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

    if args.limit and args.limit > 0:
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
