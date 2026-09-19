/**
 * リンクス茂原の総括表 (社員シート) の「入浴時間」(分) を payroll_monthly_inputs (bath_minutes) に入れる (2026-09-19)。
 *
 *   node migrations/set_bath_minutes_from_soukatsu.mjs            # DRY RUN
 *   node migrations/set_bath_minutes_from_soukatsu.mjs --execute
 *
 * 値は 総括表 xlsm (scratchpad にコピーしたもの) の extract から。Box の元ファイルには触っていない。
 * 総括表の式: 介護超過 = (訪問時間 + 入浴時間 − 120h) × 2,500 (木村 2026-03: 8,440 + 1,500 分 → 114,167 円)。
 * 3〜7月の全事業所で 入浴時間 が入っているのは この 4 件だけ。冪等 (upsert)。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const OFFICE = "1271500942"; // リンクスヘルパーステーション茂原
const MINUTES = {
  "202603": { 250201: 1500 },
  "202604": { 250201: 210 },
  "202606": { 260403: 990 },
  "202607": { 260403: 2310 },
};

const env = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

const cur = await fetch(`${SB}/rest/v1/payroll_monthly_inputs?select=employee_number,processing_month,numeric_value&office_number=eq.${OFFICE}&item_key=eq.bath_minutes`, { headers: H });
if (!cur.ok) { console.error(`★ 読めません: ${await cur.text()}`); process.exit(2); }
const have = new Map((await cur.json()).map((r) => [`${r.processing_month}|${r.employee_number}`, Number(r.numeric_value)]));

const rows = [];
for (const [m, byEmp] of Object.entries(MINUTES)) {
  for (const [emp, n] of Object.entries(byEmp)) {
    if (have.get(`${m}|${emp}`) === n) continue;
    rows.push({ office_number: OFFICE, employee_number: emp, processing_month: m, item_key: "bath_minutes", numeric_value: n,
      note: "総括表 入浴時間 から (set_bath_minutes_from_soukatsu.mjs)", updated_at: new Date().toISOString() });
    console.log(`${m} ${emp}: ${have.get(`${m}|${emp}`) ?? "なし"} → ${n} 分`);
  }
}
console.log(`書き込み ${rows.length} 件`);
if (!EXECUTE) { console.log("DRY RUN (--execute で書き込み)"); process.exit(0); }
if (rows.length === 0) process.exit(0);
const r = await fetch(`${SB}/rest/v1/payroll_monthly_inputs?on_conflict=office_number,employee_number,processing_month,item_key`, {
  method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(rows) });
if (!r.ok) { console.error(`★ 失敗: ${await r.text()}`); process.exit(1); }
console.log(`完了 ${(await r.json()).length} 件`);
