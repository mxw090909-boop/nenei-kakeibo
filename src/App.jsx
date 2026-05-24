import { useState, useEffect, useMemo } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import Papa from "papaparse";
import _ from "lodash";

/* ═══════════════════════════════════════════
   1. CONSTANTS
   ═══════════════════════════════════════════ */

const CATS = {
  food:    { name:"吃喝", icon:"🍜", color:"#e8985a", subs:["外食","コンビニ","スーパー","カフェ","デリバリー"] },
  transit: { name:"交通", icon:"🚃", color:"#6aabcf", subs:["電車・バス","タクシー","自転車","飛行機"] },
  housing: { name:"住居", icon:"🏠", color:"#7dab7d", subs:["家賃","光熱費","通信費","家具・家電"] },
  daily:   { name:"日用品", icon:"🧴", color:"#c9a84c", subs:["消耗品","洗濯・掃除","キッチン"] },
  medical: { name:"医疗", icon:"💊", color:"#d48ba6", subs:["病院","薬局","健康診断"] },
  travel:  { name:"旅行", icon:"✈️", color:"#5aafa8", subs:["宿泊","交通費","食費","アクティビティ","お土産"] },
  fashion: { name:"服饰美容", icon:"👗", color:"#a494c8", subs:["衣服","靴・バッグ","美容院","コスメ"] },
  fun:     { name:"娱乐", icon:"🎮", color:"#cf7563", subs:["書籍","映画・音楽","ゲーム","趣味"] },
  social:  { name:"社交", icon:"🥂", color:"#c47a82", subs:["飲み会","プレゼント","冠婚葬祭"] },
  admin:   { name:"行政", icon:"📋", color:"#8a95a3", subs:["税金","保険","手数料","ビザ・在留"] },
  other:   { name:"其他", icon:"📦", color:"#a39b91", subs:["未分類","雑費","ATM手数料"] },
};
const CAT_KEYS = Object.keys(CATS);
const PM_LIST = ["Olive","EPOS","PayPay","現金"];
const PM_COLORS = { Olive:"#4a9c6d", EPOS:"#7c5cbf", PayPay:"#e44e4e", "現金":"#c9a84c" };
const THEME_PRESETS = ["#d4736b", "#4a9c6d", "#6aabcf", "#7c5cbf", "#5aafa8", "#c9a84c"];

const NON_CONSUME_KW = [
  "返金","返品","キャンセル","取消","払戻","振込","送金","振替",
  "チャージ","入金","カード引落","口座引落","ATM","出金","引出",
  "クレジット支払","還付","ポイント交換"
];

/* ═══════════════════════════════════════════
   2. STORAGE ADAPTER
   ═══════════════════════════════════════════ */

const STORAGE_PREFIX = "nenei-kakeibo:";
const ASSET_DB_NAME = "nenei-kakeibo-assets";
const ASSET_STORE = "assets";
const SYNC_CLIENT_KEY = "syncClientId";
const SYNC_STATUS = {
  idle: "未配置",
  synced: "已同步",
  pending: "待同步",
  syncing: "同步中",
  error: "同步失败"
};

const createStorage = () => {
  const hasWS = typeof window !== "undefined" && window.storage;
  if (hasWS) return {
    get: async k => { try { const r = await window.storage.get(k); return r ? JSON.parse(r.value) : null } catch { return null } },
    set: async (k, v) => { try { await window.storage.set(k, JSON.stringify(v)) } catch(e) { console.error(e) } },
    del: async k => { try { await window.storage.delete(k) } catch(e) { console.error(e) } },
  };

  return {
    get: async k => {
      try {
        const raw = window.localStorage.getItem(STORAGE_PREFIX + k);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        console.warn("localStorage read failed", e);
        return null;
      }
    },
    set: async (k, v) => {
      try { window.localStorage.setItem(STORAGE_PREFIX + k, JSON.stringify(v)); }
      catch(e) { console.error("localStorage write failed", e); }
    },
    del: async k => {
      try { window.localStorage.removeItem(STORAGE_PREFIX + k); }
      catch(e) { console.error("localStorage delete failed", e); }
    },
  };
};
const db = createStorage();

const getSyncClientId = async () => {
  let clientId = await db.get(SYNC_CLIENT_KEY);
  if (!clientId) {
    clientId = `client_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,10)}`;
    await db.set(SYNC_CLIENT_KEY, clientId);
  }
  return clientId;
};

const apiUrl = (base, path) => `${String(base || "").replace(/\/+$/, "")}${path}`;

const syncFetch = async (config, path, options = {}) => {
  if (!config?.url || !config?.token) throw new Error("请先填写 VPS API URL 和 Token");
  const res = await fetch(apiUrl(config.url, path), {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.token}`,
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
};

const loadLocalCache = async () => ({
  transactions: (await db.get("txns")) || [],
  rules: (await db.get("rules")) || [],
  settings: {
    darkMode: await db.get("darkMode"),
    themeColor: await db.get("themeColor"),
    bgUrl: await db.get("bgUrl"),
    bgImage: await db.get("bgImage"),
    bgBlur: await db.get("bgBlur"),
    bgOverlay: await db.get("bgOverlay"),
    fontSize: await db.get("fontSize"),
    csvEncoding: await db.get("csvEncoding")
  },
  lastPulledAt: await db.get("syncLastPulledAt")
});

const saveLocalCache = async ({ transactions, rules, settings = {} }) => {
  if (transactions) await db.set("txns", transactions);
  if (rules) await db.set("rules", rules);
  await Promise.all(Object.entries(settings).filter(([,v]) => v !== undefined && v !== null).map(([k,v]) => db.set(k, v)));
};

const markPendingSync = record => ({
  ...record,
  pendingSync: true,
  updatedAt: record.updatedAt || new Date().toISOString()
});

const resolveConflict = (local, remote) => {
  if (!local) return remote;
  if (!remote) return local;
  return String(remote.updatedAt || "") > String(local.updatedAt || "") ? remote : local;
};

const mergeByUpdatedAt = (localItems = [], remoteItems = [], normalizer = x => x) => {
  const map = new Map();
  localItems.forEach(item => { if (item?.id) map.set(item.id, item); });
  remoteItems.forEach(item => {
    if (!item?.id) return;
    map.set(item.id, resolveConflict(map.get(item.id), { ...item, pendingSync:false, syncedAt:item.syncedAt || new Date().toISOString() }));
  });
  return Array.from(map.values()).filter(item => !item.deletedAt).map(normalizer);
};

const mergeSuggestedRules = (localItems = [], remoteItems = []) =>
  mergeByUpdatedAt(localItems, remoteItems).filter(r => !r.deletedAt && r.status !== "accepted" && r.status !== "rejected");

const pullFromVps = (config, since = "") =>
  syncFetch(config, `/api/kakeibo/sync/pull?since=${encodeURIComponent(since || "")}`);

const pushToVps = (config, payload) =>
  syncFetch(config, "/api/kakeibo/sync/push", { method:"POST", body:JSON.stringify(payload) });

const fetchClassifySummary = config =>
  syncFetch(config, "/api/kakeibo/classify/summary");

const createClassifyTask = (config, payload = {}) =>
  syncFetch(config, "/api/kakeibo/classify-tasks", { method:"POST", body:JSON.stringify(payload) });

const fetchClassifyTask = (config, taskId) =>
  syncFetch(config, `/api/kakeibo/classify-tasks/${encodeURIComponent(taskId)}`);

const runClassifyTask = (config, taskId) =>
  syncFetch(config, `/api/kakeibo/classify-tasks/${encodeURIComponent(taskId)}/run`, { method:"POST", body:"{}" });

const confirmSuggestedRules = (config, payload) =>
  syncFetch(config, "/api/kakeibo/suggested-rules/confirm", { method:"POST", body:JSON.stringify(payload) });

const applyCloudRules = (config, payload = {}) =>
  syncFetch(config, "/api/kakeibo/rules/apply", { method:"POST", body:JSON.stringify(payload) });

const collectUnknownMerchants = (transactions = []) => {
  const grouped = _.groupBy(
    transactions.filter(t => !t.deletedAt && !t.excludedFromStats && !t.categoryMain && cleanText(t.merchant)),
    t => `${cleanText(t.merchant)}|${t.paymentMethod || ""}`
  );
  return Object.values(grouped).map(items => {
    const sorted = _.orderBy(items, ["date"], ["asc"]);
    const first = sorted[0], last = sorted[sorted.length - 1];
    return {
      id: `${cleanText(first.merchant).toLowerCase()}|${first.paymentMethod || ""}`,
      merchant: cleanText(first.merchant),
      paymentMethod: first.paymentMethod || "",
      count: items.length,
      totalAmount: _.sumBy(items, statAmount),
      firstSeen: first.date,
      lastSeen: last.date,
      sampleMemos: _.uniq(items.map(t => cleanText(t.memo)).filter(Boolean)).slice(0, 5),
      updatedAt: new Date().toISOString()
    };
  });
};

const assetDb = {
  open: () => new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB unavailable")); return; }
    const req = indexedDB.open(ASSET_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains(ASSET_STORE)) database.createObjectStore(ASSET_STORE, { keyPath:"id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }),
  save: async (data, id = `asset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`) => {
    const database = await assetDb.open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(ASSET_STORE, "readwrite");
      tx.objectStore(ASSET_STORE).put({ id, data });
      tx.oncomplete = () => resolve(id);
      tx.onerror = () => reject(tx.error);
    });
  },
  get: async id => {
    const database = await assetDb.open();
    return new Promise((resolve, reject) => {
      const req = database.transaction(ASSET_STORE, "readonly").objectStore(ASSET_STORE).get(id);
      req.onsuccess = () => resolve(req.result?.data || "");
      req.onerror = () => reject(req.error);
    });
  },
  sync: async (assets = []) => {
    if (!Array.isArray(assets) || !assets.length) return;
    await Promise.all(assets.filter(a => a?.id && a?.data).map(a => assetDb.save(a.data, a.id)));
  }
};

/* ═══════════════════════════════════════════
   3. UTILITIES
   ═══════════════════════════════════════════ */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,8);
const fmtAmt = n => "¥" + Math.abs(Number(n || 0)).toLocaleString();
const fmtDate = d => { const [y,m,dd] = String(d || "").split("-"); return m && dd ? `${parseInt(m)}/${parseInt(dd)}` : "-" };
const fmtMonth = m => { const [y,mo] = String(m || "").split("-"); return `${y}年${parseInt(mo)}月` };
const today = () => new Date().toISOString().slice(0,10);
const getMonth = d => String(d || "").slice(0,7);
const weekday = d => ["日","月","火","水","木","金","土"][new Date(d).getDay()];

const shiftMonth = (m, delta) => {
  const [y,mo] = m.split("-").map(Number);
  const dt = new Date(y, mo - 1 + delta, 1);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}`;
};

const cleanText = v => String(v ?? "").replace(/^\ufeff/, "").trim();

const hexToRgb = hex => {
  const raw = String(hex || "").replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return [212, 115, 107];
  return [parseInt(raw.slice(0,2), 16), parseInt(raw.slice(2,4), 16), parseInt(raw.slice(4,6), 16)];
};

const isAssetId = value => typeof value === "string" && /^asset_[a-z0-9_]+$/i.test(value);

const readFileAsDataUrl = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || ""));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});

const highlightText = (text, query) => {
  const source = String(text || "");
  const q = cleanText(query);
  if (!q) return source;
  const idx = source.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return source;
  return (
    <>
      {source.slice(0, idx)}
      <mark className="rounded px-0.5" style={{background:"rgba(var(--accent-rgb),0.2)",color:"var(--accent)"}}>
        {source.slice(idx, idx + q.length)}
      </mark>
      {source.slice(idx + q.length)}
    </>
  );
};

const pick = (row, names) => {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== "") return row[name];
  }
  return "";
};

const parseAmount = value => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value ?? "").trim();
  if (!raw) return NaN;
  const normalized = raw
    .replace(/[￥¥円,，\s]/g, "")
    .replace(/[▲△]/g, "-")
    .replace(/^\((.*)\)$/, "-$1");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : NaN;
};

const parseOptionalAmount = value => {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "-" || raw === "－") return NaN;
  return parseAmount(raw);
};

