// 実残業代 (円換算) 計算 helper
//
// 用途:
//   - 居宅介護支援 出勤簿 (/kyotaku-attendance) の保存時に
//     「固定残業代を超えてますがよろしいですか?」警告を出す
//   - /kyotaku-labor-check 要チェック一覧で 固定残業代超過 を判定
//
// 設計:
//   payroll/page.tsx の computeOvertimePay() と同じ base/hourly_rate 算出ロジックを共有可能な
//   薄い純関数として切り出す。MonthlySummary (attendance-calc.ts) を入力に取る。
//
// 計算式 (シンプル合算):
//   hourlyRate = base / scheduled_hours_per_month
//   通常残業代 = (total_daily_overtime + total_weekly_overtime) / 60 * hourlyRate * 1.25
//   深夜割増   = total_midnight                                 / 60 * hourlyRate * 0.25
//   法休割増   = total_holiday                                  / 60 * hourlyRate * 0.35
//   合計実残業代 = 通常残業代 + 深夜割増 + 法休割増
//   超過額     = max(0, 合計実残業代 - fixed_overtime_pay)
//
// 注: 深夜かつ残業 / 深夜かつ法休 の重複は厳密に分けていない (簡易合算)。
//     固定残業代との比較目的では十分。詳細は payroll/page.tsx 本計算に従う。

import type { MonthlySummary } from "@/lib/payroll/attendance-calc";

export type SalarySettingsForOvertime = {
  base_personal_salary: number;
  skill_salary: number;
  position_allowance: number;
  qualification_allowance: number;
  tenure_allowance: number;
  treatment_improvement: number;
  specific_treatment_improvement: number;
  treatment_subsidy: number;
  fixed_overtime_pay: number;
  special_bonus: number;
};

export type OvertimeSettingForCalc = {
  scheduled_hours_per_month: number;
  include_base_personal_salary: boolean;
  include_skill_salary: boolean;
  include_position_allowance: boolean;
  include_qualification_allowance: boolean;
  include_tenure_allowance: boolean;
  include_treatment_improvement: boolean;
  include_specific_treatment: boolean;
  include_treatment_subsidy: boolean;
  include_fixed_overtime_pay: boolean;
  include_special_bonus: boolean;
};

export type OvertimePayBreakdown = {
  /** 通常残業代 (日OT + 週OT を 1.25 倍した円額) */
  regularOvertimePay: number;
  /** 深夜割増のみの円額 (0.25 倍) */
  midnightExtraPay: number;
  /** 法休割増のみの円額 (0.35 倍) */
  holidayExtraPay: number;
  /** 上記 3 種の合計 (= 実残業代総額) */
  totalOvertimePay: number;
  /** 固定残業代 (settings.fixed_overtime_pay そのまま) */
  fixedOvertimePay: number;
  /** 超過額 (合計実残業代 - 固定残業代、負なら 0) */
  exceedAmount: number;
  /** 固定残業代を超えているか */
  isExceeding: boolean;
  /** 内部計算で使った時給 (debug 用) */
  hourlyRate: number;
};

/**
 * 実残業代を計算し、固定残業代と比較する。
 * salary_settings または overtime_settings が無い場合は 0 を返し isExceeding=false。
 */
export function calcOvertimePayBreakdown(
  summary: MonthlySummary,
  salary: SalarySettingsForOvertime | null | undefined,
  ot: OvertimeSettingForCalc | null | undefined,
): OvertimePayBreakdown {
  const empty: OvertimePayBreakdown = {
    regularOvertimePay: 0,
    midnightExtraPay: 0,
    holidayExtraPay: 0,
    totalOvertimePay: 0,
    fixedOvertimePay: salary?.fixed_overtime_pay ?? 0,
    exceedAmount: 0,
    isExceeding: false,
    hourlyRate: 0,
  };
  if (!salary || !ot || ot.scheduled_hours_per_month <= 0) return empty;

  let base = 0;
  if (ot.include_base_personal_salary)    base += salary.base_personal_salary;
  if (ot.include_skill_salary)            base += salary.skill_salary;
  if (ot.include_position_allowance)      base += salary.position_allowance;
  if (ot.include_qualification_allowance) base += salary.qualification_allowance;
  if (ot.include_tenure_allowance)        base += salary.tenure_allowance;
  if (ot.include_treatment_improvement)   base += salary.treatment_improvement;
  if (ot.include_specific_treatment)      base += salary.specific_treatment_improvement;
  if (ot.include_treatment_subsidy)       base += salary.treatment_subsidy;
  if (ot.include_fixed_overtime_pay)      base += salary.fixed_overtime_pay;
  if (ot.include_special_bonus)           base += salary.special_bonus;

  const hourlyRate = base / ot.scheduled_hours_per_month;
  if (hourlyRate <= 0) return empty;

  const otMin = summary.total_daily_overtime + summary.total_weekly_overtime;
  const regularOvertimePay = Math.round((otMin / 60) * hourlyRate * 1.25);
  const midnightExtraPay = Math.round((summary.total_midnight / 60) * hourlyRate * 0.25);
  const holidayExtraPay = Math.round((summary.total_holiday / 60) * hourlyRate * 0.35);

  const totalOvertimePay = regularOvertimePay + midnightExtraPay + holidayExtraPay;
  const fixedOvertimePay = salary.fixed_overtime_pay ?? 0;
  const exceedAmount = Math.max(0, totalOvertimePay - fixedOvertimePay);
  const isExceeding = exceedAmount > 0 && fixedOvertimePay > 0;
  // fixedOvertimePay=0 のときは「固定残業代設定なし」とみなして警告しない

  return {
    regularOvertimePay,
    midnightExtraPay,
    holidayExtraPay,
    totalOvertimePay,
    fixedOvertimePay,
    exceedAmount,
    isExceeding,
    hourlyRate,
  };
}
