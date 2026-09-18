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
  /** この適用開始月からの給与形態 (時給/月給)。NULL = 職員マスタの値 (resolveEmploymentType) */
  salary_type?: string | null;
  /** この適用開始月からの役職。NULL = 職員マスタの値 */
  role_type?: string | null;
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
  /** 実績の休日区分が 日祭・休日 の訪問時間 (同行除く)。土曜を含まない。土日祝手当を 日祝だけで払う事業所用 */
  sundayHolidayMinutes: number;
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
  /** 研修・HRD研修の手当 = 研修時間 × 同行の時給 (trainingPayAmount) */
  training_pay: number;
  /** 土日祝手当の時給 (事業所ごと。未設定は 50円) */
  weekend_holiday_rate?: number;
  /** true なら土日祝手当を 日祭・休日 (実績の休日区分) の時間だけで払う (土曜を含まない) */
  weekend_holiday_sunday_only?: boolean;
  /** 時給者の残業 (日8h超 + 週40h超) の分と金額。hourlyOvertimeMinutes / hourlyOvertimePayAmount */
  overtime_minutes?: number;
  overtime_pay?: number;
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
  /** 介護超過の判定に使う介護時間 (分)。無ければ訪問時間 (careMinutesFromRecords) */
  care_minutes?: number;
  /** 介護超過の下の段 (閾値より前の from_hours〜閾値 を unit_price 円/時)。事業所ごと。payroll_app_settings care_overtime_lower_tiers */
  care_overtime_lower_tier?: { from_hours: number; unit_price: number } | null;
  /** 有給1日あたりの単価 (職員マスタ 有給単価)。monthlyPaidLeaveAllowance */
  paid_leave_unit_price?: number;
  /** 事務員の法内残業 (分)。legalWithinOvertimeMinutes */
  legal_within_minutes?: number;
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

/** パートヘルパー (訪問介護・訪問看護) の勤続手当単価 円/時。years は 1 以上 */
function visitCareTenureRate(years: number): number {
  return 10 + Math.floor(years / 5) * 20;
}

/**
 * 勤続手当計算（資格・経験による定期昇給）
 * 対象: 介護福祉士 / 実務者研修修了者 / 介護支援専門員 (= 居宅介護支援職員は全員所持)
 *   社員(月給)    : 1年=1,000円、以降1年ごと+500円
 *   パートヘルパー: 1年=10円/h、5年=30円/h、以降5年ごと+20円/h (10/30/50/70/90)
 *     ★ 2026-09-17 総括表 2026-07 全事業所のパート 127名で確認 (124名一致)。旧式 5年ごと+10円 は 5年以上で過少だった
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
      const rate = visitCareTenureRate(years);
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
  if (jobType === "訪問介護" || jobType === "訪問看護") return visitCareTenureRate(years);
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

/**
 * 介護時間 (分) = 訪問時間 − 0.75 掛け対象サービスの時間 × 0.25 (総括表と同じ。2026-09-17)
 * 例) 米倉靖子 2026-07: 7,345 − 180×0.25 = 7,300分 → 120h 超過 100分 × 2,500円 = 4,167円
 */
export function careMinutesFromRecords(records: { calc_duration: string; service_code: string }[], isHours075: (code: string) => boolean): number {
  return records.reduce((s, r) => {
    const m = parseDurationMinutes(r.calc_duration);
    return s + (isHours075(r.service_code) ? m * 0.75 : m);
  }, 0);
}

