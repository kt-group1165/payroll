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
// 計算式 (労基法37条):
//   hourlyRate = base / scheduled_hours_per_month
//   時間外    = total_daily_overtime + total_weekly_overtime
//     └ 月 60h まで      … × 1.25
//     └ 月 60h を超えた分 … × 1.50   (37条1項但書)
//   深夜割増   = total_midnight / 60 * hourlyRate * 0.25
//       (深夜帯の「本体」は所定 or 時間外で既に払われているので割増 0.25 のみ)
//   法定休日   = total_holiday  / 60 * hourlyRate * 1.35
//       (100% + 35%。attendance-calc は法定休日を daily/weekly_overtime からも
//        scheduled_minutes からも外している = 本体がどこでも払われないため、
//        ここで 1.35 を払わないと**法定休日の賃金が丸ごと未払い**になる)
//   合計実残業代 = 時間外 + 深夜割増 + 法定休日
//   超過額     = max(0, 合計実残業代 - fixed_overtime_pay)
//
// 2026-08-31 監査での是正:
//   ① 月60時間超の 50% 割増がコード上どこにも無かった
//      (実データで 澤田拓馬 2026-06 が OT 64.0h に到達済)
//   ② 法定休日が 0.35 の上乗せだけで本体 100% が支払われていなかった
//      (同 2026-06 に法休 7h 実在。3,297円しか出ず、正は 12,716円)
//
// 注: 深夜かつ法休 は 1.35 + 0.25 = 1.60 相当になる (法定どおり)。

import type { MonthlySummary } from "@/lib/payroll/attendance-calc";

/** 労基法37条の割増率 */
const OT_RATE = 1.25;              // 時間外 (月60hまで)
const OT_RATE_OVER_60H = 1.5;      // 時間外のうち月60hを超えた分
const MIDNIGHT_EXTRA_RATE = 0.25;  // 深夜の割増ぶんのみ (本体は所定/時間外で支払済)
const HOLIDAY_RATE = 1.35;         // 法定休日 = 本体100% + 割増35%
/** 月間時間外 60 時間 (分) */
const MONTHLY_OT_THRESHOLD_MIN = 60 * 60;

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
  /** 通常残業代 (日OT + 週OT のうち月 60h まで。1.25 倍) */
  regularOvertimePay: number;
  /** 月 60h を超えた時間外の円額 (1.50 倍) */
  over60OvertimePay: number;
  /** 深夜割増のみの円額 (0.25 倍) */
  midnightExtraPay: number;
  /** 法定休日労働の円額 (1.35 倍 = 本体 100% + 割増 35%) */
  holidayPay: number;
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
    over60OvertimePay: 0,
    midnightExtraPay: 0,
    holidayPay: 0,
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

  // 時間外は月 60h を境に率が変わる (労基法37条1項但書)。
  // 法定休日労働は「時間外労働」ではないので 60h の計算には入れない。
  const otMin = summary.total_daily_overtime + summary.total_weekly_overtime;
  const otWithin60 = Math.min(otMin, MONTHLY_OT_THRESHOLD_MIN);
  const otOver60 = Math.max(0, otMin - MONTHLY_OT_THRESHOLD_MIN);

  const regularOvertimePay = Math.round((otWithin60 / 60) * hourlyRate * OT_RATE);
  const over60OvertimePay = Math.round((otOver60 / 60) * hourlyRate * OT_RATE_OVER_60H);
  const midnightExtraPay = Math.round((summary.total_midnight / 60) * hourlyRate * MIDNIGHT_EXTRA_RATE);
  const holidayPay = Math.round((summary.total_holiday / 60) * hourlyRate * HOLIDAY_RATE);

  const totalOvertimePay =
    regularOvertimePay + over60OvertimePay + midnightExtraPay + holidayPay;
  const fixedOvertimePay = salary.fixed_overtime_pay ?? 0;
  const exceedAmount = Math.max(0, totalOvertimePay - fixedOvertimePay);
  const isExceeding = exceedAmount > 0 && fixedOvertimePay > 0;
  // fixedOvertimePay=0 のときは「固定残業代設定なし」とみなして警告しない

  return {
    regularOvertimePay,
    over60OvertimePay,
    midnightExtraPay,
    holidayPay,
    totalOvertimePay,
    fixedOvertimePay,
    exceedAmount,
    isExceeding,
    hourlyRate,
  };
}
