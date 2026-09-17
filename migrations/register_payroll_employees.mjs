/**
 * 稼働表 / 総括表 に居るのに payroll_employees に未登録の職員を登録する。
 *
 *   node migrations/register_payroll_employees.mjs <list.json>            # DRY RUN
 *   node migrations/register_payroll_employees.mjs <list.json> --execute
 *
 * list.json = { "office_number": "1270203191", "employees": [
 *   { "employee_number": "260409", "name": "岩田 ゆきよ", "salary_type": "時給",
 *     "employment_status": "在職者", "social_insurance": false, "source": "稼働表+総括表パート" } ] }
 *
 * - 職員番号は全社で一意ではない (別法人に同じ番号の別人がいる)。重複判定は (番号, 事業所) で行う
 * - 画面 (/employees) の新規登録と同じ既定値。住所・入社日・資格・勤続月数は空 (後で画面から入れる)
 * - member_id は付けない (members に該当者が居ない前提。居る場合は画面で紐付ける)
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const LIST = args.find((a) => !a.startsWith("--"));
if (!LIST) { console.error("list.json を指定してください"); process.exit(1); }

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
async function rest(method, path, body) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${t}`);
  return t ? JSON.parse(t) : null;
}

const list = JSON.parse(readFileSync(LIST, "utf8"));
const [office] = await rest("GET", `payroll_offices?select=id,office_number,offices(name)&office_number=eq.${list.office_number}`);
if (!office) { console.error(`payroll_offices に ${list.office_number} がありません`); process.exit(1); }

const existing = await rest("GET", `payroll_employees?select=employee_number,name&office_id=eq.${office.id}`);
const norm = (n) => String(n).trim().replace(/^0+/, "") || "0";
const have = new Map(existing.map((e) => [norm(e.employee_number), e.name]));

const payloads = [];
console.log(`=== 職員登録 ${office.offices?.name} (${office.office_number}) ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
for (const e of list.employees) {
  if (have.has(norm(e.employee_number))) {
    console.log(`  スキップ ${e.employee_number} ${e.name} (既に登録: ${have.get(norm(e.employee_number))})`);
    continue;
  }
  const p = {
    employee_number: String(e.employee_number),
    name: e.name,
    address: "",
    office_id: office.id,
    employment_status: e.employment_status ?? "在職者",
    hire_date: null,
    resignation_date: null,
    effective_service_months: 0,
    job_type: "訪問介護",
    role_type: e.salary_type === "月給" ? "社員" : "パート",
    salary_type: e.salary_type,
    transport_type: "自動車",
    has_care_qualification: false,
    social_insurance: !!e.social_insurance,
    paid_leave_unit_price: 0,
    communication_fee_type: "none",
  };
  payloads.push(p);
  console.log(`  登録 ${p.employee_number} ${p.name} ${p.role_type}/${p.salary_type}/${p.employment_status} 社保=${p.social_insurance} [${e.source ?? ""}]`);
}
if (!EXECUTE) { console.log(`\nDRY RUN (${payloads.length} 名)。--execute で書き込みます`); process.exit(0); }
if (payloads.length === 0) { console.log("登録対象なし"); process.exit(0); }

const rows = await rest("POST", "payroll_employees", payloads);
if (rows?.length !== payloads.length) { console.error(`★ 登録件数が合わない ${rows?.length}/${payloads.length}`); process.exit(2); }
const after = await rest("GET", `payroll_employees?select=employee_number,name,employment_status,salary_type&office_id=eq.${office.id}&employee_number=in.(${payloads.map((p) => p.employee_number).join(",")})`);
for (const a of after) console.log(`  確認 ${a.employee_number} ${a.name} ${a.salary_type}/${a.employment_status}`);
if (after.length !== payloads.length) { console.error("★ 登録後の確認で件数不一致"); process.exit(2); }
