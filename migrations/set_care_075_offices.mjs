/**
 * 社員の介護超過で 0.75 掛けの減算をする事業所 (Hana 系) を payroll_app_settings に入れる。
 *
 *   node migrations/set_care_075_offices.mjs            # DRY RUN
 *   node migrations/set_care_075_offices.mjs --execute
 *
 * 根拠 (総括表 2026-03〜07 の社員の「介護」列。訪問時間は同行込み、HRD 研修の時間を足す):
 *   0.75 の減算なし・100〜120h×800円＋120h超×2,500円: 五井 11/11・姉ム 14/14・市原 13/13・木更津 20/20・やわた 13/13・KT姉崎 24/25・袖ケ浦 35/43・君津 13/15
 *   0.75 の減算なし・120h超×2,500円のみ: ちはら台 20/20・いすみ 29/35・山武 7/8・東郷 23/25・茂原 40/49・大網 23/28
 *   0.75 の減算あり: Hana 系 (さつき・高品で 2026-09-17 に確認。総括表に「*0.75h」列がある事業所)
 * ⚠ 給与計算画面より先に入れること (無いと Hana 系も減算しなくなる)
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
const KEY_NAME = "care_075_offices";
// 花見川・おゆみ野・高品・さつき・中央・四街道・船橋・八千代 (Hana 系)
const want = { offices: ["1270201930", "1270501180", "1270402116", "1270203191", "1270105271", "1270303173", "1270906546", "1272603851"] };
const r = await fetch(`${SB_URL}/rest/v1/payroll_app_settings?select=key,value&key=eq.${KEY_NAME}`, { headers: H });
if (!r.ok) { console.error(await r.text()); process.exit(1); }
const [cur] = await r.json();
console.log(`=== 介護超過の 0.75 掛け減算をする事業所 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===\n  現在: ${JSON.stringify(cur?.value ?? null)}\n  設定: ${JSON.stringify(want)}`);
if (JSON.stringify(cur?.value) === JSON.stringify(want)) { console.log("同じなので何もしない"); process.exit(0); }
if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }
const w = await fetch(`${SB_URL}/rest/v1/payroll_app_settings?on_conflict=key`, { method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify({ key: KEY_NAME, value: want, updated_at: new Date().toISOString() }) });
if (!w.ok) { console.error(await w.text()); process.exit(1); }
if ((await w.json()).length !== 1) { console.error("★ 1 行になっていない"); process.exit(2); }
console.log("完了");
