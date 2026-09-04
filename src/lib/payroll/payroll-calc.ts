/**
 * 給与計算の純関数 (2026-09-04 切り出し)
 *
 * ── なぜ切り出したか ────────────────────────────────────────────────────
 *   訪問介護の月給・時給・残業・勤続手当・移動手当・端数処理は、これまで
 *   apps/payroll-app/src/app/payroll/page.tsx (2,345 行の "use client" コンポーネント)
 *   に直書きされていた。この状態だと import しただけで browser client が起動し
 *   Node のハーネスから呼べないため、検証が一度も行われていなかった。
 *
 *   本ファイルは page.tsx から関数と型を そのまま切り出したもの (挙動は変えていない)。
 *   page.tsx は本ファイルから import して使う。二重実装は作らない。
 *
 * ⚠ この検証が証明していないこと (VERIFICATION_RULES 3-1):
 *   - 勤怠集計 (AttendanceSummary の元になる出勤簿の集計ロジック) 自体の正しさ。
 *     ここにあるのは「集計済みの値からいくら払うか」の式だけ。
 *   - 移動手当のうち 距離・時間の算出 (calcDayRoute / Google Distance Matrix 経由)。
 *     ここにあるのは「秒・メートルが分かった後の金額換算」だけ。
 */

// ─── 型 (page.tsx から移動。他ファイルはそれぞれ独自定義を持つため import 不要) ───