export function careOvertimePay(p: MonthlyPayroll): number {
  if (p.role_type !== "社員") return 0;
  const s = p.settings;
  if (!s || s.care_overtime_threshold_hours <= 0 || s.care_overtime_unit_price <= 0) return 0;
  const thresholdMin = s.care_overtime_threshold_hours * 60;
  const careMin = p.care_minutes ?? p.summary.visitMinutes;
  const overMin = Math.max(0, careMin - thresholdMin);
  // 下の段: 総括表 2026-03〜07 KT姉崎・姉崎ムツミ・市原・やわた・五井・木更津・袖ケ浦・君津 の社員は 100〜120h を 800円/時
  //   (木更津 江澤 2026-07 146h: 26h×2,500=65,000 + 20h×800=16,000 = 81,000 / 姉崎ムツミ 石田 110.25h: 10.25h×800 = 8,200)
  const tier = p.care_overtime_lower_tier;
  const lowerMin = tier && tier.unit_price > 0 ? Math.max(0, Math.min(careMin, thresholdMin) - tier.from_hours * 60) : 0;
  return Math.round((overMin / 60) * s.care_overtime_unit_price) + (tier ? Math.round((lowerMin / 60) * tier.unit_price) : 0);
}

export function yochoAllowance(p: MonthlyPayroll): number {
  const s = p.settings;
  if (!s || s.yocho_unit_price <= 0 || p.yocho_hours <= 0) return 0;
  return Math.round(p.yocho_hours * s.yocho_unit_price);
}

/** 月間時間外 60 時間 (分)。これを超えた分は 50% 割増 (労基法37条1項但書) */
export const MONTHLY_OT_THRESHOLD_MIN = 60 * 60;
/** 月給の事務員の所定時間 (総括表 提責・事務=2 の単価: 224,000円 → 1,409円 = 159h。5事業所で確認) */
export const OFFICE_WORKER_SCHEDULED_HOURS = 159;

/**
 * 事務員の法内残業 (分) = 出勤簿の日ごとに min(勤務, 8h) − 所定 の正の部分。所定は 8h、事業所書式の半有給の日は 4h。
 * 総括表: 高品 福田 2026-07 半有給 7/22(7h)・7/24(7:30)・7/27(3h) → 180+210+0 = 390分 × 1,409円 = 9,159円。
 *   木更津ムツミ・船橋・四街道・茂原 の事務員も 法内残業手当 = 法内残業 × 単価。
 */
export function legalWithinOvertimeMinutes(
  attDays: { day: number; work_hours: string }[],
  ofRecs: { item_name: string; item_date?: string | null }[],
): number {
  const halfDays = new Set<number>();
  for (const r of ofRecs) {
    if (!r.item_name.includes("半")) continue;
    for (const part of String(r.item_date ?? "").split(/[,、，\s]+/)) {
      const m = /(\d{1,2})[/月](\d{1,2})/.exec(part);
      if (m) halfDays.add(Number(m[2]));
    }
  }
  return attDays.reduce((s, r) => {
    const work = parseWorkHoursMinutes(r.work_hours);
    if (work <= 0) return s;
    const scheduled = halfDays.has(r.day) ? 240 : 480;
    return s + Math.max(0, Math.min(work, 480) - scheduled);
  }, 0);
}

export function computeOvertimePay(
  p: MonthlyPayroll,
  otSettings: Map<string, OvertimeSetting>,
): number {
  const ot = otSettings.get(p.job_type);
  if (!ot || ot.scheduled_hours_per_month <= 0) return 0;
  const overtimeMin = p.summary.overtimeMinutes;
  if (overtimeMin <= 0 && !(p.role_type === "事務員" && (p.legal_within_minutes ?? 0) > 0)) return 0;
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

  // 総括表 (ケイティ系 11 事業所 2026-07 月給者 118名が1円一致): 単価 = round(基礎 / 所定時間)、
  //   残業単価 = round(単価 × 1.25)。所定時間は 事務員 159h / それ以外 は設定値 (訪問介護 168h)
  const hours = p.role_type === "事務員" ? OFFICE_WORKER_SCHEDULED_HOURS : ot.scheduled_hours_per_month;
  const hourlyRate = Math.round(base / hours);
  // 労基法37条1項但書: 月 60 時間を超える時間外は 50% 割増。
  //   2026-08-31 監査まで一律 1.25 だった (実データで OT 64.0h の職員が居る)。
  const within60 = Math.min(overtimeMin, MONTHLY_OT_THRESHOLD_MIN);
  const over60 = Math.max(0, overtimeMin - MONTHLY_OT_THRESHOLD_MIN);
  const legalWithin = p.role_type === "事務員" ? (p.legal_within_minutes ?? 0) : 0;
  return Math.round(
    (within60 / 60) * Math.round(hourlyRate * 1.25) + (over60 / 60) * Math.round(hourlyRate * 1.5),
  ) + Math.round((legalWithin / 60) * hourlyRate);
}