const normalizeDate = value => {
  let raw = String(value ?? "").trim();
  if (!raw) return "";
  raw = raw.replace(/^\ufeff/, "").split(/[ T]/)[0].replace(/[年月.\/]/g, "-").replace(/日$/, "");
  const digits = raw.replace(/-/g, "");

  let y, m, d;
  if (/^\d{8}$/.test(digits)) {
    y = digits.slice(0,4); m = digits.slice(4,6); d = digits.slice(6,8);
  } else if (/^\d{6}$/.test(digits)) {
    y = Number(digits.slice(0,2)) >= 70 ? `19${digits.slice(0,2)}` : `20${digits.slice(0,2)}`;
    m = digits.slice(2,4); d = digits.slice(4,6);
  } else {
    const parts = raw.split("-").filter(Boolean);
    if (parts.length < 3) return "";
    y = parts[0].length === 2 ? (Number(parts[0]) >= 70 ? `19${parts[0]}` : `20${parts[0]}`) : parts[0];
    m = parts[1]; d = parts[2];
  }

  const yy = Number(y), mm = Number(m), dd = Number(d);
  const dt = new Date(yy, mm - 1, dd);
  if (dt.getFullYear() !== yy || dt.getMonth() !== mm - 1 || dt.getDate() !== dd) return "";
  return `${yy}-${String(mm).padStart(2,"0")}-${String(dd).padStart(2,"0")}`;
};

const detectTxnType = (merchant, memo, amount) => {
  const txt = `${merchant} ${memo}`.toLowerCase();
  if (["返金","返品","キャンセル","取消","払戻","還付"].some(kw => txt.includes(kw.toLowerCase())) || amount < 0) return "refund";
  if (["チャージ","入金","残高追加"].some(kw => txt.includes(kw.toLowerCase()))) return "charge";
  if (["振込","送金","振替","カード引落","口座引落","クレジット支払","引落"].some(kw => txt.includes(kw.toLowerCase()))) return "transfer";
  if (["ATM","出金","引出"].some(kw => txt.includes(kw.toLowerCase()))) return "excluded";
  return "expense";
};

const detectNonConsume = (merchant, memo, amount = 0) => detectTxnType(merchant, memo, amount) !== "expense";

const settlementLabel = {
  none: "普通",
  advance: "代付",
  repayment: "还款",
  aa_payment: "AA付款"
};

const statusLabel = {
  none: "无",
  pending: "待确认",
  matched: "已绑定",
  ignored: "已忽略"
};

const settlementTypeFromTxn = (txn = {}) => {
  if (txn.settlementType) return txn.settlementType;
  if (txn.type === "repayment") return "repayment";
  if (txn.type === "aa_payment") return "aa_payment";
  return "none";
};

const normalizeTxnSettlement = (txn = {}) => {
  const amount = Math.abs(Number(txn.amount || 0));
  const settlementType = settlementTypeFromTxn(txn);
  const originalAmount = Math.abs(Number(txn.originalAmount ?? amount));
  const offsetAmount = Math.max(0, Number(txn.offsetAmount ?? 0));
  const effectiveAmount = Math.max(0, Number(txn.effectiveAmount ?? (settlementType === "repayment" ? 0 : originalAmount - offsetAmount)));
  const settlementStatus = txn.settlementStatus || (settlementType === "none" ? "none" : "pending");
  return {
    ...txn,
    amount,
    settlementType,
    settlementPerson: txn.settlementPerson || "",
    linkedTransactionId: txn.linkedTransactionId || "",
    originalAmount,
    offsetAmount,
    effectiveAmount,
    settlementStatus,
    createdAt: txn.createdAt || new Date().toISOString(),
    updatedAt: txn.updatedAt || new Date().toISOString(),
    deletedAt: txn.deletedAt || null,
    serverVersion: Number(txn.serverVersion || 0)
  };
};

const statAmount = txn => Math.max(0, Number(txn?.effectiveAmount ?? txn?.amount ?? 0));

const normalizeRule = (rule = {}) => ({
  ...rule,
  id: rule.id || uid(),
  createdAt: rule.createdAt || new Date().toISOString(),
  updatedAt: rule.updatedAt || new Date().toISOString(),
  deletedAt: rule.deletedAt || null,
  serverVersion: Number(rule.serverVersion || 0)
});

const txnKey = t => `${t.date}|${Number(t.amount)}|${cleanText(t.merchant).toLowerCase()}|${t.paymentMethod}`;

const matchRules = (rules, txn) => {
  const sorted = _.orderBy(rules.filter(r => r.enabled), ["priority"], ["desc"]);
  for (const r of sorted) {
    if (r.pmCondition && r.pmCondition !== txn.paymentMethod) continue;
    const txt = (txn.merchant + " " + (txn.memo||"")).toLowerCase();
    const kw = cleanText(r.keyword).toLowerCase();
    if (!kw) continue;
    if (r.matchType === "exact" ? txt === kw : txt.includes(kw)) return r;
  }
  return null;
};

/* ═══════════════════════════════════════════
   4. CSV PARSERS
   ═══════════════════════════════════════════ */

const detectSource = (headers) => {
  const hs = headers.map(s => cleanText(s));
  const has = (...names) => names.every(name => hs.includes(name));
  const h = hs.join(",");
  if (
    has("取引日", "出金金額（円）") ||
    has("取引日", "入金金額（円）") ||
    has("取引内容", "取引先", "取引方法")
  ) return "PayPay";
  if (h.includes("PayPay") || h.includes("取引種別") || h.includes("取引日時")) return "PayPay";
  if (h.includes("EPOS") || h.includes("エポス") || h.includes("ご利用店名")) return "EPOS";
  return "Olive";
};

const normalizeRow = (row) => {
  const out = {};
  Object.entries(row || {}).forEach(([k, v]) => { out[cleanText(k)] = typeof v === "string" ? cleanText(v) : v; });
  return out;
};

const parseCSV = (text, batchId, rules) => {
  const result = Papa.parse(text, { header:true, skipEmptyLines:"greedy", dynamicTyping:false, delimitersToGuess:[",","\t",";"] });
  const rows = (result.data || []).map(normalizeRow).filter(row => Object.values(row).some(v => cleanText(v)));
  if (!rows.length) return { txns: [], errors: [{ message:"CSV にデータがありません" }], source:"Unknown" };

  const headers = Object.keys(rows[0]);
  const src = detectSource(headers);
  const now = new Date().toISOString();
  const errors = [];

  const txns = rows.map((row, idx) => {
    let dateRaw, merchant, amountRaw, memo, signedAmount, direction = "";
    const rawStr = JSON.stringify(row);

    if (src === "PayPay") {
      dateRaw = pick(row, ["取引日", "取引日時", "日時", "日付", "利用日"]);
      merchant = pick(row, ["取引先", "店舗名", "加盟店名", "内容"]);
      memo = pick(row, ["取引内容", "取引方法", "備考", "メモ"]);
      const outRaw = pick(row, ["出金金額（円）", "出金金額", "支払金額", "金額(税込)", "金額"]);
      const inRaw = pick(row, ["入金金額（円）", "入金金額", "受取金額"]);
      const outAmount = parseOptionalAmount(outRaw);
      const inAmount = parseOptionalAmount(inRaw);
      if (Number.isFinite(outAmount)) {
        signedAmount = outAmount;
        amountRaw = outRaw;
        direction = "out";
      } else if (Number.isFinite(inAmount)) {
        signedAmount = -inAmount;
        amountRaw = inRaw;
        direction = "in";
      }
    } else if (src === "EPOS") {
      dateRaw = pick(row, ["ご利用日", "利用日", "日付"]);
      merchant = pick(row, ["ご利用店名", "利用店名", "ご利用先", "店名"]);
      amountRaw = pick(row, ["ご利用金額", "利用金額", "金額"]);
      memo = pick(row, ["備考", "支払区分", "メモ"]);
    } else {
      dateRaw = pick(row, ["利用日", "ご利用日", "日付", "取引日", "年月日"]);
      merchant = pick(row, ["利用先", "ご利用先", "店名", "加盟店名", "摘要", "内容"]);
      amountRaw = pick(row, ["利用金額", "金額", "出金額", "支払金額"]);
      memo = pick(row, ["備考", "メモ", "摘要", "内容"]);
    }

    const date = normalizeDate(dateRaw);
    if (signedAmount === undefined) signedAmount = parseAmount(amountRaw);
    if (!date || !Number.isFinite(signedAmount)) {
      errors.push({ row: idx + 2, message: `日付または金額を解析できません`, raw: rawStr });
      return null;
    }

    let type = detectTxnType(merchant, memo, signedAmount);
    let excludedFromStats = type !== "expense";
    if (src === "PayPay") {
      const memoText = cleanText(memo);
      if (direction === "in" && memoText.includes("受け取った金額")) {
        type = "repayment";
        excludedFromStats = true;
      } else if (direction === "in" && memoText.includes("ポイント、残高の獲得")) {
        type = "excluded";
        excludedFromStats = true;
      } else if (direction === "out" && memoText.includes("支払い")) {
        type = "expense";
        excludedFromStats = false;
      } else if (direction === "out" && memoText.includes("送金")) {
        type = "aa_payment";
        excludedFromStats = false;
      } else if (direction === "in") {
        type = "transfer";
        excludedFromStats = true;
      }
    }
    const txn = {
      id: uid(), date, amount: Math.abs(signedAmount), merchant: cleanText(merchant) || cleanText(memo) || "未記入",
      memo: cleanText(memo), categoryMain: "", categorySub: "",
      paymentMethod: src === "PayPay" ? "PayPay" : src === "EPOS" ? "EPOS" : "Olive",
      source: src, importBatchId: batchId, raw: rawStr, direction,
      type, excludedFromStats,
      createdAt: now, updatedAt: now,
    };
    const settlementType = type === "repayment" ? "repayment" : type === "aa_payment" ? "aa_payment" : "none";
    Object.assign(txn, normalizeTxnSettlement({
      ...txn,
      settlementType,
      settlementPerson: settlementType === "none" ? "" : txn.merchant,
      settlementStatus: type === "excluded" ? "ignored" : settlementType === "none" ? "none" : "pending",
      effectiveAmount: settlementType === "repayment" ? 0 : txn.amount
    }));

    const rule = matchRules(rules, txn);
    if (rule) { txn.categoryMain = rule.catMain; txn.categorySub = rule.catSub; }
    return txn;
  }).filter(Boolean);

  return { txns, errors, source: src };
};

const findDuplicates = (newTxns, existing) => {
  return newTxns.filter(n => existing.some(e => txnKey(e) === txnKey(n)));
};

const decodeFile = async (file, preferredEncoding = "auto") => {
  const buffer = await file.arrayBuffer();
  const decode = (enc) => new TextDecoder(enc, { fatal:false }).decode(buffer);
  if (preferredEncoding !== "auto") return { text: decode(preferredEncoding), encoding: preferredEncoding };

  const utf8 = decode("utf-8");
  const sjis = decode("shift-jis");
  const badness = s => (s.match(/�/g) || []).length;
  return badness(sjis) < badness(utf8) ? { text: sjis, encoding:"shift-jis" } : { text: utf8, encoding:"utf-8" };
};

/* ═══════════════════════════════════════════
   5. UI COMPONENTS
   ═══════════════════════════════════════════ */

const Modal = ({ open, onClose, title, children }) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={onClose}>
      <div className="absolute inset-0" style={{background:"rgba(0,0,0,0.35)",backdropFilter:"blur(4px)"}} />
      <div onClick={e=>e.stopPropagation()} className="relative w-full max-w-lg rounded-t-3xl overflow-hidden"
        style={{background:"var(--card)",maxHeight:"85vh",display:"flex",flexDirection:"column"}}>
        <div className="flex items-center justify-between px-5 py-4" style={{borderBottom:"1px solid var(--border)"}}>
          <h3 className="text-lg font-semibold" style={{color:"var(--text)"}}>{title}</h3>
          <button onClick={onClose} className="text-2xl leading-none" style={{color:"var(--text2)"}}>×</button>
        </div>
        <div className="overflow-y-auto px-5 py-4 flex-1">{children}</div>
      </div>
    </div>
  );
};

const Pill = ({ text, color, small }) => (
  <span className={`inline-block rounded-full font-medium ${small ? "text-xs px-2 py-0.5" : "text-sm px-3 py-1"}`}
    style={{background: color+"22", color}}>{text}</span>
);

const Select = ({ value, onChange, options, placeholder }) => (
  <select value={value} onChange={e=>onChange(e.target.value)}
    className="w-full rounded-xl px-3 py-2.5 text-sm outline-none"
    style={{background:"var(--input)",color:"var(--text)",border:"1px solid var(--border)"}}>
    {placeholder && <option value="">{placeholder}</option>}
    {options.map(o => <option key={typeof o==="string"?o:o.v} value={typeof o==="string"?o:o.v}>
      {typeof o==="string"?o:o.l}</option>)}
  </select>
);