export type OvertimeSetting = {
  job_type: string;
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

export type SalarySettings = {
  employee_id: string;
  effective_from: string;
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
  bonus_amount: number;
  travel_unit_price: number;
  care_overtime_threshold_hours: number;
  care_overtime_unit_price: number;
  yocho_unit_price: number;
};

export type AttendanceSummary = {
  workDays: number;
  helperDays: number;
  paidLeave: number;
  halfLeave: number;
  specialLeave: number;
  workHoursMin: number;
  overtimeMinutes: number;
  recordCount: number;
  accompaniedCount: number;
  visitMinutes: number;
  hrdCount: number;
  hrdMinutes: number;
  meetingCount: number;
  commuteKmTotal: number;
  businessKmTotal: number;
  weekendHolidayMinutes: number;
  weekendHolidayAccompaniedMinutes: number;
  visitMinutesExcludingAccompanied: number;
};

export type HourlyDetailRow = {
  id: string;
  service_date: string;
  minutes: number;
  service_code: string;
  category_name: string;
  hourly_rate: number | null;
  pay: number | null;
};

// 時給者
export type HourlyPayroll = {
  employee_number: string;
  employee_name: string;
  role_type: string;
  has_care_qualification: boolean;
  job_type: string;
  effective_service_months: number;
  care_plan_count: number;
  error_adjustment: number;
  treatment_subsidy: number;
  paid_leave_allowance: number;
  cancel_count: number;
  cancel_allowance: number;
  travel_time_sec: number;
  travel_allowance: number;
  communication_fee: number;
  meeting_fee: number;
  childcare_allowance: number;
  commute_fee: number;
  commute_distance_m: number;
  business_trip_fee: number;
  records: HourlyDetailRow[];
  totalMinutes: number;
  totalPay: number;
  unmappedCount: number;
  summary: AttendanceSummary;
};

// 月給者
export type MonthlyPayroll = {
  employee_id: string;
  employee_number: string;
  employee_name: string;
  role_type: string;
  job_type: string;
  auth_user_id: string | null;
  settings: SalarySettings | null;
  bonus_paid: boolean;
  travel_km: number;
  travel_km_auto: number;
  office_travel_unit_price: number;
  office_commute_unit_price: number;
  business_trip_fee: number;
  childcare_allowance: number;
  yocho_hours: number;
  summary: AttendanceSummary;
};

// ─── 勤続手当 ────────────────────────────────────────────────────────────

/**
 * 勤続手当 資格要件チェック。
 *   - has_care_qualification (= 介護福祉士 or 実務者研修修了者) TRUE
 *   - または job_type='居宅介護支援' (= 介護支援専門員所持の前提)
 */
export function hasTenureQualification(
  hasCareQualification: boolean,
  jobType: string,
): boolean {
  return hasCareQualification || jobType === "居宅介護支援";
}

/**
 * 勤続手当計算（資格・経験による定期昇給）
 * 対象: 介護福祉士 / 実務者研修修了者 / 介護支援専門員 (= 居宅介護支援職員は全員所持)
 *   社員(月給)    : 1年=1,000円、以降1年ごと+500円
 *   パートヘルパー: 1年=10円/h、5年=20円/h、以降5年ごと+10円/h
 *   パート訪問入浴: 1年=10円/件、5年=20円/件、以降5年ごと+10円/件
 *   非常勤居宅介護支援: 1年=50円/件、5年=100円/件、以降5年ごと+50円/件
 */
export function computeTenureAllowance(
  hasQualification: boolean,
  effectiveServiceMonths: number,
  salaryType: string,
  jobType: string,
  workHoursMin: number,
  recordCount: number,
  carePlanCount: number,
): number {
  if (!hasTenureQualification(hasQualification, jobType)) return 0;
  const years = Math.floor(effectiveServiceMonths / 12);
  if (years < 1) return 0;

  if (salaryType === "月給") {
    return 1000 + (years - 1) * 500;
  }

  if (salaryType === "時給") {
    if (jobType === "訪問介護" || jobType === "訪問看護") {
      const rate = (Math.floor(years / 5) + 1) * 10;
      return Math.round((workHoursMin / 60) * rate);
    }
    if (jobType === "訪問入浴") {
      const rate = (Math.floor(years / 5) + 1) * 10;
      return rate * recordCount;
    }
    if (jobType === "居宅介護支援") {
      const rate = (Math.floor(years / 5) + 1) * 50;
      return rate * carePlanCount;
    }
  }

  return 0;
}

/** 勤続手当の単価（率）を返す */
export function computeTenureRate(
  hasQualification: boolean,
  effectiveServiceMonths: number,
  jobType: string,
): number {
  if (!hasTenureQualification(hasQualification, jobType)) return 0;
  const years = Math.floor(effectiveServiceMonths / 12);
  if (years < 1) return 0;
  if (jobType === "訪問介護" || jobType === "訪問看護") return (Math.floor(years / 5) + 1) * 10;
  if (jobType === "訪問入浴") return (Math.floor(years / 5) + 1) * 10;
  if (jobType === "居宅介護支援") return (Math.floor(years / 5) + 1) * 50;
  return 0;
}

/**
 * 設定の tenure_allowance_auto が TRUE なら computed 値を、FALSE なら手動入力の
 * tenure_allowance を返す。flag が undefined のときは default TRUE 扱い (= 既存挙動)。
 */
export function resolveTenureAllowance(
  stored: SalarySettings | null,
  computed: number,
): number {
  if (!stored) return computed;
  const auto =
    (stored as SalarySettings & { tenure_allowance_auto?: boolean })
      .tenure_allowance_auto;
  if (auto === false) return stored.tenure_allowance ?? 0;
  return computed;
}

// ─── 月給者 ──────────────────────────────────────────────────────────────

export function fixedTotal(s: SalarySettings): number {
  return (
    s.base_personal_salary + s.skill_salary +
    s.position_allowance + s.qualification_allowance + s.tenure_allowance +
    s.treatment_improvement + s.specific_treatment_improvement + s.treatment_subsidy +
    s.fixed_overtime_pay + s.special_bonus
  );
}

export function careOvertimePay(p: MonthlyPayroll): number {
  if (p.role_type !== "社員") return 0;
  const s = p.settings;
  if (!s || s.care_overtime_threshold_hours <= 0 || s.care_overtime_unit_price <= 0) return 0;
  const thresholdMin = s.care_overtime_threshold_hours * 60;
  const overMin = Math.max(0, p.summary.visitMinutes - thresholdMin);
  return Math.round((overMin / 60) * s.care_overtime_unit_price);
}

export function yochoAllowance(p: MonthlyPayroll): number {
  const s = p.settings;
  if (!s || s.yocho_unit_price <= 0 || p.yocho_hours <= 0) return 0;
  return Math.round(p.yocho_hours * s.yocho_unit_price);
}

/** 月間時間外 60 時間 (分)。これを超えた分は 50% 割増 (労基法37条1項但書) */
export const MONTHLY_OT_THRESHOLD_MIN = 60 * 60;

export function computeOvertimePay(
  p: MonthlyPayroll,
  otSettings: Map<string, OvertimeSetting>,
): number {
  const ot = otSettings.get(p.job_type);
  if (!ot || ot.scheduled_hours_per_month <= 0) return 0;
  const overtimeMin = p.summary.overtimeMinutes;
  if (overtimeMin <= 0) return 0;
  const s = p.settings;
  if (!s) return 0;

  let base = 0;
  if (ot.include_base_personal_salary)    base += s.base_personal_salary;
  if (ot.include_skill_salary)            base += s.skill_salary;
  if (ot.include_position_allowance)      base += s.position_allowance;
  if (ot.include_qualification_allowance) base += s.qualification_allowance;
  if (ot.include_tenure_allowance)        base += s.tenure_allowance;
  if (ot.include_treatment_improvement)   base += s.treatment_improvement;
  if (ot.include_specific_treatment)      base += s.specific_treatment_improvement;
  if (ot.include_treatment_subsidy)       base += s.treatment_subsidy;
  if (ot.include_fixed_overtime_pay)      base += s.fixed_overtime_pay;
  if (ot.include_special_bonus)           base += s.special_bonus;

  const hourlyRate = base / ot.scheduled_hours_per_month;
  // 労基法37条1項但書: 月 60 時間を超える時間外は 50% 割増。
  //   2026-08-31 監査まで一律 1.25 だった (実データで OT 64.0h の職員が居る)。
  const within60 = Math.min(overtimeMin, MONTHLY_OT_THRESHOLD_MIN);
  const over60 = Math.max(0, overtimeMin - MONTHLY_OT_THRESHOLD_MIN);
  return Math.round(
    (within60 / 60) * hourlyRate * 1.25 + (over60 / 60) * hourlyRate * 1.5,
  );
}

export function effectiveTravelKm(p: MonthlyPayroll): number {
  return p.travel_km > 0 ? p.travel_km : p.travel_km_auto;
}

export function travelFeeAmount(p: MonthlyPayroll): number {
  return Math.round(effectiveTravelKm(p) * p.office_travel_unit_price);
}

export function commuteFeeAmount(p: MonthlyPayroll): number {
  return Math.round(p.summary.commuteKmTotal * p.office_commute_unit_price);
}

export function overtimeExcessPay(p: MonthlyPayroll, otSettings: Map<string, OvertimeSetting>): number {
  return Math.max(0, computeOvertimePay(p, otSettings) - (p.settings?.fixed_overtime_pay ?? 0));
}

/**
 * 月給者の総支給額。ここが唯一の正 (single source of truth)。
 *
 * 2026-08-31 監査での是正:
 *   同じ「総支給額」を 3 か所が別々の式で計算しており、値が食い違っていた。
 *   1 つの関数に集約して食い違いを構造的に無くした。page.tsx はこの関数を
 *   CSV 出力・一覧の行・フッタ合計の 3 箇所すべてから呼ぶ。
 */
export function monthlyGrandTotal(p: MonthlyPayroll, otSettings: Map<string, OvertimeSetting>): number {
  if (!p.settings) return 0;
  return (
    fixedTotal(p.settings) +
    (p.bonus_paid ? p.settings.bonus_amount : 0) +
    travelFeeAmount(p) +
    commuteFeeAmount(p) +
    p.business_trip_fee +
    p.childcare_allowance +
    careOvertimePay(p) +
    yochoAllowance(p) +
    overtimeExcessPay(p, otSettings)
  );
}

// ─── 時給者 ──────────────────────────────────────────────────────────────

export function hourlyTenure(e: HourlyPayroll): number {
  return computeTenureAllowance(
    e.has_care_qualification,
    e.effective_service_months,
    "時給",
    e.job_type,
    e.summary.visitMinutesExcludingAccompanied,
    e.summary.recordCount,
    e.care_plan_count,
  );
}

/**
 * 時給者の総支給額。月給者の monthlyGrandTotal と同じ理由で 1 か所に集約している。
 *
 * ⚠ 土日祝手当 (weekendHolidayAllowanceAmount) は 意図的にここに入れていない。
 *   CSV の列にも一覧にも出るが、支給対象なのか表示だけなのかは業務判断のため
 *   (2026-03 全社実績で 635,967 円ぶん)。追加するときは user 判断のうえ、
 *   ここに1行足すだけで CSV・一覧・フッタの3箇所が揃って変わる。
 */
export function hourlyTotalPay(e: HourlyPayroll): number {
  return (
    e.totalPay +
    hourlyTenure(e) +
    e.treatment_subsidy +
    e.paid_leave_allowance +
    e.cancel_allowance +
    e.travel_allowance +
    e.communication_fee +
    e.meeting_fee +
    e.childcare_allowance +
    e.commute_fee +
    e.business_trip_fee +
    e.error_adjustment
  );
}

/**
 * 土日祝手当の額。CSV・一覧・フッタの3箇所が同じ式 Math.round(min/60*100) を
 * 別々に書いていたのを統一した (挙動は変えていない)。
 *
 * ⚠ hourlyTotalPay には含まれない (上記コメント参照)。この関数は表示専用。
 */
export function weekendHolidayAllowanceAmount(weekendHolidayMinutes: number): number {
  return Math.round((weekendHolidayMinutes / 60) * 100);
}

// ─── 移動手当 (訪問介護・時給者) ─────────────────────────────────────────
//
// ⚠ 距離・時間そのもの (calcDayRoute 経由、Google Distance Matrix API を叩く)
//   は非同期・DB/外部API依存なのでここでは扱わない。ここは
//   「秒・メートルが分かった後」の金額換算だけを切り出したもの。

export function travelAllowanceAmount(totalTravelSec: number, rate: number): number {
  return rate > 0 ? Math.round((totalTravelSec / 3600) * rate) : 0;
}

export function adjustedCommuteDistanceM(totalCommuteM: number, distanceAdjustmentRatePct: number): number {
  return Math.round(totalCommuteM * (distanceAdjustmentRatePct / 100));
}

export function businessTripFeeAmount(adjustedDistanceM: number, travelUnitPrice: number): number {
  return Math.round((adjustedDistanceM / 1000) * travelUnitPrice);
}