export function effectiveTravelKm(p: MonthlyPayroll): number {
  return p.travel_km > 0 ? p.travel_km : p.travel_km_auto;
}

/**
 * 月給者の出張費 = 距離 × 単価 の円未満切り上げ (総括表と同じ。2026-09-17 確認)
 * さつきが丘 12.3円/km: 小林志麻 2026-07 530.9km → 6,530.07 → 6,531円 / 宮野宏子 838.1km → 10,308.63 → 10,309円
 */
export function travelFeeAmount(p: MonthlyPayroll): number {
  // 浮動小数の誤差で余計に 1 円上がらないよう 1e-6 を引いてから切り上げ
  return Math.ceil(effectiveTravelKm(p) * p.office_travel_unit_price - 1e-6);
}

export function commuteFeeAmount(p: MonthlyPayroll): number {
  return Math.round(p.summary.commuteKmTotal * p.office_commute_unit_price);
}

/** 提責・管理者は固定残業代を超える残業代を払わない (総括表: さつきが丘 提責3名 2026-04〜07、高品 千葉弘美 2026-07 で確認) */
export const NO_OVERTIME_EXCESS_ROLES = new Set(["提責", "管理者"]);

export function overtimeExcessPay(p: MonthlyPayroll, otSettings: Map<string, OvertimeSetting>): number {
  if (NO_OVERTIME_EXCESS_ROLES.has(p.role_type)) return 0;
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
    monthlyPaidLeaveAllowance(p) +
    overtimeExcessPay(p, otSettings)
  );
}

/**
 * 月給者の有給休暇手当 = (有給 + 半有給×0.5) × 人ごとの有給単価 (円/日)。
 * 総括表: 同じ人は月が違っても日額が同じ (高品 根本 82円 3〜7月 / さつき 大治 252円 4〜7月 / 高品 櫻井 3月半日643・7月1日1,286)。
 * 提責・事務員は有給単価 0 のまま (総括表で有給休暇手当が出ていない)。
 */
export function monthlyPaidLeaveAllowance(p: MonthlyPayroll): number {
  return paidLeaveAllowanceAmount(paidLeaveDays(p.summary.paidLeave, p.summary.halfLeave), p.paid_leave_unit_price ?? 0);
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
    weekendHolidayAllowanceAmount(weekendAllowanceMinutes(e), e.weekend_holiday_rate) +
    e.office_work_pay +
    hourlyTenure(e) +
    e.treatment_subsidy +
    e.paid_leave_allowance +
    e.cancel_allowance +
    e.travel_allowance +
    e.communication_fee +
    e.meeting_fee +
    e.training_pay +
    (e.overtime_pay ?? 0) +
    e.childcare_allowance +
    e.commute_fee +
    e.business_trip_fee +
    e.error_adjustment
  );
}

/**
 * 土日祝手当 = 土日祝の訪問時間 (同行を除く) × 50円/時、四捨五入。hourlyTotalPay に含める。
 * 2026-09-17: 総括表の総支給額に含まれていることを確認 (さつきが丘 2026-04〜07 で 65名中54名が1円一致。
 *   森幸代 2026-04 1,095分 → 912.5 → 913円)。ずれる数件は祝日カレンダーの違い (振替休日・海の日など、未調査)。
 *   それまでは 100円/時 の表示専用で総支給に入れていなかった。
 */