const Input = ({ value, onChange, placeholder, type="text", ...rest }) => (
  <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
    className="w-full min-w-0 rounded-xl px-3 py-2.5 text-sm outline-none"
    style={{background:"var(--input)",color:"var(--text)",border:"1px solid var(--border)",boxSizing:"border-box",maxWidth:"100%"}} {...rest} />
);

const Btn = ({ children, onClick, primary, danger, small, disabled, className="" }) => (
  <button onClick={onClick} disabled={disabled}
    className={`rounded-xl font-medium transition-all active:scale-95 ${small?"text-xs px-3 py-1.5":"text-sm px-4 py-2.5"} ${className}`}
    style={{
      background: danger ? "#e44e4e" : primary ? "var(--accent)" : "var(--input)",
      color: primary || danger ? "#fff" : "var(--text)",
      opacity: disabled ? 0.5 : 1, border: primary||danger ? "none" : "1px solid var(--border)"
    }}>{children}</button>
);

const Range = ({ value, onChange, min, max, step }) => (
  <input type="range" value={value} min={min} max={max} step={step}
    onChange={e=>onChange(Number(e.target.value))}
    className="w-full h-1 rounded-lg appearance-none cursor-pointer"
    style={{accentColor:"var(--accent)",background:"var(--border)"}} />
);

const CatPicker = ({ main, sub, onMainChange, onSubChange }) => (
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
    <div>
      <Select value={main} onChange={v => { onMainChange(v); onSubChange("") }}
        placeholder="大类" options={CAT_KEYS.map(k => ({v:k, l:CATS[k].icon+" "+CATS[k].name}))} />
    </div>
    <div>
      <Select value={sub} onChange={onSubChange} placeholder="子类"
        options={main && CATS[main] ? CATS[main].subs : []} />
    </div>
  </div>
);

/* ═══════════════════════════════════════════
   6. MAIN APP
   ═══════════════════════════════════════════ */

