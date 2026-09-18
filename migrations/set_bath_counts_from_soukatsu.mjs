/**
 * おゆみ野の総括表 (提責_社員シート) の「訪問件数」= 入浴件数 を payroll_monthly_inputs に入れる (2026-09-18)。
 *
 *   node migrations/set_bath_counts_from_soukatsu.mjs            # DRY RUN
 *   node migrations/set_bath_counts_from_soukatsu.mjs --execute
 *
 * 値は 総括表 xlsm (scratchpad にコピーしたもの) の 訪問件数 列を openpyxl で読んだもの。Box の元ファイルには触っていない。
 * 総括表の式: 時間外h = 訪問時間 − 重度×0.25 + HRD + 1.12 × 訪問件数 − 120 (3〜7月すべて 1.12)
 * 件数の元の記録は未確認 (user 保留 2026-09-18)。
 * 前提 SQL: migrations/payroll_monthly_inputs.sql
 * 冪等 (upsert)。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const OFFICE = "1270501180"; // Ｈａｎａヘルパーステーションおゆみ野
const COUNTS = {
  "202603": { 3037: 33, 3212: 17, 3325: 34, 3136: 109, 3328: 101, 11047: 68 },
  "202604": { 3037: 34, 3212: 20, 3325: 29, 3136: 105, 3328: 97, 11047: 92 },
  "202605": { 3037: 23, 3212: 22, 3325: 51, 3136: 103, 3328: 102, 11047: 73 },
  "202606": { 3037: 31, 3212: 13, 3325: 27, 3136: 110, 3328: 87, 11047: 70 },
  "202607": { 398: 7, 3037: 35, 3212: 23, 3325: 30, 3136: 115, 3328: 102, 11047: 82 },
};

const env = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

const cur = await fetch(`${SB}/rest/v1/payroll_monthly_inputs?select=employee_number,processing_month,numeric_value&office_number=eq.${OFFICE}&item_key=eq.bath_visit_count`, { headers: H });
if (!cur.ok) { console.error(`★ 読めません (SQL 未適用?): ${await cur.text()}`); process.exit(2); }
const have = new Map((await cur.json()).map((r) => [`${r.processing_month}|${r.employee_number}`, Number(r.numeric_value)]));

const rows = [];
for (const [m, byEmp] of Object.entries(COUNTS)) {
  for (const [emp, n] of Object.entries(byEmp)) {
    if (have.get(`${m}|${emp}`) === n) continue;
    rows.push({ office_number: OFFICE, employee_number: emp, processing_month: m, item_key: "bath_visit_count", numeric_value: n,
      note: "総括表 訪問件数 から (set_bath_counts_from_soukatsu.mjs)", updated_at: new Date().toISOString() });
    console.log(`${m} ${emp}: ${have.get(`${m}|${emp}`) ?? "なし"} → ${n} 件`);
  }
}
console.log(`書き込み ${rows.length} 件`);
if (!EXECUTE) { console.log("DRY RUN (--execute で書き込み)"); process.exit(0); }
if (rows.length === 0) process.exit(0);
const r = await fetch(`${SB}/rest/v1/payroll_monthly_inputs?on_conflict=office_number,employee_number,processing_month,item_key`, {
  method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(rows) });
if (!r.ok) { console.error(`★ 失敗: ${await r.text()}`); process.exit(1); }
console.log(`完了 ${(await r.json()).length} 件`);
