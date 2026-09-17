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
  /** 事務時給 (円/時間)。事務員 (payroll_employees.is_office_worker) のみ使用。0 = 計算しない */
  office_work_hourly_rate: number;
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
  /** 事務時間 (分)。事務員のみ = 出勤簿の出勤時間。それ以外は 0 */
  office_work_minutes: number;
  office_work_hourly_rate: number;
  /** 事務の本人給 = 事務時間 × 事務時給 (officeWorkPayAmount) */
  office_work_pay: number;
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
    e.office_work_pay +
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

// ─── 保育手当・会議費 (事業所書式入力レコード由来) ────────────────────────
// page.tsx から一言一句転記 (2026-09-05 切り出し)。

export type OfficeFormRecord = {
  employee_number: string;
  record_type: string;
  item_name: string;
  item_date: string | null;
  numeric_value: number | null;
  start_time: string | null;
  end_time: string | null;
  year_month: string | null; // childcare: 何月分か (YYYYMM)
  child_name: string | null; // childcare: 子供の名前
  amount: number | null;     // childcare: 支払い金額
};

const MONTH_ABBR: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

/** "YYYY/M" "YYYY/MM" "MMM-YY" "YY-MMM" 等 表記ゆれのある年月文字列を YYYYMM に正規化する */
export function normalizeYM(ym: string): string {
  if (!ym) return ym;
  // "YYYY/M" or "YYYY/MM"
  const slashIdx = ym.indexOf("/");
  if (slashIdx !== -1) {
    const y = ym.slice(0, slashIdx);
    const m = ym.slice(slashIdx + 1).padStart(2, "0");
    return y + m;
  }
  // "MMM-YY" or "YY-MMM" (e.g. "Dec-25" or "25-Dec" → "202512")
  const dashIdx = ym.indexOf("-");
  if (dashIdx !== -1) {
    const left = ym.slice(0, dashIdx);
    const right = ym.slice(dashIdx + 1);
    // Dec-25 形式
    if (MONTH_ABBR[left]) {
      const fullYear = "20" + right.padStart(2, "0");
      return fullYear + MONTH_ABBR[left];
    }
    // 25-Dec 形式
    if (MONTH_ABBR[right]) {
      const fullYear = "20" + left.padStart(2, "0");
      return fullYear + MONTH_ABBR[right];
    }
  }
  return ym;
}

/**
 * 保育手当を計算する。
 * @param recs 対象職員の childcare レコード (呼出元で employee_number フィルタ済み)
 * @param salaryType "月給" | "時給" (時給者は実働按分)
 * @param visitMinutesByEmpMonth `${empNum}:${ym}` → その月の visitMinutes (時給者の按分に使う)
 * @param empNum 対象職員番号 (visitMinutesByEmpMonth のキー組み立てに使う)
 * @param selectedMonth year_month が空のレコードのフォールバック月
 */
export function computeChildcareAllowance(
  recs: OfficeFormRecord[],
  salaryType: string,
  visitMinutesByEmpMonth: Map<string, number>,
  empNum: string,
  selectedMonth: string,
): number {
  if (recs.length === 0) return 0;
  const uniqueChildren = new Set(recs.map((r) => r.child_name ?? "不明")).size;
  const ceiling = uniqueChildren >= 2 ? 30000 : 20000;
  let total = 0;
  for (const rec of recs) {
    const amount = rec.amount ?? 0;
    if (amount <= 0) continue;
    const isKindergarten = rec.item_name.includes("幼稚園");
    const baseRate = isKindergarten ? 0.2 : 0.4;
    if (salaryType === "月給") {
      total += Math.round(amount * baseRate);
    } else {
      // year_month を YYYYMM に正規化してからルックアップ
      const rawYm = rec.year_month ?? selectedMonth;
      const ym = normalizeYM(rawYm);
      const visitMin = visitMinutesByEmpMonth.get(`${empNum}:${ym}`) ?? 0;
      const ratio = Math.min(visitMin / (120 * 60), 1.0);
      total += Math.round(amount * baseRate * ratio);
    }
  }
  return Math.min(total, ceiling);
}

