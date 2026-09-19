/**
 * 船橋 (1270906546) の 重度訪問 の時給を 1,700 → 1,750 円にする (2026-09-19)。
 *
 *   node migrations/set_funabashi_juho_rate.mjs            # DRY RUN
 *   node migrations/set_funabashi_juho_rate.mjs --execute
 *
 * 根拠: 総括表 2026-03〜07 の 本人給 (集計項目小計) の差が 重度訪問の分数 × 50円/時 と全員・全月で一致
 *   鍬本 1,086/2,272/2,907/2,721/3,184 (重度 1,305/2,730/3,495/3,225/3,825 分) / 岡部 150・300 / 清水 175・62・575・87 / 手塚 50
 * 冪等。
 */
import { readFileSync } from "node:fs";
const EXECUTE = process.argv.includes("--execute");
const env = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL + "/rest/v1/";
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
const get = async (p) => { const r = await fetch(SB + p, { headers: H }); if (!r.ok) throw new Error(`${p}: ${await r.text()}`); return r.json(); };
const off = (await get("payroll_offices?select=id&office_number=eq.1270906546"))[0];
const cat = (await get("payroll_service_categories?select=id&name=eq.重度訪問"))[0];
const row = (await get(`payroll_category_hourly_rates?select=id,hourly_rate&office_id=eq.${off.id}&category_id=eq.${cat.id}`))[0];
if (!row) { console.error("★ 行がありません"); process.exit(1); }
console.log(`船橋 重度訪問: ${row.hourly_rate} → 1750`);
if (row.hourly_rate === 1750) { console.log("変更なし"); process.exit(0); }
if (!EXECUTE) { console.log("DRY RUN (--execute で書き込み)"); process.exit(0); }
const r = await fetch(`${SB}payroll_category_hourly_rates?id=eq.${row.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ hourly_rate: 1750 }) });
if (!r.ok) { console.error(`★ 失敗: ${await r.text()}`); process.exit(1); }
console.log("完了");
