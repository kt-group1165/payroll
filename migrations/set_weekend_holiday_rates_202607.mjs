/**
 * 土日祝手当の時給 (事業所ごと) を payroll_app_settings に入れる。
 *
 *   node migrations/set_weekend_holiday_rates_202607.mjs            # DRY RUN
 *   node migrations/set_weekend_holiday_rates_202607.mjs --execute
 *
 * 根拠: 総括表 2026-07 の時給者「土日祝」と、当方の 50円/時 の計算の比。
 *   Hana系 (花見川・船橋・おゆみ野・高品・中央・さつき・八千代・四街道) は差なし = 50円 (設定しない)。
 *   下の 14 事業所はほとんどの職員でちょうど 2 倍 = 100円。
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

const KEY_NAME = "weekend_holiday_allowance_rates";
const RATES = Object.fromEntries([
  "1278600398", // いすみ
  "1279000366", // 山武
  "1271502518", // 東郷
  "1275800892", // 大網
  "1271500942", // 茂原
  "1272401561", // 市原ムツミ
  "1272400142", // KT姉崎
  "1272400829", // 姉崎ムツミ
  "1272401967", // KT五井
  "1271101295", // 木更津ムツミ
  "1272403534", // ちはら台
  "1273400844", // 袖ケ浦ムツミ
  "1273001626", // 君津ムツミ
  "1272404508", // KTやわた
].map((no) => [no, 100]));

const r = await fetch(`${SB_URL}/rest/v1/payroll_app_settings?select=key,value&key=eq.${KEY_NAME}`, { headers: H });
if (!r.ok) { console.error(await r.text()); process.exit(1); }
const [cur] = await r.json();
const want = { rates: RATES };
console.log(`=== 土日祝手当の時給 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log(`  現在: ${JSON.stringify(cur?.value ?? null)}`);
console.log(`  設定: ${JSON.stringify(want)}`);
if (JSON.stringify(cur?.value) === JSON.stringify(want)) { console.log("同じなので何もしない"); process.exit(0); }
if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }
const w = await fetch(`${SB_URL}/rest/v1/payroll_app_settings?on_conflict=key`, { method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify({ key: KEY_NAME, value: want, updated_at: new Date().toISOString() }) });
if (!w.ok) { console.error(await w.text()); process.exit(1); }
const rows = await w.json();
if (rows.length !== 1) { console.error(`★ ${rows.length} 行`); process.exit(2); }
console.log("完了");
