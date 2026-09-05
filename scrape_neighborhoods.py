#!/usr/bin/env python3
"""
Scrape Bexar CAD neighborhood property data from the same ArcGIS services
used by https://bexar.trueautomation.com/mapSearch/?cid=110

Exports every parcel in each neighborhood (paginated past the map UI's
1000-row Export limit). Neighborhoods with more than 1000 parcels are still
marked so you can see which ones exceed the public UI export ceiling.

No browser automation — avoids CAPTCHAs by using the public REST endpoints
the map itself loads.

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

CID = 110
MAP_SEARCH_ORIGIN = "https://bexar.trueautomation.com"
MAP_SERVER = "https://maps.bcad.org/arcgis/rest/services/PAMapSearch/MapServer"
HOOD_TABLE_ID = 8  # map_neighborhood_vw (hood_cd, hood_name)
PROP_TABLE_ID = 9  # web_map_property
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
            "Referer": f"{MAP_SEARCH_ORIGIN}/mapSearch/?cid={CID}",
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


def fetch_neighborhoods(max_retries: int) -> list[dict[str, str]]:
    """Load neighborhood codes/names from table 8 (same source as Advanced Search → Neighborhood)."""
    data = query_layer(
        HOOD_TABLE_ID,
        where="1=1",
        out_fields="hood_cd,hood_name",
        return_geometry=False,
        max_retries=max_retries,
    )
    hoods: list[dict[str, str]] = []
    for feat in data.get("features") or []:
        attrs = feat.get("attributes") or {}
        hood_cd = str(attrs.get("hood_cd") or "").strip()
        hood_name = str(attrs.get("hood_name") or "").strip()
        if not hood_cd:
            continue
        hoods.append({"hood_cd": hood_cd, "hood_name": hood_name})
    hoods.sort(key=lambda h: h["hood_cd"])
    return hoods


def hood_where(hood_cd: str) -> str:
    return f"hood_cd LIKE '{hood_cd.replace(chr(39), chr(39)*2)}%'"


def count_properties_for_hood(hood_cd: str, *, max_retries: int) -> int:
    data = query_layer(
        PROP_TABLE_ID,
        where=hood_where(hood_cd),
        return_count_only=True,
        max_retries=max_retries,
    )
    return int(data.get("count") or 0)


def fetch_properties_for_hood(
    hood_cd: str,
    *,
    page_size: int,
    guard: AdaptiveGuard,
    max_retries: int,
) -> dict[str, Any]:
    """Fetch all properties for a neighborhood via paginated ArcGIS queries."""
    where = hood_where(hood_cd)
    total_available = count_properties_for_hood(hood_cd, max_retries=max_retries)
    guard.record_success()

    over_1000 = total_available > OVER_1000_MARK

    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        data = query_layer(
            PROP_TABLE_ID,
            where=where,
            out_fields="*",
            return_geometry=False,
            order_by="pacs_prop_id ASC",
            result_offset=offset,
            result_record_count=page_size,
            max_retries=max_retries,
        )
        guard.record_success()
        features = data.get("features") or []
        if not features:
            break
        for feat in features:
            rows.append(feat.get("attributes") or {})
        if len(features) < page_size:
            break
        offset += page_size
        guard.sleep(extra=0.0)

    return {
        "rows": rows,
        "total_available": total_available,
        "exported": len(rows),
        "over_1000": over_1000,
        "truncated": False,
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
    path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")


def touch_over_1000_marker(out_dir: Path, hood_cd: str, *, total: int, exported: int) -> Path:
    """Marker file so oversized hoods stand out (full export still written)."""
    marker = out_dir / f"{hood_cd}.OVER_1000"
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
    p.add_argument("-v", "--verbose", action="store_true")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
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

    log.info("Source map: %s/mapSearch/?cid=%s", MAP_SEARCH_ORIGIN, CID)
    log.info("Map server: %s", MAP_SERVER)
    log.info(
        "Guard: base_delay=%.2fs max_delay=%.2fs backoff=%.1fx quit_after=%s consecutive, quit_on_block=%s",
        args.delay,
        args.max_delay,
        args.backoff,
        args.max_consecutive_failures,
        not args.no_quit_on_block,
    )

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
    report_path = Path("data/scrape_report.csv")
    over_report_path = Path("data/over_1000_report.csv")
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
            out_path = args.out_dir / f"{hood_cd}.csv"
            processed_path = args.processed_dir / f"{hood_cd}.csv"
            meta_path = args.out_dir / f"{hood_cd}.meta.json"
            marker_path = args.out_dir / f"{hood_cd}.OVER_1000"

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
                if result["over_1000"]:
                    over_1000_count += 1
                    touch_over_1000_marker(
                        args.out_dir,
                        hood_cd,
                        total=result["total_available"],
                        exported=result["exported"],
                    )
                    marker_name = marker_path.name
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
                            "over_1000": True,
                            "truncated": False,
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
