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
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request


DB_PATH = Path(os.environ.get("KAKEIBO_DB", "/opt/codex-tg/kakeibo.sqlite3"))
AUTH_TOKEN = os.environ.get("KAKEIBO_SYNC_TOKEN", "")
CODEX_CMD = os.environ.get("KAKEIBO_CODEX_CMD", "")
CLASSIFY_WORKER_CMD = os.environ.get("KAKEIBO_CLASSIFY_WORKER_CMD", "")

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
    token = header[7:].strip() if header.startswith("Bearer ") else header.strip()
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
    return jsonify({"serverTime": server_time, "accepted": accepted})


@app.route("/api/kakeibo/classify/summary", methods=["GET", "OPTIONS"])
def classify_summary():
    if request.method == "OPTIONS":
        return ("", 204)
    with db() as conn:
        transactions = read_all_payloads(conn, "transactions", include_deleted=False)
        tasks = read_all_payloads(conn, "classify_tasks", include_deleted=False)
        suggested = read_all_payloads(conn, "suggested_rules", include_deleted=False)
        unclassified = [t for t in transactions if is_unclassified_txn(t)]
        unknown = aggregate_unknown_merchants(transactions)
        pending_settlements = [t for t in transactions if is_pending_settlement(t)]
        last_task = sorted(tasks, key=lambda t: t.get("updatedAt", ""), reverse=True)
    return jsonify({
        "unclassifiedTransactionCount": len(unclassified),
        "unknownMerchantCount": len(unknown),
        "pendingSettlementCount": len(pending_settlements),
        "pendingSuggestedRuleCount": len([r for r in suggested if r.get("status", "pending") == "pending"]),
        "lastTask": summarize_task(last_task[0]) if last_task else None,
    })


@app.route("/api/kakeibo/classify-tasks", methods=["POST", "OPTIONS"])
def create_classify_task():
    if request.method == "OPTIONS":
        return ("", 204)
    payload = request.get_json(force=True, silent=True) or {}
    limit = int(payload.get("limit") or 200)
    server_time = now_iso()
    with db() as conn:
        transactions = read_all_payloads(conn, "transactions", include_deleted=False)
        unknown_merchants = aggregate_unknown_merchants(transactions, limit=limit)
        pending_settlements = aggregate_pending_settlements(transactions, limit=limit)
        task_id = "task_" + uuid.uuid4().hex
        task = {
            "id": task_id,
            "status": "pending",
            "scope": payload.get("scope") or "unclassified",
            "months": payload.get("months") or [],
            "source": payload.get("source") or "",
            "limit": limit,
            "unknownMerchants": unknown_merchants,
            "pendingSettlements": pending_settlements,
            "unknownMerchantCount": len(unknown_merchants),
            "pendingSettlementCount": len(pending_settlements),
            "error": "",
            "createdAt": server_time,
            "updatedAt": server_time,
            "deletedAt": None,
            "serverVersion": 1,
        }
        upsert_many(conn, "classify_tasks", [task], server_time)
        upsert_unknown_merchants(conn, unknown_merchants, server_time)
    maybe_run_classify_worker(task_id)
    return jsonify({
        "taskId": task_id,
        "status": "pending",
        "unknownMerchantCount": len(unknown_merchants),
        "pendingSettlementCount": len(pending_settlements),
    })


@app.route("/api/kakeibo/classify-tasks/<task_id>", methods=["GET", "OPTIONS"])
def get_classify_task(task_id: str):
    if request.method == "OPTIONS":
        return ("", 204)
    with db() as conn:
        task = get_payload(conn, "classify_tasks", task_id)
        if not task:
            return jsonify({"error": "task not found"}), 404
        suggestions = [
            r for r in read_all_payloads(conn, "suggested_rules", include_deleted=False)
            if r.get("taskId") == task_id and r.get("status", "pending") == "pending"
        ]
    return jsonify({
        **summarize_task(task),
        "error": task.get("error", ""),
        "unknownMerchantCount": task.get("unknownMerchantCount", len(task.get("unknownMerchants", []))),
        "pendingSettlementCount": task.get("pendingSettlementCount", len(task.get("pendingSettlements", []))),
        "suggestedRules": suggestions,
    })