/** 会議費を計算する (月給・時給共通) */
export function computeMeetingFee(ofRecs: OfficeFormRecord[], meetingUnitPrice: number): number {
  const meetingCount = ofRecs
    .filter((r) => r.item_name.includes("会議1"))
    .reduce((s, r) => s + (r.record_type === "km" ? Math.round((r.numeric_value as number) ?? 1) : 1), 0);
  return Math.round(meetingCount * meetingUnitPrice);
}

// ─── 時給者の各種手当 (page.tsx から一言一句転記。2026-09-05 切り出し) ────

/**
 * 処遇改善支援費 (訪問介護・社保加入・当月実績ありなら事業所単価、それ以外は給与設定の額)。
 * ⚠ 手当というより「どちらの単価を採用するか」の選択ロジック。
 */
export function treatmentSubsidyAmount(
  isVisitCare: boolean,
  hasSocialInsurance: boolean,
  visitMinutes: number,
  officeSubsidyAmount: number,
  salaryTreatmentSubsidy: number,
): number {
  return isVisitCare && hasSocialInsurance && visitMinutes > 0 ? officeSubsidyAmount : salaryTreatmentSubsidy;
}

/** キャンセル手当 (時給者) */
export function cancelAllowanceAmount(cancelCount: number, cancelUnitPrice: number): number {
  return Math.round(cancelCount * cancelUnitPrice);
}

/** 有給手当 (時給者) */
export function paidLeaveAllowanceAmount(paidLeaveDays: number, paidLeaveUnitPrice: number): number {
  return Math.round(paidLeaveDays * paidLeaveUnitPrice);
}

/**
 * 通信手当 (時給者・社保未加入のみ変動支給)。
 * 社保加入者は0円固定。未加入者は当月訪問時間で 50h超=1000円 / 0〜50h=500円 / 0h=0円。
 */
export function communicationFeeAmount(hasSocialInsurance: boolean, visitMinutes: number): number {
  if (hasSocialInsurance) return 0;
  const visitHours = visitMinutes / 60;
  if (visitHours > 50) return 1000;
  if (visitHours > 0) return 500;
  return 0;
}

/** 通勤費 (時給者) */
export function hourlyCommuteFeeAmount(commuteKmTotal: number, commuteUnitPrice: number): number {
  return Math.round(commuteKmTotal * commuteUnitPrice);
}

/** 出張費 (時給者) */
export function hourlyBusinessTripFeeAmount(businessKmTotal: number, travelUnitPrice: number): number {
  return Math.round(businessKmTotal * travelUnitPrice);
}

/**
 * 事務員の本人給 = 事務時間 × 事務時給。
 * 事務時間は出勤簿の出勤時間 (AttendanceSummary.workHoursMin) をそのまま使う
 * (総括表の「内事務入浴」= 出勤時間。例: さつきが丘 福島可奈 2026-07 126:30 × 1,150円 = 145,475円)。
 * 事務員でない / 事務時給が 0 のときは 0。
 */
export function officeWorkPayAmount(isOfficeWorker: boolean, workHoursMin: number, hourlyRate: number): number {
  if (!isOfficeWorker || !(hourlyRate > 0)) return 0;
  return Math.round((workHoursMin / 60) * hourlyRate);
}

/** 実績1件ぶんの支給額 (時給 × 時間)。単価が引けない (hourlyRate=null) 明細は null (未マッピング扱い) */
export function hourlyRecordPay(minutes: number, hourlyRate: number | null): number | null {
  return hourlyRate !== null ? Math.round((minutes / 60) * hourlyRate) : null;
}

// ─── 勤怠サマリー (computeSummary) の依存 helper。page.tsx から一言一句転記
// (2026-09-05 切り出し)。★ 2026-08-31 に「週残業まるごと未払い」の実バグが
// 出た箇所 (小原奈保子 2026-02-07 で ¥13,333 が 0円になっていた)。

