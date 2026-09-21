/**
 * payroll_employees.social_insurance を直す (2026-09-21)。
 *
 *   node migrations/fix_employee_social_insurance.mjs            # DRY RUN
 *   node migrations/fix_employee_social_insurance.mjs --execute
 *
 * なぜ: 処遇改善補助金手当 (月 ¥20,000) は 訪問介護 × 社保加入 × 当月実績あり に出る
 *   (treatmentSubsidyAmount)。総括表 2026-03〜07 を全数突合すると
 *   社保あり 464/517 = 89.7% / 社保なし 41/2,050 = 2.0% で この規則どおり。
 *   当方の社保フラグが落ちている人だけ 手当が 0 円になっていた。
 *
 * ⚠ social_insurance は 給与計算では 処遇改善補助金手当の判定にしか使っていない
 *   (他は 職員一覧の表示と CSV 入出力)。
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

/** 直す人。根拠を必ず書く */
const TARGETS = [
  { office_number: "1270201930", employee_number: "4089", name: "松元　綾子", to: true,
    why: "総括表 2026-03〜07 の 5 か月とも 処遇改善補助金手当 ¥20,000 が出ている (user 確認 2026-09-21)" },
];

const q = async (path) => {
  const r = await fetch(SB + path, { headers: H });
  if (!r.ok) throw new Error(`${path} → ${await r.text()}`);
  return r.json();
};
const offices = await q("payroll_offices?select=id,office_number");
const byNum = new Map(offices.map((o) => [o.office_number, o.id]));

let changed = 0;
for (const t of TARGETS) {
  const oid = byNum.get(t.office_number);
  if (!oid) { console.error(`✗ 事業所が引けない: ${t.office_number}`); process.exit(1); }
  const rows = await q(`payroll_employees?office_id=eq.${oid}&employee_number=eq.${t.employee_number}&select=id,name,social_insurance,role_type,salary_type,job_type`);
  if (rows.length !== 1) { console.error(`✗ 1 名に絞れない (${rows.length} 件): ${t.office_number} ${t.employee_number}`); process.exit(2); }
  const e = rows[0];
  const nameOk = String(e.name).replace(/[\s　]/g, "") === String(t.name).replace(/[\s　]/g, "");
  if (!nameOk) { console.error(`✗ 氏名が違う: DB「${e.name}」/ 指定「${t.name}」`); process.exit(2); }
  console.log(`${e.name} (${t.office_number} ${t.employee_number}) ${e.role_type}/${e.salary_type}/${e.job_type}`);
  console.log(`   social_insurance: ${e.social_insurance} → ${t.to}`);
  console.log(`   根拠: ${t.why}`);
  if (e.social_insurance === t.to) { console.log("   → 既にその値。何もしない"); continue; }
  changed++;
  if (!EXECUTE) continue;
  const r = await fetch(`${SB}payroll_employees?id=eq.${e.id}`, {
    method: "PATCH", headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify({ social_insurance: t.to }),
  });
  if (!r.ok) { console.error(`✗ 更新失敗: ${await r.text()}`); process.exit(1); }
  console.log("   → 更新した");
}
console.log(`\n対象 ${TARGETS.length} 名 / 変更 ${changed} 名`);
if (!EXECUTE) console.log("DRY RUN (--execute で書き込み)");
