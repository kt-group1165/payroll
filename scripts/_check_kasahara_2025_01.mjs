// 笠原 2025年1月 の固定残業代超過チェック
// /kyotaku-labor-check と同ロジックで実行

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(resolve(__dirname, "..", "..", "kaigo-app", ".env.local"), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// 1) 笠原を探す
const { data: emps } = await sb
  .from("payroll_employees")
  .select("id, name, office_id, job_type")
  .ilike("name", "%笠原%");
console.log("=== 笠原 候補 ===");
for (const e of emps ?? []) {
  const { data: o } = await sb.from("payroll_offices").select("short_name, office_type, work_week_start").eq("id", e.office_id).maybeSingle();
  console.log(`  id=${e.id} / ${e.name} / job=${e.job_type} / office=${o?.short_name} (${o?.office_type}, week_start=${o?.work_week_start})`);
}
if (!emps || emps.length === 0) {
  console.error("笠原 見つからず");
  process.exit(1);
}
// 居宅介護支援の人を選ぶ
const target = emps.find((e) => e.job_type === "居宅介護支援") ?? emps[0];
console.log(`\n→ target: ${target.name} (id=${target.id})`);

// 2) salary_settings
const { data: salary } = await sb
  .from("payroll_salary_settings")
  .select("base_personal_salary, skill_salary, position_allowance, qualification_allowance, tenure_allowance, treatment_improvement, specific_treatment_improvement, treatment_subsidy, fixed_overtime_pay, special_bonus")
  .eq("employee_id", target.id)
  .maybeSingle();
console.log("\n=== salary_settings ===");
console.log(JSON.stringify(salary, null, 2));

// 3) overtime_settings
const { data: ot } = await sb
  .from("payroll_overtime_settings")
  .select("*")
  .eq("job_type", "居宅介護支援")
  .maybeSingle();
console.log("\n=== overtime_settings (job_type=居宅介護支援) ===");
console.log(JSON.stringify(ot, null, 2));

// 4) attendance records 2025-01 (前後の週も含めて)
//    extendedMonthRange と同じく月 ± 9 日くらい余裕を持って取得
const { data: rows } = await sb
  .from("payroll_kyotaku_attendance_records")
  .select("work_date, start_time, end_time, break_minutes, is_legal_holiday, paid_leave_type, is_paid_leave, substitute_for_date")
  .eq("employee_id", target.id)
  .gte("work_date", "2024-12-22")
  .lte("work_date", "2025-02-09")
  .order("work_date");
console.log(`\n=== attendance rows 2024-12-22 ~ 2025-02-09: ${(rows??[]).length} 件 ===`);
for (const r of rows ?? []) {
  console.log(`  ${r.work_date}  ${r.start_time ?? "----"}-${r.end_time ?? "----"}  休憩${r.break_minutes}分  ${r.is_legal_holiday ? "[法休]" : ""}${r.paid_leave_type ?? r.is_paid_leave ? "[有給]" : ""}${r.substitute_for_date ? "[振替:"+r.substitute_for_date+"]" : ""}`);
}

// 5) 計算: lib を import
const { calcMonthlySummary, formatHM } = await import("../src/lib/payroll/attendance-calc.ts").catch(async () => {
  // tsx 未導入なら手動 require は不可。直接 calc は省略して raw data だけ報告
  return {};
});

if (calcMonthlySummary) {
  // company_holidays
  const { data: hd } = await sb
    .from("payroll_company_holidays")
    .select("holiday_date")
    .eq("tenant_id", "kt-group");
  const cHolidays = new Set((hd ?? []).map(r => r.holiday_date));

  // AttendanceRecord 形式に変換
  function toUiTime(s) { if(!s) return null; const m=/^(\d{1,2}):(\d{1,2})/.exec(s); return m?`${String(parseInt(m[1],10)).padStart(2,'0')}:${String(parseInt(m[2],10)).padStart(2,'0')}`:null; }
  const records = (rows ?? []).map(r => ({
    work_date: r.work_date,
    start_time: toUiTime(r.start_time),
    end_time: toUiTime(r.end_time),
    break_minutes: r.break_minutes ?? 0,
    is_legal_holiday: !!r.is_legal_holiday,
    paid_leave_type: r.paid_leave_type === "full" || r.paid_leave_type === "half" ? r.paid_leave_type : (r.is_paid_leave ? "full" : null),
    substitute_for_date: r.substitute_for_date ?? null,
  }));

  const { data: o } = await sb.from("payroll_offices").select("work_week_start").eq("id", target.office_id).maybeSingle();
  const weekStart = o?.work_week_start ?? 0;
  const sum = calcMonthlySummary(records, weekStart, "2025-01", cHolidays);
  console.log("\n=== MonthlySummary 2025-01 ===");
  console.log(`  total_work:           ${formatHM(sum.total_work)}`);
  console.log(`  total_daily_overtime: ${formatHM(sum.total_daily_overtime)}`);
  console.log(`  total_weekly_overtime: ${formatHM(sum.total_weekly_overtime)}`);
  console.log(`  total_midnight:       ${formatHM(sum.total_midnight)}`);
  console.log(`  total_holiday:        ${formatHM(sum.total_holiday)}`);
  console.log(`  total_absence:        ${formatHM(sum.total_absence)}`);

  // 固定残業代 vs 実残業代
  const { calcOvertimePayBreakdown } = await import("../src/lib/payroll/overtime-pay-calc.ts");
  const breakdown = calcOvertimePayBreakdown(sum, salary, ot);
  console.log("\n=== Overtime Pay Breakdown ===");
  console.log(`  hourlyRate:          ¥${Math.round(breakdown.hourlyRate)}`);
  console.log(`  regularOvertimePay:  ¥${breakdown.regularOvertimePay.toLocaleString()}`);
  console.log(`  midnightExtraPay:    ¥${breakdown.midnightExtraPay.toLocaleString()}`);
  console.log(`  holidayExtraPay:     ¥${breakdown.holidayExtraPay.toLocaleString()}`);
  console.log(`  totalOvertimePay:    ¥${breakdown.totalOvertimePay.toLocaleString()}`);
  console.log(`  fixedOvertimePay:    ¥${breakdown.fixedOvertimePay.toLocaleString()}`);
  console.log(`  exceedAmount:        ¥${breakdown.exceedAmount.toLocaleString()}`);
  console.log(`  isExceeding:         ${breakdown.isExceeding}`);
}