const JAPAN_HOLIDAYS = new Set([
  // 2024
  "20240101", "20240108", "20240211", "20240212", "20240223", "20240320",
  "20240429", "20240503", "20240504", "20240505", "20240506",
  "20240715", "20240811", "20240812", "20240916", "20240923", "20241014",
  "20241103", "20241104", "20241123",
  // 2025
  "20250101", "20250113", "20250211", "20250224", "20250320",
  "20250429", "20250503", "20250504", "20250505", "20250506",
  "20250721", "20250811", "20250915", "20250923", "20251013",
  "20251103", "20251123", "20251124",
  // 2026
  "20260101", "20260112", "20260211", "20260223", "20260320",
  "20260429", "20260503", "20260504", "20260505", "20260506",
  "20260720", "20260811", "20260921", "20260923", "20261012",
  "20261103", "20261123",
  // 2027
  "20270101", "20270111", "20270211", "20270223", "20270321",
  "20270429", "20270503", "20270504", "20270505",
  "20270719", "20270811", "20270920", "20270923", "20271011",
  "20271103", "20271123",
]);

/** YYYYMMDD 形式の日付が土日または祝日かどうかを判定 */
export function isWeekendOrHoliday(dateStr: string): boolean {
  const d = dateStr.replace(/\D/g, "");
  if (d.length < 8) return false;
  const date = new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
  const dow = date.getDay();
  return dow === 0 || dow === 6 || JAPAN_HOLIDAYS.has(d.slice(0, 8));
}

export function parseDurationMinutes(str: string): number {
  if (!str) return 0;
  str = str.trim();
  let result: number;
  if (str.includes(":")) {
    const [h, m] = str.split(":").map(Number);
    result = (h || 0) * 60 + (m || 0);
  } else {
    result = parseInt(str, 10) || 0;
  }
  // 開始時刻＝終了時刻のとき24時間になる場合は0として扱う
  return result >= 1440 ? 0 : result;
}

export function parseWorkHoursMinutes(s: string): number {
  if (!s || !s.trim()) return 0;
  s = s.trim();
  let result: number;
  if (s.includes(":")) {
    const [h, m] = s.split(":").map(Number);
    result = (h || 0) * 60 + (m || 0);
  } else {
    const n = parseFloat(s);
    result = isNaN(n) ? 0 : Math.round(n * 60);
  }
  // 開始時刻＝終了時刻のとき24時間になる場合は0として扱う
  return result >= 1440 ? 0 : result;
}

/** service_date 文字列から「日」の数値を抽出（YYYYMMDD / YYYY/MM/DD 等に対応） */
export function extractDay(serviceDate: string): number {
  const digits = serviceDate.replace(/\D/g, ""); // 数字のみ
  if (digits.length >= 8) return parseInt(digits.slice(6, 8), 10);
  return 0;
}

/** 訪問介護実績記録 (payroll_service_records 由来)。page.tsx の旧 ServiceRecord。 */
export type VisitServiceRecord = {
  id: string;
  employee_number: string;
  employee_name: string;
  service_date: string;
  calc_duration: string;
  service_code: string;
  office_number: string;
  accompanied_visit: string;
  client_number: string;
  dispatch_start_time: string;
  dispatch_end_time: string;
};

/**
 * 事業所書式の出勤簿1日ぶん (payroll_office_attendance 由来)。page.tsx の旧 AttendanceRecord。
 * ⚠ attendance-calc.ts の `AttendanceRecord` (居宅ケアマネ向け) とは別物。名前が同じでも中身が違う。
 */
export type OfficeAttendanceRecord = {
  employee_number: string;
  day: number;
  work_note_1: string;
  work_note_2: string;
  work_note_3: string;
  work_note_4: string;
  work_note_5: string;
  start_time_1: string;
  work_hours: string;
  overtime_daily: string;
  overtime_weekly: string;
  // ⚠ 実データには commute_km / business_km も入っているが、元の型定義には
  //   無く unsafe cast で読んでいた (page.tsx 由来の既存の型安全性の穴。
  //   ここでの切り出しでは挙動を変えないためそのまま踏襲する)。
};

