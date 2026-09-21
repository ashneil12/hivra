#!/usr/bin/env python3
"""Push aggregate Hermes WebUI usage to HermesOS dashboard.

Runs inside a WebUI/agent container. It reads the local Hermes state.db,
aggregates counts by UTC day, and POSTs counts only to the dashboard ingest
endpoint. No prompts, messages, tool args, user ids, or secrets are sent.

Required env:
  HERMES_INSTANCE_ID       UUID for the dashboard hermes_instances row
  HERMES_WEBUI_API_KEY     per-instance API server key / bearer

Optional env:
  HERMES_STATE_DB          default: /home/hermes/.hermes/state.db
  HERMES_USAGE_BEACON_URL  default: https://hermesos.cloud/api/agent-usage/ingest
  HERMES_USAGE_BEACON_DAYS default: 90
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_URL = "https://hermesos.cloud/api/agent-usage/ingest"
DEFAULT_DB = "/home/hermes/.hermes/state.db"


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def usage_payload(db_path: Path, instance_id: str, days: int) -> dict:
    cut = time.time() - days * 86400
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        daily = [
            dict(row)
            for row in conn.execute(
                """
                SELECT date(started_at,'unixepoch') stat_date,
                       COALESCE(SUM(input_tokens),0) input_tokens,
                       COALESCE(SUM(output_tokens),0) output_tokens,
                       COALESCE(SUM(cache_read_tokens),0) cache_read_tokens,
                       COALESCE(SUM(reasoning_tokens),0) reasoning_tokens,
                       COALESCE(SUM(estimated_cost_usd),0) estimated_cost_usd,
                       COUNT(*) sessions,
                       COALESCE(SUM(api_call_count),0) api_calls
                  FROM sessions
                 WHERE started_at > ?
                 GROUP BY stat_date
                 ORDER BY stat_date
                """,
                (cut,),
            )
        ]
        models = [
            dict(row)
            for row in conn.execute(
                """
                SELECT date(started_at,'unixepoch') stat_date,
                       model,
                       COALESCE(SUM(input_tokens + output_tokens),0) tokens,
                       COALESCE(SUM(api_call_count),0) requests
                  FROM sessions
                 WHERE started_at > ? AND model IS NOT NULL AND model <> ''
                 GROUP BY stat_date, model
                """,
                (cut,),
            )
        ]
        providers = [
            dict(row)
            for row in conn.execute(
                """
                SELECT date(started_at,'unixepoch') stat_date,
                       COALESCE(NULLIF(billing_provider,''),'unknown') provider,
                       COALESCE(SUM(input_tokens + output_tokens),0) tokens,
                       COALESCE(SUM(api_call_count),0) requests
                  FROM sessions
                 WHERE started_at > ?
                 GROUP BY stat_date, provider
                """,
                (cut,),
            )
        ]
    finally:
        conn.close()

    by_date = {row["stat_date"]: {**row, "by_model": {}, "by_provider": {}} for row in daily}
    for row in models:
        day = row.get("stat_date")
        model = row.get("model") or "unknown"
        if day in by_date:
            by_date[day]["by_model"][model] = {
                "tokens": int(row.get("tokens") or 0),
                "requests": int(row.get("requests") or 0),
            }
    for row in providers:
        day = row.get("stat_date")
        provider = row.get("provider") or "unknown"
        if day in by_date:
            by_date[day]["by_provider"][provider] = {
                "tokens": int(row.get("tokens") or 0),
                "requests": int(row.get("requests") or 0),
            }

    return {"instanceId": instance_id, "days": list(by_date.values())}


def post_payload(url: str, bearer: str, payload: dict) -> tuple[int, str]:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {bearer}",
            "Content-Type": "application/json",
            "User-Agent": "hermesos-agent-usage-beacon/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")


def main() -> int:
    instance_id = env("HERMES_INSTANCE_ID")
    bearer = env("HERMES_WEBUI_API_KEY") or env("HERMES_API_SERVER_KEY")
    url = env("HERMES_USAGE_BEACON_URL", DEFAULT_URL)
    db_path = Path(env("HERMES_STATE_DB", DEFAULT_DB))
    try:
        days = max(1, min(int(env("HERMES_USAGE_BEACON_DAYS", "90")), 90))
    except ValueError:
        days = 90

    if not instance_id:
        print("usage beacon skipped: HERMES_INSTANCE_ID is missing", file=sys.stderr)
        return 2
    if not bearer:
        print("usage beacon skipped: HERMES_WEBUI_API_KEY is missing", file=sys.stderr)
        return 2
    if not db_path.exists():
        print(f"usage beacon skipped: state db not found at {db_path}", file=sys.stderr)
        return 2

    payload = usage_payload(db_path, instance_id, days)
    if not payload["days"]:
        print("usage beacon: no usage rows to send")
        return 0

    status, text = post_payload(url, bearer, payload)
    if 200 <= status < 300:
        print(f"usage beacon: sent {len(payload['days'])} daily rows")
        return 0
    print(f"usage beacon failed: HTTP {status} {text[:300]}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
