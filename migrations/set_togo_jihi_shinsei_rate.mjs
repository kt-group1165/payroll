/**
 * 東郷の「自費身生」の時給を入れる (2026-09-23 user「入れて」)。
 *
 *   node migrations/set_togo_jihi_shinsei_rate.mjs            # DRY RUN
 *   node migrations/set_togo_jihi_shinsei_rate.mjs --execute
 *
 * 時給が無いと その訪問が 0 円になる。東郷の 012350「自費（身生）」19 件 (3〜7月) が 0 円だった。
 *
 * 1,750 円/時 の根拠 (どれも実データ):
 *   ① 自費生活 == 生活援助 が 12/12 事業所で一致 (袖ケ浦・東郷・いすみ・大網・山武・茂原・中央・
 *      木更津・君津・ちはら台・八千代・姉崎ムツミ)。自費は「保険外だが同じ仕事」で時給が同じ
 *   ② 東郷の 身体生活 = 1,750 円/時
 *   ③ 総括表①②の 東郷 木村陽子 2026-06 の差 8,750 円 ÷ 5 時間 = 1,750 円/時 で一致
 *
 * ⚠ 「時給が無ければ別の類型を見る」フォールバックは入れない (user 2026-09-23)。
 *    代用すると 金額は出るが 間違っていても気づけない。0 円のままにして 給与計算の画面に出す。
 * 冪等: 既に同じ値なら触らない。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const OFFICE_NUMBER = "1271502518";   // リンクスヘルパーステーション東郷
const CATEGORY = "自費身生";
const RATE = 1750;
const EFFECTIVE_FROM = "2000-01-01";  // 他の類型と同じ (期間を分けない)

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
const get = async (q) => {
  const r = await fetch(`${SB_URL}/rest/v1/${q}`, { headers: H });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(JSON.stringify(j));
  return j;
};

const offs = await get(`payroll_offices?select=id,office_number&office_number=eq.${OFFICE_NUMBER}`);
if (offs.length !== 1) { console.error(`★ 事業所 ${OFFICE_NUMBER} が ${offs.length} 件`); process.exit(1); }
const cats = await get(`payroll_service_categories?select=id,name&name=eq.${encodeURIComponent(CATEGORY)}`);
if (cats.length !== 1) { console.error(`★ 類型「${CATEGORY}」が ${cats.length} 件`); process.exit(1); }
const officeId = offs[0].id, categoryId = cats[0].id;

const now = await get(`payroll_category_hourly_rates?select=id,hourly_rate,effective_from&office_id=eq.${officeId}&category_id=eq.${categoryId}`);
// 参考: 同じ事業所の 身体生活 (根拠②)
const ref = await get(`payroll_service_categories?select=id,name&name=eq.${encodeURIComponent("身体生活")}`);
const refRate = ref.length === 1
  ? (await get(`payroll_category_hourly_rates?select=hourly_rate&office_id=eq.${officeId}&category_id=eq.${ref[0].id}`))[0]?.hourly_rate
  : null;

console.log(`=== 東郷 × ${CATEGORY} の時給 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log(`  今の設定: ${now.length === 0 ? "無し (= 訪問が 0 円になる)" : now.map((r) => `${r.hourly_rate} 円 (${r.effective_from})`).join(" / ")}`);
console.log(`  入れる値: ${RATE} 円/時  (参考: 同じ事業所の 身体生活 = ${refRate ?? "?"} 円/時)`);
if (now.some((r) => Number(r.hourly_rate) === RATE)) { console.log("  既に同じ値なので触りません"); process.exit(0); }
if (now.length > 0) { console.log("  ★ 既に別の値が入っています。上書きせず終わります (画面で直してください)"); process.exit(0); }
if (!EXECUTE) { console.log("DRY RUN。--execute で書き込みます"); process.exit(0); }

const res = await fetch(`${SB_URL}/rest/v1/payroll_category_hourly_rates?on_conflict=office_id,category_id,effective_from`, {
  method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" },
  body: JSON.stringify([{ office_id: officeId, category_id: categoryId, hourly_rate: RATE, effective_from: EFFECTIVE_FROM }]),
});
const b = await res.json();
if (!res.ok || !Array.isArray(b) || b.length !== 1) { console.error("★ 書き込みに失敗:", b); process.exit(1); }
console.log(`  反映しました (${RATE} 円/時)。東郷の給与計算を実行し直すと 0 円だった訪問に単価が付きます`);