/**
 * 職員1名ぶんの勤怠サマリーを組み立てる。
 * @param empRecs 対象職員の訪問実績 (呼出元で employee_number フィルタ済み)
 * @param attDays 対象職員の出勤簿 (同上)
 * @param ofRecs 対象職員の事業所書式レコード (同上)
 *
 * ── 実データ突合 (2026-09-05・202602 / 訪問実績32,801行・出勤簿336行・
 *   事業所書式198行・職員454名) ──
 *   ✅ 切り出し前後 (OLD/NEW) は全員 1分/1件まで完全一致。
 *   record_type分岐の実データ分布: 有給/半有給/特休/HRDは全件date型、
 *   会議1は全件km型 (両方の分岐が実際に発火している)。
 *   残業の日/週の組み合わせ: 日残業のみ6件・★週残業のみ1件 (2026-08-31に
 *   丸ごと未払いだった型が実データにも存在)・両方0件・fallback発火117件。
 *
 * ⚠ ★ 半日換算 (workDays の 0.5) は実データで一度も発火していない (0/7,388日)。
 *   原因: 半有給レコードの item_date が実データでは "2/17" や "1月2日" 形式で
 *   保存されており、extractDay() が期待する8桁日付 (YYYYMMDD) と一致しないため
 *   extractDay が常に0を返す。→ 半日換算ロジックは事実上の死んだコード。
 *   ★ ただし workDays は CSV出力・画面表示のみに使われ、給与計算の入力には
 *   なっていない (grep確認済み) ので金銭的な影響は無い。日付形式の統一は
 *   別途 user 判断が必要なため、ここでは修正せず現状維持 (verbatim移植の対象外の発見)。
 */
