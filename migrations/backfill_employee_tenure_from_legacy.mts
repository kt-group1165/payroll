/**
 * 職員一覧の勤続月数 (payroll_employees.company_tenure_months / group_tenure_months / tenure_as_of) を
 * 旧システムの従業員データ (payroll_legacy_employee) から写す (2026-10-08)。
 *
 *   npx tsx migrations/backfill_employee_tenure_from_legacy.mts            # DRY RUN
 *   npx tsx migrations/backfill_employee_tenure_from_legacy.mts --execute
 *
 * 給与計算 (payroll/page.tsx) と同じ引き方: (所属名, 社員No) で旧システムの行を引き、
 *   グループ通算 = resolveGroupTenureMonths (再入社の人は 戻ってからの月数) / 法人 = company_tenure_months。
 * ★ 写したあとも 給与計算の結果は変わらない (同じ値を 別の場所から読むだけ) ことが前提。
 *   変わりうる人 (再入社で 月給の節目判定に使う月数が変わる人) は 一覧に出して 写さない。
 * ★ 3 列のどれかに既に値がある職員 (画面で入れた人) は 触らない。
 */
import { readFileSync } from "node:fs";
import { restAll } from "../scripts/_rest.mjs";
import { resolveGroupTenureMonths } from "@/lib/payroll/payroll-calc";

const EXECUTE = process.argv.includes("--execute");

type Emp = { id: string; employee_number: string; name: string; office_id: string; salary_type: string | null;
  company_tenure_months: number | null; group_tenure_months: number | null; tenure_as_of: string | null };
type Off = { id: string; office_number: string; master: { name: string | null } | null };
type Leg = { office_name: string; employee_number: string; employee_name: string | null; office_tenure_months: number | null;
  group_tenure_months: number | null; company_tenure_months: number | null; tenure_as_of: string; hire_date: string | null; quit_date: string | null };

const normName = (x: string) => x.normalize("NFKC").replace(/[\s　]/g, "");
const normEmp = (v: string) => String(v ?? "").trim().replace(/^0+/, "");

const emps = await restAll<Emp>("payroll_employees?select=id,employee_number,name,office_id,salary_type,company_tenure_months,group_tenure_months,tenure_as_of");
const offs = await restAll<Off>("payroll_offices?select=id,office_number,master:offices!office_id(name)");
const legs = await restAll<Leg>("payroll_legacy_employee?select=office_name,employee_number,employee_name,office_tenure_months,group_tenure_months,company_tenure_months,tenure_as_of,hire_date,quit_date");
const officeName = new Map(offs.map((o) => [o.id, normName(o.master?.name ?? "")]));

const byPerson = new Map<string, Leg[]>();
for (const r of legs) {
  const k = normEmp(r.employee_number) + "|" + normName(r.employee_name ?? "");
  const l = byPerson.get(k); if (l) l.push(r); else byPerson.set(k, [r]);
}
const legByKey = new Map<string, Leg>();
for (const r of legs) if (r.group_tenure_months != null) legByKey.set(normName(r.office_name) + "|" + normEmp(r.employee_number), r);

const plans: { id: string; label: string; company: number | null; group: number; asOf: string }[] = [];
const skippedHasValue: string[] = [];
const skippedStepChange: string[] = [];
let noLegacy = 0;
for (const e of emps) {
  const r = legByKey.get((officeName.get(e.office_id) ?? "") + "|" + normEmp(e.employee_number));
  if (!r) { noLegacy++; continue; }
  const label = `${e.employee_number} ${e.name}`;
  if (e.company_tenure_months != null || e.group_tenure_months != null || e.tenure_as_of != null) { skippedHasValue.push(label); continue; }
  const group = resolveGroupTenureMonths(r, byPerson.get(normEmp(r.employee_number) + "|" + normName(r.employee_name ?? "")) ?? [r]);
  if (group == null) continue;
  // 給与計算の節目判定 (月給) は 旧システムの生のグループ月数と法人の長い方。写した値からは max(group, company) になる
  const stepBefore = Math.max(r.group_tenure_months!, r.company_tenure_months ?? 0);
  const stepAfter = Math.max(group, r.company_tenure_months ?? 0);
  if (stepBefore !== stepAfter && e.salary_type === "月給") {
    skippedStepChange.push(`${label} (月給・節目の月数 ${stepBefore} → ${stepAfter}。再入社)`);
    continue;
  }
  plans.push({ id: e.id, label, company: r.company_tenure_months, group, asOf: r.tenure_as_of });
}

console.log(`職員 ${emps.length} 行 / 旧システムの行が引ける ${emps.length - noLegacy} 行 / 引けない ${noLegacy} 行`);
console.log(`写す ${plans.length} 行 / 既に値がある (触らない) ${skippedHasValue.length} 行 / 計算が変わるので写さない ${skippedStepChange.length} 行`);
for (const s of skippedStepChange) console.log(`  ⚠ ${s}`);
const asOfs = new Map<string, number>(); for (const p of plans) asOfs.set(p.asOf, (asOfs.get(p.asOf) ?? 0) + 1);
console.log(`いつ時点か: ${[...asOfs].map(([k, v]) => `${k}=${v}`).join(" / ")}`);
for (const p of plans.slice(0, 5)) console.log(`  例 ${p.label}: 法人 ${p.company ?? "空"} / グループ ${p.group} (${p.asOf})`);

if (!EXECUTE) { console.log("\nDRY RUN。書き込むときは --execute"); process.exit(0); }

const env: Record<string, string> = {};
for (const f of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" };
let ok = 0; const fails: string[] = [];
for (const p of plans) {
  // 画面で入れた値を上書きしないよう 3 列が空の行だけ更新する
  const url = `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/payroll_employees?id=eq.${p.id}&group_tenure_months=is.null&company_tenure_months=is.null&tenure_as_of=is.null`;
  const r = await fetch(url, { method: "PATCH", headers: H, body: JSON.stringify({ company_tenure_months: p.company, group_tenure_months: p.group, tenure_as_of: p.asOf }) });
  if (!r.ok) fails.push(`${p.label}: ${r.status} ${(await r.text()).slice(0, 160)}`); else ok++;
}
console.log(`更新 ${ok} 行 / 失敗 ${fails.length} 行`);
for (const f of fails.slice(0, 10)) console.log(`  ✗ ${f}`);
// 件数確認
const after = await restAll<{ id: string }>("payroll_employees?select=id&group_tenure_months=not.is.null");
console.log(`確認: グループ通算が入っている職員 ${after.length} 行`);
if (fails.length > 0) process.exit(1);