export default function App() {
  const [darkMode, setDarkMode] = useState("light");
  const [systemDark, setSystemDark] = useState(false);
  const [tab, setTab] = useState("dash");
  const [month, setMonth] = useState(() => {
    const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
  });
  const [txns, setTxns] = useState([]);
  const [rules, setRules] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [themeColor, setThemeColor] = useState("#d4736b");
  const [bgUrl, setBgUrl] = useState("");
  const [bgImage, setBgImage] = useState("");
  const [bgImageData, setBgImageData] = useState("");
  const [bgBlur, setBgBlur] = useState(0);
  const [bgOverlay, setBgOverlay] = useState(0.78);
  const [fontSize, setFontSize] = useState(16);
  const [syncUrl, setSyncUrl] = useState("");
  const [syncToken, setSyncToken] = useState("");
  const [syncStatus, setSyncStatus] = useState("idle");
  const [syncError, setSyncError] = useState("");
  const [lastSyncAt, setLastSyncAt] = useState("");
  const [lastPulledAt, setLastPulledAt] = useState("");
  const [suggestedRules, setSuggestedRules] = useState([]);
  const [settingsPendingSync, setSettingsPendingSync] = useState(false);
  const [classifySummary, setClassifySummary] = useState(null);
  const [classifyTask, setClassifyTask] = useState(null);
  const [classifyStatus, setClassifyStatus] = useState("idle");
  const [classifyError, setClassifyError] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  
  // Modals
  const [editId, setEditId] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [skipDupes, setSkipDupes] = useState(true);
  const [csvEncoding, setCsvEncoding] = useState("auto");
  const [ruleEdit, setRuleEdit] = useState(null);
  const [drillCat, setDrillCat] = useState(null);
  
  // Filters
  const [fCat, setFCat] = useState("");
  const [fSub, setFSub] = useState("");
  const [fPm, setFPm] = useState("");
  const [fKw, setFKw] = useState("");
  const [fUncat, setFUncat] = useState(false);
  
  // Manual entry
  const [mDate, setMDate] = useState(today());
  const [mAmt, setMAmt] = useState("");
  const [mMerch, setMMerch] = useState("");
  const [mMemo, setMMemo] = useState("");
  const [mCatM, setMCatM] = useState("");
  const [mCatS, setMCatS] = useState("");

  // Load
  useEffect(() => {
    (async () => {
      const cache = await loadLocalCache();
      if (cache.transactions) setTxns(cache.transactions.map(normalizeTxnSettlement));
      if (cache.rules) setRules(cache.rules.map(normalizeRule));
      const dm = cache.settings.darkMode;
      if (dm) setDarkMode(dm);
      else {
        const d = await db.get("dark");
        if (d !== null) setDarkMode(d ? "dark" : "light");
      }
      const tc = cache.settings.themeColor; if (tc) setThemeColor(tc);
      const bu = cache.settings.bgUrl; if (bu) setBgUrl(bu);
      const bi = cache.settings.bgImage; if (bi) setBgImage(bi);
      const bb = cache.settings.bgBlur; if (bb !== null && bb !== undefined) setBgBlur(bb);
      const bo = cache.settings.bgOverlay; if (bo !== null && bo !== undefined) setBgOverlay(bo);
      const fs = cache.settings.fontSize; if (fs !== null && fs !== undefined) setFontSize(fs);
      const ce = cache.settings.csvEncoding; if (ce) setCsvEncoding(ce);
      const su = await db.get("syncUrl"); if (su) setSyncUrl(su);
      const st = await db.get("syncToken"); if (st) setSyncToken(st);
      const lsa = await db.get("syncLastSyncAt"); if (lsa) setLastSyncAt(lsa);
      if (cache.lastPulledAt) setLastPulledAt(cache.lastPulledAt);
      const sr = await db.get("suggestedRules"); if (Array.isArray(sr)) setSuggestedRules(sr);
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setSystemDark(mq.matches);
    sync();
    mq.addEventListener?.("change", sync);
    return () => mq.removeEventListener?.("change", sync);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!isAssetId(bgImage)) { setBgImageData(bgImage || ""); return; }
      try {
        const data = await assetDb.get(bgImage);
        if (alive) setBgImageData(data);
      } catch (e) {
        console.warn("Background asset load failed", e);
        if (alive) setBgImageData("");
      }
    })();
    return () => { alive = false; };
  }, [bgImage]);

  // Save
  useEffect(() => { if (loaded) db.set("txns", txns) }, [txns, loaded]);
  useEffect(() => { if (loaded) db.set("rules", rules) }, [rules, loaded]);
  useEffect(() => { if (loaded) db.set("darkMode", darkMode) }, [darkMode, loaded]);
  useEffect(() => { if (loaded) db.set("themeColor", themeColor) }, [themeColor, loaded]);
  useEffect(() => { if (loaded) db.set("bgUrl", bgUrl) }, [bgUrl, loaded]);
  useEffect(() => { if (loaded) db.set("bgImage", bgImage) }, [bgImage, loaded]);
  useEffect(() => { if (loaded) db.set("bgBlur", bgBlur) }, [bgBlur, loaded]);
  useEffect(() => { if (loaded) db.set("bgOverlay", bgOverlay) }, [bgOverlay, loaded]);
  useEffect(() => { if (loaded) db.set("fontSize", fontSize) }, [fontSize, loaded]);
  useEffect(() => { if (loaded) db.set("csvEncoding", csvEncoding) }, [csvEncoding, loaded]);
  useEffect(() => { if (loaded) db.set("syncUrl", syncUrl) }, [syncUrl, loaded]);
  useEffect(() => { if (loaded) db.set("syncToken", syncToken) }, [syncToken, loaded]);
  useEffect(() => { if (loaded) db.set("syncLastSyncAt", lastSyncAt) }, [lastSyncAt, loaded]);
  useEffect(() => { if (loaded) db.set("syncLastPulledAt", lastPulledAt) }, [lastPulledAt, loaded]);
  useEffect(() => { if (loaded) db.set("suggestedRules", suggestedRules) }, [suggestedRules, loaded]);

  // Computed
  const activeRules = useMemo(() => rules.filter(r => !r.deletedAt), [rules]);
  const monthTxns = useMemo(() => txns.filter(t => !t.deletedAt && getMonth(t.date) === month), [txns, month]);
  const statsTxns = useMemo(() => monthTxns.filter(t => !t.excludedFromStats && statAmount(t) > 0), [monthTxns]);
  const prevMonth = shiftMonth(month, -1);
  const prevStatsTxns = useMemo(() => txns.filter(t => !t.deletedAt && getMonth(t.date) === prevMonth && !t.excludedFromStats && statAmount(t) > 0), [txns, prevMonth]);
  const pendingSyncCount = useMemo(() =>
    txns.filter(t => t.pendingSync).length + rules.filter(r => r.pendingSync).length + (settingsPendingSync ? 1 : 0)
  , [txns, rules, settingsPendingSync]);
  
  const totalSpend = useMemo(() => _.sumBy(statsTxns, statAmount), [statsTxns]);
  const prevTotal = useMemo(() => _.sumBy(prevStatsTxns, statAmount), [prevStatsTxns]);
  const daysInMonth = new Date(+month.split("-")[0], +month.split("-")[1], 0).getDate();
  const dailyAvg = Math.round(totalSpend / (daysInMonth || 1));
  const maxTxn = useMemo(() => _.maxBy(statsTxns, statAmount), [statsTxns]);
  const uncatCount = useMemo(() => statsTxns.filter(t => !t.categoryMain).length, [statsTxns]);
  const changePercent = prevTotal ? Math.round((totalSpend - prevTotal) / prevTotal * 100) : null;

  const catData = useMemo(() => {
    const grouped = _.groupBy(statsTxns.filter(t=>t.categoryMain), "categoryMain");
    return CAT_KEYS.map(k => ({
      key: k, name: CATS[k].icon+" "+CATS[k].name, value: _.sumBy(grouped[k]||[], statAmount), color: CATS[k].color, count: (grouped[k]||[]).length
    })).filter(d => d.value > 0).sort((a,b) => b.value - a.value);
  }, [statsTxns]);

  const pmData = useMemo(() => {
    const grouped = _.groupBy(statsTxns, "paymentMethod");
    return PM_LIST.map(pm => ({ name:pm, value: _.sumBy(grouped[pm]||[], statAmount), color: PM_COLORS[pm] })).filter(d=>d.value>0);
  }, [statsTxns]);

  const filteredTxns = useMemo(() => {
    let list = monthTxns;
    if (fCat) list = list.filter(t => t.categoryMain === fCat);
    if (fSub) list = list.filter(t => t.categorySub === fSub);
    if (fPm) list = list.filter(t => t.paymentMethod === fPm);
    if (fKw) { const kw = fKw.toLowerCase(); list = list.filter(t => (t.merchant+t.memo).toLowerCase().includes(kw)); }
    if (fUncat) list = list.filter(t => !t.categoryMain);
    return _.orderBy(list, ["date","createdAt"], ["desc","desc"]);
  }, [monthTxns, fCat, fSub, fPm, fKw, fUncat]);

  const groupedTxns = useMemo(() => {
    const groups = _.groupBy(filteredTxns, "date");
    return Object.entries(groups).sort((a,b) => b[0].localeCompare(a[0])).map(([date, items]) => ({
      date, weekday: weekday(date), total: _.sumBy(items.filter(t => !t.excludedFromStats), statAmount), items
    }));
  }, [filteredTxns]);

  // Actions
  const updateTxn = (id, patch) => {
    setTxns(prev => prev.map(t => t.id === id ? normalizeTxnSettlement(markPendingSync({...t, ...patch, updatedAt: new Date().toISOString()})) : t));
  };

  const handleImport = async (file) => {
    try {
      const { text, encoding } = await decodeFile(file, csvEncoding);
      const batchId = uid();
      const parsed = parseCSV(text, batchId, activeRules);
      if (!parsed.txns.length) {
        alert(parsed.errors?.length ? `未能解析交易记录：${parsed.errors[0].message}` : "未能解析任何交易记录");
        return;
      }
      const dupes = findDuplicates(parsed.txns, txns.filter(t => !t.deletedAt));
      const dupeKeys = new Set(dupes.map(txnKey));
      const dates = parsed.txns.map(t=>t.date).filter(Boolean).sort();
      setSkipDupes(true);
      setImportPreview({
        txns: parsed.txns.map(t => ({ ...t, isDuplicate: dupeKeys.has(txnKey(t)) })), batchId,
        source: parsed.source || parsed.txns[0]?.source || "Unknown",
        encoding,
        dateRange: dates.length ? `${fmtDate(dates[0])} ~ ${fmtDate(dates[dates.length-1])}` : "-",
        count: parsed.txns.length,
        total: _.sumBy(parsed.txns.filter(t => !t.excludedFromStats), statAmount),
        uncatCount: parsed.txns.filter(t => !t.categoryMain && !t.excludedFromStats).length,
        excludedCount: parsed.txns.filter(t => t.excludedFromStats).length,
        dupeCount: dupes.length,
        errorCount: parsed.errors?.length || 0,
        sample: parsed.txns.slice(0, 8),
      });
    } catch (e) {
      console.error(e);
      alert("读取 CSV 失败，请确认文件格式");
    }
  };

  const confirmImport = () => {
    if (!importPreview) return;
    const importing = skipDupes ? importPreview.txns.filter(t => !t.isDuplicate) : importPreview.txns;
    setTxns(prev => [...prev, ...importing.map(({isDuplicate, ...t}) => markPendingSync(t))]);
    setImportPreview(null);
  };

  const undoImport = (batchId) => {
    if (!confirm("确定撤销此次导入？")) return;
    const now = new Date().toISOString();
    setTxns(prev => prev.map(t => t.importBatchId === batchId ? markPendingSync({...t, deletedAt:now, updatedAt:now}) : t));
  };

  const addManual = () => {
    const parsedAmt = parseAmount(mAmt);
    if (!Number.isFinite(parsedAmt) || !mDate) return;
    const txn = {
      id: uid(), date: mDate, amount: Math.abs(parsedAmt), merchant: mMerch.trim(), memo: mMemo.trim(),
      categoryMain: mCatM, categorySub: mCatS, paymentMethod: "現金",
      source: "manual", importBatchId: "", raw: "",
      type: "expense", excludedFromStats: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    Object.assign(txn, normalizeTxnSettlement(markPendingSync(txn)));
    setTxns(prev => [...prev, txn]);
    setMAmt(""); setMMerch(""); setMMemo(""); setMCatM(""); setMCatS("");
  };

  const exportData = async () => {
    const assets = [];
    if (isAssetId(bgImage)) {
      try {
        const data = await assetDb.get(bgImage);
        if (data) assets.push({ id:bgImage, data });
      } catch (e) {
        console.warn("Background asset export failed", e);
      }
    }
    const payload = {
      version: 2,
      exportedAt: new Date().toISOString(),
      txns,
      rules,
      appearance: { darkMode, themeColor, bgUrl, bgImage, bgBlur, bgOverlay, fontSize },
      assets
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type:"application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nenei-kakeibo-${today()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importBackup = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const source = payload.data || payload;
      if (!source || typeof source !== "object") throw new Error("备份格式不正确");
      if (!confirm("导入备份会覆盖当前账本和外观设置。确定继续？")) return;
      await assetDb.sync(payload.assets || source.assets || []);
      setTxns(Array.isArray(source.txns) ? source.txns.map(normalizeTxnSettlement) : []);
      setRules(Array.isArray(source.rules) ? source.rules.map(normalizeRule) : []);
      const ap = source.appearance || {};
      setDarkMode(ap.darkMode || (ap.dark ? "dark" : "light"));
      setThemeColor(ap.themeColor || "#d4736b");
      setBgUrl(ap.bgUrl || "");
      setBgImage(ap.bgImage || "");
      setBgBlur(Number(ap.bgBlur || 0));
      setBgOverlay(Number(ap.bgOverlay ?? 0.78));
      setFontSize(Number(ap.fontSize || 16));
    } catch (e) {
      console.error(e);
      alert("导入失败：" + e.message);
    }
  };

  const uploadBackground = async (file) => {
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const id = await assetDb.save(dataUrl);
      setBgImage(id);
      setBgImageData(dataUrl);
      setBgUrl("");
      setSettingsPendingSync(true);
    } catch (e) {
      console.error(e);
      alert("背景图保存失败");
    }
  };

  const clearBackground = () => { setBgUrl(""); setBgImage(""); setSettingsPendingSync(true); };

  const saveRule = (rule) => {
    const now = new Date().toISOString();
    if (rule.id) {
      setRules(prev => prev.map(r => r.id === rule.id ? markPendingSync(normalizeRule({...rule, updatedAt:now})) : r));
    } else {
      setRules(prev => [...prev, markPendingSync(normalizeRule({ ...rule, id: uid(), createdAt:now, updatedAt:now, deletedAt:null, serverVersion:0 }))]);
    }
    setRuleEdit(null);
  };

  const applyRulesToHistory = (rule) => {
    setTxns(prev => prev.map(t => {
      if (t.categoryMain) return t;
      const txt = (t.merchant + " " + (t.memo||"")).toLowerCase();
      const kw = rule.keyword.toLowerCase();
      const match = rule.matchType === "exact" ? txt === kw : txt.includes(kw);
      if (!match) return t;
      if (rule.pmCondition && rule.pmCondition !== t.paymentMethod) return t;
      return normalizeTxnSettlement(markPendingSync({ ...t, categoryMain: rule.catMain, categorySub: rule.catSub, updatedAt: new Date().toISOString() }));
    }));
  };

  const confirmSettlementMatch = (repaymentId, advanceId) => {
    if (!confirm("确认把这笔还款绑定到代付记录？")) return;
    const now = new Date().toISOString();
    setTxns(prev => {
      const repayment = prev.find(t => t.id === repaymentId);
      if (!repayment) return prev;
      const repaymentAmount = Math.abs(Number(repayment.originalAmount ?? repayment.amount ?? 0));
      return prev.map(t => {
        if (t.id === advanceId) {
          const originalAmount = Math.abs(Number(t.originalAmount ?? t.amount ?? 0));
          const offsetAmount = Math.min(originalAmount, Math.max(0, Number(t.offsetAmount || 0)) + repaymentAmount);
          return normalizeTxnSettlement(markPendingSync({
            ...t,
            settlementType: "advance",
            originalAmount,
            offsetAmount,
            effectiveAmount: Math.max(0, originalAmount - offsetAmount),
            settlementStatus: "matched",
            updatedAt: now
          }));
        }
        if (t.id === repaymentId) {
          return normalizeTxnSettlement(markPendingSync({
            ...t,
            settlementType: "repayment",
            linkedTransactionId: advanceId,
            effectiveAmount: 0,
            excludedFromStats: true,
            settlementStatus: "matched",
            updatedAt: now
          }));
        }
        return t;
      });
    });
    setEditId(null);
  };

  const currentSettingsRecord = () => ({
    id: "appearance",
    darkMode, themeColor, bgUrl, bgImage, bgBlur, bgOverlay, fontSize, csvEncoding,
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    serverVersion: 0
  });

  const applyRemoteSettings = (settings) => {
    const list = Array.isArray(settings) ? settings : Object.values(settings || {});
    const appearance = list.find(s => s?.id === "appearance") || settings?.appearance || null;
    if (!appearance || appearance.deletedAt) return;
    if (appearance.darkMode) setDarkMode(appearance.darkMode);
    if (appearance.themeColor) setThemeColor(appearance.themeColor);
    setBgUrl(appearance.bgUrl || "");
    setBgImage(appearance.bgImage || "");
    if (appearance.bgBlur !== undefined) setBgBlur(Number(appearance.bgBlur || 0));
    if (appearance.bgOverlay !== undefined) setBgOverlay(Number(appearance.bgOverlay ?? 0.78));
    if (appearance.fontSize !== undefined) setFontSize(Number(appearance.fontSize || 16));
    if (appearance.csvEncoding) setCsvEncoding(appearance.csvEncoding);
    setSettingsPendingSync(false);
  };

  const markSettingsDirty = (setter) => (value) => {
    setter(value);
    if (loaded) setSettingsPendingSync(true);
  };

  const runSync = async ({ pushFirst = true, silent = false } = {}) => {
    const config = { url: syncUrl, token: syncToken };
    if (!config.url || !config.token) {
      setSyncStatus("idle");
      if (!silent) setSyncError("请先填写 VPS API URL 和 Token");
      return;
    }
    try {
      setSyncStatus("syncing");
      setSyncError("");
      const clientId = await getSyncClientId();
      if (pushFirst) {
        const payload = {
          clientId,
          lastPulledAt,
          transactions: txns.filter(t => t.pendingSync),
          rules: rules.filter(r => r.pendingSync),
          settings: settingsPendingSync ? [markPendingSync(currentSettingsRecord())] : [],
          unknownMerchants: collectUnknownMerchants(txns)
        };
        if (payload.transactions.length || payload.rules.length || payload.settings.length || payload.unknownMerchants.length) {
          await pushToVps(config, payload);
          const syncedAt = new Date().toISOString();
          setTxns(prev => prev.map(t => t.pendingSync ? { ...t, pendingSync:false, syncedAt } : t));
          setRules(prev => prev.map(r => r.pendingSync ? { ...r, pendingSync:false, syncedAt } : r));
          setSettingsPendingSync(false);
        }
      }

      const pulled = await pullFromVps(config, lastPulledAt);
      const remoteTxns = Array.isArray(pulled.transactions) ? pulled.transactions : [];
      const remoteRules = Array.isArray(pulled.rules) ? pulled.rules : [];
      const deletedTxnIds = new Set(pulled.deletedIds?.transactions || []);
      const deletedRuleIds = new Set(pulled.deletedIds?.rules || []);
      setTxns(prev => mergeByUpdatedAt(prev, remoteTxns, normalizeTxnSettlement).filter(t => !deletedTxnIds.has(t.id)));
      setRules(prev => mergeByUpdatedAt(prev, remoteRules, normalizeRule).filter(r => !deletedRuleIds.has(r.id)));
      applyRemoteSettings(pulled.settings);
      if (Array.isArray(pulled.suggestedRules)) setSuggestedRules(prev => mergeSuggestedRules(prev, pulled.suggestedRules));
      const serverTime = pulled.serverTime || new Date().toISOString();
      setLastPulledAt(serverTime);
      setLastSyncAt(new Date().toISOString());
      setSyncStatus("synced");
    } catch (e) {
      console.error(e);
      setSyncStatus("error");
      setSyncError(e.message || "同步失败");
    }
  };

  const testSyncConnection = async () => {
    try {
      setSyncStatus("syncing");
      setSyncError("");
      await pullFromVps({ url: syncUrl, token: syncToken }, "");
      setSyncStatus("synced");
      setLastSyncAt(new Date().toISOString());
    } catch (e) {
      setSyncStatus("error");
      setSyncError(e.message || "连接失败");
    }
  };

  const acceptSuggestedRule = (suggestion) => {
    confirmCloudSuggestions({ acceptedIds:[suggestion.id], rejectedIds:[], editedRules:[] });
  };

  const loadClassifySummary = async () => {
    if (!syncUrl || !syncToken) return;
    try {
      setClassifyError("");
      const summary = await fetchClassifySummary({ url:syncUrl, token:syncToken });
      setClassifySummary(summary);
      if (summary.lastTask) setClassifyTask(prev => prev || summary.lastTask);
    } catch (e) {
      setClassifyError(e.message || "读取分类概况失败");
    }
  };

  const startClassifyTask = async () => {
    try {
      setClassifyStatus("syncing");
      setClassifyError("");
      await runSync({ pushFirst:true, silent:true });
      const task = await createClassifyTask({ url:syncUrl, token:syncToken }, { scope:"unclassified", months:[], source:"", limit:200 });
      setClassifyTask({ id:task.taskId, status:task.status, unknownMerchantCount:task.unknownMerchantCount, pendingSettlementCount:task.pendingSettlementCount });
      setClassifyStatus("pending");
      await loadClassifySummary();
    } catch (e) {
      setClassifyStatus("error");
      setClassifyError(e.message || "创建分类任务失败");
    }
  };

  const refreshClassifyTask = async () => {
    if (!classifyTask?.id) {
      await loadClassifySummary();
      return;
    }
    try {
      setClassifyStatus("syncing");
      setClassifyError("");
      const task = await fetchClassifyTask({ url:syncUrl, token:syncToken }, classifyTask.id);
      setClassifyTask(task);
      if (Array.isArray(task.suggestedRules)) setSuggestedRules(task.suggestedRules.filter(r => !r.deletedAt && r.status !== "accepted" && r.status !== "rejected"));
      setClassifyStatus(task.status || "idle");
      await loadClassifySummary();
    } catch (e) {
      setClassifyStatus("error");
      setClassifyError(e.message || "刷新分类任务失败");
    }
  };

  const triggerClassifyRun = async () => {
    if (!classifyTask?.id) return;
    try {
      setClassifyStatus("syncing");
      await runClassifyTask({ url:syncUrl, token:syncToken }, classifyTask.id);
      setTimeout(refreshClassifyTask, 1000);
    } catch (e) {
      setClassifyStatus("error");
      setClassifyError(e.message || "触发 worker 失败");
    }
  };

  const confirmCloudSuggestions = async ({ acceptedIds = [], rejectedIds = [], editedRules = [] }) => {
    try {
      setClassifyStatus("syncing");
      setClassifyError("");
      const result = await confirmSuggestedRules({ url:syncUrl, token:syncToken }, { acceptedIds, rejectedIds, editedRules });
      if (Array.isArray(result.rules)) setRules(prev => mergeByUpdatedAt(prev, result.rules, normalizeRule));
      setSuggestedRules(prev => prev.filter(r => !acceptedIds.includes(r.id) && !rejectedIds.includes(r.id) && !editedRules.some(e => e.suggestedRuleId === r.id)));
      await applyCloudRules({ url:syncUrl, token:syncToken }, { force:false });
      await runSync({ pushFirst:false, silent:true });
      await loadClassifySummary();
      setClassifyStatus("synced");
    } catch (e) {
      setClassifyStatus("error");
      setClassifyError(e.message || "确认建议失败");
    }
  };

  const rejectSuggestedRule = async (suggestion) => {
    await confirmCloudSuggestions({ acceptedIds:[], rejectedIds:[suggestion.id], editedRules:[] });
  };

  const editAndAcceptSuggestedRule = async (suggestion, patch = {}) => {
    await confirmCloudSuggestions({
      editedRules:[{
        suggestedRuleId:suggestion.id,
        keyword:cleanText(patch.keyword ?? suggestion.keyword ?? suggestion.merchant),
        matchType:patch.matchType || suggestion.matchType || "contains",
        ruleType:patch.ruleType || suggestion.ruleType || "category",
        categoryMain:patch.categoryMain ?? suggestion.categoryMain ?? suggestion.catMain ?? "",
        categorySub:patch.categorySub ?? suggestion.categorySub ?? suggestion.catSub ?? "",
        settlementPerson:patch.settlementPerson ?? suggestion.settlementPerson ?? "",
        settlementTypeHint:patch.settlementTypeHint ?? suggestion.settlementTypeHint ?? "",
        priority:Number(patch.priority ?? suggestion.priority ?? 50)
      }]
    });
  };

  const applyRulesToCloudHistory = async () => {
    try {
      setClassifyStatus("syncing");
      const result = await applyCloudRules({ url:syncUrl, token:syncToken }, { force:false });
      await runSync({ pushFirst:false, silent:true });
      await loadClassifySummary();
      setClassifyStatus("synced");
      alert(`已回填 ${result.updatedTransactions || 0} 笔交易`);
    } catch (e) {
      setClassifyStatus("error");
      setClassifyError(e.message || "应用规则失败");
    }
  };

  useEffect(() => {
    if (!loaded || !syncUrl || !syncToken) return;
    runSync({ pushFirst:false, silent:true });
    loadClassifySummary();
  }, [loaded, syncUrl, syncToken]);

  useEffect(() => {
    if (!loaded || !syncUrl || !syncToken || pendingSyncCount === 0 || syncStatus === "syncing") return;
    setSyncStatus("pending");
    const timer = setTimeout(() => runSync({ pushFirst:true, silent:true }), 1200);
    return () => clearTimeout(timer);
  }, [loaded, syncUrl, syncToken, pendingSyncCount]);

  // CSS Variables
  const dark = darkMode === "dark" || (darkMode === "auto" && systemDark);
  const [ar, ag, ab] = hexToRgb(themeColor);
  const hasBg = !!(bgUrl || bgImageData);
  const overlayRgb = dark ? "28,25,23" : "248,245,240";
  const theme = dark ? {
    "--bg":"#1c1917","--card":hasBg?"rgba(41,37,36,0.88)":"#292524","--input":hasBg?"rgba(61,56,53,0.78)":"#3d3835","--border":hasBg?"rgba(231,229,228,0.16)":"#4a4540",
    "--text":"#e7e5e4","--text2":"#a8a29e","--text3":"#78716c","--accent":themeColor,"--accent2":"#e8985a",
    "--accent-rgb":`${ar},${ag},${ab}`,"--text-scale":fontSize / 16,"--glass":hasBg?"rgba(41,37,36,0.72)":"rgba(41,37,36,0.8)"
  } : {
    "--bg":"#f8f5f0","--card":hasBg?"rgba(255,255,255,0.88)":"#ffffff","--input":hasBg?"rgba(243,239,233,0.74)":"#f3efe9","--border":hasBg?"rgba(45,41,38,0.12)":"#e8e2d9",
    "--text":"#2d2926","--text2":"#8a8078","--text3":"#b5ada4","--accent":themeColor,"--accent2":"#e8985a",
    "--accent-rgb":`${ar},${ag},${ab}`,"--text-scale":fontSize / 16,"--glass":hasBg?"rgba(255,255,255,0.72)":"rgba(255,255,255,0.8)"
  };
  const bgImageStyle = bgUrl ? `url("${bgUrl}")` : bgImageData ? `url("${bgImageData}")` : "none";

  const editTxn = editId ? txns.find(t=>t.id===editId) : null;
  const settlementCandidates = useMemo(() => {
    if (!editTxn || editTxn.settlementType !== "repayment") return [];
    const repaymentDate = new Date(editTxn.date);
    const person = cleanText(editTxn.settlementPerson || editTxn.merchant);
    return _.orderBy(txns.filter(t => {
      if (t.id === editTxn.id || t.settlementType !== "advance") return false;
      if (statAmount(t) <= 0) return false;
      const diff = Math.round((repaymentDate - new Date(t.date)) / 86400000);
      if (diff < 0 || diff > 14) return false;
      const otherPerson = cleanText(t.settlementPerson || t.merchant);
      return !person || !otherPerson || person === otherPerson;
    }), ["date","createdAt"], ["desc","desc"]).slice(0, 6);
  }, [editTxn, txns]);
  
  const recentManual = useMemo(() =>
    txns.filter(t=>!t.deletedAt && t.source==="manual").sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,5)
  , [txns]);

  const importBatches = useMemo(() => {
    const batches = _.groupBy(txns.filter(t=>!t.deletedAt && t.importBatchId), "importBatchId");
    return Object.entries(batches).map(([bid, items]) => ({
      id: bid, source: items[0].source, count: items.length,
      date: items[0].createdAt?.slice(0,10), total: _.sumBy(items,"amount")
    })).sort((a,b) => (b.date||"").localeCompare(a.date||""));
  }, [txns]);

  /* ─── RENDER ─── */

  const tabItems = [
    { key:"dash", icon:"📊", label:"仪表盘" },
    { key:"list", icon:"📋", label:"明细" },
    { key:"add",  icon:"✏️", label:"补录" },
    { key:"settings", icon:"⚙️", label:"设置" },
  ];

  return (
    <div className="nenei-app" style={{...theme, background:"var(--bg)", color:"var(--text)", minHeight:"100vh", fontFamily:"-apple-system,BlinkMacSystemFont,'Hiragino Sans',sans-serif",
      display:"flex",flexDirection:"column",maxWidth:480,margin:"0 auto",position:"relative",overflow:"hidden"}}>
      <style>{`
        .nenei-app .text-xs { font-size: calc(0.75rem * var(--text-scale)) !important; line-height: calc(1rem * var(--text-scale)) !important; }
        .nenei-app .text-sm { font-size: calc(0.875rem * var(--text-scale)) !important; line-height: calc(1.25rem * var(--text-scale)) !important; }
        .nenei-app .text-lg { font-size: calc(1.125rem * var(--text-scale)) !important; line-height: calc(1.75rem * var(--text-scale)) !important; }
        .nenei-app .text-xl { font-size: calc(1.25rem * var(--text-scale)) !important; line-height: calc(1.75rem * var(--text-scale)) !important; }
        .nenei-app .text-2xl { font-size: calc(1.5rem * var(--text-scale)) !important; line-height: calc(2rem * var(--text-scale)) !important; }
        .nenei-app input[type="date"] { min-width: 0; max-width: 100%; -webkit-appearance: none; }
      `}</style>
      {hasBg && (
        <>
          <div style={{position:"fixed",inset:0,maxWidth:480,margin:"0 auto",backgroundImage:bgImageStyle,backgroundSize:"cover",backgroundPosition:"center",
            filter:`blur(${bgBlur}px)`,transform:bgBlur?"scale(1.04)":"none",zIndex:0,pointerEvents:"none"}} />
          <div style={{position:"fixed",inset:0,maxWidth:480,margin:"0 auto",background:`rgba(${overlayRgb},${bgOverlay})`,zIndex:0,pointerEvents:"none"}} />
        </>
      )}
      
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-4 pb-2" style={{position:"relative",zIndex:1}}>
        <button onClick={()=>setMonth(shiftMonth(month,-1))} className="text-xl p-1" style={{color:"var(--text2)"}}>‹</button>
        <h1 className="text-lg font-bold tracking-tight">{fmtMonth(month)}</h1>
        <button onClick={()=>setMonth(shiftMonth(month,1))} className="text-xl p-1" style={{color:"var(--text2)"}}>›</button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto pb-24 px-4" style={{position:"relative",zIndex:1}}>

        {/* ═══ DASHBOARD ═══ */}
        {tab === "dash" && (
          <div className="space-y-4 pt-2">
            {/* Summary Cards */}
            <div className="grid grid-cols-2 gap-3">
              {[
                { label:"总支出", value: fmtAmt(totalSpend), sub: changePercent !== null ? `${changePercent > 0 ? "↑":"↓"}${Math.abs(changePercent)}% 环比` : "—" },
                { label:"日均", value: fmtAmt(dailyAvg) },
                { label:"最大单笔", value: maxTxn ? fmtAmt(statAmount(maxTxn)) : "—", sub: maxTxn?.merchant?.slice(0,10) },
                { label:"未分类", value: uncatCount+"笔", sub: uncatCount > 0 ? "需要归类" : "全部已分类", alert: uncatCount > 0 },
              ].map((c,i) => (
                <div key={i} className="rounded-2xl p-4" style={{background:"var(--card)",boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}
                  onClick={()=>{ if(c.alert){ setFUncat(true); setTab("list") }}}>
                  <div className="text-xs mb-1" style={{color:"var(--text2)"}}>{c.label}</div>
                  <div className="text-xl font-bold" style={c.alert?{color:"var(--accent)"}:{}}>{c.value}</div>
                  {c.sub && <div className="text-xs mt-0.5" style={{color: c.alert?"var(--accent)":"var(--text3)"}}>{c.sub}</div>}
                </div>
              ))}
            </div>

            {/* Pie Chart */}
            {!drillCat ? (
              <div className="rounded-2xl p-4" style={{background:"var(--card)",boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
                <div className="text-sm font-semibold mb-3" style={{color:"var(--text2)"}}>分类占比</div>
                {catData.length > 0 ? (
                  <>
                    <div style={{height:200}}>
                      <ResponsiveContainer>
                        <PieChart>
                          <Pie data={catData} dataKey="value" cx="50%" cy="50%" innerRadius={50} outerRadius={80}
                            paddingAngle={2} onClick={(d)=>setDrillCat(d.key)} style={{cursor:"pointer",outline:"none"}}>
                            {catData.map(d => <Cell key={d.key} fill={d.color} stroke="none" />)}
                          </Pie>
                          <Tooltip formatter={v=>[fmtAmt(v),""]} contentStyle={{borderRadius:12,border:"none",boxShadow:"0 2px 8px rgba(0,0,0,0.1)",background:"var(--card)",color:"var(--text)"}} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="space-y-2 mt-3">
                      {catData.map(d => (
                        <div key={d.key} className="flex items-center justify-between py-1.5 rounded-xl px-3 transition-colors"
                          style={{cursor:"pointer"}} onClick={()=>setDrillCat(d.key)}>
                          <div className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full" style={{background:d.color}} />
                            <span className="text-sm">{d.name}</span>
                            <span className="text-xs" style={{color:"var(--text3)"}}>{d.count}笔</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{fmtAmt(d.value)}</span>
                            <span className="text-xs" style={{color:"var(--text3)"}}>{totalSpend?Math.round(d.value/totalSpend*100):0}%</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : <div className="text-center py-8 text-sm" style={{color:"var(--text3)"}}>本月暂无数据</div>}
              </div>
            ) : (
              /* Drill into subcategory */
              <div className="rounded-2xl p-4" style={{background:"var(--card)",boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
                <div className="flex items-center gap-2 mb-3">
                  <button onClick={()=>setDrillCat(null)} className="text-lg" style={{color:"var(--accent)"}}>‹</button>
                  <span className="text-sm font-semibold">{CATS[drillCat]?.icon} {CATS[drillCat]?.name} 明细</span>
                </div>
                {(() => {
                  const subs = statsTxns.filter(t=>t.categoryMain===drillCat);
                  const subGroups = _.groupBy(subs, t=>t.categorySub||"未分類");
                  const subData = Object.entries(subGroups).map(([name,items])=>({
                    name, value:_.sumBy(items, statAmount), count:items.length
                  })).sort((a,b)=>b.value-a.value);
                  const catTotal = _.sumBy(subs, statAmount);
                  return (
                    <div className="space-y-2">
                      <div className="text-xl font-bold mb-2">{fmtAmt(catTotal)}</div>
                      {subData.map(d => (
                        <div key={d.name} className="flex items-center justify-between py-2">
                          <div className="flex items-center gap-2">
                            <span className="text-sm">{d.name}</span>
                            <span className="text-xs" style={{color:"var(--text3)"}}>{d.count}笔</span>
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="h-1.5 rounded-full" style={{width:Math.max(20,d.value/catTotal*120),background:CATS[drillCat]?.color}} />
                            <span className="text-sm font-medium w-20 text-right">{fmtAmt(d.value)}</span>
                          </div>
                        </div>
                      ))}
                      <Btn small onClick={()=>{ setFCat(drillCat); setDrillCat(null); setTab("list") }}>查看全部明细 →</Btn>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Payment method breakdown */}
            {pmData.length > 0 && !drillCat && (
              <div className="rounded-2xl p-4" style={{background:"var(--card)",boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
                <div className="text-sm font-semibold mb-3" style={{color:"var(--text2)"}}>支付方式</div>
                <div className="space-y-2">
                  {pmData.map(d => (
                    <div key={d.name} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full" style={{background:d.color}} />
                        <span className="text-sm">{d.name}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 rounded-full" style={{width:Math.max(20,d.value/totalSpend*100),background:d.color,opacity:0.7}} />
                        <span className="text-sm font-medium">{fmtAmt(d.value)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══ TRANSACTION LIST ═══ */}
        {tab === "list" && (
          <div className="space-y-3 pt-2">
            {/* Filters */}
            <div className="rounded-2xl p-3 space-y-2" style={{background:"var(--card)",boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
              <Input value={fKw} onChange={setFKw} placeholder="搜索商户名或备注…" />
              <div className="flex gap-2">
                <div className="flex-1"><Select value={fCat} onChange={v=>{setFCat(v);setFSub("")}} placeholder="全部分类" options={CAT_KEYS.map(k=>({v:k,l:CATS[k].icon+" "+CATS[k].name}))} /></div>
                <div className="flex-1"><Select value={fPm} onChange={setFPm} placeholder="支付方式" options={PM_LIST} /></div>
              </div>
              <div className="flex gap-2">
                {fCat && <div className="flex-1"><Select value={fSub} onChange={setFSub} placeholder="全部子类" options={CATS[fCat]?.subs||[]} /></div>}
                <button onClick={()=>setFUncat(!fUncat)} className="rounded-xl px-3 py-1.5 text-xs font-medium"
                  style={{background:fUncat?"var(--accent)":"var(--input)",color:fUncat?"#fff":"var(--text)",border:"1px solid var(--border)"}}>
                  未分类
                </button>
                {(fCat||fPm||fKw||fUncat||fSub) && (
                  <button onClick={()=>{setFCat("");setFSub("");setFPm("");setFKw("");setFUncat(false)}}
                    className="text-xs px-2" style={{color:"var(--accent)"}}>清除</button>
                )}
              </div>
            </div>

            {/* Grouped list */}
            <div className="text-xs px-1 mb-1" style={{color:"var(--text3)"}}>{filteredTxns.length}笔交易</div>
            {groupedTxns.map(g => (
              <div key={g.date}>
                <div className="flex justify-between items-center px-1 mb-1.5">
                  <div className="text-xs font-medium" style={{color:"var(--text2)"}}>{fmtDate(g.date)} ({g.weekday})</div>
                  <div className="text-xs font-medium" style={{color:"var(--text2)"}}>{fmtAmt(g.total)}</div>
                </div>
                <div className="rounded-2xl overflow-hidden" style={{background:"var(--card)",boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
                  {g.items.map((t,i) => (
                    <div key={t.id} className="flex items-center gap-3 px-4 py-3 active:bg-black/5 transition-colors"
                      style={{borderTop:i?"1px solid var(--border)":"none",cursor:"pointer",opacity:t.excludedFromStats?0.5:1}}
                      onClick={()=>setEditId(t.id)}>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium truncate">{highlightText(t.merchant || "不明", fKw)}</span>
                          {t.excludedFromStats && <span className="text-xs" style={{color:"var(--text3)"}}>除外</span>}
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          {t.categoryMain && <Pill small text={CATS[t.categoryMain]?.icon+" "+(t.categorySub||CATS[t.categoryMain]?.name)} color={CATS[t.categoryMain]?.color} />}
                          {!t.categoryMain && <Pill small text="未分類" color="#999" />}
                          {t.memo && <span className="text-xs truncate" style={{color:"var(--text3)"}}>{highlightText(t.memo, fKw)}</span>}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-semibold">-{fmtAmt(t.excludedFromStats && statAmount(t) === 0 ? t.amount : statAmount(t))}</div>
                        <div className="text-xs mt-0.5" style={{color:PM_COLORS[t.paymentMethod]||"var(--text3)"}}>{t.paymentMethod}</div>
                        {t.settlementType !== "none" && (
                          <div className="text-[10px] mt-0.5" style={{color:"var(--accent)"}}>{settlementLabel[t.settlementType]}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {groupedTxns.length === 0 && <div className="text-center py-12 text-sm" style={{color:"var(--text3)"}}>暂无记录</div>}
          </div>
        )}

        {/* ═══ MANUAL ENTRY ═══ */}
        {tab === "add" && (
          <div className="space-y-4 pt-2">
            <div className="rounded-2xl p-4 space-y-3" style={{background:"var(--card)",boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
              <div className="text-sm font-semibold" style={{color:"var(--text2)"}}>现金补录</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div><Input type="date" value={mDate} onChange={setMDate} /></div>
                <div><Input type="number" value={mAmt} onChange={setMAmt} placeholder="金额" /></div>
              </div>
              <Input value={mMerch} onChange={setMMerch} placeholder="商户名" />
              <Input value={mMemo} onChange={setMMemo} placeholder="备注（可选）" />
              <CatPicker main={mCatM} sub={mCatS} onMainChange={setMCatM} onSubChange={setMCatS} />
              <Btn primary onClick={addManual} disabled={!mAmt||!mDate} className="w-full">记一笔 💴</Btn>
            </div>

            {recentManual.length > 0 && (
              <div className="rounded-2xl p-4" style={{background:"var(--card)",boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
                <div className="text-sm font-semibold mb-2" style={{color:"var(--text2)"}}>最近补录</div>
                {recentManual.map(t => (
                  <div key={t.id} className="flex justify-between items-center py-2" style={{borderBottom:"1px solid var(--border)"}}>
                    <div>
                      <div className="text-sm">{t.merchant||"—"}</div>
                      <div className="text-xs" style={{color:"var(--text3)"}}>{fmtDate(t.date)}{t.categorySub ? " · "+t.categorySub : ""}</div>
                    </div>
                    <span className="text-sm font-medium">{fmtAmt(t.amount)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ═══ SETTINGS ═══ */}
        {tab === "settings" && (
          <div className="space-y-4 pt-2">
            {/* Data */}
            <div className="rounded-2xl p-4" style={{background:"var(--card)",boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-semibold" style={{color:"var(--text2)"}}>数据</div>
                <div className="flex gap-2">
                  <label className="rounded-xl font-medium transition-all active:scale-95 text-xs px-3 py-1.5 cursor-pointer"
                    style={{background:"var(--input)",color:"var(--text)",border:"1px solid var(--border)"}}>
                    导入
                    <input type="file" accept=".json,application/json" className="hidden" onChange={e=>{importBackup(e.target.files?.[0]); e.target.value = "";}} />
                  </label>
                  <Btn small onClick={exportData}>导出</Btn>
                </div>
              </div>
              <div className="mb-3">
                <Select value={csvEncoding} onChange={markSettingsDirty(setCsvEncoding)} options={[{v:"auto",l:"自动识别编码"},{v:"utf-8",l:"UTF-8"},{v:"shift-jis",l:"Shift_JIS / CP932"}]} />
              </div>
              <label className="block rounded-xl border-2 border-dashed p-6 text-center cursor-pointer transition-colors"
                style={{borderColor:"var(--border)",color:"var(--text3)"}}
                onDragOver={e=>{e.preventDefault(); e.currentTarget.style.borderColor="var(--accent)"}}
                onDragLeave={e=>{e.currentTarget.style.borderColor="var(--border)"}}
                onDrop={e=>{e.preventDefault(); e.currentTarget.style.borderColor="var(--border)"; const f=e.dataTransfer.files?.[0]; if(f) handleImport(f)}}>
                <div className="text-2xl mb-1">📁</div>
                <div className="text-sm">CSV 文件</div>
                <input type="file" accept=".csv,text/csv" className="hidden" onChange={e=>e.target.files[0]&&handleImport(e.target.files[0])} />
              </label>
              {importBatches.length > 0 && (
                <div className="mt-3 space-y-2">
                  <div className="text-xs font-medium" style={{color:"var(--text3)"}}>导入历史</div>
                  {importBatches.slice(0,5).map(b => (
                    <div key={b.id} className="flex justify-between items-center text-xs py-1.5">
                      <span>{b.source} · {b.count}笔 · {fmtAmt(b.total)}</span>
                      <button onClick={()=>undoImport(b.id)} className="px-2 py-0.5 rounded" style={{color:"var(--accent)"}}>撤销</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Cloud Sync */}
            <div className="rounded-2xl p-4 space-y-3" style={{background:"var(--card)",boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold" style={{color:"var(--text2)"}}>云同步</div>
                <span className="text-xs px-2 py-1 rounded-full" style={{background:"var(--input)",color:syncStatus==="error"?"#c44":"var(--text2)"}}>
                  {syncStatus === "pending" ? `待同步 ${pendingSyncCount} 条` : SYNC_STATUS[syncStatus]}
                </span>
              </div>
              <Input value={syncUrl} onChange={setSyncUrl} placeholder="VPS API URL，例如 https://api.example.com" />
              <Input type="password" value={syncToken} onChange={setSyncToken} placeholder="Token（只保存在本机）" />
              <div className="grid grid-cols-2 gap-2">
                <Btn onClick={testSyncConnection} disabled={!syncUrl || !syncToken || syncStatus==="syncing"}>测试连接</Btn>
                <Btn primary onClick={()=>runSync({pushFirst:true})} disabled={!syncUrl || !syncToken || syncStatus==="syncing"}>立即同步</Btn>
              </div>
              <div className="text-xs space-y-1" style={{color:"var(--text3)"}}>
                <div>最后同步：{lastSyncAt ? new Date(lastSyncAt).toLocaleString() : "尚未同步"}</div>
                {syncError && <div style={{color:"#c44"}}>{syncError}</div>}
              </div>
              {suggestedRules.length > 0 && (
                <div className="flex items-center justify-between gap-3 pt-2" style={{borderTop:"1px solid var(--border)"}}>
                  <div className="text-xs" style={{color:"var(--text3)"}}>有 {suggestedRules.length} 条分类建议待确认</div>
                  <Btn small onClick={()=>setShowSuggestions(true)}>查看</Btn>
                </div>
              )}
            </div>

            {/* Cloud Classification */}
            <div className="rounded-2xl p-4 space-y-3" style={{background:"var(--card)",boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold" style={{color:"var(--text2)"}}>云端分类</div>
                <span className="text-xs px-2 py-1 rounded-full" style={{background:"var(--input)",color:classifyStatus==="error"?"#c44":"var(--text2)"}}>
                  {classifyTask?.status || classifyStatus || "idle"}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {[
                  ["未分类交易", classifySummary?.unclassifiedTransactionCount ?? "—"],
                  ["未知商户", classifySummary?.unknownMerchantCount ?? "—"],
                  ["AA/还款待确认", classifySummary?.pendingSettlementCount ?? "—"],
                  ["建议待确认", classifySummary?.pendingSuggestedRuleCount ?? suggestedRules.length],
                ].map(([label,value]) => (
                  <div key={label} className="rounded-xl px-3 py-2" style={{background:"var(--input)"}}>
                    <div className="text-[10px]" style={{color:"var(--text3)"}}>{label}</div>
                    <div className="text-sm font-semibold">{value}</div>
                  </div>
                ))}
              </div>
              {classifySummary?.lastTask && (
                <div className="text-xs" style={{color:"var(--text3)"}}>
                  最近任务：{classifySummary.lastTask.status} · {classifySummary.lastTask.updatedAt ? new Date(classifySummary.lastTask.updatedAt).toLocaleString() : ""}
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <Btn primary onClick={startClassifyTask} disabled={!syncUrl || !syncToken || classifyStatus==="syncing"}>生成分类建议</Btn>
                <Btn onClick={refreshClassifyTask} disabled={!syncUrl || !syncToken || classifyStatus==="syncing"}>刷新任务状态</Btn>
                <Btn onClick={()=>setShowSuggestions(true)} disabled={!suggestedRules.length}>查看建议</Btn>
                <Btn onClick={applyRulesToCloudHistory} disabled={!syncUrl || !syncToken || classifyStatus==="syncing"}>应用到历史</Btn>
              </div>
              {classifyTask?.id && (
                <div className="flex items-center justify-between text-xs" style={{color:"var(--text3)"}}>
                  <span className="truncate">task: {classifyTask.id}</span>
                  <button onClick={triggerClassifyRun} style={{color:"var(--accent)"}}>手动运行</button>
                </div>
              )}
              {classifyError && <div className="text-xs" style={{color:"#c44"}}>{classifyError}</div>}
            </div>

            {/* Appearance */}
            <div className="rounded-2xl p-4 space-y-4" style={{background:"var(--card)",boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold" style={{color:"var(--text2)"}}>外观</div>
                <div className="flex rounded-xl p-1" style={{background:"var(--input)",border:"1px solid var(--border)"}}>
                  {[["light","浅"],["dark","深"],["auto","自动"]].map(([v,l]) => (
                    <button key={v} onClick={()=>markSettingsDirty(setDarkMode)(v)} className="text-xs px-2.5 py-1 rounded-lg transition-colors"
                      style={{background:darkMode===v?"var(--accent)":"transparent",color:darkMode===v?"#fff":"var(--text2)"}}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-xs font-medium mb-2" style={{color:"var(--text3)"}}>主题色</div>
                <div className="flex items-center gap-2">
                  {THEME_PRESETS.map(c => (
                    <button key={c} onClick={()=>markSettingsDirty(setThemeColor)(c)} className="w-8 h-8 rounded-full transition-transform"
                      style={{background:c,border:themeColor===c?"3px solid var(--text)":"3px solid transparent",transform:themeColor===c?"scale(1.05)":"none"}} />
                  ))}
                  <label className="w-8 h-8 rounded-full overflow-hidden border flex items-center justify-center" style={{borderColor:"var(--border)",background:"var(--input)"}}>
                    <input type="color" value={themeColor} onChange={e=>markSettingsDirty(setThemeColor)(e.target.value)} className="w-10 h-10 border-0 p-0 cursor-pointer" />
                  </label>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs font-medium" style={{color:"var(--text3)"}}>背景图</div>
                  {(bgUrl || bgImage) && <button onClick={clearBackground} className="text-xs" style={{color:"var(--accent)"}}>清除</button>}
                </div>
                <Input value={bgUrl} onChange={v=>{setBgUrl(v); if(v) setBgImage(""); setSettingsPendingSync(true);}} placeholder="图片 URL" />
                <div className="mt-2 flex gap-2">
                  <label className="flex-1 rounded-xl px-3 py-2.5 text-sm text-center cursor-pointer"
                    style={{background:"var(--input)",border:"1px solid var(--border)",color:"var(--text)"}}>
                    上传
                    <input type="file" accept="image/*" className="hidden" onChange={e=>uploadBackground(e.target.files?.[0])} />
                  </label>
                  <div className="w-20 rounded-xl overflow-hidden" style={{background:"var(--input)",border:"1px solid var(--border)"}}>
                    {hasBg ? <div className="w-full h-full" style={{backgroundImage:bgImageStyle,backgroundSize:"cover",backgroundPosition:"center"}} /> :
                      <div className="w-full h-full" style={{background:`linear-gradient(135deg, rgba(var(--accent-rgb),0.2), var(--input))`}} />}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="flex justify-between text-xs mb-2" style={{color:"var(--text3)"}}><span>模糊</span><span>{bgBlur}px</span></div>
                  <Range value={bgBlur} onChange={markSettingsDirty(setBgBlur)} min={0} max={20} step={1} />
                </div>
                <div>
                  <div className="flex justify-between text-xs mb-2" style={{color:"var(--text3)"}}><span>遮罩</span><span>{Math.round(bgOverlay*100)}%</span></div>
                  <Range value={bgOverlay} onChange={markSettingsDirty(setBgOverlay)} min={0.35} max={0.95} step={0.05} />
                </div>
              </div>

              <div>
                <div className="flex justify-between text-xs mb-2" style={{color:"var(--text3)"}}><span>字号</span><span>{fontSize}px</span></div>
                <Range value={fontSize} onChange={markSettingsDirty(setFontSize)} min={14} max={19} step={0.5} />
              </div>
            </div>

            {/* Rules */}
            <div className="rounded-2xl p-4" style={{background:"var(--card)",boxShadow:"0 1px 4px rgba(0,0,0,0.06)"}}>
              <div className="flex justify-between items-center mb-3">
                <div className="text-sm font-semibold" style={{color:"var(--text2)"}}>分类规则 ({activeRules.length})</div>
                <Btn small primary onClick={()=>setRuleEdit({keyword:"",matchType:"contains",catMain:"",catSub:"",pmCondition:"",priority:10,enabled:true})}>新建</Btn>
              </div>
              {activeRules.length === 0 && <div className="text-xs py-4 text-center" style={{color:"var(--text3)"}}>暂无规则</div>}
              <div className="space-y-2">
                {_.orderBy(activeRules,["priority"],["desc"]).map(r => (
                  <div key={r.id} className="flex items-center justify-between py-2 px-2 rounded-xl"
                    style={{background:"var(--input)",opacity:r.enabled?1:0.5}}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium truncate">「{r.keyword}」</span>
                        <span className="text-xs" style={{color:"var(--text3)"}}>{r.matchType==="exact"?"完全一致":"包含"}</span>
                      </div>
                      <div className="text-xs mt-0.5" style={{color:"var(--text2)"}}>
                        → {r.ruleType === "settlement_person" ? `结算对象 ${r.settlementPerson || r.keyword}` : `${CATS[r.catMain || r.categoryMain]?.icon || ""} ${r.catSub || r.categorySub || CATS[r.catMain || r.categoryMain]?.name || ""}`}
                        {r.pmCondition && ` · ${r.pmCondition}限定`}
                        {` · 優先度${r.priority}`}
                      </div>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button onClick={()=>applyRulesToHistory(r)} className="text-xs px-1.5 py-0.5 rounded" style={{color:"var(--accent)"}}>回溯</button>
                      <button onClick={()=>setRuleEdit(r)} className="text-xs px-1.5 py-0.5 rounded" style={{color:"var(--text2)"}}>编辑</button>
                      <button onClick={()=>{const now=new Date().toISOString();setRules(prev=>prev.map(x=>x.id===r.id?markPendingSync({...x,deletedAt:now,updatedAt:now}):x))}} className="text-xs px-1.5 py-0.5 rounded" style={{color:"#c44"}}>删</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Data info */}
            <div className="text-xs text-center py-2" style={{color:"var(--text3)"}}>
              共 {txns.filter(t=>!t.deletedAt).length} 笔交易 · {activeRules.length} 条规则
            </div>
          </div>
        )}
      </div>

      {/* ═══ TAB BAR ═══ */}
      <div className="fixed bottom-0 left-0 right-0 flex justify-center" style={{zIndex:40}}>
        <div className="w-full max-w-lg flex items-center justify-around py-2 pb-5"
          style={{background:"var(--glass)",backdropFilter:"blur(16px)",borderTop:"1px solid var(--border)"}}>
          {tabItems.map(t => (
            <button key={t.key} onClick={()=>{setTab(t.key);if(t.key!=="list"){setFCat("");setFSub("");setFPm("");setFKw("");setFUncat(false)}setDrillCat(null)}}
              className="flex flex-col items-center gap-0.5 px-4 py-1 transition-all"
              style={{color:tab===t.key?"var(--accent)":"var(--text3)",transform:tab===t.key?"scale(1.05)":"scale(1)"}}>
              <span className="text-lg">{t.icon}</span>
              <span className="text-xs">{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ═══ MODALS ═══ */}
      
      {/* Import Preview */}
      <Modal open={!!importPreview} onClose={()=>setImportPreview(null)} title="导入预览">
        {importPreview && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              {[
                ["来源", importPreview.source],
                ["日期范围", importPreview.dateRange],
                ["交易笔数", importPreview.count+"笔"],
                ["总金额", fmtAmt(importPreview.total)],
                ["未分类", importPreview.uncatCount+"笔"],
                ["非消费", importPreview.excludedCount+"笔"],
                ["疑似重复", importPreview.dupeCount+"笔"],
              ].map(([l,v],i) => (
                <div key={i} className="py-2">
                  <div className="text-xs" style={{color:"var(--text3)"}}>{l}</div>
                  <div className="text-sm font-medium">{v}</div>
                </div>
              ))}
            </div>
            <div className="text-xs" style={{color:"var(--text3)"}}>编码：{importPreview.encoding}{importPreview.errorCount ? ` · 跳过异常 ${importPreview.errorCount} 行` : ""}</div>
            {importPreview.dupeCount > 0 && (
              <label className="flex items-center gap-2 text-xs p-3 rounded-xl" style={{background:"var(--accent)"+"18",color:"var(--accent)"}}>
                <input type="checkbox" checked={skipDupes} onChange={e=>setSkipDupes(e.target.checked)} />
                跳过疑似重复：{importPreview.dupeCount} 笔
              </label>
            )}
            {importPreview.excludedCount > 0 && (
              <div className="text-xs p-3 rounded-xl" style={{background:"var(--accent2)"+"18",color:"var(--accent2)"}}>
                非消费：{importPreview.excludedCount} 笔
              </div>
            )}
            <div className="rounded-xl overflow-hidden" style={{border:"1px solid var(--border)"}}>
              <div className="text-xs px-3 py-2" style={{background:"var(--input)",color:"var(--text2)"}}>样本预览</div>
              <div className="divide-y" style={{borderColor:"var(--border)"}}>
                {importPreview.sample.map(t => (
                  <div key={t.id} className="px-3 py-2 text-xs flex justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate">{t.date} · {t.merchant}</div>
                      <div style={{color:"var(--text3)"}}>{t.paymentMethod}{t.categorySub ? ` · ${t.categorySub}` : " · 未分類"}{t.excludedFromStats ? ` · ${t.type}` : ""}</div>
                    </div>
                    <div className="font-medium shrink-0">{fmtAmt(t.amount)}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <Btn className="flex-1" onClick={()=>setImportPreview(null)}>取消</Btn>
              <Btn primary className="flex-1" onClick={confirmImport}>确认导入{skipDupes && importPreview.dupeCount ? ` ${importPreview.count-importPreview.dupeCount}笔` : ""}</Btn>
            </div>
          </div>
        )}
      </Modal>

      {/* Transaction Edit */}
      <Modal open={!!editTxn} onClose={()=>setEditId(null)} title="编辑交易">
        {editTxn && <TxnEditor txn={editTxn} onSave={(id,patch)=>{updateTxn(id,patch);setEditId(null)}}
          settlementCandidates={settlementCandidates}
          onConfirmSettlement={confirmSettlementMatch}
          onCreateRule={(kw,catM,catS)=>setRuleEdit({keyword:kw,matchType:"contains",catMain:catM,catSub:catS,pmCondition:"",priority:10,enabled:true})}
          onDelete={()=>{const now=new Date().toISOString();setTxns(prev=>prev.map(t=>t.id===editId?markPendingSync({...t,deletedAt:now,updatedAt:now}):t));setEditId(null)}} />}
      </Modal>

      {/* Suggested Rules */}
      <Modal open={showSuggestions} onClose={()=>setShowSuggestions(false)} title="分类建议">
        <div className="space-y-3">
          {suggestedRules.length === 0 && <div className="text-sm text-center py-8" style={{color:"var(--text3)"}}>暂无待确认建议</div>}
          {suggestedRules.map(s => (
            <SuggestedRuleEditor
              key={s.id}
              suggestion={s}
              onAccept={acceptSuggestedRule}
              onEditAccept={editAndAcceptSuggestedRule}
              onReject={rejectSuggestedRule}
            />
          ))}
        </div>
      </Modal>

      {/* Rule Edit */}
      <Modal open={!!ruleEdit} onClose={()=>setRuleEdit(null)} title={ruleEdit?.id?"编辑规则":"新建规则"}>
        {ruleEdit && <RuleEditForm rule={ruleEdit} onSave={saveRule} onCancel={()=>setRuleEdit(null)} />}
      </Modal>
    </div>
  );
}

/* ═══════════════════════════════════════════
   7. EDITOR COMPONENTS
   ═══════════════════════════════════════════ */

function SuggestedRuleEditor({ suggestion, onAccept, onEditAccept, onReject }) {
  const initialMain = suggestion.categoryMain || suggestion.catMain || "";
  const initialSub = suggestion.categorySub || suggestion.catSub || "";
  const initialRuleType = suggestion.ruleType || "category";
  const [keyword, setKeyword] = useState(suggestion.keyword || suggestion.merchant || "");
  const [matchType, setMatchType] = useState(suggestion.matchType || "contains");
  const [ruleType, setRuleType] = useState(initialRuleType);
  const [categoryMain, setCategoryMain] = useState(initialMain);
  const [categorySub, setCategorySub] = useState(initialSub);
  const [settlementPerson, setSettlementPerson] = useState(suggestion.settlementPerson || suggestion.keyword || "");
  const [settlementTypeHint, setSettlementTypeHint] = useState(suggestion.settlementTypeHint || "repayment");
  const [priority, setPriority] = useState(String(suggestion.priority || 50));
  const confidence = Math.round(Number(suggestion.confidence || 0) * 100);
  const isDirty =
    keyword !== (suggestion.keyword || suggestion.merchant || "") ||
    matchType !== (suggestion.matchType || "contains") ||
    ruleType !== initialRuleType ||
    categoryMain !== initialMain ||
    categorySub !== initialSub ||
    settlementPerson !== (suggestion.settlementPerson || suggestion.keyword || "") ||
    settlementTypeHint !== (suggestion.settlementTypeHint || "repayment") ||
    Number(priority || 0) !== Number(suggestion.priority || 50);

  const accept = () => {
    if (!isDirty) {
      onAccept(suggestion);
      return;
    }
    onEditAccept(suggestion, {
      keyword, matchType, ruleType, categoryMain, categorySub,
      settlementPerson, settlementTypeHint, priority:Number(priority || 50)
    });
  };

  return (
    <div className="rounded-2xl p-3 space-y-3" style={{background:"var(--input)",border:"1px solid var(--border)"}}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">「{suggestion.keyword || suggestion.merchant}」</div>
          <div className="text-xs mt-0.5" style={{color:"var(--text3)"}}>
            {ruleType === "settlement_person"
              ? `结算对象 · ${settlementPerson || keyword}`
              : ruleType === "exclude"
                ? "排除统计"
                : `${CATS[categoryMain]?.name || categoryMain || "未指定"}${categorySub ? " · "+categorySub : ""}`}
          </div>
        </div>
        <span className="text-xs shrink-0" style={{color:"var(--accent)"}}>{confidence}%</span>
      </div>

      {suggestion.reason && <div className="text-xs" style={{color:"var(--text2)"}}>{suggestion.reason}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Input value={keyword} onChange={setKeyword} placeholder="关键词" />
        <Select value={matchType} onChange={setMatchType} options={[{v:"contains",l:"包含匹配"},{v:"exact",l:"完全一致"}]} />
        <Select value={ruleType} onChange={setRuleType} options={[
          {v:"category",l:"分类规则"},
          {v:"settlement_person",l:"AA/还款对象"},
          {v:"exclude",l:"排除统计"}
        ]} />
        <Input type="number" value={priority} onChange={setPriority} placeholder="优先级" />
      </div>

      {ruleType === "category" && (
        <CatSelect main={categoryMain} sub={categorySub} onMainChange={setCategoryMain} onSubChange={setCategorySub} />
      )}

      {ruleType === "settlement_person" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Input value={settlementPerson} onChange={setSettlementPerson} placeholder="结算对象名" />
          <Select value={settlementTypeHint} onChange={setSettlementTypeHint} options={[
            {v:"repayment",l:"对方还我"},
            {v:"aa_payment",l:"我付 AA 款"}
          ]} />
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Btn small primary onClick={accept}>{isDirty ? "编辑后确认" : "确认"}</Btn>
        <Btn small onClick={()=>onAccept(suggestion)}>按原建议确认</Btn>
        <Btn small danger onClick={()=>onReject(suggestion)}>拒绝</Btn>
      </div>
    </div>
  );
}

function TxnEditor({ txn, onSave, onCreateRule, onDelete, settlementCandidates = [], onConfirmSettlement }) {
  const [merchant, setMerchant] = useState(txn.merchant);
  const [memo, setMemo] = useState(txn.memo);
  const [catM, setCatM] = useState(txn.categoryMain);
  const [catS, setCatS] = useState(txn.categorySub);
  const [pm, setPm] = useState(txn.paymentMethod);
  const [excl, setExcl] = useState(txn.excludedFromStats);
  const [settlementType, setSettlementType] = useState(txn.settlementType || "none");
  const [settlementPerson, setSettlementPerson] = useState(txn.settlementPerson || "");
  const [askRule, setAskRule] = useState(false);
  const originalAmount = Math.abs(Number(txn.originalAmount ?? txn.amount ?? 0));
  const offsetAmount = Math.max(0, Number(txn.offsetAmount ?? 0));
  const effectiveAmount = settlementType === "repayment" ? 0 : Math.max(0, originalAmount - offsetAmount);

  const save = () => {
    const nextExcluded = settlementType === "repayment" ? true : excl;
    onSave(txn.id, {
      merchant, memo, categoryMain:catM, categorySub:catS, paymentMethod:pm,
      excludedFromStats:nextExcluded,
      type: settlementType === "repayment" ? "repayment" : settlementType === "aa_payment" ? "aa_payment" : "expense",
      settlementType,
      settlementPerson: cleanText(settlementPerson),
      originalAmount,
      offsetAmount,
      effectiveAmount: settlementType === "none" || settlementType === "aa_payment" ? originalAmount : effectiveAmount,
      settlementStatus: settlementType === "none" ? "none" : txn.settlementStatus === "matched" ? "matched" : "pending"
    });
    if (askRule && merchant && catM) onCreateRule(merchant, catM, catS);
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-between text-xs" style={{color:"var(--text3)"}}>
        <span>{txn.date} · {txn.source}</span>
        <span className="text-lg font-bold" style={{color:"var(--text)"}}>-{fmtAmt(statAmount(txn))}</span>
      </div>
      <Input value={merchant} onChange={setMerchant} placeholder="商户名" />
      <Input value={memo} onChange={setMemo} placeholder="备注" />
      <CatPicker main={catM} sub={catS} onMainChange={setCatM} onSubChange={setCatS} />
      <Select value={pm} onChange={setPm} placeholder="支付方式" options={PM_LIST} />
      <div className="rounded-xl p-3 space-y-2" style={{background:"var(--input)",border:"1px solid var(--border)"}}>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="text-[10px]" style={{color:"var(--text3)"}}>原始金额</div>
            <div className="text-sm font-semibold">{fmtAmt(originalAmount)}</div>
          </div>
          <div>
            <div className="text-[10px]" style={{color:"var(--text3)"}}>已抵消</div>
            <div className="text-sm font-semibold">{fmtAmt(offsetAmount)}</div>
          </div>
          <div>
            <div className="text-[10px]" style={{color:"var(--text3)"}}>实际支出</div>
            <div className="text-sm font-semibold">{fmtAmt(settlementType === "repayment" ? 0 : effectiveAmount)}</div>
          </div>
        </div>
        <Select value={settlementType} onChange={setSettlementType} options={[
          {v:"none",l:"普通消费"},
          {v:"advance",l:"我先代付"},
          {v:"repayment",l:"对方还款"},
          {v:"aa_payment",l:"我付 AA 款"}
        ]} />
        <Input value={settlementPerson} onChange={setSettlementPerson} placeholder="结算对象（可选）" />
        <div className="flex justify-between text-xs" style={{color:"var(--text3)"}}>
          <span>{settlementLabel[settlementType]} · {statusLabel[txn.settlementStatus || "none"]}</span>
          {txn.linkedTransactionId && <span>已关联还款记录</span>}
        </div>
      </div>
      {txn.settlementType === "repayment" && txn.settlementStatus !== "matched" && (
        <div className="rounded-xl p-3 space-y-2" style={{background:"rgba(var(--accent-rgb),0.08)",border:"1px solid rgba(var(--accent-rgb),0.2)"}}>
          <div className="text-xs font-medium" style={{color:"var(--accent)"}}>可绑定的最近代付</div>
          {settlementCandidates.length ? settlementCandidates.map(c => (
            <button key={c.id} onClick={()=>onConfirmSettlement?.(txn.id, c.id)}
              className="w-full text-left rounded-lg px-3 py-2 text-xs"
              style={{background:"var(--card)",border:"1px solid var(--border)",color:"var(--text)"}}>
              <div className="font-medium">{fmtDate(c.date)} · {c.merchant}</div>
              <div style={{color:"var(--text3)"}}>剩余 {fmtAmt(statAmount(c))} / 原始 {fmtAmt(c.originalAmount ?? c.amount)}</div>
            </button>
          )) : <div className="text-xs" style={{color:"var(--text3)"}}>最近 14 天没有可匹配的代付记录</div>}
        </div>
      )}
      <div className="flex items-center justify-between py-1">
        <span className="text-sm">排除统计</span>
        <button onClick={()=>setExcl(!excl)} className="w-10 h-6 rounded-full relative transition-colors"
          style={{background:excl?"var(--accent)":"var(--border)"}}>
          <div className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all" style={{left:excl?18:2}} />
        </button>
      </div>
      {catM !== txn.categoryMain && catM && (
        <label className="flex items-center gap-2 text-xs" style={{color:"var(--text2)"}}>
          <input type="checkbox" checked={askRule} onChange={e=>setAskRule(e.target.checked)} />
          同时保存为分类规则（关键词:「{merchant}」）
        </label>
      )}
      <div className="flex gap-2 pt-2">
        <Btn danger small onClick={onDelete}>删除</Btn>
        <div className="flex-1" />
        <Btn primary onClick={save}>保存</Btn>
      </div>
    </div>
  );
}

function RuleEditForm({ rule, onSave, onCancel }) {
  const [kw, setKw] = useState(rule.keyword);
  const [mt, setMt] = useState(rule.matchType||"contains");
  const [catM, setCatM] = useState(rule.catMain);
  const [catS, setCatS] = useState(rule.catSub);
  const [pmC, setPmC] = useState(rule.pmCondition||"");
  const [pri, setPri] = useState(rule.priority||10);
  const [en, setEn] = useState(rule.enabled!==false);

  return (
    <div className="space-y-3">
      <Input value={kw} onChange={setKw} placeholder="匹配关键词" />
      <Select value={mt} onChange={setMt} options={[{v:"contains",l:"包含匹配"},{v:"exact",l:"完全一致"}]} />
      <CatPicker main={catM} sub={catS} onMainChange={setCatM} onSubChange={setCatS} />
      <Select value={pmC} onChange={setPmC} placeholder="不限支付方式" options={PM_LIST} />
      <div className="flex items-center gap-2">
        <span className="text-sm shrink-0">优先级</span>
        <Input type="number" value={pri} onChange={v=>setPri(Number(v))} />
      </div>
      <div className="flex items-center justify-between py-1">
        <span className="text-sm">启用</span>
        <button onClick={()=>setEn(!en)} className="w-10 h-6 rounded-full relative transition-colors"
          style={{background:en?"var(--accent)":"var(--border)"}}>
          <div className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all" style={{left:en?18:2}} />
        </button>
      </div>
      <div className="flex gap-2 pt-2">
        <Btn onClick={onCancel}>取消</Btn>
        <Btn primary onClick={()=>onSave({...rule,keyword:kw,matchType:mt,catMain:catM,catSub:catS,pmCondition:pmC,priority:pri,enabled:en})} disabled={!kw||!catM}>保存</Btn>
      </div>
    </div>
  );
}