@app.route("/api/kakeibo/classify-tasks/<task_id>/run", methods=["POST", "OPTIONS"])
def run_classify_task(task_id: str):
    if request.method == "OPTIONS":
        return ("", 204)
    with db() as conn:
        task = get_payload(conn, "classify_tasks", task_id)
    if not task:
        return jsonify({"error": "task not found"}), 404
    if task.get("status") in ("running", "completed"):
        return jsonify(summarize_task(task))
    maybe_run_classify_worker(task_id)
    return jsonify({**summarize_task(task), "status": "pending"})


@app.route("/api/kakeibo/suggested-rules/confirm", methods=["POST", "OPTIONS"])
def confirm_suggested_rules():
    if request.method == "OPTIONS":
        return ("", 204)
    payload = request.get_json(force=True, silent=True) or {}
    accepted_ids = set(payload.get("acceptedIds") or [])
    rejected_ids = set(payload.get("rejectedIds") or [])
    edited_rules = payload.get("editedRules") or []
    server_time = now_iso()
    formal_rules: list[dict[str, Any]] = []
    with db() as conn:
        suggestions = {r["id"]: r for r in read_all_payloads(conn, "suggested_rules", include_deleted=False)}
        for sid in rejected_ids:
            suggestion = suggestions.get(sid)
            if suggestion:
                suggestion["status"] = "rejected"
                suggestion["updatedAt"] = server_time
                upsert_many(conn, "suggested_rules", [suggestion], server_time)
        for sid in accepted_ids:
            suggestion = suggestions.get(sid)
            if suggestion:
                formal_rules.append(rule_from_suggestion(suggestion, server_time))
                suggestion["status"] = "accepted"
                suggestion["updatedAt"] = server_time
                upsert_many(conn, "suggested_rules", [suggestion], server_time)
        for edited in edited_rules:
            sid = edited.get("suggestedRuleId")
            suggestion = suggestions.get(sid, {})
            merged = {**suggestion, **edited, "id": sid or edited.get("id") or uuid.uuid4().hex}
            formal_rules.append(rule_from_suggestion(merged, server_time))
            if sid and sid in suggestions:
                suggestions[sid]["status"] = "accepted"
                suggestions[sid]["updatedAt"] = server_time
                upsert_many(conn, "suggested_rules", [suggestions[sid]], server_time)
        saved = upsert_many(conn, "rules", formal_rules, server_time)
        rules = [get_payload(conn, "rules", r["id"]) for r in saved]
    return jsonify({"rules": [r for r in rules if r]})


@app.route("/api/kakeibo/rules/apply", methods=["POST", "OPTIONS"])
def apply_rules():
    if request.method == "OPTIONS":
        return ("", 204)
    payload = request.get_json(force=True, silent=True) or {}
    force = bool(payload.get("force"))
    server_time = now_iso()
    updated = []
    applied_rule_ids = set()
    with db() as conn:
        rules = sorted(
            [r for r in read_all_payloads(conn, "rules", include_deleted=False) if r.get("enabled", True)],
            key=lambda r: int(r.get("priority") or 0),
            reverse=True,
        )
        txns = read_all_payloads(conn, "transactions", include_deleted=False)
        for txn in txns:
            if not should_apply_rule_to_txn(txn, force):
                continue
            for rule in rules:
                if not rule_matches_txn(rule, txn):
                    continue
                changed = apply_rule_to_txn(txn, rule, force)
                if changed:
                    txn["updatedAt"] = server_time
                    txn["pendingSync"] = False
                    updated.append(txn)
                    applied_rule_ids.add(rule["id"])
                break
        if updated:
            upsert_many(conn, "transactions", updated, server_time)
    return jsonify({"updatedTransactions": len(updated), "appliedRules": len(applied_rule_ids)})


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


