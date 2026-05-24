#!/usr/bin/env python3
"""
Cloud classification worker for nenei-kakeibo.

VPS stores the full ledger. Codex only receives aggregated unknown merchants
and pending settlement objects, then returns suggestedRules. It never modifies
transactions directly.
"""

from __future__ import annotations

import json
import os
import shlex
import sqlite3
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DB_PATH = Path(os.environ.get("KAKEIBO_DB", "/opt/codex-tg/kakeibo.sqlite3"))
CODEX_CLI = os.environ.get("KAKEIBO_CODEX_CLI", "codex")
MODEL = os.environ.get("KAKEIBO_CLASSIFY_MODEL", "gpt-5.5")
REASONING = os.environ.get("KAKEIBO_CLASSIFY_REASONING", "medium")
DRY_RUN = os.environ.get("KAKEIBO_CLASSIFY_DRY_RUN", "0") == "1"
TIMEOUT = int(os.environ.get("KAKEIBO_CLASSIFY_TIMEOUT", "90"))


CATEGORIES = {
    "food": ["外食", "コンビニ", "スーパー", "カフェ", "デリバリー"],
    "transit": ["電車・バス", "タクシー", "自転車", "飛行機"],
    "housing": ["家賃", "光熱費", "通信費", "家具・家電"],
    "daily": ["消耗品", "洗濯・掃除", "キッチン"],
    "medical": ["病院", "薬局", "健康診断"],
    "travel": ["宿泊", "交通費", "食費", "アクティビティ", "お土産"],
    "fashion": ["衣服", "靴・バッグ", "美容院", "コスメ"],
    "fun": ["書籍", "映画・音楽", "ゲーム", "趣味"],
    "social": ["飲み会", "プレゼント", "冠婚葬祭"],
    "admin": ["税金", "保険", "手数料", "ビザ・在留"],
    "other": ["未分類", "雑費", "ATM手数料"],
}


