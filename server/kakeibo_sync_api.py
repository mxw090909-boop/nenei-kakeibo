#!/usr/bin/env python3
"""
Nenei Kakeibo sync API.

Run on the VPS behind HTTPS, for example:
  KAKEIBO_SYNC_TOKEN='change-me' python3 server/kakeibo_sync_api.py

The GitHub Pages frontend stores the token only in the browser settings page.
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request


DB_PATH = Path(os.environ.get("KAKEIBO_DB", "/opt/codex-tg/kakeibo.sqlite3"))
AUTH_TOKEN = os.environ.get("KAKEIBO_SYNC_TOKEN", "")
CODEX_CMD = os.environ.get("KAKEIBO_CODEX_CMD", "")

app = Flask(__name__)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    schema = """
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      deletedAt TEXT,
      serverVersion INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      deletedAt TEXT,
      serverVersion INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS import_batches (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      deletedAt TEXT,
      serverVersion INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS settings (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      deletedAt TEXT,
      serverVersion INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS unknown_merchants (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      deletedAt TEXT,
      serverVersion INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS classify_tasks (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      deletedAt TEXT,
      serverVersion INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS suggested_rules (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      deletedAt TEXT,
      serverVersion INTEGER NOT NULL DEFAULT 1
    );
    """
    with db() as conn:
      conn.executescript(schema)


def require_auth() -> tuple[dict[str, Any] | None, int | None]:
    if request.method == "OPTIONS":
        return {}, None
    if not AUTH_TOKEN:
        return {"error": "KAKEIBO_SYNC_TOKEN is not configured on the VPS"}, 500
    header = request.headers.get("Authorization", "")
    token = header.removeprefix("Bearer ").strip()
    if token != AUTH_TOKEN:
        return {"error": "Unauthorized"}, 401
    return None, None


@app.before_request
def before_request() -> Any:
    if request.path.startswith("/api/kakeibo/"):
        body, status = require_auth()
        if status:
            return jsonify(body), status
    return None


@app.after_request
def cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return resp


@app.route("/api/kakeibo/sync/pull", methods=["GET", "OPTIONS"])
def pull():
    if request.method == "OPTIONS":
        return ("", 204)
    since = request.args.get("since", "")
    with db() as conn:
        transactions = read_changed(conn, "transactions", since, include_deleted=False)
        rules = read_changed(conn, "rules", since, include_deleted=False)
        settings = read_changed(conn, "settings", since, include_deleted=False)
        deleted_ids = read_deleted(conn, since)
        suggested_rules = read_changed(conn, "suggested_rules", since, include_deleted=False)
        rules_version = conn.execute("SELECT COALESCE(MAX(serverVersion), 0) AS v FROM rules").fetchone()["v"]
    return jsonify({
        "serverTime": now_iso(),
        "transactions": transactions,
        "rules": rules,
        "settings": settings,
        "deletedIds": deleted_ids,
        "rulesVersion": rules_version,
        "suggestedRules": suggested_rules,
    })


@app.route("/api/kakeibo/sync/push", methods=["POST", "OPTIONS"])
def push():
    if request.method == "OPTIONS":
        return ("", 204)
    payload = request.get_json(force=True, silent=False) or {}
    server_time = now_iso()
    with db() as conn:
        accepted = {
            "transactions": upsert_many(conn, "transactions", payload.get("transactions", []), server_time),
            "rules": upsert_many(conn, "rules", payload.get("rules", []), server_time),
            "settings": upsert_many(conn, "settings", payload.get("settings", []), server_time),
            "unknownMerchants": upsert_unknown_merchants(conn, payload.get("unknownMerchants", []), server_time),
        }
        enqueue_classify_tasks(conn, payload.get("clientId", ""), payload.get("unknownMerchants", []), server_time)
    maybe_run_codex_classifier()
    return jsonify({"serverTime": server_time, "accepted": accepted})


@app.route("/api/kakeibo/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "serverTime": now_iso()})


def read_changed(conn: sqlite3.Connection, table: str, since: str, include_deleted: bool) -> list[dict[str, Any]]:
    where = "updatedAt > ?"
    args: list[Any] = [since or ""]
    if not include_deleted:
        where += " AND deletedAt IS NULL"
    rows = conn.execute(f"SELECT * FROM {table} WHERE {where} ORDER BY updatedAt ASC", args).fetchall()
    return [row_to_payload(row) for row in rows]


def read_deleted(conn: sqlite3.Connection, since: str) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for table in ("transactions", "rules", "settings"):
        rows = conn.execute(f"SELECT id FROM {table} WHERE deletedAt IS NOT NULL AND updatedAt > ?", (since or "",)).fetchall()
        out[table] = [row["id"] for row in rows]
    return out


def row_to_payload(row: sqlite3.Row) -> dict[str, Any]:
    data = json.loads(row["payload"])
    data.update({
        "id": row["id"],
        "createdAt": row["createdAt"],
        "updatedAt": row["updatedAt"],
        "deletedAt": row["deletedAt"],
        "serverVersion": row["serverVersion"],
    })
    return data


def normalize_record(record: dict[str, Any], server_time: str) -> dict[str, Any]:
    rid = str(record.get("id") or "").strip()
    if not rid:
        raise ValueError("record missing id")
    return {
        **record,
        "id": rid,
        "createdAt": record.get("createdAt") or server_time,
        "updatedAt": record.get("updatedAt") or server_time,
        "deletedAt": record.get("deletedAt") or None,
    }


def upsert_many(conn: sqlite3.Connection, table: str, records: list[dict[str, Any]], server_time: str) -> list[dict[str, Any]]:
    accepted = []
    for raw in records or []:
        if not isinstance(raw, dict):
            continue
        record = normalize_record(raw, server_time)
        existing = conn.execute(f"SELECT updatedAt, serverVersion FROM {table} WHERE id = ?", (record["id"],)).fetchone()
        if existing and str(existing["updatedAt"]) > str(record["updatedAt"]):
            continue
        version = int(existing["serverVersion"] if existing else 0) + 1
        record["serverVersion"] = version
        conn.execute(
            f"""
            INSERT INTO {table} (id, payload, createdAt, updatedAt, deletedAt, serverVersion)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              payload=excluded.payload,
              updatedAt=excluded.updatedAt,
              deletedAt=excluded.deletedAt,
              serverVersion=excluded.serverVersion
            """,
            (record["id"], json.dumps(record, ensure_ascii=False), record["createdAt"], record["updatedAt"], record["deletedAt"], version),
        )
        accepted.append({"id": record["id"], "serverVersion": version})
    return accepted


def upsert_unknown_merchants(conn: sqlite3.Connection, records: list[dict[str, Any]], server_time: str) -> list[dict[str, Any]]:
    cleaned = []
    for raw in records or []:
        if not isinstance(raw, dict) or not raw.get("merchant"):
            continue
        rid = str(raw.get("id") or f"{raw.get('merchant')}|{raw.get('paymentMethod', '')}").lower()
        cleaned.append({**raw, "id": rid, "createdAt": raw.get("createdAt") or server_time, "updatedAt": server_time})
    return upsert_many(conn, "unknown_merchants", cleaned, server_time)


def enqueue_classify_tasks(conn: sqlite3.Connection, client_id: str, merchants: list[dict[str, Any]], server_time: str) -> None:
    for merchant in merchants or []:
        if not isinstance(merchant, dict) or not merchant.get("merchant"):
            continue
        task_id = f"classify:{merchant.get('id') or merchant.get('merchant')}"
        existing = conn.execute("SELECT id FROM classify_tasks WHERE id = ?", (task_id,)).fetchone()
        if existing:
            continue
        task = {
            "id": task_id,
            "clientId": client_id,
            "merchantId": merchant.get("id"),
            "merchant": merchant.get("merchant"),
            "paymentMethod": merchant.get("paymentMethod", ""),
            "status": "pending",
            "createdAt": server_time,
            "updatedAt": server_time,
            "deletedAt": None,
            "serverVersion": 1,
        }
        conn.execute(
            "INSERT INTO classify_tasks (id, payload, createdAt, updatedAt, deletedAt, serverVersion) VALUES (?, ?, ?, ?, ?, ?)",
            (task_id, json.dumps(task, ensure_ascii=False), server_time, server_time, None, 1),
        )


def maybe_run_codex_classifier() -> None:
    if not CODEX_CMD:
        return
    try:
        subprocess.Popen(CODEX_CMD, shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as exc:
        app.logger.warning("failed to start classifier: %s", exc)


init_db()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8787")))
