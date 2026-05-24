import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const smbcParserPatchPlugin = () => ({
  name: "nenei-smbc-parser-patch",
  enforce: "pre",
  transform(code, id) {
    if (!id.endsWith("/src/App.jsx") && !id.endsWith("\\src\\App.jsx")) return null;
    let patched = code;

    patched = patched.replace(
      `  if (h.includes("EPOS") || h.includes("エポス") || h.includes("ご利用店名")) return "EPOS";\n  return "Olive";`,
      `  if (h.includes("EPOS") || h.includes("エポス") || h.includes("ご利用店名")) return "EPOS";\n  if (has("年月日", "お引出し", "お預入れ", "お取り扱い内容")) return "SMBC";\n  return "Olive";`
    );

    patched = patched.replace(
      `    } else if (src === "EPOS") {\n      dateRaw = pick(row, ["ご利用日", "利用日", "日付"]);\n      merchant = pick(row, ["ご利用店名", "利用店名", "ご利用先", "店名"]);\n      amountRaw = pick(row, ["ご利用金額", "利用金額", "金額"]);\n      memo = pick(row, ["備考", "支払区分", "メモ"]);\n    } else {`,
      `    } else if (src === "SMBC") {\n      dateRaw = pick(row, ["年月日", "日付", "取引日", "利用日"]);\n      merchant = pick(row, ["お取り扱い内容", "お取扱内容", "お取引内容", "摘要", "内容"]);\n      memo = pick(row, ["メモ", "ラベル", "お取り扱い内容", "摘要", "内容"]);\n      const outRaw = pick(row, ["お引出し", "出金額", "出金", "支払金額", "金額"]);\n      const inRaw = pick(row, ["お預入れ", "入金額", "入金", "受取金額"]);\n      const outAmount = parseOptionalAmount(outRaw);\n      const inAmount = parseOptionalAmount(inRaw);\n      if (Number.isFinite(outAmount)) {\n        signedAmount = outAmount;\n        amountRaw = outRaw;\n        direction = "out";\n      } else if (Number.isFinite(inAmount)) {\n        signedAmount = -inAmount;\n        amountRaw = inRaw;\n        direction = "in";\n      }\n    } else if (src === "EPOS") {\n      dateRaw = pick(row, ["ご利用日", "利用日", "日付"]);\n      merchant = pick(row, ["ご利用店名", "利用店名", "ご利用先", "店名"]);\n      amountRaw = pick(row, ["ご利用金額", "利用金額", "金額"]);\n      memo = pick(row, ["備考", "支払区分", "メモ"]);\n    } else {`
    );

    patched = patched.replace(
      `    if (src === "PayPay") {\n      const memoText = cleanText(memo);\n      if (direction === "in" && memoText.includes("受け取った金額")) {\n        type = "repayment";\n        excludedFromStats = true;\n      } else if (direction === "in" && memoText.includes("ポイント、残高の獲得")) {\n        type = "excluded";\n        excludedFromStats = true;\n      } else if (direction === "out" && memoText.includes("支払い")) {\n        type = "expense";\n        excludedFromStats = false;\n      } else if (direction === "out" && memoText.includes("送金")) {\n        type = "aa_payment";\n        excludedFromStats = false;\n      } else if (direction === "in") {\n        type = "transfer";\n        excludedFromStats = true;\n      }\n    }\n    const txn = {`,
      `    if (src === "PayPay") {\n      const memoText = cleanText(memo);\n      if (direction === "in" && memoText.includes("受け取った金額")) {\n        type = "repayment";\n        excludedFromStats = true;\n      } else if (direction === "in" && memoText.includes("ポイント、残高の獲得")) {\n        type = "excluded";\n        excludedFromStats = true;\n      } else if (direction === "out" && memoText.includes("支払い")) {\n        type = "expense";\n        excludedFromStats = false;\n      } else if (direction === "out" && memoText.includes("送金")) {\n        type = "aa_payment";\n        excludedFromStats = false;\n      } else if (direction === "in") {\n        type = "transfer";\n        excludedFromStats = true;\n      }\n    }\n    if (src === "SMBC") {\n      const bankText = `${cleanText(merchant)} ${cleanText(memo)}`.toUpperCase();\n      if (direction === "in") {\n        type = "transfer";\n        excludedFromStats = true;\n      }\n      if (bankText.includes("PAYPAY")) {\n        type = "charge";\n        excludedFromStats = true;\n      } else if (bankText.includes("AEON PAY") || bankText.includes("ＡＥＯＮ") || bankText.includes("イオン")) {\n        type = "expense";\n        excludedFromStats = false;\n      }\n    }\n    const txn = {`
    );

    patched = patched.replace(
      `    const settlementType = type === "repayment" ? "repayment" : type === "aa_payment" ? "aa_payment" : "none";`,
      `    if (src === "SMBC") {\n      const bankText = `${cleanText(txn.merchant)} ${cleanText(txn.memo)}`.toUpperCase();\n      if (bankText.includes("AEON PAY") || bankText.includes("ＡＥＯＮ") || bankText.includes("イオン")) {\n        txn.categoryMain = "food";\n        txn.categorySub = "スーパー";\n      }\n    }\n    const settlementType = type === "repayment" ? "repayment" : type === "aa_payment" ? "aa_payment" : "none";`
    );

    return patched === code ? null : { code: patched, map: null };
  },
});

export default defineConfig({
  plugins: [smbcParserPatchPlugin(), react()],
  base: "./",
});
