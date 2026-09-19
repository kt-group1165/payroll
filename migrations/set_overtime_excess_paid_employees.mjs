/**
 * 固定残業代を超えた分を払う提責 (総括表「提責・事務」= 1) を payroll_app_settings に入れる (2026-09-19)。
 *
 *   node migrations/set_overtime_excess_paid_employees.mjs            # DRY RUN
 *   node migrations/set_overtime_excess_paid_employees.mjs --execute
 *
 * 総括表 2026-03〜07 で 区分 1 だった 7 名。区分 3 (96 名) は超過分を払わない (当方の既定)。冪等。
 */
import { readFileSync } from "node:fs";
const EXECUTE = process.argv.includes("--execute");
const VALUE = {
  "1272401561": ["1056"],            // 市原ムツミ 角津 恵梨
  "1270402116": ["260606"],          // 高品 岡林 真美
  "1272603851": ["260202"],          // 八千代 田中 恵
  "1270303173": ["260204", "260411"],// 四街道 金 香蘭 / 秋元 環
  "1275800892": ["230801"],          // 大網 髙橋 久江
  "1271500942": ["398"],             // 茂原 吉野 陽子
};
const env = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL + "/rest/v1/";
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
const cur = await (await fetch(`${SB}payroll_app_settings?select=value&key=eq.overtime_excess_paid_employees`, { headers: H })).json();
console.log("現在:", JSON.stringify(cur[0]?.value ?? null));
console.log("入れる:", JSON.stringify(VALUE));
if (JSON.stringify(cur[0]?.value ?? null) === JSON.stringify(VALUE)) { console.log("変更なし"); process.exit(0); }
if (!EXECUTE) { console.log("DRY RUN (--execute で書き込み)"); process.exit(0); }
const r = await fetch(`${SB}payroll_app_settings?on_conflict=key`, { method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates" },
  body: JSON.stringify({ key: "overtime_excess_paid_employees", value: VALUE, updated_at: new Date().toISOString() }) });
if (!r.ok) { console.error(`★ 失敗: ${await r.text()}`); process.exit(1); }
console.log("完了");
