"""Data connection: pull new rows from an external factory data source (the
factory_data_simulator, or later a real ERP/historian with the same shape) and
append them to the project's source files, so the next retrain sees fresh data.

Tareeka B (incremental append), not a full re-upload: for each table we ask the
source only for rows newer than what we already have, and we append only rows
whose natural key (the file's timestamp/date column — the first column of these
wide time-series files) isn't already present. That dedup is what keeps repeated
refreshes idempotent and stops any row being counted twice, which would silently
corrupt every prediction built on it.
"""

import csv
import json
import urllib.parse
import urllib.request
from pathlib import Path


def _get_json(url: str, timeout: float = 15.0) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:  # noqa: S310 — user-configured trusted URL
        return json.loads(resp.read().decode("utf-8"))


def _existing_keys(path: Path, key_col: str) -> tuple[list[str], set[str]]:
    """Returns (header, set of key values already in the file)."""
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        header = reader.fieldnames or []
        keys = {row[key_col] for row in reader if row.get(key_col)}
    return header, keys


def refresh_from_source(project_id: str, upload_dir: Path, base_url: str) -> dict:
    """Pull deltas for every table the source serves that this project also has
    as a source file, dedup-append them, and report exactly what changed. Does NOT
    retrain — the caller kicks that off so the HTTP response stays quick."""
    base_url = base_url.rstrip("/")
    tables = _get_json(f"{base_url}/tables")

    per_file: list[dict] = []
    total_added = 0
    for t in tables:
        table = t["table"]
        key_col = t["key_col"]
        dest = upload_dir / table
        if not dest.exists():
            # The source offers a table this project never uploaded — skip it, don't
            # invent a file the confirmed graph doesn't know about.
            continue

        header, existing = _existing_keys(dest, key_col)
        since = max(existing) if existing else None
        payload = _get_json(f"{base_url}/data/{table}" + (f"?since={urllib.parse.quote(since)}" if since else ""))
        new_rows = payload.get("rows", [])

        appended = 0
        with open(dest, "a", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            for row in new_rows:
                key = str(row.get(key_col, "")).strip()
                if not key or key in existing:
                    continue  # natural-key dedup — never double-count
                writer.writerow([row.get(col, "") for col in header])
                existing.add(key)
                appended += 1
        total_added += appended
        per_file.append({"file": table, "rows_added": appended, "latest_key": max(existing) if existing else None})

    return {"total_rows_added": total_added, "files": per_file}


def source_status(project_id: str, upload_dir: Path, base_url: str) -> dict:
    """For the Data connections UI: which of the source's tables this project has,
    how many rows each file currently holds, and the source's own latest point."""
    base_url = base_url.rstrip("/")
    tables = _get_json(f"{base_url}/tables")
    src_status = _get_json(f"{base_url}/status")
    latest_by_table = {row["table"]: row["latest"] for row in src_status.get("tables", [])}

    files = []
    for t in tables:
        table = t["table"]
        dest = upload_dir / table
        if not dest.exists():
            continue
        _header, keys = _existing_keys(dest, t["key_col"])
        files.append(
            {
                "file": table,
                "key_col": t["key_col"],
                "signal_cols": t.get("signal_cols", []),
                "our_rows": len(keys),
                "our_latest": max(keys) if keys else None,
                "source_latest": latest_by_table.get(table),
            }
        )
    return {"files": files, "source_signals": src_status.get("signals", [])}
