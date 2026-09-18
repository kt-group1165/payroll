/**
 * 通勤km・出張km の確認ライン (km/日) を事業所ごとに payroll_app_settings に入れる。
 *
 *   node migrations/set_km_anomaly_lines.mjs            # DRY RUN
 *   node migrations/set_km_anomaly_lines.mjs --execute
 *
 * 決め方 (総括表 2026-03〜07、出勤日数 3 日以上の人): 1 日あたりの距離の 上位 5% の値 × 1.5 を 10 km 単位で切り上げ。
 * 下限 通勤 30 / 出張 60。件数が少ない事業所 (通勤 4 件未満・出張 10 件未満) は既定 (通勤 80 / 出張 180)。
 * この線で総括表を見ると 1,196 人月中 8 件が警告 (船橋 金子 22,816km・高品 櫻井 13,974km など打ち間違いを含む)。
 * 画面では警告を出すだけで計算は止めない (km-anomaly.ts)。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY がありません"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const KEY_NAME = "km_anomaly_lines";
const want = { offices: {"1270105271":{"commute_per_day":30,"trip_per_day":90},"1270201930":{"commute_per_day":80,"trip_per_day":90},"1270203191":{"commute_per_day":80,"trip_per_day":60},"1270303173":{"commute_per_day":30,"trip_per_day":60},"1270402116":{"commute_per_day":30,"trip_per_day":110},"1270501180":{"commute_per_day":90,"trip_per_day":150},"1270906546":{"commute_per_day":30,"trip_per_day":60},"1271101295":{"commute_per_day":40,"trip_per_day":90},"1271500942":{"commute_per_day":30,"trip_per_day":140},"1271502518":{"commute_per_day":30,"trip_per_day":140},"1272400142":{"commute_per_day":80,"trip_per_day":110},"1272400829":{"commute_per_day":30,"trip_per_day":100},"1272401561":{"commute_per_day":40,"trip_per_day":140},"1272401967":{"commute_per_day":80,"trip_per_day":100},"1272403534":{"commute_per_day":90,"trip_per_day":100},"1272404508":{"commute_per_day":30,"trip_per_day":150},"1272603851":{"commute_per_day":80,"trip_per_day":60},"1273001626":{"commute_per_day":30,"trip_per_day":90},"1273400844":{"commute_per_day":30,"trip_per_day":110},"1275800892":{"commute_per_day":30,"trip_per_day":150},"1278600398":{"commute_per_day":70,"trip_per_day":190},"1279000366":{"commute_per_day":30,"trip_per_day":150}} };

const r = await fetch(`${SB_URL}/rest/v1/payroll_app_settings?select=key,value&key=eq.${KEY_NAME}`, { headers: H });
if (!r.ok) { console.error(await r.text()); process.exit(1); }
const [cur] = await r.json();
console.log(`=== 距離の確認ライン ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${Object.keys(want.offices).length} 事業所 ===`);
for (const [on, v] of Object.entries(want.offices)) console.log(`  ${on} 通勤 ${v.commute_per_day} / 出張 ${v.trip_per_day} km/日`);
if (JSON.stringify(cur?.value) === JSON.stringify(want)) { console.log("同じなので何もしない"); process.exit(0); }
if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }
const w = await fetch(`${SB_URL}/rest/v1/payroll_app_settings?on_conflict=key`, { method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify({ key: KEY_NAME, value: want, updated_at: new Date().toISOString() }) });
if (!w.ok) { console.error(await w.text()); process.exit(1); }
if ((await w.json()).length !== 1) { console.error("★ 1 行になっていない"); process.exit(2); }
console.log("完了");