PROMPT = """你是个人记账分类规则生成器。
你只根据 unknownMerchants 生成分类规则建议。
你不能修改交易。
你只能输出 JSON，不要输出解释性正文。

可用分类如下：
food: 外食, コンビニ, スーパー, カフェ, デリバリー
transit: 電車・バス, タクシー, 自転車, 飛行機
housing: 家賃, 光熱費, 通信費, 家具・家電
daily: 消耗品, 洗濯・掃除, キッチン
medical: 病院, 薬局, 健康診断
travel: 宿泊, 交通費, 食費, アクティビティ, お土産
fashion: 衣服, 靴・バッグ, 美容院, コスメ
fun: 書籍, 映画・音楽, ゲーム, 趣味
social: 飲み会, プレゼント, 冠婚葬祭
admin: 税金, 保険, 手数料, ビザ・在留
other: 未分類, 雑費, ATM手数料

判断规则：
1. 便利店归 food / コンビニ。
2. 餐厅、拉面、中餐、食堂、饮食店归 food / 外食。
3. 咖啡店归 food / カフェ。
4. 超市、生鲜、食品馆归 food / スーパー。
5. 外卖平台归 food / デリバリー。
6. 电车、公交、Suica、Pasmo 归 transit / 電車・バス。
7. 水电气通信费归 housing。
8. 药局、医院归 medical。
9. 手续费、邮政、行政相关归 admin。
10. PayPay direction=in 且 memo 类似“受け取った金額”，商户像人名时，生成 settlement_person 规则。
11. 不确定时 confidence 低于 0.7，并放到 needsReview。
12. 不要编造不存在的分类。

输出 JSON 格式：
{
  "suggestedRules": [
    {
      "keyword": "福萬年",
      "matchType": "contains",
      "ruleType": "category",
      "categoryMain": "food",
      "categorySub": "外食",
      "priority": 50,
      "confidence": 0.9,
      "reason": "餐厅名，高频外食消费"
    }
  ],
  "settlementRules": [
    {
      "keyword": "Queenie",
      "matchType": "contains",
      "ruleType": "settlement_person",
      "settlementPerson": "Queenie",
      "settlementTypeHint": "repayment",
      "priority": 80,
      "confidence": 0.95,
      "reason": "PayPay 入金，取引内容为受け取った金額，像固定还款对象"
    }
  ],
  "needsReview": [
    {
      "merchant": "Amazon",
      "reason": "可能是日用品、书籍或电子产品，需要用户确认"
    }
  ]
}
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def row_to_payload(row: sqlite3.Row) -> dict[str, Any]:
    payload = json.loads(row["payload"])
    payload.update({
        "id": row["id"],
        "createdAt": row["createdAt"],
        "updatedAt": row["updatedAt"],
        "deletedAt": row["deletedAt"],
        "serverVersion": row["serverVersion"],
    })
    return payload


def get_task(conn: sqlite3.Connection, task_id: str | None = None) -> dict[str, Any] | None:
    if task_id:
        row = conn.execute("SELECT * FROM classify_tasks WHERE id = ? AND deletedAt IS NULL", (task_id,)).fetchone()
    else:
        row = conn.execute(
            "SELECT * FROM classify_tasks WHERE deletedAt IS NULL AND json_extract(payload, '$.status') = 'pending' ORDER BY createdAt ASC LIMIT 1"
        ).fetchone()
    return row_to_payload(row) if row else None


def upsert(conn: sqlite3.Connection, table: str, record: dict[str, Any]) -> None:
    existing = conn.execute(f"SELECT serverVersion FROM {table} WHERE id = ?", (record["id"],)).fetchone()
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
        (
            record["id"],
            json.dumps(record, ensure_ascii=False),
            record.get("createdAt") or now_iso(),
            record.get("updatedAt") or now_iso(),
            record.get("deletedAt"),
            version,
        ),
    )


def update_task(conn: sqlite3.Connection, task: dict[str, Any], status: str, error: str = "") -> None:
    task["status"] = status
    task["error"] = error
    task["updatedAt"] = now_iso()
    upsert(conn, "classify_tasks", task)


def build_prompt(task: dict[str, Any]) -> str:
    data = {
        "taskId": task["id"],
        "unknownMerchants": task.get("unknownMerchants", []),
        "pendingSettlements": task.get("pendingSettlements", []),
    }
    return PROMPT + "\n\n输入数据 JSON：\n" + json.dumps(data, ensure_ascii=False, indent=2)


def dry_run_result(task: dict[str, Any]) -> dict[str, Any]:
    suggestions = []
    settlements = []
    review = []
    for item in task.get("unknownMerchants", [])[:12]:
        merchant = str(item.get("merchant") or "")
        lower = merchant.lower()
        memos = " ".join(item.get("sampleMemos") or [])
        if any(k in lower for k in ("7-eleven", "familymart", "lawson", "セブン", "ファミマ", "ローソン")):
            suggestions.append(make_category_rule(merchant, "food", "コンビニ", 0.92, "便利店消费"))
        elif any(k in lower for k in ("cafe", "coffee", "スタバ", "珈琲", "カフェ")):
            suggestions.append(make_category_rule(merchant, "food", "カフェ", 0.86, "咖啡店消费"))
        elif any(k in lower for k in ("suica", "pasmo", "jr", "metro", "東急", "小田急")):
            suggestions.append(make_category_rule(merchant, "transit", "電車・バス", 0.88, "交通相关商户"))
        elif any(k in lower for k in ("薬", "drug", "clinic", "病院")):
            suggestions.append(make_category_rule(merchant, "medical", "薬局", 0.84, "药局或医疗相关"))
        elif "支払い" in memos or item.get("paymentMethod") == "PayPay":
            suggestions.append(make_category_rule(merchant, "food", "外食", 0.72, "PayPay 高频支出，需用户确认"))
        else:
            review.append({"merchant": merchant, "reason": "dry-run 无法高置信判断"})
    for item in task.get("pendingSettlements", [])[:12]:
        merchant = str(item.get("merchant") or "")
        direction = set(item.get("directionSamples") or [])
        hint = "repayment" if "in" in direction else "aa_payment"
        settlements.append({
            "keyword": merchant,
            "matchType": "contains",
            "ruleType": "settlement_person",
            "settlementPerson": merchant,
            "settlementTypeHint": hint,
            "priority": 80,
            "confidence": 0.9,
            "reason": "AA/还款待确认对象",
        })
    return {"suggestedRules": suggestions, "settlementRules": settlements, "needsReview": review}


def make_category_rule(keyword: str, main: str, sub: str, confidence: float, reason: str) -> dict[str, Any]:
    return {
        "keyword": keyword,
        "matchType": "contains",
        "ruleType": "category",
        "categoryMain": main,
        "categorySub": sub,
        "priority": 50,
        "confidence": confidence,
        "reason": reason,
    }


def run_codex(task: dict[str, Any]) -> dict[str, Any]:
    if DRY_RUN:
        return dry_run_result(task)
    prompt = build_prompt(task)
    cmd = shlex.split(CODEX_CLI)
    if "{model}" in CODEX_CLI or "{prompt}" in CODEX_CLI:
        command = CODEX_CLI.format(model=MODEL, prompt=shlex.quote(prompt))
        proc = subprocess.run(command, shell=True, text=True, capture_output=True, timeout=TIMEOUT)
    else:
        with tempfile.NamedTemporaryFile("r+", encoding="utf-8", delete=False) as tmp:
            output_path = tmp.name
        command = cmd + [
            "exec",
            "--skip-git-repo-check",
            "--model", MODEL,
            "-c", f'model_reasoning_effort="{REASONING}"',
            "--output-last-message", output_path,
        ]
        proc = subprocess.run(command, input=prompt, text=True, capture_output=True, timeout=TIMEOUT)
        if proc.returncode == 0:
            try:
                stdout = Path(output_path).read_text(encoding="utf-8")
            finally:
                Path(output_path).unlink(missing_ok=True)
            return parse_json_output(stdout)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or f"Codex exited {proc.returncode}")
    return parse_json_output(proc.stdout)


def parse_json_output(stdout: str) -> dict[str, Any]:
    text = stdout.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                pass
    raise ValueError("Codex output is not valid JSON: " + text[:2000])


def normalize_suggestion(raw: dict[str, Any], task_id: str, server_time: str) -> dict[str, Any]:
    rule_type = raw.get("ruleType") or "category"
    category_main = raw.get("categoryMain") or raw.get("catMain") or ""
    category_sub = raw.get("categorySub") or raw.get("catSub") or ""
    return {
        "id": "suggested_" + uuid.uuid4().hex,
        "taskId": task_id,
        "keyword": raw.get("keyword") or raw.get("merchant") or "",
        "matchType": raw.get("matchType") or "contains",
        "ruleType": rule_type,
        "categoryMain": category_main,
        "categorySub": category_sub,
        "catMain": category_main,
        "catSub": category_sub,
        "settlementPerson": raw.get("settlementPerson") or "",
        "settlementTypeHint": raw.get("settlementTypeHint") or "",
        "priority": int(raw.get("priority") or (80 if rule_type == "settlement_person" else 50)),
        "confidence": float(raw.get("confidence") or 0),
        "reason": raw.get("reason") or "",
        "status": "pending",
        "createdAt": server_time,
        "updatedAt": server_time,
        "deletedAt": None,
        "serverVersion": 0,
    }


def save_suggestions(conn: sqlite3.Connection, task_id: str, result: dict[str, Any]) -> int:
    server_time = now_iso()
    raw_rules = list(result.get("suggestedRules") or []) + list(result.get("settlementRules") or [])
    count = 0
    for raw in raw_rules:
        if not isinstance(raw, dict):
            continue
        suggestion = normalize_suggestion(raw, task_id, server_time)
        if not suggestion["keyword"]:
            continue
        upsert(conn, "suggested_rules", suggestion)
        count += 1
    return count


def run_one(task_id: str | None = None) -> int:
    with db() as conn:
        task = get_task(conn, task_id)
        if not task or task.get("status") in ("running", "completed"):
            return 0
        update_task(conn, task, "running")
    try:
        result = run_codex(task)
        with db() as conn:
            saved_count = save_suggestions(conn, task["id"], result)
            task["suggestedRuleCount"] = saved_count
            task["needsReview"] = result.get("needsReview") or []
            update_task(conn, task, "completed")
        return saved_count
    except Exception as exc:
        with db() as conn:
            task["rawError"] = str(exc)
            update_task(conn, task, "failed", compact_error(str(exc)))
        return 1


def compact_error(message: str, limit: int = 4000) -> str:
    if len(message) <= limit:
        return message
    half = max(500, limit // 2 - 40)
    return message[:half] + "\n...\n" + message[-half:]


if __name__ == "__main__":
    run_one(sys.argv[1] if len(sys.argv) > 1 else None)
