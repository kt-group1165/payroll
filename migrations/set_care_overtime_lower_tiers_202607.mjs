/**
 * 社員の介護超過の下の段 (100〜120h × 800円/時) がある事業所を payroll_app_settings に入れる。
 *
 *   node migrations/set_care_overtime_lower_tiers_202607.mjs            # DRY RUN
 *   node migrations/set_care_overtime_lower_tiers_202607.mjs --execute
 *
 * 根拠: 総括表 2026-03〜07 の社員 (提責・事務 が空) の「介護」列が
 *   round(max(0, min(h,120) − 100) × 800) + round(max(0, h − 120) × 2,500) と一致する事業所 (8)。
 *   KT姉崎 16/25 / 姉崎ムツミ 10/14 / 市原 10/13 / やわた 13/13 / 五井 11/11 / 木更津 16/20 / 袖ケ浦 35/43 / 君津 13/15 (0.75掛けを無視した概算での一致数)
 *   ちはら台・いすみ・山武・東郷・大網・茂原・さつき・高品 は 120h 超 × 2,500 だけ。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY がありません"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

const KEY_NAME = "care_overtime_lower_tiers";
const TIER = { from_hours: 100, unit_price: 800 };
const want = { tiers: Object.fromEntries(["1272400142", "1272400829", "1272401561", "1272404508", "1272401967", "1271101295", "1273400844", "1273001626"].map((no) => [no, TIER])) };

const r = await fetch(`${SB_URL}/rest/v1/payroll_app_settings?select=key,value&key=eq.${KEY_NAME}`, { headers: H });
if (!r.ok) { console.error(await r.text()); process.exit(1); }
const [cur] = await r.json();
console.log(`=== 介護超過の下の段 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log(`  現在: ${JSON.stringify(cur?.value ?? null)}`);
console.log(`  設定: ${JSON.stringify(want)}`);
if (JSON.stringify(cur?.value) === JSON.stringify(want)) { console.log("同じなので何もしない"); process.exit(0); }
if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }
const w = await fetch(`${SB_URL}/rest/v1/payroll_app_settings?on_conflict=key`, { method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify({ key: KEY_NAME, value: want, updated_at: new Date().toISOString() }) });
if (!w.ok) { console.error(await w.text()); process.exit(1); }
if ((await w.json()).length !== 1) { console.error("★ 更新を確認できません"); process.exit(2); }
console.log("完了");
