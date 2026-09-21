/**
 * 月給者の社会保険フラグを true にそろえる (2026-09-21)。
 *
 *   node migrations/fix_monthly_staff_social_insurance.mjs            # DRY RUN
 *   node migrations/fix_monthly_staff_social_insurance.mjs --execute
 *
 * 根拠: 月給者はみな社会保険に加入している (user 2026-09-21)。
 *   当方は 月給 366 名中 357 名が false = ★ そもそも保守されていなかった
 *   (true の 9 名は 社員番号が 2604xx 形式 = 2026-04 入社。新規登録のときだけ入れていたと思われる)。
 *
 * 対象は ★ 訪問介護の 23 事業所 × 職種「訪問介護」× 役職がパートでない 在職者 に絞る:
 *   ・居宅など別事業所の 10 名は 今回の突合対象外
 *   ・訪問入浴の 1 名 (おゆみ野 髙山洋) も対象外
 *   ・役職「パート」なのに月給の 5 名は 役職と給与形態が食い違っており 要確認なので外す
 *     (茂原 48 酒井絹恵 / 山武 251002 堀内歩那 / 大網 209 長谷川初子 /
 *      やわた 260101 磯貝彩乃 / 五井 231101 小林克代)
 *
 * ⚠ social_insurance を給与計算で見ているのは
 *   ・処遇改善補助金手当 (treatmentSubsidyAmount)
 *   ・通信手当 (communicationFeeAmount)
 *   のどちらも **時給者のループの中だけ**。月給者の金額は これを直しても変わらない。
 *   直すのは 職員一覧の表示・CSV と、月の途中で 時給→月給 に変わる人のため。
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
async function all(q) {
  const out = [];
  for (let o = 0; ; o += 1000) {
    const r = await fetch(`${SB}${q}&order=id&limit=1000&offset=${o}`, { headers: H });
    if (!r.ok) throw new Error(`${q} → ${await r.text()}`);
    const j = await r.json(); out.push(...j);
    if (j.length < 1000) break;
  }
  return out;
}
/** 訪問介護の 23 事業所 */
const OFF23 = new Set(["1270501180", "1270203191", "1270201930", "1270402116", "1270303173", "1270105271", "1270906546", "1272603851", "1272404508", "1272401967", "1272400142", "1272403534", "1272400829", "1271500942", "1278600398", "1279000366", "1275800892", "1271101295", "1272401561", "1273400844", "1273001626", "1271502518", "1271502500"]);
const po = await all("payroll_offices?select=id,office_number");
const numById = new Map(po.map((o) => [o.id, o.office_number]));
const es = await all("payroll_employees?select=id,employee_number,name,office_id,role_type,job_type,salary_type,social_insurance,employment_status");
const monthly = es.filter((e) => e.salary_type === "月給");
const target = monthly.filter((e) =>
  e.social_insurance !== true &&
  e.employment_status === "在職者" &&
  OFF23.has(numById.get(e.office_id)) &&
  e.job_type === "訪問介護" &&
  e.role_type !== "パート");
const skipped = monthly.filter((e) => e.social_insurance !== true && !target.includes(e));
console.log(`月給者 ${monthly.length} 名 / 社保が true でない ${monthly.filter((e) => e.social_insurance !== true).length} 名`);
console.log(`  → 対象 ${target.length} 名 (訪問介護23事業所 × 職種訪問介護 × 役職パート以外 × 在職者)`);
console.log(`  → 対象外 ${skipped.length} 名 (退職者 ${skipped.filter((e) => e.employment_status !== "在職者").length} / 別事業所・訪問入浴・パート役職 ${skipped.filter((e) => e.employment_status === "在職者").length})`);
for (const e of skipped.filter((e) => e.employment_status === "在職者"))
  console.log(`     除外: ${numById.get(e.office_id)} ${e.employee_number} ${e.name} ${e.role_type}/${e.job_type}`);
if (!EXECUTE) { console.log("\nDRY RUN (--execute で書き込み)"); process.exit(0); }
for (let i = 0; i < target.length; i += 100) {
  const ids = target.slice(i, i + 100).map((e) => e.id);
  const r = await fetch(`${SB}payroll_employees?id=in.(${ids.join(",")})`, {
    method: "PATCH", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify({ social_insurance: true }),
  });
  if (!r.ok) { console.error(`✗ 更新失敗 (${i}件目〜): ${await r.text()}`); process.exit(1); }
}
console.log(`完了 ${target.length} 名`);
