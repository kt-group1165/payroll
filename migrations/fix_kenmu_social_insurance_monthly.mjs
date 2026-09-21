/**
 * 兼務者の 月ごとの社会保険 (処遇改善補助金の判定) を 支払い側 (総括表 ②) に合わせる。
 *
 *   node migrations/fix_kenmu_social_insurance_monthly.mjs            # DRY RUN
 *   node migrations/fix_kenmu_social_insurance_monthly.mjs --execute
 *
 * 経緯 (2026-09-21):
 *   import_social_insurance_monthly.mjs は 総括表データ_パート (① 旧システムの出力) の補助金から月別の社保を作った。
 *   ① は兼務者に 両方の事業所で補助金を出している:
 *     松元 綾子 4089   花見川 20,000 / 高品 20,000   → 当方も両方で払い ★ 月 40,000 の二重払い
 *     大島 拓也 2155   花見川 20,000 / 高品 なし
 *   支払い側 (② パート_総括表データより) は 松元 = 花見川で 1 回だけ / 大島 = 訪問介護の両事業所とも なし。
 *   → 松元の高品・大島の花見川 を 0 にする (大島の補助金は入浴側で払っているか確認中: questions.md 60)。
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
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" };
const MONTHS = ["202603", "202604", "202605", "202606", "202607"];
const TARGETS = [
  { office: "1270402116", emp: "4089", name: "松元 綾子 (高品)", note: "兼務: 補助金は花見川で1回だけ払う (総括表 ② / ① は両事業所で出していた)" },
  { office: "1270201930", emp: "2155", name: "大島 拓也 (花見川)", note: "兼務: 総括表 ② では訪問介護の両事業所とも補助金なし (① だけ花見川に出ていた)" },
];

console.log(`=== 兼務者の月別社保 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
const rows = [];
for (const t of TARGETS) {
  const r = await fetch(`${SB_URL}/rest/v1/payroll_monthly_inputs?select=id,processing_month,numeric_value&item_key=eq.social_insurance&office_number=eq.${t.office}&employee_number=eq.${t.emp}&processing_month=in.(${MONTHS.join(",")})`, { headers: H });
  const cur = await r.json();
  if (!Array.isArray(cur)) { console.error("読込失敗:", cur); process.exit(1); }
  for (const m of MONTHS) {
    const c = cur.find((x) => x.processing_month === m);
    console.log(`  ${t.name} ${m}: ${c ? c.numeric_value : "(無し)"} → 0`);
    rows.push({ office_number: t.office, employee_number: t.emp, processing_month: m, item_key: "social_insurance", numeric_value: 0, note: t.note });
  }
}
if (!EXECUTE) { console.log(`DRY RUN: ${rows.length} 行。--execute で反映`); process.exit(0); }
const up = await fetch(`${SB_URL}/rest/v1/payroll_monthly_inputs?on_conflict=office_number,employee_number,processing_month,item_key`, {
  method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(rows),
});
const res = await up.json();
if (!up.ok || !Array.isArray(res)) { console.error("書込失敗:", res); process.exit(1); }
console.log(`  反映 ${res.length} 行`);
if (res.length !== rows.length) { console.error(`★ 件数不一致 (期待 ${rows.length})`); process.exit(1); }