export function computeSummary(
  empRecs: VisitServiceRecord[],
  attDays: OfficeAttendanceRecord[],
  ofRecs: OfficeFormRecord[],
): AttendanceSummary {
  // ヘルパー日数：service_date をそのまま Set のキーにして重複排除
  const helperDateSet = new Set(empRecs.map((r) => r.service_date));
  const helperDays = helperDateSet.size;

  // 出勤日数：実績の「日」+ 出勤簿の実勤務日の和集合
  // 半有給・半欠勤等の半日事象がある日は 0.5 として計算
  const helperDayNums = new Set(empRecs.map((r) => extractDay(r.service_date)).filter((d) => d > 0));
  const attWorkDayNums = new Set(
    attDays.filter((r) => r.start_time_1 && r.start_time_1.trim() !== "").map((r) => r.day),
  );
  const halfDayNums = new Set(
    ofRecs
      .filter((r) => r.item_name.startsWith("半"))
      .map((r) => extractDay(r.item_date ?? ""))
      .filter((d) => d > 0),
  );
  const allWorkedDays = new Set([...helperDayNums, ...attWorkDayNums]);
  const workDays = [...allWorkedDays].reduce((s, d) => s + (halfDayNums.has(d) ? 0.5 : 1.0), 0);

  // 有給・半有給・特休・HRDは事業所書式から取得
  // record_type を問わず item_name で判定（数値スロット＝"km"で保存されるケースを吸収）
  // 数値スロットの場合は numeric_value が件数、日付スロットの場合は1件として計算
  const paidLeaveRecs = ofRecs.filter((r) => r.item_name.includes("有給") && !r.item_name.includes("半"));
  const paidLeaveFromOf = paidLeaveRecs.reduce((s, r) =>
    s + (r.record_type === "km" ? Math.round((r.numeric_value as number) ?? 1) : 1), 0);
  const paidLeave = paidLeaveFromOf;
  const halfLeave = ofRecs.filter((r) => r.item_name.includes("半有給")).reduce((s, r) =>
    s + (r.record_type === "km" ? Math.round((r.numeric_value as number) ?? 1) : 1), 0);
  const specialLeave = ofRecs.filter((r) => r.item_name.includes("特休")).reduce((s, r) =>
    s + (r.record_type === "km" ? Math.round((r.numeric_value as number) ?? 1) : 1), 0);
  const hrdCount = ofRecs.filter((r) => r.item_name.includes("HRD")).reduce((s, r) =>
    s + (r.record_type === "km" ? Math.round((r.numeric_value as number) ?? 1) : 1), 0);
  const hrdMinutes = ofRecs.filter((r) => r.item_name.includes("HRD")).reduce((s, r) => {
    if (r.start_time && r.end_time) {
      const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
      return s + Math.max(0, toMin(r.end_time) - toMin(r.start_time));
    }
    return s + Math.round((r.numeric_value ?? 0) * 60);
  }, 0);
  const meetingCount = ofRecs.filter((r) => r.item_name.includes("会議1")).reduce((s, r) =>
    s + (r.record_type === "km" ? Math.round((r.numeric_value as number) ?? 1) : 1), 0);

  const workHoursMin = attDays.reduce((s, r) => s + parseWorkHoursMinutes(r.work_hours), 0);
  // 日残業 + 週残業 (Format B)。どちらも無ければ work_hours - 8h (Format A)。
  //
  // 2026-08-31 監査での是正:
  //   CSV 取込は 週残業/休日/法内残業 を保存しているのに、ここは
  //   overtime_daily しか見ておらず select にも入れていなかった。
  //   = 週残業が丸ごと未払い。実データで 小原奈保子 2026-02-07 に
  //     overtime_weekly="08:00" が実在し、13,333円 が 0円 になっていた。
  //   日残業(1日8h超) と 週残業(週40h超) は排他なので単純加算でよい。
  const overtimeMinutes = attDays.reduce((s, r) => {
    const od = parseWorkHoursMinutes(r.overtime_daily ?? "");
    const ow = parseWorkHoursMinutes(r.overtime_weekly ?? "");
    if (od > 0 || ow > 0) return s + od + ow;
    return s + Math.max(0, parseWorkHoursMinutes(r.work_hours) - 480);
  }, 0);
  const recordCount = empRecs.length;
  const accompaniedCount = empRecs.filter((r) => r.accompanied_visit && r.accompanied_visit.trim() !== "").length;
  const visitMinutes = empRecs.reduce((s, r) => s + parseDurationMinutes(r.calc_duration), 0);
  const visitMinutesExcludingAccompanied = empRecs
    .filter((r) => !r.accompanied_visit || r.accompanied_visit.trim() === "")
    .reduce((s, r) => s + parseDurationMinutes(r.calc_duration), 0);
  const commuteKmTotal = attDays.reduce((s, r) => s + ((r as unknown as { commute_km?: number }).commute_km ?? 0), 0);
  const businessKmTotal = attDays.reduce((s, r) => s + ((r as unknown as { business_km?: number }).business_km ?? 0), 0);
  const weekendHolidayMinutes = empRecs
    .filter((r) => isWeekendOrHoliday(r.service_date) && (!r.accompanied_visit || r.accompanied_visit.trim() === ""))
    .reduce((s, r) => s + parseDurationMinutes(r.calc_duration), 0);
  const weekendHolidayAccompaniedMinutes = empRecs
    .filter((r) => isWeekendOrHoliday(r.service_date) && r.accompanied_visit && r.accompanied_visit.trim() !== "")
    .reduce((s, r) => s + parseDurationMinutes(r.calc_duration), 0);

  return { workDays, helperDays, paidLeave, halfLeave, specialLeave, workHoursMin, overtimeMinutes, recordCount, accompaniedCount, visitMinutes, visitMinutesExcludingAccompanied, hrdCount, hrdMinutes, meetingCount, commuteKmTotal, businessKmTotal, weekendHolidayMinutes, weekendHolidayAccompaniedMinutes };
}
