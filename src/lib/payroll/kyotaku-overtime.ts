// 居宅介護支援 (ケアマネ) の残業代 (2026-10-21)。
//
// 出勤簿 (/kyotaku-attendance) と 労働時間チェック (/kyotaku-labor-check) で 2026-05-20 に作った計算をそのまま使う:
//   時給 = 残業設定 (job_type 居宅介護支援) の「単価の元にする手当」の合計 ÷ 月の所定時間
//   実残業代 = 時間外 × 1.25 (月 60h 超は 1.5) + 深夜 × 0.25 + 法定休日 × 1.35   (overtime-pay-calc.ts)
//   ★ 払う額 = max(0, 実残業代 − 固定残業代)。固定残業代 (kotei_zangyo) は 本人給などと一緒に毎月払っているので、超えた分だけを足す
// 給与の計算 (ダッシュボード・総括表の画面) と 労働時間チェック が 同じ関数を通るよう ここにまとめる (逐語コピーで食い違わないため)。

import { calcMonthlySummary, type AttendanceRecord, type MonthlySummary } from "@/lib/payroll/attendance-calc";
import { calcOvertimePayBreakdown, type OvertimePayBreakdown, type OvertimeSettingForCalc, type SalarySettingsForOvertime } from "@/lib/payroll/overtime-pay-calc";
import { activeOvertimeRow } from "@/lib/payroll/overtime-settings-history";
import type { KyotakuSalary } from "@/lib/payroll/kyotaku-salary-history";

/** 残業設定 (payroll_overtime_settings) の 居宅の職種 */
export const KYOTAKU_OVERTIME_JOB_TYPE = "居宅介護支援";
/** 残業設定の select 列 */
export const OVERTIME_SETTING_COLUMNS =
  "job_type, effective_from, scheduled_hours_per_month, include_base_personal_salary, include_skill_salary, include_position_allowance, include_qualification_allowance, include_tenure_allowance, include_treatment_improvement, include_specific_treatment, include_treatment_subsidy, include_fixed_overtime_pay, include_special_bonus";
export type OvertimeSettingRow = OvertimeSettingForCalc & { job_type: string; effective_from: string };

/** 居宅の出勤簿の DB の行 (payroll_kyotaku_attendance_records) */
export type KyotakuAttendanceDbRow = {
  employee_id: string;
  work_date: string;
  start_time: string | null;
  end_time: string | null;
  break_minutes: number | null;
  is_legal_holiday: boolean | null;
  paid_leave_type: "full" | "half" | null | string;
  is_paid_leave?: boolean | null;
  substitute_for_date: string | null;
};
/** 残業の計算に要る 出勤簿の列 */
export const KYOTAKU_ATTENDANCE_TIME_COLUMNS =
  "employee_id, work_date, start_time, end_time, break_minutes, is_legal_holiday, paid_leave_type, is_paid_leave, substitute_for_date";

function toUiTime(s: string | null): string | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{1,2})/.exec(s);
  if (!m) return null;
  return `${String(parseInt(m[1], 10)).padStart(2, "0")}:${String(parseInt(m[2], 10)).padStart(2, "0")}`;
}

/** DB の行 → 出勤簿の集計 (attendance-calc) の形 */
export function kyotakuAttendanceToRecord(r: KyotakuAttendanceDbRow): AttendanceRecord {
  const paidLeaveType: "full" | "half" | null =
    r.paid_leave_type === "full" || r.paid_leave_type === "half" ? r.paid_leave_type : r.is_paid_leave ? "full" : null;
  return {
    work_date: r.work_date,
    start_time: toUiTime(r.start_time),
    end_time: toUiTime(r.end_time),
    break_minutes: r.break_minutes ?? 0,
    is_legal_holiday: !!r.is_legal_holiday,
    paid_leave_type: paidLeaveType,
    substitute_for_date: r.substitute_for_date ?? null,
  };
}

/** 居宅の給与設定 (その月に有効な行) → 残業の時給の元にする手当。固定残業代は kotei_zangyo */
export function kyotakuSalaryForOvertime(active: KyotakuSalary | null): SalarySettingsForOvertime {
  return {
    base_personal_salary: active?.honnin_kyu ?? 0,
    skill_salary: active?.shokuno_kyu ?? 0,
    position_allowance: active?.position_allowance ?? 0,
    qualification_allowance: active?.shikaku_teate ?? 0,
    tenure_allowance: active?.kotei ?? 0,
    treatment_improvement: 0,
    specific_treatment_improvement: active?.tokutei_shogu ?? 0,
    treatment_subsidy: 0,
    fixed_overtime_pay: active?.kotei_zangyo ?? 0,
    special_bonus: 0,
  };
}

/**
 * 1 人 × 1 か月の残業代。records は その月の前後 (週の計算のため extendedMonthRange の範囲) の出勤簿。
 * 残業設定が無い・給与設定が無いときは 0 (calcOvertimePayBreakdown の空)。
 */
export function kyotakuOvertimeFor(
  records: AttendanceRecord[],
  weekStart: number,
  ym: string, // YYYY-MM
  companyHolidayDates: Set<string>,
  active: KyotakuSalary | null,
  otRows: OvertimeSettingRow[],
): { summary: MonthlySummary; breakdown: OvertimePayBreakdown } {
  const summary = calcMonthlySummary(records, weekStart, ym, companyHolidayDates);
  const breakdown = calcOvertimePayBreakdown(summary, kyotakuSalaryForOvertime(active), activeOvertimeRow(otRows, KYOTAKU_OVERTIME_JOB_TYPE, `${ym}-01`));
  return { summary, breakdown };
}