def read_all_payloads(conn: sqlite3.Connection, table: str, include_deleted: bool) -> list[dict[str, Any]]:
    where = "" if include_deleted else "WHERE deletedAt IS NULL"
    rows = conn.execute(f"SELECT * FROM {table} {where} ORDER BY updatedAt ASC").fetchall()
    return [row_to_payload(row) for row in rows]


def get_payload(conn: sqlite3.Connection, table: str, record_id: str) -> dict[str, Any] | None:
    row = conn.execute(f"SELECT * FROM {table} WHERE id = ?", (record_id,)).fetchone()
    return row_to_payload(row) if row else None


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


def clean_text(value: Any) -> str:
    return str(value or "").strip()


def is_truthy(value: Any) -> bool:
    return value is True or str(value).lower() in ("1", "true", "yes")


def is_unclassified_txn(txn: dict[str, Any]) -> bool:
    return (
        not txn.get("deletedAt")
        and not clean_text(txn.get("categoryMain"))
        and not is_truthy(txn.get("excludedFromStats"))
    )


def is_pending_settlement(txn: dict[str, Any]) -> bool:
    return (
        not txn.get("deletedAt")
        and txn.get("settlementType") in ("repayment", "aa_payment")
        and txn.get("settlementStatus") == "pending"
    )


def normalized_merchant(value: Any) -> str:
    return clean_text(value).lower()


def aggregate_unknown_merchants(transactions: list[dict[str, Any]], limit: int = 200) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for txn in transactions:
        if not is_unclassified_txn(txn):
            continue
        merchant = clean_text(txn.get("merchant"))
        if not merchant:
            continue
        key = "|".join([
            normalized_merchant(merchant),
            clean_text(txn.get("paymentMethod")),
            clean_text(txn.get("source")),
            clean_text(txn.get("direction")),
            clean_text(txn.get("type")),
        ])
        groups.setdefault(key, []).append(txn)
    items = [aggregate_txn_group(rows) for rows in groups.values()]
    items.sort(key=lambda x: (x["count"], x["amountTotal"]), reverse=True)
    return items[:limit]


def aggregate_pending_settlements(transactions: list[dict[str, Any]], limit: int = 200) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for txn in transactions:
        if not is_pending_settlement(txn):
            continue
        merchant = clean_text(txn.get("merchant"))
        if not merchant:
            continue
        key = "|".join([
            normalized_merchant(merchant),
            clean_text(txn.get("paymentMethod")),
            clean_text(txn.get("source")),
            clean_text(txn.get("direction")),
            clean_text(txn.get("type")),
        ])
        groups.setdefault(key, []).append(txn)
    items = [aggregate_txn_group(rows) for rows in groups.values()]
    items.sort(key=lambda x: (x["count"], x["amountTotal"]), reverse=True)
    return items[:limit]


def aggregate_txn_group(rows: list[dict[str, Any]]) -> dict[str, Any]:
    rows = sorted(rows, key=lambda r: r.get("date") or "")
    first = rows[0]
    amounts = [float(r.get("effectiveAmount") or r.get("amount") or 0) for r in rows]
    memos = []
    for row in rows:
        memo = clean_text(row.get("memo"))
        if memo and memo not in memos:
            memos.append(memo)
    return {
        "merchant": clean_text(first.get("merchant")),
        "normalizedMerchant": normalized_merchant(first.get("merchant")),
        "paymentMethod": clean_text(first.get("paymentMethod")),
        "source": clean_text(first.get("source")),
        "directionSamples": sorted({clean_text(r.get("direction")) for r in rows if clean_text(r.get("direction"))}),
        "typeSamples": sorted({clean_text(r.get("type")) for r in rows if clean_text(r.get("type"))}),
        "count": len(rows),
        "amountMin": min(amounts) if amounts else 0,
        "amountMax": max(amounts) if amounts else 0,
        "amountTotal": sum(amounts),
        "firstDate": rows[0].get("date", ""),
        "lastDate": rows[-1].get("date", ""),
        "sampleMemos": memos[:5],
    }


