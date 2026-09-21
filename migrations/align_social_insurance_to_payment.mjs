/**
 * 月ごとの社会保険 (処遇改善補助金の判定) を 総括表の支払い側 (② 印字シート = extract.json) に合わせる。
 *
 *   SP=<scratchpad> node migrations/align_social_insurance_to_payment.mjs            # DRY RUN
 *   SP=<scratchpad> node migrations/align_social_insurance_to_payment.mjs --execute
 *
 * 経緯 (2026-09-21):
 *   import_social_insurance_monthly.mjs は ① 総括表データ_パート (旧システムの出力) の補助金から月別の社保を作った。
 *   ② (実際の支払い) は ① に手で補助金を足していることがある。2026-03〜07 で 17 人月:
 *     さつき 福島可奈 5か月 / 市原ムツミ 中村素子 5か月 / 同 片岡久美子 03 / 東郷 仁見初江 04 /
 *     新人の入社月 (東郷 安藤仁海 05 / 五井 山下愛望 06 / 茂原 杉尾加奈子 06 / 山武 童子悦 07) / 大網 橋本光代 05
 *   user 方針「基本は金額に合わせてほしい」(2026-09-21) → ② に補助金があれば 1。
 * 対象: 当方の判定 (月別があれば月別、無ければ職員マスタ) が 0 で、② に補助金がある人月だけ。
 *   逆向き (当方 1 / ② 0) は兼務者の同一番号 2 行 (花見川の「松元綾子_高品」) で誤判定になるので触らない
 *   (兼務は fix_kenmu_social_insurance_monthly.mjs で個別に直した)。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const S = process.env.SP;
if (!S) { console.error("✗ SP に soukatsu<YYYYMM>/extract.json のある作業ディレクトリを渡してください"); process.exit(1); }
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
const page = async (q) => {
  let out = [], from = 0;
  for (;;) {
    const r = await fetch(`${SB_URL}/rest/v1/${q}&order=id`, { headers: { ...H, Range: `${from}-${from + 999}` } });
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(JSON.stringify(j));
    out = out.concat(j);
    if (j.length < 1000) break;
    from += 1000;
  }
  return out;
};
// extract.json の office (フォルダ名) → 事業所番号 (訪問介護 22 事業所)
const OFF = { "04_おゆみ野": "1270501180", "06_さつき": "1270203191", "02_花見川": "1270201930", "05_高品": "1270402116", "11_Hana四街道": "1270303173", "06_Hana中央": "1270105271", "04_Hana船橋": "1270906546", "10_Hana八千代": "1272603851", "03_やわた": "1272404508", "03_五井": "1272401967", "01_KT姉崎": "1272400142", "05_Hanaちはら台": "1272403534", "01_姉崎ムツミ": "1272400829", "リンクス茂原": "1271500942", "08_いすみ": "1278600398", "09_山武": "1279000366", "リンクス大網": "1275800892", "03_木更津ムツミ": "1271101295", "02_市原ムツミ": "1272401561", "07_袖ケ浦": "1273400844", "14_君津": "1273001626", "13_東郷": "1271502518" };
const MONTHS = ["202603", "202604", "202605", "202606", "202607"];
const nn = (s) => String(s ?? "").replace(/^0+/, "");

const offices = await page("payroll_offices?select=id,office_number");
const offIdByNum = new Map(offices.map((o) => [o.office_number, o.id]));
const empSI = new Map();
for (const e of await page("payroll_employees?select=id,employee_number,office_id,social_insurance")) empSI.set(`${e.office_id}|${nn(e.employee_number)}`, !!e.social_insurance);
const monthly = new Map();
for (const r of await page("payroll_monthly_inputs?item_key=eq.social_insurance&select=id,office_number,employee_number,processing_month,numeric_value"))
  monthly.set(`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, Number(r.numeric_value ?? 0) > 0);

const rows = [];
for (const m of MONTHS) {
  const ex = JSON.parse(readFileSync(`${S}/soukatsu${m}/extract.json`, "utf8"));
  for (const f of ex) {
    const on = OFF[f.office];
    if (f.kind !== "part" || !on) continue;
    for (const r of f.rows) {
      const code = nn(r._code ?? r["№"]);
      if (!code || String(r._code ?? "").includes("合計")) continue;
      if (!(Number(r["処遇改善補助金手当"] || 0) > 0)) continue;
      const k = `${on}|${code}|${m}`;
      const ours = monthly.has(k) ? monthly.get(k) : empSI.get(`${offIdByNum.get(on)}|${code}`);
      if (ours === undefined || ours) continue;
      rows.push({ office_number: on, employee_number: code, processing_month: m, item_key: "social_insurance", numeric_value: 1,
        note: `総括表 ② (支払) ${m} 処遇改善補助金手当 ${r["処遇改善補助金手当"]} に合わせる (① には無し)`, _name: r["氏名"], _office: f.office });
    }
  }
}
console.log(`=== 社保 (月別) を支払いに合わせる ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
for (const r of rows) console.log(`  ${r.processing_month} ${r._office} ${r.employee_number} ${r._name}: 0 → 1`);
console.log(`  ${rows.length} 行`);
if (!EXECUTE || rows.length === 0) process.exit(0);
const body = rows.map(({ _name, _office, ...x }) => { void _name; void _office; return x; });
const up = await fetch(`${SB_URL}/rest/v1/payroll_monthly_inputs?on_conflict=office_number,employee_number,processing_month,item_key`, {
  method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body),
});
const res = await up.json();
if (!up.ok || !Array.isArray(res)) { console.error("書込失敗:", res); process.exit(1); }
console.log(`  反映 ${res.length} 行`);
if (res.length !== rows.length) { console.error(`★ 件数不一致 (期待 ${rows.length})`); process.exit(1); }