/**
 * 土日祝手当の対象時間。
 * Hana系 (さつき・高品 等) は 土日祝 (カレンダー) × 50円。KT姉崎・ムツミ系・リンクス 等は 実績の休日区分 日祭・休日 だけ × 100円
 * (総括表 姉崎ムツミ 2026-07: 栗原 日祭13.0h+休日0.75h = 13.75h → 1,375円 / 土曜 22h の 加藤 は 日祭8h+休日1h = 900円)。
 */
export function weekendAllowanceMinutes(e: { summary: AttendanceSummary; weekend_holiday_sunday_only?: boolean }): number {
  return e.weekend_holiday_sunday_only ? e.summary.sundayHolidayMinutes : e.summary.weekendHolidayMinutes;
}

/** 土日祝手当の時給の既定値。事業所ごとの値は payroll_app_settings の weekend_holiday_allowance_rates */
export const DEFAULT_WEEKEND_HOLIDAY_RATE = 50;

export function weekendHolidayAllowanceAmount(weekendHolidayMinutes: number, ratePerHour: number = DEFAULT_WEEKEND_HOLIDAY_RATE): number {
  return Math.round((weekendHolidayMinutes / 60) * ratePerHour);
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
  break_time?: string | null;
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

/**
 * 会議の時間 (分)。事業所書式の 研修 の「会議」(開始・終了あり) を足す。
 * 総括表では 会議費 = 会議件数 × 会議単価 (1,500円) ＋ 会議時間 × 同行の時給 の合計。
 *   四街道 2026-05 米倉有香 2,650円 = 60分×1,150 + 1件×1,500 / やわた 2026-06 石本美幸 3,800円 = 120分×1,150 + 1,500
 * ⚠ おゆみ野だけは 会議の記録があっても総括表が 0 円 (2026-07 の 3 名で確認)。
 *   事業所ごとの除外は payroll_app_settings の meeting_fee_unpaid_offices で持つ。
 */
export function meetingMinutes(ofRecs: OfficeFormRecord[]): number {
  const toMin = (t: string | null | undefined) => { const [h, m] = String(t ?? "").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  return ofRecs
    .filter((r) => r.record_type === "training" && r.item_name === "会議" && r.start_time && r.end_time)
    .reduce((s, r) => s + Math.max(0, toMin(r.end_time) - toMin(r.start_time) - toMin(r.break_time)), 0);
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

/**
 * 同行ドタキャン (010999) は 600円。ドタキャン・キャンセル (010386/013052/010008/019007) は全事業所共通の 800円 (事業所のキャンセル単価)。
 * 総括表 2026-03〜07 全事業所: 010999 の 5 件がすべて 600円、010386/013052/010008/019007 は 800円
 *   (ちはら台 鈴木恵子 010999+013052 = 1,400円)。
 */
export const CANCEL_600_CODES = new Set(["010999"]);

/** キャンセル手当 (時給者): キャンセル明細のサービスコードごとに 600円 / 事業所単価 */
export function cancelAllowanceFromCodes(cancelCodes: string[], officeCancelUnitPrice: number): number {
  return cancelCodes.reduce((s, code) => s + (CANCEL_600_CODES.has(code) ? 600 : officeCancelUnitPrice), 0);
}

/** キャンセル手当 (時給者) */
export function cancelAllowanceAmount(cancelCount: number, cancelUnitPrice: number): number {
  return Math.round(cancelCount * cancelUnitPrice);
}

/** 有給手当 (時給者) */
/** 有給の日数 = 有給 + 半有給 × 0.5 (森幸代 2026-06 半有給1回 × 8,635円 = 4,318円 で総括表と一致) */
export function paidLeaveDays(paidLeave: number, halfLeave: number): number {
  return paidLeave + halfLeave * 0.5;
}

/**
 * 研修の時間 (分)。事業所書式の日時項目「研修」「HRD研修」の 開始〜終了 − 休憩。
 * ⚠ 初任者研修は含めない (総括表の初任者研修時間と記録の時間が合わず、ルール未確認)
 */
export function trainingMinutes(ofRecs: OfficeFormRecord[]): number {
  const toMin = (t: string | null | undefined) => { const [h, m] = String(t ?? "").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  return ofRecs
    .filter((r) => r.record_type === "training" && (r.item_name === "研修" || r.item_name === "HRD研修") && r.start_time && r.end_time)
    .reduce((s, r) => s + Math.max(0, toMin(r.end_time) - toMin(r.start_time) - toMin(r.break_time)), 0);
}

/**
 * 初任者研修の時間 (事業所書式 研修 の 初任者研修: 終了−開始−休憩)。
 * 総括表では 初任者研修費 = 時間 × 同行の時給 (さつきが丘 福井知佳子 2026-05 2670分 51,175円 / 2026-06 2820分 54,050円 = 1,150円/時)。
 * ⚠ 事業所書式から出す時間は 2840分 / 2990分 で、総括表より両月とも 170分 多い (原因未特定)。
 * 介護時間 (社員の介護超過) には足さない。
 */
export function shoninshaTrainingMinutes(ofRecs: OfficeFormRecord[]): number {
  const toMin = (t: string | null | undefined) => { const [h, m] = String(t ?? "").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  return ofRecs
    .filter((r) => r.record_type === "training" && r.item_name === "初任者研修" && r.start_time && r.end_time)
    .reduce((s, r) => s + Math.max(0, toMin(r.end_time) - toMin(r.start_time) - toMin(r.break_time)), 0);
}

/** 研修手当 = 研修時間 × 同行の時給 (さつきが丘 1,150円: 岩田ゆきよ 2026-05 研修2h 2,300円 / 2026-07 HRD2h 2,300円+研修1h 1,150円) */
export function trainingPayAmount(minutes: number, hourlyRate: number | null): number {
  if (!hourlyRate || minutes <= 0) return 0;
  return Math.round((minutes / 60) * hourlyRate);
}

export function paidLeaveAllowanceAmount(paidLeaveDays: number, paidLeaveUnitPrice: number): number {
  return Math.round(paidLeaveDays * paidLeaveUnitPrice);
}

/**
 * 通信手当 (時給者・社保未加入のみ変動支給)。
 * 社保加入者は0円固定。未加入者は当月訪問時間で 50h超=1000円 / 0〜50h=500円 / 0h=0円。
 */
/**
 * 通信費タイプ (payroll_employees.communication_fee_type)
 *   none         既定。社保加入 0円 / 未加入は訪問時間で 500・1000円
 *   variable     社保加入でも 訪問時間で 500・1000円 (スマホ貸与なし。高品 伊藤あゆみ)
 *   lend         スマホ貸与あり 0円 (高品 松元綾子)
 *   (DB 列は varchar(10) なので値は 10 文字以内)
 *   lend_fee  貸与要件を満たさないが引き続き貸与を希望 → 負担 -1,700円 (user 2026-09-17。高品 菊池・中村・西田)
 */
export const COMMUNICATION_FEE_TYPES = ["none", "variable", "lend", "lend_fee"] as const;
export const PHONE_LEND_CHARGE = -1700;

export function communicationFeeAmount(hasSocialInsurance: boolean, visitMinutes: number, feeType: string = "none"): number {
  if (feeType === "lend_fee") return PHONE_LEND_CHARGE;
  if (feeType === "lend") return 0;
  if (hasSocialInsurance && feeType !== "variable") return 0;
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
/**
 * 時給者の出張費 = 事業所書式の出張km × 事業所の出張単価、円未満切り上げ (総括表と同じ)。
 * さつきが丘 2026-06 12.3円/km で 15/15 名一致 (石毛 64km → 787.2 → 788円)。
 */
export function hourlyBusinessTripFeeAmount(businessKmTotal: number, travelUnitPrice: number): number {
  return Math.ceil(businessKmTotal * travelUnitPrice - 1e-6);
}

/**
 * 出勤時間 (分)。出勤簿があればその合計。出勤簿が無い社員 (提責・事務員以外の月給者) は
 * サービス時間 + 訪問間の移動時間 (2時間以上の空きは除く・15分控除なし) とする (2026-09-17 user 方針)。
 * 実データ: さつきが丘 2026-07 米倉靖子 訪問 7,345分 + 移動 1,093分 ≒ 総括表 8,436分 (差 +2分)。
 */
export function employeeWorkMinutes(
  attendanceDays: number,
  attendanceWorkMin: number,
  visitMinutes: number,
  travelTimeFullSec: number,
): number {
  if (attendanceDays > 0) return attendanceWorkMin;
  return visitMinutes + Math.round(travelTimeFullSec / 60);
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

/**
 * 訪問 1 件の支給額 (総括表を作っている給与管理システムと同じ式。2026-09-17 さつきが丘で確認)。
 *
 *   - 身体介護・同行援護 (移動支援の身体ありも身体介護に仕分け) は 最初の 1.5 時間まで その区分の時給、
 *     1.5 時間を超えた分は overflowRate (その事業所の生活援助の時給)。
 *       例) 同行援護 3:00 = 1.5h×2,100 + 1.5h×1,800 = 5,850円 / 移身有7 7:00 = 13,050円
 *   - 早朝・夜間 (時間帯 夜朝/夜間/早朝/早朝夜間/早朝・夜間) は 25%増し (身3夜 1:30 → 3,150 + 788 = 3,938円)。
 *     深夜は ×1.5 (★ 実データ未確認)
 *   - 円未満は 1 件ごとに切り捨て (身1生1 0:40 × 1,900円 = 1,266円)
 *   - 土日祝・特日の割増は ここでは付けない (別の手当)
 * 実データ: 滝下恵子 2026-08 104,682円 / 柏熊ルミ子 2026-08 55,116円 が給与管理システムの総合計と一致。
 * 単価が引けない (hourlyRate=null) 明細は null (未マッピング扱い)。
 */
export const VISIT_PAY_TIERED_CATEGORIES = new Set(["身体介護", "同行援護"]);
export const VISIT_PAY_TIER_HOURS = 1.5;
/**
 * 夜朝の時間 (時間単位) = 時間帯が早朝・夜間の訪問の算定時間の合計。月給者の夜朝手当 (yochoAllowance) に使う。
 * 実データ (さつきが丘 × 200円/時): 大治浅美 2026-06 510分→1,700円 / 2026-07 480分→1,600円、米倉靖子 90分→300円 / 120分→400円 が総括表と一致。
 * ⚠ 深夜を含めるかは未確認 (深夜の実績が無かった) → 含めていない
 */
/**
 * 時給者 (出勤簿なし) の残業時間 = 日ごとの訪問時間の 8時間超 + 週 (日曜始まり・月内) の 8時間以内分の 40時間超。
 * 総括表の「内残業」と一致: さつきが丘 石毛 2026-05 30分 (5/8 8:30) / 滝下 2026-05 60分・2026-07 30分、
 *   おゆみ野 金城 2026-07 2190分 (日1230+週960) / 加藤 570 / 花見川 朝比奈 150 / 袖ケ浦 藤田 90。
 * ⚠ 合わない例あり (五井 森朱希 2339 vs 1945 / やわた 石本 3153 vs 3015 / 高品 鈴木一生 230 vs 150)。移動時間を含むか等は未特定。
 */
export function hourlyOvertimeMinutes(records: { service_date: string; calc_duration: string }[]): number {
  const day = new Map<string, number>();
  for (const r of records) day.set(r.service_date, (day.get(r.service_date) ?? 0) + parseDurationMinutes(r.calc_duration));
  let daily = 0;
  const week = new Map<string, number>();
  for (const [date, min] of day) {
    daily += Math.max(0, min - 480);
    const [y, m, d] = date.split(/[-/]/).map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay());
    const key = dt.toISOString().slice(0, 10);
    week.set(key, (week.get(key) ?? 0) + Math.min(min, 480));
  }
  let weekly = 0;
  for (const w of week.values()) weekly += Math.max(0, w - 2400);
  return daily + weekly;
}

/** 時給者の残業代 = 残業分 × 10円 (総括表 全事業所 2026-05〜07 の 35 件すべてで 残業 = 内残業 × 10) */
export function hourlyOvertimePayAmount(minutes: number): number {
  return Math.max(0, minutes) * 10;
}

export function yochoHoursFromRecords(records: { calc_duration: string; time_period?: string | null }[]): number {
  const min = records
    .filter((r) => { const t = (r.time_period ?? "").trim(); return !t.includes("深夜") && /夜朝|夜間|早朝/.test(t); })
    .reduce((s, r) => s + parseDurationMinutes(r.calc_duration), 0);
  return min / 60;
}

export function timePeriodMultiplier(timePeriod: string | null | undefined): number {
  const t = (timePeriod ?? "").trim();
  if (t.includes("深夜")) return 1.5;
  if (/夜朝|夜間|早朝/.test(t)) return 1.25;
  return 1;
}
export function visitPayAmount(
  minutes: number,
  hourlyRate: number | null,
  categoryName: string,
  timePeriod: string | null | undefined,
  overflowRate: number | null,
): number | null {
  if (hourlyRate === null) return null;
  const hours = minutes / 60;
  let base = hours * hourlyRate;
  if (VISIT_PAY_TIERED_CATEGORIES.has(categoryName) && overflowRate !== null && hours > VISIT_PAY_TIER_HOURS) {
    base = VISIT_PAY_TIER_HOURS * hourlyRate + (hours - VISIT_PAY_TIER_HOURS) * overflowRate;
  }
  // 基本額は円未満切り捨て (浮動小数の誤差で 1 円落ちないよう 1e-6 を足す)、割増分は四捨五入して足す
  // (身3夜 1:30: 3,150 + round(787.5)=788 → 3,938。田村佳子 2026-07 9件 35,442円 と一致)
  // ★ 同行だけは基本額も四捨五入 (45分×1,150円 = 862.5 → 863)。2026-07 の総括表で
  //   端数差だった時給者 307 人が 286 → 307 人 全員 1 円一致 (2026-09-18)
  const baseYen = categoryName === "同行" ? Math.round(base) : Math.floor(base + 1e-6);
  return baseYen + Math.round(baseYen * (timePeriodMultiplier(timePeriod) - 1));
}

/** 実績1件ぶんの支給額 (時給 × 時間)。⚠ 旧式 (四捨五入・段階なし)。給与計算画面は visitPayAmount を使う単価が引けない (hourlyRate=null) 明細は null (未マッピング扱い) */
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
  /** 時間帯 (通常/日中/早朝夜間/深夜 など)。訪問の支給額の割増に使う */
  time_period?: string | null;
  /** MEISAI の休日区分 (平日/日祭/休日 …) */
  holiday_type?: string | null;
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
/** 事業所書式の日付欄に入っている日付の数 ("7/3,7/6" → 2、"7月22日" → 1、空 → 1) */
export function listedDateCount(itemDate: string | null | undefined): number {
  const n = String(itemDate ?? "").split(/[,、，\s]+/).filter((x) => x.trim() !== "").length;
  return Math.max(1, n);
}

export function computeSummary(
  empRecs: VisitServiceRecord[],
  attDays: OfficeAttendanceRecord[],
  ofRecs: OfficeFormRecord[],
  /** 通勤km の優先: 事務員は 事業所書式 / それ以外 (提責など) は 出勤簿。空・0 ならもう一方 (user 2026-09-18) */
  commuteSource: "office_form_first" | "attendance_first" = "attendance_first",
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
  // 日付スロットは 1 行に複数日が入ることがある (高品 2026-07: "7/3,7/6,7/11")。日付の数を日数とする
  //   (総括表: 菊池 6日×8,759=52,554 / 福田 半有給 "7/22,7/24,7/27" = 1.5日)
  // record_type を問わず item_name で判定（数値スロット＝"km"で保存されるケースを吸収）
  // 数値スロットの場合は numeric_value が件数、日付スロットの場合は1件として計算
  const paidLeaveRecs = ofRecs.filter((r) => r.item_name.includes("有給") && !r.item_name.includes("半"));
  const paidLeaveFromOf = paidLeaveRecs.reduce((s, r) =>
    s + (r.record_type === "km" ? Math.round((r.numeric_value as number) ?? 1) : listedDateCount(r.item_date)), 0);
  const paidLeave = paidLeaveFromOf;
  const halfLeave = ofRecs.filter((r) => r.item_name.includes("半有給")).reduce((s, r) =>
    s + (r.record_type === "km" ? Math.round((r.numeric_value as number) ?? 1) : listedDateCount(r.item_date)), 0);
  const specialLeave = ofRecs.filter((r) => r.item_name.includes("特休")).reduce((s, r) =>
    s + (r.record_type === "km" ? Math.round((r.numeric_value as number) ?? 1) : listedDateCount(r.item_date)), 0);
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
  // 通勤km: 出勤簿の合計と 事業所書式のどちらを優先するかは 職種で分ける (user 2026-09-18)。
  //   事務員 = 書式優先 / 提責など = 出勤簿優先。どちらも 空・0 ならもう一方を使う。
  // 参考 (総括表 2026-04〜07 の提責): 両方が違うのは 4 件で、いずれも書式の値で一致していた
  // (高品 福田 出勤簿0→書式69 / 君津 森田 14.4→61.2 / ちはら台 鎗田 988→1020.6)。出勤簿優先はこの 4 件がずれる
  const commuteKmFromAtt = attDays.reduce((s, r) => s + ((r as unknown as { commute_km?: number }).commute_km ?? 0), 0);
  const commuteKmFromOf = ofRecs.filter((r) => r.item_name === "通勤km").reduce((s, r) => s + (Number(r.numeric_value) || 0), 0);
  const commuteKmTotal = commuteSource === "office_form_first"
    ? (commuteKmFromOf > 0 ? commuteKmFromOf : commuteKmFromAtt)
    : (commuteKmFromAtt > 0 ? commuteKmFromAtt : commuteKmFromOf);
  const businessKmTotal = attDays.reduce((s, r) => s + ((r as unknown as { business_km?: number }).business_km ?? 0), 0);
  const weekendHolidayMinutes = empRecs
    .filter((r) => isWeekendOrHoliday(r.service_date) && (!r.accompanied_visit || r.accompanied_visit.trim() === ""))
    .reduce((s, r) => s + parseDurationMinutes(r.calc_duration), 0);
  const weekendHolidayAccompaniedMinutes = empRecs
    .filter((r) => isWeekendOrHoliday(r.service_date) && r.accompanied_visit && r.accompanied_visit.trim() !== "")
    .reduce((s, r) => s + parseDurationMinutes(r.calc_duration), 0);
  const sundayHolidayMinutes = empRecs
    .filter((r) => /日祭|休日/.test(r.holiday_type ?? "") && (!r.accompanied_visit || r.accompanied_visit.trim() === ""))
    .reduce((s, r) => s + parseDurationMinutes(r.calc_duration), 0);

  return { workDays, helperDays, paidLeave, halfLeave, specialLeave, workHoursMin, overtimeMinutes, recordCount, accompaniedCount, visitMinutes, visitMinutesExcludingAccompanied, hrdCount, hrdMinutes, meetingCount, commuteKmTotal, businessKmTotal, weekendHolidayMinutes, weekendHolidayAccompaniedMinutes, sundayHolidayMinutes };
}