def summarize_task(task: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": task.get("id"),
        "status": task.get("status", "pending"),
        "createdAt": task.get("createdAt", ""),
        "updatedAt": task.get("updatedAt", ""),
    }


def rule_from_suggestion(suggestion: dict[str, Any], server_time: str) -> dict[str, Any]:
    rule_type = suggestion.get("ruleType") or "category"
    keyword = suggestion.get("keyword") or suggestion.get("merchant") or ""
    category_main = suggestion.get("categoryMain") or suggestion.get("catMain") or ""
    category_sub = suggestion.get("categorySub") or suggestion.get("catSub") or ""
    rid = suggestion.get("ruleId") or "rule_" + uuid.uuid4().hex
    return {
        "id": rid,
        "keyword": keyword,
        "matchType": suggestion.get("matchType") or "contains",
        "ruleType": rule_type,
        "categoryMain": category_main,
        "categorySub": category_sub,
        "catMain": category_main,
        "catSub": category_sub,
        "settlementPerson": suggestion.get("settlementPerson") or "",
        "settlementTypeHint": suggestion.get("settlementTypeHint") or "",
        "pmCondition": suggestion.get("paymentMethod") or suggestion.get("pmCondition") or "",
        "priority": int(suggestion.get("priority") or 50),
        "enabled": True,
        "source": "cloud_classification",
        "suggestedRuleId": suggestion.get("id") or suggestion.get("suggestedRuleId") or "",
        "createdAt": server_time,
        "updatedAt": server_time,
        "deletedAt": None,
        "serverVersion": 0,
    }


def should_apply_rule_to_txn(txn: dict[str, Any], force: bool) -> bool:
    if txn.get("deletedAt") or is_truthy(txn.get("excludedFromStats")):
        return False
    if force:
        return True
    return not clean_text(txn.get("categoryMain")) or is_pending_settlement(txn)


def rule_matches_txn(rule: dict[str, Any], txn: dict[str, Any]) -> bool:
    pm_condition = clean_text(rule.get("pmCondition"))
    if pm_condition and pm_condition != clean_text(txn.get("paymentMethod")):
        return False
    keyword = clean_text(rule.get("keyword")).lower()
    if not keyword:
        return False
    haystack = f"{clean_text(txn.get('merchant'))} {clean_text(txn.get('memo'))}".lower()
    if rule.get("matchType") == "exact":
        return haystack.strip() == keyword or clean_text(txn.get("merchant")).lower() == keyword
    return keyword in haystack


def apply_rule_to_txn(txn: dict[str, Any], rule: dict[str, Any], force: bool) -> bool:
    rule_type = rule.get("ruleType") or "category"
    changed = False
    if rule_type == "category" and (force or not clean_text(txn.get("categoryMain"))):
        category_main = rule.get("categoryMain") or rule.get("catMain") or ""
        if category_main:
            txn["categoryMain"] = category_main
            txn["categorySub"] = rule.get("categorySub") or rule.get("catSub") or ""
            changed = True
    elif rule_type == "settlement_person":
        person = rule.get("settlementPerson") or rule.get("keyword") or ""
        hint = rule.get("settlementTypeHint") or txn.get("settlementType") or ""
        if person:
            txn["settlementPerson"] = person
            changed = True
        if hint in ("repayment", "aa_payment"):
            txn["settlementType"] = hint
            txn["settlementStatus"] = "pending"
            changed = True
    elif rule_type == "exclude":
        txn["excludedFromStats"] = True
        txn["type"] = "excluded"
        changed = True
    return changed


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


def maybe_run_classify_worker(task_id: str | None = None) -> None:
    worker = Path(__file__).with_name("kakeibo_classify_worker.py")
    if CLASSIFY_WORKER_CMD:
        cmd = CLASSIFY_WORKER_CMD.format(task_id=task_id or "")
        subprocess.Popen(cmd, shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return
    if not worker.exists():
        return
    cmd = [sys.executable, str(worker)]
    if task_id:
        cmd.append(task_id)
    try:
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as exc:
        app.logger.warning("failed to start classify worker: %s", exc)


init_db()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8787")))
