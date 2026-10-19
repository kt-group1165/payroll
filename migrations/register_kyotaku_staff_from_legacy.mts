/**
 * 居宅のケアマネを 給与の職員一覧 (payroll_employees) に登録する (2026-10-19 user「進めて」)。
 *
 *   npx tsx migrations/register_kyotaku_staff_from_legacy.mts            # DRY RUN
 *   npx tsx migrations/register_kyotaku_staff_from_legacy.mts --execute
 *
 * 対象: 居宅の実績 (payroll_kyotaku_records) に担当として出てくるのに、その事業所の職員一覧に 同じ名前 (空白の違いは無視) がいない人。
 * 材料: 旧システムの従業員データ (payroll_legacy_employee。所属名 + 社員No + 氏名 + 入社日 + 支払形態 + 勤続月数)。
 *   ★ 旧システムの所属名が その居宅の事業所 (共通マスタの名前) と同じ行 があるときだけ登録する。
 *     所属が違う (異動・兼務) / 旧システムにいない 人は 一覧に出して 登録しない (社員番号が事業所ごとに違うため)
 * 登録する値: 社員番号・氏名 = 旧システム / 職種 = 居宅介護支援 / 給与形態 = 月給者→月給・他→時給 / 役職 = 月給→社員・時給→パート /
 *   在職区分・入社日・退職日 = 旧システム / 勤続月数 (法人・グループ・いつ時点か) = 旧システム。他は 職員一覧の登録の既定値
 * 給与設定 (本人給・単価など) は ここでは入れない (総括表から別に入れる)。
 */
import { readFileSync } from "node:fs";
import { restAll } from "../scripts/_rest.mjs";

const EXECUTE = process.argv.includes("--execute");
const nm = (s: string | null | undefined) => String(s ?? "").normalize("NFKC").replace(/[\s　]/g, "");

const recs = await restAll<{ office_number: string; staff_name: string }>("payroll_kyotaku_records?select=id,office_number,staff_name&detail_row_no=eq.1");
const payOffices = await restAll<{ id: string; office_id: string | null; office_number: string; office_type: string; master: { name: string | null } | null }>(
  "payroll_offices?select=id,office_id,office_number,office_type,master:offices!office_id(name)");
const officeByNum = new Map(payOffices.map((o) => [o.office_number, o]));
const emps = await restAll<{ name: string; office_id: string }>("payroll_employees?select=id,name,office_id");
const have = new Set(emps.map((e) => `${e.office_id}|${nm(e.name)}`));
const legacy = await restAll<{ office_name: string; employee_number: string; employee_name: string | null; employment_status: string | null; pay_type: string | null; job_type: string | null; hire_date: string | null; quit_date: string | null; office_tenure_months: number | null; company_tenure_months: number | null; group_tenure_months: number | null; tenure_as_of: string }>(
  "payroll_legacy_employee?select=id,office_name,employee_number,employee_name,employment_status,pay_type,job_type,hire_date,quit_date,office_tenure_months,company_tenure_months,group_tenure_months,tenure_as_of");

// 実績の 事業所 × 担当者 (件数)
const pairs = new Map<string, { office: string; staff: string; n: number }>();
for (const r of recs) { const k = `${r.office_number}|${nm(r.staff_name)}`; const v = pairs.get(k) ?? { office: r.office_number, staff: r.staff_name, n: 0 }; v.n++; pairs.set(k, v); }

const plans: { office: (typeof payOffices)[number]; l: (typeof legacy)[number]; n: number }[] = [];
const otherOffice: string[] = [], notInLegacy: string[] = [], dupLegacy: string[] = [];
for (const p of pairs.values()) {
  const o = officeByNum.get(p.office);
  if (!o || o.office_type !== "居宅介護支援") continue;
  if (have.has(`${o.id}|${nm(p.staff)}`)) continue;
  const mine = legacy.filter((l) => nm(l.employee_name) === nm(p.staff));
  const label = `${p.office} ${p.staff} (実績 ${p.n} 件)`;
  if (mine.length === 0) { notInLegacy.push(label); continue; }
  const same = mine.filter((l) => nm(l.office_name) === nm(o.master?.name));
  if (same.length === 0) { otherOffice.push(`${label}: 旧システムの所属 ${[...new Set(mine.map((l) => `${l.office_name}(${l.employee_number}${l.employment_status ? "・" + l.employment_status : ""})`))].join(" / ")}`); continue; }
  if (same.length > 1) { dupLegacy.push(`${label}: 同じ所属に ${same.length} 行 (${same.map((l) => l.employee_number).join(",")})`); continue; }
  plans.push({ office: o, l: same[0], n: p.n });
}

console.log(`登録する ${plans.length} 人 / 旧システムの所属が違う ${otherOffice.length} / 旧システムにいない ${notInLegacy.length} / 同じ所属に複数 ${dupLegacy.length}`);
for (const p of plans) console.log(`  ＋ ${p.office.office_number} ${p.l.employee_number} ${p.l.employee_name} ${p.l.pay_type ?? ""} ${p.l.employment_status ?? ""} 入社 ${p.l.hire_date ?? "?"} (実績 ${p.n} 件)`);
for (const [t, l] of [["旧システムの所属が違う (登録しない)", otherOffice], ["旧システムにいない (総括表から)", notInLegacy], ["同じ所属に複数", dupLegacy]] as const) {
  if (l.length) { console.log(`\n--- ${t} (${l.length}) ---`); for (const s of l) console.log("  " + s); }
}
if (!EXECUTE) { console.log("\nDRY RUN。書き込むときは --execute"); process.exit(0); }

const env: Record<string, string> = {};
for (const f of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" };
const payload = plans.map(({ office, l }) => {
  const monthly = (l.pay_type ?? "").includes("月給");
  return {
    employee_number: l.employee_number, name: l.employee_name, address: "", office_id: office.id,
    employment_status: l.employment_status && ["在職者", "休職者", "退職者"].includes(l.employment_status) ? l.employment_status : "在職者",
    hire_date: l.hire_date, resignation_date: l.quit_date, effective_service_months: 0,
    job_type: "居宅介護支援", role_type: monthly ? "社員" : "パート", salary_type: monthly ? "月給" : "時給",
    transport_type: "車", has_care_qualification: false, social_insurance: false, paid_leave_unit_price: 0, communication_fee_type: "none",
    company_tenure_months: l.company_tenure_months, group_tenure_months: l.group_tenure_months, tenure_as_of: l.tenure_as_of,
  };
});
const r = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/payroll_employees`, { method: "POST", headers: H, body: JSON.stringify(payload) });
if (!r.ok) { console.error(`登録に失敗: ${r.status} ${await r.text()}`); process.exit(1); }
const after = await restAll<{ name: string; office_id: string }>("payroll_employees?select=id,name,office_id");
const haveAfter = new Set(after.map((e) => `${e.office_id}|${nm(e.name)}`));
console.log(`登録 ${payload.length} 人 / 確認: 職員一覧に入った ${plans.filter((p) => haveAfter.has(`${p.office.id}|${nm(p.l.employee_name)}`)).length}/${plans.length}`);
