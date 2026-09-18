// 訪問介護の給与計算 (月給・時給・残業・勤続手当・移動手当・土日祝手当) の
// 境界値検証 (純関数のみ・DB は一切触らない)。
//
//   npx tsx scripts/verify-payroll-calc-boundary.mts
//
// ── なぜ要るか ────────────────────────────────────────────────────────────
//   これらの式は apps/payroll-app/src/app/payroll/page.tsx (2,345行の
//   "use client" コンポーネント) に直書きされていて、import すると browser
//   client が起動し Node のハーネスから呼べなかった。検証が一度も行われていなかった。
//   src/lib/payroll/payroll-calc.ts に切り出したことで初めて検証できる。
//
// ⚠ この検証が証明していないこと (VERIFICATION_RULES 3-1):
//   - 勤怠集計 (AttendanceSummary の元になる出勤簿の集計) 自体の正しさ
//     → calcDaily/calcDailyListWithWeekly/calcMonthlySummary は
//       verify-overtime-boundary.mts で境界値検証済み (2026-09-05)
//   - 移動手当のうち 距離・時間の算出 (calcDayRoute)
//     → calcDayRoute自体は verify-distance-calculator.mts で境界値検証済み (2026-09-05)。
//       ただし distMap の中身 (Google Distance Matrix API / payroll_distance_cache の
//       値そのもの) は未検証
//   - 実データでの妥当性
import { buildActiveSalaryMap, resolveEmploymentType, resolvePaidLeaveUnitPriceFromHistory } from "../src/lib/payroll/salary-history";
import { bathVisitCareMinutes } from "../src/lib/payroll/monthly-inputs";
import { keepFirstKmRows } from "../src/lib/csv/office-form-parser";
import { findKmAnomalies } from "../src/lib/payroll/km-anomaly";
import {
  hasTenureQualification,
  computeTenureAllowance,
  computeTenureRate,
  listedDateCount,
  resolveTenureAllowance,
  fixedTotal,
  careOvertimePay,
  yochoAllowance,
  computeOvertimePay,
  MONTHLY_OT_THRESHOLD_MIN,
  effectiveTravelKm,
  travelFeeAmount,
  commuteFeeAmount,
  overtimeExcessPay,
  monthlyPaidLeaveAllowance,
  legalWithinOvertimeMinutes,
  midMonthWorkDays,
  hrdTrainingMinutes,
  dailyOvertimeFromVisits,
  shinyaHoursFromRecords,
  absenceDeduction,
  paidLeaveAllowanceByGrant,
  activePaidLeaveGrant,
  prorateMonthlyFixed,
  OFFICE_WORKER_SCHEDULED_HOURS,
  monthlyGrandTotal,
  hourlyTenure,
  hourlyTotalPay,
  weekendHolidayAllowanceAmount,
  weekendAllowanceMinutes,
  travelAllowanceAmount,
  adjustedCommuteDistanceM,
  businessTripFeeAmount,
  normalizeYM,
  computeChildcareAllowance,
  computeMeetingFee,
  isSundayOrHoliday,
  meetingMinutes,
  treatmentSubsidyAmount,
  cancelAllowanceAmount,
  cancelAllowanceFromCodes,
  paidLeaveAllowanceAmount,
  communicationFeeAmount,
  hourlyCommuteFeeAmount,
  hourlyBusinessTripFeeAmount,
  hourlyRecordPay,
  paidLeaveDays,
  trainingMinutes,
  shoninshaTrainingMinutes,
  hourlyOvertimeMinutes,
  hourlyOvertimePayAmount,
  trainingPayAmount,
  visitPayAmount,
  timePeriodMultiplier,
  yochoHoursFromRecords,
  careMinutesFromRecords,
  officeWorkPayAmount,
  employeeWorkMinutes,
  computeSummary,
  isWeekendOrHoliday,
  parseWorkHoursMinutes,
  extractDay,
  type SalarySettings,
  type OvertimeSetting,
  type MonthlyPayroll,
  type HourlyPayroll,
  type AttendanceSummary,
  type OfficeFormRecord,
  type VisitServiceRecord,
  type OfficeAttendanceRecord,
} from "../src/lib/payroll/payroll-calc";
import { isCareHours075 } from "../src/lib/payroll/care-hours-075";

let pass = 0;
const fail: string[] = [];
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fail.push(`${name}\n     期待 ${JSON.stringify(want)}\n     実際 ${JSON.stringify(got)}`);
};

// ─── 勤続手当 ────────────────────────────────────────────────────────────

eq("資格要件: 介護福祉士等でなくても居宅介護支援なら満たす",
  hasTenureQualification(false, "居宅介護支援"), true);
eq("資格要件: 資格なし・居宅介護支援でもないなら不成立",
  hasTenureQualification(false, "訪問介護"), false);

eq("勤続1年未満は0円 (11ヶ月)",
  computeTenureAllowance(true, 11, "月給", "訪問介護", 0, 0, 0), 0);
eq("月給 勤続1年ちょうど = 1,000円 (境界)",
  computeTenureAllowance(true, 12, "月給", "訪問介護", 0, 0, 0), 1000);
eq("月給 勤続2年 = 1,500円",
  computeTenureAllowance(true, 24, "月給", "訪問介護", 0, 0, 0), 1500);
eq("月給 勤続1年11ヶ月 (23ヶ月) はまだ1年目 = 1,000円",
  computeTenureAllowance(true, 23, "月給", "訪問介護", 0, 0, 0), 1000);

eq("時給 訪問介護 勤続1年・実働10h = 10円/h×10h=100円",
  computeTenureAllowance(true, 12, "時給", "訪問介護", 600, 0, 0), 100);
eq("★ 時給 訪問介護 勤続5年ちょうど (境界) = 30円/h (総括表 2026-07 全事業所)",
  computeTenureRate(true, 60, "訪問介護"), 30);
eq("★ 時給 訪問介護 勤続10/15/20年 = 50/70/90円/h (高品 鈴木香織 21年 90円)",
  [120, 180, 240, 263].map((m) => computeTenureRate(true, m, "訪問介護")), [50, 70, 90, 90]);
eq("★ 時給 訪問介護 勤続9年11ヶ月 = 30円/h", computeTenureRate(true, 119, "訪問介護"), 30);
eq("時給 訪問介護 勤続4年11ヶ月 (59ヶ月) はまだ10円/h",
  computeTenureRate(true, 59, "訪問介護"), 10);
eq("時給 訪問看護も訪問介護と同じ単価体系",
  computeTenureRate(true, 60, "訪問看護"), 30);
eq("時給 訪問入浴 勤続1年・実績3件 = 10円×3件=30円",
  computeTenureAllowance(true, 12, "時給", "訪問入浴", 0, 3, 0), 30);
eq("時給 居宅介護支援 勤続1年・プラン2件 = 50円×2件=100円",
  computeTenureAllowance(true, 12, "時給", "居宅介護支援", 0, 0, 2), 100);
eq("時給 対象外の職種 (事務等) は0円",
  computeTenureAllowance(true, 60, "時給", "事務", 1000, 10, 10), 0);
eq("資格なし・居宅介護支援でもない時給者は勤続年数があっても0円",
  computeTenureAllowance(false, 120, "時給", "訪問介護", 600, 0, 0), 0);

eq("勤続手当 auto=true (既定) は computed を返す",
  resolveTenureAllowance({ tenure_allowance: 999 } as unknown as SalarySettings, 100), 100);
eq("勤続手当 auto=false は手動入力値を返す",
  resolveTenureAllowance({ tenure_allowance: 999, tenure_allowance_auto: false } as unknown as SalarySettings, 100), 999);
eq("勤続手当 settings が null なら computed をそのまま返す",
  resolveTenureAllowance(null, 100), 100);

// ─── 月給者: 各手当・総支給額 ────────────────────────────────────────────

const salary = (over: Partial<SalarySettings> = {}): SalarySettings => ({
  employee_id: "e1", effective_from: "2026-01-01",
  base_personal_salary: 200000, skill_salary: 10000, position_allowance: 5000,
  qualification_allowance: 3000, tenure_allowance: 1000, treatment_improvement: 8000,
  specific_treatment_improvement: 2000, treatment_subsidy: 1000, fixed_overtime_pay: 20000,
  special_bonus: 0, bonus_amount: 0, travel_unit_price: 0,
  care_overtime_threshold_hours: 0, care_overtime_unit_price: 0, yocho_unit_price: 0,
  office_work_hourly_rate: 0,
  ...over,
});
eq("fixedTotal = 各手当の単純合計",
  fixedTotal(salary()), 200000 + 10000 + 5000 + 3000 + 1000 + 8000 + 2000 + 1000 + 20000 + 0);

const summary = (over: Partial<AttendanceSummary> = {}): AttendanceSummary => ({
  workDays: 0, helperDays: 0, paidLeave: 0, halfLeave: 0, specialLeave: 0,
  workHoursMin: 0, overtimeMinutes: 0, recordCount: 0, accompaniedCount: 0,
  visitMinutes: 0, hrdCount: 0, hrdMinutes: 0, meetingCount: 0,
  commuteKmTotal: 0, businessKmTotal: 0, weekendHolidayMinutes: 0,
  weekendHolidayAccompaniedMinutes: 0, sundayHolidayMinutes: 0, visitMinutesExcludingAccompanied: 0,
  ...over,
});
const monthly = (over: Partial<MonthlyPayroll> = {}): MonthlyPayroll => ({
  employee_id: "e1", employee_number: "1", employee_name: "サンプル",
  role_type: "社員", job_type: "訪問介護", auth_user_id: null,
  settings: salary(), bonus_paid: false, travel_km: 0, travel_km_auto: 0,
  office_travel_unit_price: 100, office_commute_unit_price: 50,
  business_trip_fee: 0, childcare_allowance: 0, yocho_hours: 0,
  summary: summary(),
  ...over,
});

eq("介護時間外手当: role_type が社員以外なら0円",
  careOvertimePay(monthly({ role_type: "パート" })), 0);
eq("介護時間外手当: 閾値未満なら0円",
  careOvertimePay(monthly({
    settings: salary({ care_overtime_threshold_hours: 10, care_overtime_unit_price: 1000 }),
    summary: summary({ visitMinutes: 599 }),
  })), 0);
eq("介護時間外手当: 閾値ちょうど10h(600分)は超過0円 (境界)",
  careOvertimePay(monthly({
    settings: salary({ care_overtime_threshold_hours: 10, care_overtime_unit_price: 1000 }),
    summary: summary({ visitMinutes: 600 }),
  })), 0);
eq("介護時間外手当: 閾値+1h(660分)は1h×1000円=1000円",
  careOvertimePay(monthly({
    settings: salary({ care_overtime_threshold_hours: 10, care_overtime_unit_price: 1000 }),
    summary: summary({ visitMinutes: 660 }),
  })), 1000);
eq("★ 介護超過 下の段: 146h (閾値120h×2,500 / 100h〜×800) = 65,000 + 16,000 (木更津 江澤 2026-07)",
  careOvertimePay(monthly({ settings: salary({ care_overtime_threshold_hours: 120, care_overtime_unit_price: 2500 }), care_minutes: 146 * 60, care_overtime_lower_tier: { from_hours: 100, unit_price: 800 } })), 81000);
eq("★ 介護超過 下の段: 110.25h は 10.25h × 800 = 8,200 (姉崎ムツミ 石田 2026-07)",
  careOvertimePay(monthly({ settings: salary({ care_overtime_threshold_hours: 120, care_overtime_unit_price: 2500 }), care_minutes: 6615, care_overtime_lower_tier: { from_hours: 100, unit_price: 800 } })), 8200);
eq("介護超過 下の段: ちょうど100h は 0 / 段の設定が無ければ 120h 超だけ",
  [careOvertimePay(monthly({ settings: salary({ care_overtime_threshold_hours: 120, care_overtime_unit_price: 2500 }), care_minutes: 6000, care_overtime_lower_tier: { from_hours: 100, unit_price: 800 } })), careOvertimePay(monthly({ settings: salary({ care_overtime_threshold_hours: 120, care_overtime_unit_price: 2500 }), care_minutes: 146 * 60 }))], [0, 65000]);

eq("夜朝手当: 単価か時間が0なら0円",
  yochoAllowance(monthly({ settings: salary({ yocho_unit_price: 0 }), yocho_hours: 5 })), 0);
eq("夜朝手当: 5時間×1000円=5000円",
  yochoAllowance(monthly({ settings: salary({ yocho_unit_price: 1000 }), yocho_hours: 5 })), 5000);

eq("出張費: travel_km が入っていればそちらを優先",
  effectiveTravelKm(monthly({ travel_km: 10, travel_km_auto: 999 })), 10);
eq("出張費: travel_km が0(未上書き)なら自動値を使う",
  effectiveTravelKm(monthly({ travel_km: 0, travel_km_auto: 15 })), 15);
eq("出張費金額 = 距離 × 単価",
  travelFeeAmount(monthly({ travel_km: 10, office_travel_unit_price: 100 })), 1000);
eq("★ 出張費は円未満切り上げ: 530.9km × 12.3 = 6,530.07 → 6,531 (小林 2026-07 総括表)",
  travelFeeAmount(monthly({ travel_km: 530.9, office_travel_unit_price: 12.3 })), 6531);
eq("出張費 切り上げ: 838.1km × 12.3 = 10,308.63 → 10,309 (宮野 2026-07 総括表)",
  travelFeeAmount(monthly({ travel_km: 838.1, office_travel_unit_price: 12.3 })), 10309);
eq("通勤費金額 = 距離 × 単価",
  commuteFeeAmount(monthly({ summary: summary({ commuteKmTotal: 20 }), office_commute_unit_price: 50 })), 1000);

const ot = (over: Partial<OvertimeSetting> = {}): OvertimeSetting => ({
  job_type: "訪問介護", scheduled_hours_per_month: 160,
  include_base_personal_salary: true, include_skill_salary: false,
  include_position_allowance: false, include_qualification_allowance: false,
  include_tenure_allowance: false, include_treatment_improvement: false,
  include_specific_treatment: false, include_treatment_subsidy: false,
  include_fixed_overtime_pay: false, include_special_bonus: false,
  ...over,
});
const otMap = (o: OvertimeSetting) => new Map([[o.job_type, o]]);

eq("時間外手当: 60h ちょうど(3600分)は境界。全部1.25倍",
  computeOvertimePay(
    monthly({ settings: salary({ base_personal_salary: 320000 }), summary: summary({ overtimeMinutes: MONTHLY_OT_THRESHOLD_MIN }) }),
    otMap(ot()),
  ),
  Math.round((3600 / 60) * (320000 / 160) * 1.25));
eq("時間外手当: 60h+1分は超過1分だけ1.5倍",
  computeOvertimePay(
    monthly({ settings: salary({ base_personal_salary: 320000 }), summary: summary({ overtimeMinutes: MONTHLY_OT_THRESHOLD_MIN + 1 }) }),
    otMap(ot()),
  ),
  Math.round((3600 / 60) * (320000 / 160) * 1.25 + (1 / 60) * (320000 / 160) * 1.5));
{
  const kt = ot({ scheduled_hours_per_month: 168, include_skill_salary: true, include_treatment_subsidy: true });
  const fukuda = monthly({ role_type: "事務員", settings: salary({ base_personal_salary: 100000, skill_salary: 110000, treatment_subsidy: 14000 }), summary: summary({ overtimeMinutes: 1590 }), legal_within_minutes: 390 });
  eq("★ 事務員の所定は159h: 単価 round(224,000/159)=1,409 → 残業単価 1,761 × 1590分 = 46,667 + 法内 390分×1,409 = 9,159 (高品 福田 2026-07 総括表)",
    computeOvertimePay(fukuda, otMap(kt)), 46667 + 9159);
  eq("事務員の所定時間定数 = 159", OFFICE_WORKER_SCHEDULED_HOURS, 159);
  eq("★ 法内残業は事務員だけ (社員に legal_within_minutes があっても足さない)",
    computeOvertimePay({ ...fukuda, role_type: "社員", summary: summary({ overtimeMinutes: 0 }) }, otMap(kt)), 0);
  eq("★ 残業単価は単価を丸めてから×1.25: 根本 2026-07 298,000/168=1,774 → 2,218 × 474分 = 17,522",
    computeOvertimePay(monthly({ role_type: "社員", settings: salary({ base_personal_salary: 298000 }), summary: summary({ overtimeMinutes: 474 }) }), otMap(ot({ scheduled_hours_per_month: 168 }))), 17522);
  const att = (day: number, work_hours: string) => ({ day, work_hours });
  eq("★ 法内残業: 半有給の日は所定4h (7h→180 / 7:30→210 / 3h→0)、通常日は8h超でも0 (福田 390分)",
    legalWithinOvertimeMinutes([att(1, "10:00"), att(22, "7:00"), att(24, "7:30"), att(27, "3:00"), att(28, "0:00")], [{ item_name: "半有給", item_date: "7/22,7/24,7/27" }]), 390);
  eq("法内残業: 半有給が「7月10日」形式でも日を読む", legalWithinOvertimeMinutes([att(10, "6:00")], [{ item_name: "半有給", item_date: "7月10日" }]), 120);
}
eq("時間外手当: 設定に無い job_type は0円",
  computeOvertimePay(monthly({ job_type: "訪問看護" }), otMap(ot())), 0);
eq("時間外手当: 残業0分は0円",
  computeOvertimePay(monthly({ summary: summary({ overtimeMinutes: 0 }) }), otMap(ot())), 0);

eq("固定残業超過額: 実残業代が固定残業代を超えない場合は0",
  overtimeExcessPay(
    monthly({ settings: salary({ base_personal_salary: 320000, fixed_overtime_pay: 999999 }), summary: summary({ overtimeMinutes: 60 }) }),
    otMap(ot()),
  ), 0);

// monthlyGrandTotal は各要素の合算であることを確認 (恒等式)
{
  const p = monthly({
    settings: salary({ base_personal_salary: 320000, care_overtime_threshold_hours: 10, care_overtime_unit_price: 1000 }),
    bonus_paid: true,
    travel_km: 10, office_travel_unit_price: 100,
    summary: summary({ commuteKmTotal: 20, visitMinutes: 660, overtimeMinutes: 100 }),
    office_commute_unit_price: 50,
    business_trip_fee: 500, childcare_allowance: 300, yocho_hours: 2, paid_leave_unit_price: 82,
  });
  eq("★ 月給者の有給休暇手当: 有給2日 × 82円 = 164 (高品 根本 2026-07)", monthlyPaidLeaveAllowance(monthly({ paid_leave_unit_price: 82, summary: summary({ paidLeave: 2 }) })), 164);
  eq("★ 月給者の有給休暇手当: 半有給1回 × 1,286円 = 643 (高品 櫻井 2026-03)", monthlyPaidLeaveAllowance(monthly({ paid_leave_unit_price: 1286, summary: summary({ halfLeave: 1 }) })), 643);
  eq("月給者の有給休暇手当: 単価未設定なら0", monthlyPaidLeaveAllowance(monthly({ summary: summary({ paidLeave: 3 }) })), 0);
  const expect =
    fixedTotal(p.settings!) +
    (p.bonus_paid ? p.settings!.bonus_amount : 0) +
    travelFeeAmount(p) + commuteFeeAmount(p) +
    p.business_trip_fee + p.childcare_allowance +
    careOvertimePay(p) + yochoAllowance(p) + monthlyPaidLeaveAllowance(p) +
    overtimeExcessPay(p, otMap(ot()));
  eq("monthlyGrandTotal = 各要素の合算 (恒等式)", monthlyGrandTotal(p, otMap(ot())), expect);
}
eq("monthlyGrandTotal: settings が null なら0円",
  monthlyGrandTotal(monthly({ settings: null }), otMap(ot())), 0);

// ─── 時給者 ──────────────────────────────────────────────────────────────

const hourly = (over: Partial<HourlyPayroll> = {}): HourlyPayroll => ({
  employee_number: "1", employee_name: "サンプル", role_type: "パート",
  has_care_qualification: true, job_type: "訪問介護", effective_service_months: 24,
  care_plan_count: 0, error_adjustment: 0, treatment_subsidy: 0,
  paid_leave_allowance: 0, cancel_count: 0, cancel_allowance: 0,
  travel_time_sec: 0, travel_allowance: 0, communication_fee: 0,
  meeting_fee: 0, childcare_allowance: 0, commute_fee: 0, commute_distance_m: 0,
  business_trip_fee: 0, training_pay: 0, office_work_minutes: 0, office_work_hourly_rate: 0, office_work_pay: 0,
  records: [], totalMinutes: 0, totalPay: 0, unmappedCount: 0,
  summary: summary(),
  ...over,
});

eq("時給者の勤続手当: visitMinutesExcludingAccompanied を使う (visitMinutes ではない)",
  hourlyTenure(hourly({
    effective_service_months: 12,
    summary: summary({ visitMinutes: 99999, visitMinutesExcludingAccompanied: 600 }),
  })),
  computeTenureAllowance(true, 12, "時給", "訪問介護", 600, 0, 0));

{
  const e = hourly({
    totalPay: 50000, treatment_subsidy: 1000, paid_leave_allowance: 2000,
    cancel_allowance: 500, travel_allowance: 300, communication_fee: 100,
    meeting_fee: 200, childcare_allowance: 400, commute_fee: 600,
    business_trip_fee: 700, error_adjustment: -50, office_work_pay: 800, training_pay: 900,
  });
  eq("hourlyTotalPay = 各要素の合算 (恒等式)", hourlyTotalPay(e),
    e.totalPay + weekendHolidayAllowanceAmount(weekendAllowanceMinutes(e), e.weekend_holiday_rate) + e.office_work_pay + hourlyTenure(e) + e.treatment_subsidy + e.paid_leave_allowance +
    e.cancel_allowance + e.travel_allowance + e.communication_fee + e.meeting_fee + e.training_pay +
    e.childcare_allowance + e.commute_fee + e.business_trip_fee + e.error_adjustment);
}

// ── 事務の本人給 (officeWorkPayAmount) (2026-09-17 追加) ──
// 期待値は総括表 (さつきが丘 2026-07 福島可奈) の実額: 出勤時間 126:30 (7,590分) × 事務時給 1,150円 = 本人給 145,475円
eq("事務本人給: 福島可奈 2026-07 実額 7,590分×1,150円 = 145,475円", officeWorkPayAmount(true, 7590, 1150), 145475);
// ── 社員の出勤時間 (employeeWorkMinutes) (2026-09-17 追加) ──
eq("出勤時間: 出勤簿があれば出勤簿の合計 (訪問・移動は見ない)", employeeWorkMinutes(22, 10970, 4065, 999999), 10970);
eq("出勤時間: 出勤簿が無ければ 訪問 + 移動全量 (米倉靖子 2026-07: 7,345 + 1,093分)", employeeWorkMinutes(0, 0, 7345, 1093 * 60), 8438);
eq("出勤時間: 移動秒は四捨五入で分に (89秒→1分 / 90秒→2分)", [employeeWorkMinutes(0, 0, 0, 89), employeeWorkMinutes(0, 0, 0, 90)], [1, 2]);
eq("出勤時間: 出勤簿も訪問も無ければ0", employeeWorkMinutes(0, 0, 0, 0), 0);
eq("事務本人給: 事務員でなければ時間・時給があっても0円", officeWorkPayAmount(false, 7590, 1150), 0);
eq("事務本人給: 事務時給0円なら0円", officeWorkPayAmount(true, 7590, 0), 0);
eq("事務本人給: 端数は四捨五入 (10分×1,000円 = 166.67 → 167)", officeWorkPayAmount(true, 10, 1000), 167);
eq("事務本人給: hourlyTotalPay に入る (本人給10,000 + 事務5,000)",
  hourlyTotalPay(hourly({ totalPay: 10000, office_work_pay: 5000, effective_service_months: 0 })), 15000);
eq("★ 時給者残業代: hourlyTotalPay に入る (本人給93,400 + 残業300)",
  hourlyTotalPay(hourly({ totalPay: 93400, overtime_pay: 300, effective_service_months: 0 })), 93700);

// ★ 土日祝手当は hourlyTotalPay に含まれる (2026-09-17 総括表で確認。50円/時)
{
  const base = hourly({ totalPay: 10000, effective_service_months: 0 });
  const withWeekend = hourly({ totalPay: 10000, effective_service_months: 0, summary: summary({ weekendHolidayMinutes: 600 }) });
  eq("★ 土日祝手当 600分 × 50円/時 = 500円 が hourlyTotalPay に入る", hourlyTotalPay(withWeekend) - hourlyTotalPay(base), 500);
  eq("土日祝手当 四捨五入: 1,095分 → 912.5 → 913 (森幸代 2026-04 総括表)", weekendHolidayAllowanceAmount(1095), 913);
  eq("★ 土日祝手当 事業所の時給 100円: 1,095分 → 1,825 (茂原・やわた等)", weekendHolidayAllowanceAmount(1095, 100), 1825);
  eq("土日祝手当: 1,885分 → 1,570.8 → 1,571 (滝下 2026-05 総括表)", weekendHolidayAllowanceAmount(1885), 1571);
}
{
  // 提責は固定残業代を超える残業代を払わない (宮野 2026-04: 残業23.9h×2,835=67,757 > 固定残業代50,000 でも 0)
  const s = salary({ base_personal_salary: 100000, skill_salary: 96000, fixed_overtime_pay: 50000 });
  const p = (role: string) => monthly({ role_type: role, settings: s, summary: summary({ overtimeMinutes: 1434 }) });
  eq("★ 提責・管理者は残業代の超過分 0 (社員なら超過が出る設定でも)", [overtimeExcessPay(p("提責"), otMap(ot({ scheduled_hours_per_month: 10 }))), overtimeExcessPay(p("管理者"), otMap(ot({ scheduled_hours_per_month: 10 })))], [0, 0]);
  eq("社員は超過分を払う (> 0)", overtimeExcessPay(p("社員"), otMap(ot({ scheduled_hours_per_month: 10 }))) > 0, true);
}

// ─── 移動手当 (訪問介護・時給者) ─────────────────────────────────────────

eq("移動手当: 単価0なら0円 (0除算にもならない)",
  travelAllowanceAmount(3600, 0), 0);
eq("移動手当: 1時間(3600秒)×単価500円/h = 500円",
  travelAllowanceAmount(3600, 500), 500);
eq("距離調整: 100%(既定)ならそのまま",
  adjustedCommuteDistanceM(10000, 100), 10000);
eq("距離調整: 50%なら半分",
  adjustedCommuteDistanceM(10000, 50), 5000);
eq("出張費: 距離1000m(調整後)×単価100円/km = 100円",
  businessTripFeeAmount(1000, 100), 100);

// ── 保育手当 (computeChildcareAllowance) / 会議費 (computeMeetingFee) (2026-09-05 追加) ──
// page.tsx に埋め込まれていて呼べなかったロジック (2026-09-05 に payroll-calc.ts へ切り出し)。
const cRec = (o: Partial<OfficeFormRecord>): OfficeFormRecord =>
  ({ employee_number: "1", record_type: "childcare", item_name: "保育園", item_date: null,
    numeric_value: null, start_time: null, end_time: null, year_month: null, child_name: "子1",
    amount: 10000, ...o });

eq("保育手当: recsが空なら0", computeChildcareAllowance([], "月給", new Map(), "1", "202606"), 0);
eq("保育手当: 幼稚園(20%) 月給 amount=10000 → round(2000)",
  computeChildcareAllowance([cRec({ item_name: "○○幼稚園" })], "月給", new Map(), "1", "202606"), 2000);
eq("保育手当: 保育園等(40%・幼稚園以外) 月給 amount=10000 → round(4000)",
  computeChildcareAllowance([cRec({ item_name: "○○保育園" })], "月給", new Map(), "1", "202606"), 4000);
eq("★ 保育手当: amount<=0 は加算されない (スキップ)",
  computeChildcareAllowance([cRec({ amount: 0 })], "月給", new Map(), "1", "202606"), 0);
eq("★ 保育手当: 子1名の上限は20,000円 (40%換算で50,000円分入れても頭打ち)",
  computeChildcareAllowance([cRec({ amount: 50000, item_name: "保育園" })], "月給", new Map(), "1", "202606"), 20000);
eq("★ 保育手当: 子2名以上の上限は30,000円",
  computeChildcareAllowance(
    [cRec({ amount: 50000, item_name: "保育園", child_name: "子1" }), cRec({ amount: 50000, item_name: "保育園", child_name: "子2" })],
    "月給", new Map(), "1", "202606"), 30000);
// 時給者: visitMinutesByEmpMonth の按分。120h(7200分)で満額、60h(3600分)で半額
eq("★ 保育手当(時給): visitMin=7200分(120h)以上 → ratio=1.0 (満額)",
  computeChildcareAllowance([cRec({ item_name: "保育園" })], "時給", new Map([["1:202606", 7200]]), "1", "202606"), 4000);
eq("★ 保育手当(時給): visitMin=3600分(60h) → ratio=0.5 → round(4000*0.5)=2000",
  computeChildcareAllowance([cRec({ item_name: "保育園" })], "時給", new Map([["1:202606", 3600]]), "1", "202606"), 2000);
eq("★ 保育手当(時給): visitMin=14400分(240h) でも ratio は 1.0 で頭打ち (2倍にならない)",
  computeChildcareAllowance([cRec({ item_name: "保育園" })], "時給", new Map([["1:202606", 14400]]), "1", "202606"), 4000);
eq("★ 保育手当(時給): visitMinutesByEmpMonthに無い月は0扱い (ratio=0)",
  computeChildcareAllowance([cRec({ item_name: "保育園" })], "時給", new Map(), "1", "202606"), 0);
// year_month の正規化 (normalizeYM 経由のlookup)
eq("★ 保育手当(時給): year_month='2026/6' が normalizeYM で '202606' に正規化されてlookupされる",
  computeChildcareAllowance([cRec({ item_name: "保育園", year_month: "2026/6" })], "時給", new Map([["1:202606", 7200]]), "1", "209912"), 4000);
eq("★ 保育手当(時給): year_month が無ければ selectedMonth にフォールバック",
  computeChildcareAllowance([cRec({ item_name: "保育園", year_month: null })], "時給", new Map([["1:202607", 7200]]), "1", "202607"), 4000);
eq("normalizeYM 単体: '2026/6' → '202606'", normalizeYM("2026/6"), "202606");
eq("normalizeYM 単体: 'Dec-25' → '202512'", normalizeYM("Dec-25"), "202512");

const mRec = (item_name: string, record_type = "count", numeric_value: number | null = null): OfficeFormRecord =>
  ({ employee_number: "1", record_type, item_name, item_date: null, numeric_value,
    start_time: null, end_time: null, year_month: null, child_name: null, amount: null });
eq("会議費: 会議1以外の記録は数えない", computeMeetingFee([mRec("会議2")], 1000), 0);
eq("会議費: 会議1 かつ record_type!=km は1件=1回", computeMeetingFee([mRec("会議1")], 1000), 1000);
eq("★ 会議費: record_type=km は numeric_value を回数として丸めて使う",
  computeMeetingFee([mRec("会議1", "km", 2.6)], 1000), 3000);
eq("会議費: 複数レコード合算 (1回+1回)×単価1000円",
  computeMeetingFee([mRec("会議1"), mRec("会議1")], 1000), 2000);

// ── 時給者の各種手当 (2026-09-05 追加) ───────────────────────────────────
eq("処遇改善支援費: 訪問介護+社保加入+当月実績あり → 事業所単価",
  treatmentSubsidyAmount(true, true, 60, 5000, 3000), 5000);
eq("★ 処遇改善支援費: 当月実績なし(0分) → 給与設定の額 (事業所単価は使わない)",
  treatmentSubsidyAmount(true, true, 0, 5000, 3000), 3000);
eq("処遇改善支援費: 訪問介護でない → 給与設定の額", treatmentSubsidyAmount(false, true, 60, 5000, 3000), 3000);
eq("処遇改善支援費: 社保未加入 → 給与設定の額", treatmentSubsidyAmount(true, false, 60, 5000, 3000), 3000);

eq("キャンセル手当: 3件×500円", cancelAllowanceAmount(3, 500), 1500);
eq("キャンセル手当: 0件は0円", cancelAllowanceAmount(0, 500), 0);
eq("★ ドタキャン: 010999 は600円、他のキャンセルコードは事業所単価 (ちはら台 鈴木恵子 010999+013052 = 1,400)", cancelAllowanceFromCodes(["010999", "013052"], 800), 1400);
eq("ドタキャン: 010386 ×2 = 1,600 / 無し = 0", [cancelAllowanceFromCodes(["010386", "010386"], 800), cancelAllowanceFromCodes([], 800)], [1600, 0]);
eq("有給手当: 2.5日×1000円 (半休を含む端数)", paidLeaveAllowanceAmount(2.5, 1000), 2500);

eq("通信手当: 社保加入なら0円固定 (時間に関わらず)", communicationFeeAmount(true, 999999), 0);
eq("通信手当: 未加入・0分は0円", communicationFeeAmount(false, 0), 0);
eq("★ 通信手当: 未加入・ちょうど50h(3000分) は境界含まず500円", communicationFeeAmount(false, 3000), 500);
eq("★ 通信手当: 未加入・50h+1分(3001分) は1000円", communicationFeeAmount(false, 3001), 1000);
eq("通信手当: 未加入・1分でも勤務あれば500円", communicationFeeAmount(false, 1), 500);
eq("★ 通信手当: 貸与負担 (lend_fee) は社保・時間に関わらず -1,700円 (高品 菊池/中村/西田)", [communicationFeeAmount(true, 2850, "lend_fee"), communicationFeeAmount(false, 0, "lend_fee")], [-1700, -1700]);
eq("★ 通信手当: スマホ貸与あり (lend) は 0円 (高品 松元)", communicationFeeAmount(false, 1050, "lend"), 0);
eq("★ 通信手当: variable は社保加入でも時間で 1,000円 (高品 伊藤 5160分)", communicationFeeAmount(true, 5160, "variable"), 1000);

eq("通勤費(時給): 10km×100円/km", hourlyCommuteFeeAmount(10, 100), 1000);
eq("出張費(時給): 5km×200円/km", hourlyBusinessTripFeeAmount(5, 200), 1000);
eq("★ 出張費(時給) 円未満切り上げ: 64km × 12.3 = 787.2 → 788 (石毛 2026-06 総括表)", hourlyBusinessTripFeeAmount(64, 12.3), 788);
eq("出張費(時給) ちょうど整数は上がらない: 113.8km × 12.3 = 1399.74→1400 / 100km×12 = 1200", [hourlyBusinessTripFeeAmount(113.8, 12.3), hourlyBusinessTripFeeAmount(100, 12)], [1400, 1200]);

eq("実績1件の支給額: 60分×時給2000円 = 2000円", hourlyRecordPay(60, 2000), 2000);

// ── 訪問1件の支給額 (visitPayAmount) 2026-09-17。期待値は給与管理システム (総括表の元) の画面の実額 ──
eq("同行援護 3:00 = 1.5h×2,100 + 1.5h×1,800 = 5,850 (石毛 8/19)", visitPayAmount(180, 2100, "同行援護", "通常", 1800), 5850);
eq("同行援護 2:00 = 4,050 (滝下 8/2)", visitPayAmount(120, 2100, "同行援護", "通常", 1800), 4050);
eq("同行援護 8:30 = 15,750 (滝下 7/26)", visitPayAmount(510, 2100, "同行援護", "通常", 1800), 15750);
eq("移身有7 (身体介護に仕分け) 7:00 = 13,050 (滝下 7/27)", visitPayAmount(420, 2100, "身体介護", "通常", 1800), 13050);
eq("★ ちょうど1.5h は段階なし: 身3 1:30 = 3,150", visitPayAmount(90, 2100, "身体介護", "通常", 1800), 3150);
eq("身体生活は段階なし: 身2生2 1:45 × 1,900 = 3,325", visitPayAmount(105, 1900, "身体生活", "通常", 1800), 3325);
eq("★ 円未満は切り捨て: 身1生1 0:40 × 1,900 = 1,266", visitPayAmount(40, 1900, "身体生活", "通常", 1800), 1266);
eq("★ 同行 1:20 × 1,150 = 1,533 (切り捨て)", visitPayAmount(80, 1150, "同行", "通常", 1800), 1533);
eq("早朝夜間 25%増し: 身3夜 1:30 = 3,150 + round(787.5) = 3,938 (田村 2026-07 9件で総括表 35,442 と一致)", visitPayAmount(90, 2100, "身体介護", "早朝夜間", 1800), 3938);
eq("時間帯の表記ゆれ: 夜朝/夜間/早朝/早朝・夜間 はすべて 1.25、日中/通常 は 1", ["夜朝","夜間","早朝","早朝・夜間","日中","通常",""].map(timePeriodMultiplier), [1.25,1.25,1.25,1.25,1,1,1]);
eq("単価が引けなければ null", visitPayAmount(60, null, "身体介護", "通常", 1800), null);
eq("有給日数: 有給1 + 半有給1 = 1.5日", paidLeaveDays(1, 1), 1.5);
eq("★ 半有給1回 × 8,635円 = 4,318円 (森幸代 2026-06 総括表)", paidLeaveAllowanceAmount(paidLeaveDays(0, 1), 8635), 4318);
{
  const tr = (item_name: string, s: string, e: string, b = "0:00"): OfficeFormRecord => ({ employee_number: "1", record_type: "training", item_name, item_date: "7/15", numeric_value: null, start_time: s, end_time: e, break_time: b, year_month: null, child_name: null, amount: null });
  const recs = [tr("HRD研修", "14:00", "16:00"), tr("研修", "9:30", "10:30"), tr("初任者研修", "9:30", "16:40", "0:50")];
  eq("研修時間: 研修+HRD研修 (休憩を引く)、初任者研修は含めない = 180分 (岩田 2026-07)", trainingMinutes(recs), 180);
  eq("研修手当: 180分 × 1,150円 = 3,450円 (岩田 2026-07 総括表 HRD2,300+会議費1,150)", trainingPayAmount(180, 1150), 3450);
  eq("研修手当: 休憩を引く 9:30-16:40 休憩0:50 = 380分", trainingMinutes([tr("研修", "9:30", "16:40", "0:50")]), 380);
  eq("研修手当: 同行の時給が無ければ0円", trainingPayAmount(120, null), 0);
  {
    const r = (service_date: string, calc_duration: string) => ({ service_date, calc_duration });
    eq("★ 時給者残業: 1日 8:30 → 30分 (石毛 2026-05)", hourlyOvertimeMinutes([r("2026/05/08", "008:30"), r("2026/05/11", "001:45")]), 30);
    eq("時給者残業: ちょうど8時間は0", hourlyOvertimeMinutes([r("2026/05/08", "005:00"), r("2026/05/08", "003:00")]), 0);
    eq("時給者残業: 同日の複数訪問を合算 5h+3h+1分 → 1分", hourlyOvertimeMinutes([r("2026/05/08", "005:00"), r("2026/05/08", "003:01")]), 1);
    const wk = ["2026/07/05","2026/07/06","2026/07/07","2026/07/08","2026/07/09"].map((d) => r(d, "008:00"));
    eq("時給者残業: 日曜始まりの週 8h×5日=40h ちょうどは0", hourlyOvertimeMinutes(wk), 0);
    eq("★ 時給者残業: 同じ週に6日目 2h → 週40h超 120分", hourlyOvertimeMinutes([...wk, r("2026-07-10", "002:00")]), 120);
    eq("時給者残業: 翌週 (日曜) に回れば0", hourlyOvertimeMinutes([...wk, r("2026/07/12", "002:00")]), 0);
    eq("時給者残業: 日8h超分は週の40hに数えない 9h×5日 → 日300分のみ", hourlyOvertimeMinutes(wk.map((x) => ({ ...x, calc_duration: "009:00" }))), 300);
    eq("★ 時給者残業代: 30分 × 10円 = 300円", hourlyOvertimePayAmount(30), 300);
  }
  eq("初任者研修の時間: 初任者研修だけ (休憩を引く) = 380分", shoninshaTrainingMinutes(recs), 380);
  eq("★ 初任者研修費: 2670分 × 1,150円 = 51,175円 (福井 2026-05 総括表)", trainingPayAmount(2670, 1150), 51175);
}
eq("夜朝の時間: 早朝夜間だけ合計 (大治 2026-06: 30分×5 + 90分×4 = 510分 = 8.5h)",
  yochoHoursFromRecords([...Array(5)].map(() => ({ calc_duration: "000:30", time_period: "早朝夜間" })).concat([...Array(4)].map(() => ({ calc_duration: "001:30", time_period: "早朝夜間" })), [{ calc_duration: "002:00", time_period: "通常" }])), 8.5);
eq("夜朝の時間: 表記ゆれ 夜朝/夜間/早朝/早朝・夜間 を含め、深夜・日中は含めない",
  yochoHoursFromRecords(["夜朝","夜間","早朝","早朝・夜間","深夜","日中"].map((t) => ({ calc_duration: "001:00", time_period: t }))), 4);
{
  // 米倉靖子 2026-07: 訪問 7,345分 のうち 移身有0.5/移身有1 が 180分 → 介護時間 7,300分 (1件24h以上は0分扱いなので 1,433分×5件で組む)
  const recs = [...Array(5)].map(() => ({ calc_duration: "023:53", service_code: "111111" })).concat([{ calc_duration: "002:00", service_code: "010047" }, { calc_duration: "001:00", service_code: "010048" }]);
  eq("介護時間: 0.75掛け対象(移身有)は ×0.75 (7,165 + 180×0.75 = 7,300分)", careMinutesFromRecords(recs, isCareHours075), 7300);
  eq("0.75掛け対象コードの判定: 010047 移身有0.5 / 021003 重度介護(自立) は対象、111111 身体介護1 は対象外", ["010047","021003","111111"].map(isCareHours075), [true, true, false]);
  // 2026-09-18: 021006/021007/021008 は総括表の「重度」時間に入る (Hana 9 事業所 2026-07 社員 43 人で確認)。旧期待値 (対象外) はコード一覧由来で実データ未確認だった
  eq("★ 通院介助(自立) 021006 / 通院･身体(自立) 021007 / 同行援護(自立) 021008 は対象、家事援助(自立) 021002 は対象外", ["021006","021007","021008","021002"].map(isCareHours075), [true, true, true, false]);
  const setting = salary({ care_overtime_threshold_hours: 120, care_overtime_unit_price: 2500 });
  eq("介護超過: 米倉 2026-07 (7,300−7,200)/60 × 2,500 = 4,167 (総括表)", careOvertimePay(monthly({ role_type: "社員", settings: setting, care_minutes: 7300, summary: summary({ visitMinutes: 7345 }) })), 4167);
  eq("介護超過: 米倉 2026-06 (8,020−7,200)/60 × 2,500 = 34,167 (総括表)", careOvertimePay(monthly({ role_type: "社員", settings: setting, care_minutes: 8020 })), 34167);
  eq("介護超過: 大治 2026-06 (7,610−7,200)/60 × 2,500 = 17,083 (総括表)", careOvertimePay(monthly({ role_type: "社員", settings: setting, care_minutes: 7610 })), 17083);
}
eq("夜朝手当: 8.5h × 200円 = 1,700 (大治 2026-06 総括表)", yochoAllowance(monthly({ settings: salary({ yocho_unit_price: 200 }), yocho_hours: 8.5 })), 1700);
eq("生活援助の単価が無い事業所は段階なし (2h×2,100)", visitPayAmount(120, 2100, "身体介護", "通常", null), 4200);
eq("実績1件の支給額: 30分×時給2000円 = 1000円 (端数切り上げ丸め)", hourlyRecordPay(30, 2000), 1000);
eq("★ 実績1件の支給額: 単価が引けない(null)場合は null (未マッピング扱い)", hourlyRecordPay(60, null), null);

// ── 勤怠サマリー (computeSummary) (2026-09-05 追加) ───────────────────────
// 2026-08-31に「週残業まるごと未払い」の実バグが出た箇所 (小原奈保子2026-02-07 ¥13,333)。
const vRec = (o: Partial<VisitServiceRecord>): VisitServiceRecord =>
  ({ id: "1", employee_number: "1", employee_name: "テスト", service_date: "20260601",
    calc_duration: "1:00", service_code: "111111", office_number: "1",
    accompanied_visit: "", client_number: "1", dispatch_start_time: "09:00", dispatch_end_time: "10:00", ...o });
const aRec = (o: Partial<OfficeAttendanceRecord>): OfficeAttendanceRecord =>
  ({ employee_number: "1", day: 1, work_note_1: "", work_note_2: "", work_note_3: "",
    work_note_4: "", work_note_5: "", start_time_1: "09:00", work_hours: "8:00",
    overtime_daily: "", overtime_weekly: "", ...o });
const oRec = (o: Partial<OfficeFormRecord>): OfficeFormRecord =>
  ({ employee_number: "1", record_type: "date", item_name: "", item_date: null,
    numeric_value: null, start_time: null, end_time: null, year_month: null,
    child_name: null, amount: null, ...o });

const empty = computeSummary([], [], []);
eq("空のrecsは全部0", empty, {
  workDays: 0, helperDays: 0, paidLeave: 0, halfLeave: 0, specialLeave: 0, workHoursMin: 0,
  overtimeMinutes: 0, recordCount: 0, accompaniedCount: 0, visitMinutes: 0,
  visitMinutesExcludingAccompanied: 0, hrdCount: 0, hrdMinutes: 0, meetingCount: 0,
  commuteKmTotal: 0, businessKmTotal: 0, weekendHolidayMinutes: 0, weekendHolidayAccompaniedMinutes: 0, sundayHolidayMinutes: 0,
});
eq("helperDays: 同じ日付の複数訪問は1日として数える",
  computeSummary([vRec({ service_date: "20260601" }), vRec({ id: "2", service_date: "20260601" }), vRec({ id: "3", service_date: "20260602" })], [], []).helperDays, 2);

eq("★ workDays: 半有給(半日)がある日は0.5換算 (通常1日+半日1日=1.5)",
  computeSummary(
    [vRec({ service_date: "20260601" }), vRec({ id: "2", service_date: "20260602" })],
    [], [oRec({ item_name: "半有給", item_date: "20260602" })],
  ).workDays, 1.5);
eq("★ workDays: helper日と出勤簿日の和集合 (重複しない日は加算)",
  computeSummary([vRec({ service_date: "20260601" })], [aRec({ day: 2, start_time_1: "09:00" })], []).workDays, 2);
eq("workDays: 出勤簿のstart_time_1が空の日はカウントしない",
  computeSummary([], [aRec({ day: 1, start_time_1: "" })], []).workDays, 0);

eq("有給(date型): 1件=1日", computeSummary([], [], [oRec({ item_name: "有給" })]).paidLeave, 1);
eq("★ 有給(km型): numeric_valueを丸めて日数扱い (2.4→2)",
  computeSummary([], [], [oRec({ item_name: "有給", record_type: "km", numeric_value: 2.4 })]).paidLeave, 2);
eq("★ 「半有給」は有給(paidLeave)には含めない (半排除フィルタ)",
  computeSummary([], [], [oRec({ item_name: "半有給" })]).paidLeave, 0);
eq("「半有給」はhalfLeaveとして数える", computeSummary([], [], [oRec({ item_name: "半有給" })]).halfLeave, 1);
eq("特休(date型): 1件", computeSummary([], [], [oRec({ item_name: "特休" })]).specialLeave, 1);
eq("★ 有給: 1行に日付が複数 \"7/3,7/6,7/11,7/16,7/25,7/27\" → 6日 (高品 菊池 2026-07)",
  computeSummary([], [], [oRec({ item_name: "有給", item_date: "7/3,7/6,7/11,7/16,7/25,7/27" })]).paidLeave, 6);
eq("★ 半有給: \"7/22,7/24,7/27\" → 3回 (高品 福田 2026-07 = 1.5日)",
  computeSummary([], [], [oRec({ item_name: "半有給", item_date: "7/22,7/24,7/27" })]).halfLeave, 3);
eq("有給: \"7月22日\" は1日 / 読点区切り \"7/1、7/2\" は2日",
  [listedDateCount("7月22日"), listedDateCount("7/1、7/2"), listedDateCount(null)], [1, 2, 1]);
eq("★ 通勤km: 出勤簿に無ければ事業所書式の通勤km (高品 福田 69km)",
  computeSummary([], [], [oRec({ item_name: "通勤km", record_type: "km", numeric_value: 69 })]).commuteKmTotal, 69);
{
  const att = [aRec({ commute_km: 14.4 } as never)], of = [oRec({ item_name: "通勤km", record_type: "km", numeric_value: 61.2 })];
  eq("★ 通勤km (事務員): 両方あれば 書式", computeSummary([], att, of, "office_form_first").commuteKmTotal, 61.2);
  eq("★ 通勤km (提責など・既定): 両方あれば 出勤簿", computeSummary([], att, of).commuteKmTotal, 14.4);
  eq("通勤km (事務員): 書式が 0 なら 出勤簿", computeSummary([], [aRec({ commute_km: 176 } as never)], [oRec({ item_name: "通勤km", record_type: "km", numeric_value: 0 })], "office_form_first").commuteKmTotal, 176);
  eq("通勤km (提責): 出勤簿が 0 なら 書式 (高品 福田 出勤簿0 → 書式69)", computeSummary([], [aRec({ commute_km: 0 } as never)], [oRec({ item_name: "通勤km", record_type: "km", numeric_value: 69 })]).commuteKmTotal, 69);
  eq("★★ 事務員と提責で結果が変わる (= 切替が効いている)", computeSummary([], att, of, "office_form_first").commuteKmTotal !== computeSummary([], att, of).commuteKmTotal, true);
}
// 同じ人の通勤km/出張km が書式に 2 行 → 先頭だけ (五井 加瀬 540/567 → 540)
eq("★ 書式の通勤km が 2 行なら 先頭の行だけ残す (五井 加瀬 540/567 → 540)",
  keepFirstKmRows([oRec({ item_name: "通勤km", record_type: "km", numeric_value: 540 }), oRec({ item_name: "通勤km", record_type: "km", numeric_value: 567 })]).map((r) => r.numeric_value), [540]);
eq("出張km も同じ / 別の人・別の項目・有給の日付行は残す",
  keepFirstKmRows([
    oRec({ item_name: "出張km", record_type: "km", numeric_value: 36 }), oRec({ item_name: "出張km", record_type: "km", numeric_value: 17.1 }),
    oRec({ employee_number: "999", item_name: "出張km", record_type: "km", numeric_value: 5 }),
    oRec({ item_name: "通勤km", record_type: "km", numeric_value: 567 }),
    oRec({ item_name: "有給", item_date: "7/16" }), oRec({ item_name: "有給", item_date: "7/20" }),
  ]).length, 5);
eq("★ 空の行が先頭にあっても 値のある先頭の行を使う (五井に空の出張km行が多数)",
  keepFirstKmRows([oRec({ item_name: "出張km", record_type: "km", numeric_value: null }), oRec({ item_name: "出張km", record_type: "km", numeric_value: 630.1 }), oRec({ item_name: "出張km", record_type: "km", numeric_value: 17.1 })]).map((r) => r.numeric_value), [null, 630.1]);
eq("★★ 直す前 (両方足す) なら 1,107km = この検査は差を検出できる",
  computeSummary([], [], keepFirstKmRows([oRec({ item_name: "通勤km", record_type: "km", numeric_value: 540 }), oRec({ item_name: "通勤km", record_type: "km", numeric_value: 567 })])).commuteKmTotal !== 1107, true);

eq("★ HRD時間: start/end timeがあれば差分(9:00-11:30=150分)",
  computeSummary([], [], [oRec({ item_name: "HRD研修", start_time: "09:00", end_time: "11:30" })]).hrdMinutes, 150);
eq("★ HRD時間: start/endが無ければ numeric_value×60分 (2.5h→150分)",
  computeSummary([], [], [oRec({ item_name: "HRD研修", record_type: "km", numeric_value: 2.5 })]).hrdMinutes, 150);
eq("hrdCount: km型は丸めた値を件数として数える (round(2.5)=3)",
  computeSummary([], [], [oRec({ item_name: "HRD研修", record_type: "km", numeric_value: 2.5 })]).hrdCount, 3);
eq("meetingCount: date型1件+km型1件(round(1)=1) = 2",
  computeSummary([], [], [oRec({ item_name: "会議1" }), oRec({ item_name: "会議1", record_type: "km", numeric_value: 1 })]).meetingCount, 2);

eq("残業: 日残業のみ(1h、週残業0) → 60分",
  computeSummary([], [aRec({ overtime_daily: "1:00", overtime_weekly: "", work_hours: "9:00" })], []).overtimeMinutes, 60);
eq("★★ 残業: 週残業のみ(8h、日残業0) → 480分 (2026-08-31に丸ごと未払いだった型そのもの)",
  computeSummary([], [aRec({ overtime_daily: "", overtime_weekly: "8:00", work_hours: "8:00" })], []).overtimeMinutes, 480);
eq("残業: 日残業(1h)+週残業(8h) → 540分 (単純加算)",
  computeSummary([], [aRec({ overtime_daily: "1:00", overtime_weekly: "8:00", work_hours: "9:00" })], []).overtimeMinutes, 540);
eq("残業: 日・週とも無ければ work_hours-8h (9h-8h=1h=60分)",
  computeSummary([], [aRec({ work_hours: "9:00" })], []).overtimeMinutes, 60);
eq("残業: フォールバックはmax(0,...)で負にならない (7h-8h→0)",
  computeSummary([], [aRec({ work_hours: "7:00" })], []).overtimeMinutes, 0);

eq("visitMinutes: 同伴あり/なし両方を合算", computeSummary(
  [vRec({ calc_duration: "1:00", accompanied_visit: "" }), vRec({ id: "2", calc_duration: "0:30", accompanied_visit: "同伴A" })], [], [],
).visitMinutes, 90);
eq("visitMinutesExcludingAccompanied: 同伴ありは除外", computeSummary(
  [vRec({ calc_duration: "1:00", accompanied_visit: "" }), vRec({ id: "2", calc_duration: "0:30", accompanied_visit: "同伴A" })], [], [],
).visitMinutesExcludingAccompanied, 60);
eq("accompaniedCount: 同伴ありの件数", computeSummary(
  [vRec({ accompanied_visit: "" }), vRec({ id: "2", accompanied_visit: "同伴A" })], [], [],
).accompaniedCount, 1);
eq("★ sundayHolidayMinutes: 休日区分 日祭・休日 だけ (土曜の 平日区分 は数えない、同行除く)",
  computeSummary([vRec({ service_date: "20260606", calc_duration: "2:00", holiday_type: "平日" }), vRec({ id: "2", service_date: "20260607", calc_duration: "1:00", holiday_type: "日祭" }), vRec({ id: "3", service_date: "20260720", calc_duration: "0:45", holiday_type: "休日" }), vRec({ id: "4", service_date: "20260607", calc_duration: "1:00", holiday_type: "日祭", accompanied_visit: "同行" })], [], []).sundayHolidayMinutes, 105);
eq("★ 土日祝手当の対象時間: sunday_only なら日祭・休日、そうでなければ土日祝",
  [weekendAllowanceMinutes({ summary: summary({ weekendHolidayMinutes: 600, sundayHolidayMinutes: 120 }), weekend_holiday_sunday_only: true }), weekendAllowanceMinutes({ summary: summary({ weekendHolidayMinutes: 600, sundayHolidayMinutes: 120 }) })], [120, 600]);
eq("★ weekendHolidayMinutes: 休日(土日祝)かつ同伴なしのみ集計 (2026-06-06は土曜)",
  computeSummary([vRec({ service_date: "20260606", calc_duration: "1:00", accompanied_visit: "" })], [], []).weekendHolidayMinutes, 60);
eq("weekendHolidayMinutes: 平日は集計しない (2026-06-01は月曜)",
  computeSummary([vRec({ service_date: "20260601", calc_duration: "1:00" })], [], []).weekendHolidayMinutes, 0);
eq("★ weekendHolidayAccompaniedMinutes: 休日かつ同伴ありは別枠で集計",
  computeSummary([vRec({ service_date: "20260606", calc_duration: "1:00", accompanied_visit: "同伴A" })], [], []).weekendHolidayAccompaniedMinutes, 60);
eq("commuteKmTotal: 出勤簿のcommute_km(unsafe cast経由)を合算",
  computeSummary([], [{ ...aRec({}), commute_km: 5 } as OfficeAttendanceRecord], []).commuteKmTotal, 5);
eq("businessKmTotal: 出勤簿のbusiness_km(unsafe cast経由)を合算",
  computeSummary([], [{ ...aRec({}), business_km: 3 } as OfficeAttendanceRecord], []).businessKmTotal, 3);

console.log("\n══ 負のコントロール: 週残業を落とす実装を再現 (2026-08-31の実バグそのもの) ══");
{
  // ★ 2026-08-31以前の壊れた実装をそのまま再現: overtime_weeklyを一切見ない
  function computeOvertimeMinutesBuggy(attDays: OfficeAttendanceRecord[]): number {
    return attDays.reduce((s, r) => {
      const od = parseWorkHoursMinutes(r.overtime_daily ?? "");
      if (od > 0) return s + od; // ★ overtime_weekly を見ていない (旧バグ)
      return s + Math.max(0, parseWorkHoursMinutes(r.work_hours) - 480);
    }, 0);
  }
  const buggyDays = [aRec({ overtime_daily: "", overtime_weekly: "8:00", work_hours: "8:00" })];
  const buggyResult = computeOvertimeMinutesBuggy(buggyDays);
  const realResult = computeSummary([], buggyDays, []).overtimeMinutes;
  eq("★★ 壊れた実装(週残業無視)と正しい実装は異なる値を返す (=このテストは差を検出できる)",
    buggyResult !== realResult, true);
  console.log(`  (参考: 壊れた実装=${buggyResult}分 / 正しい実装=${realResult}分)`);
}

// isWeekendOrHoliday / extractDay 単体の境界値 (computeSummary内部で使われる)
eq("isWeekendOrHoliday: 土曜(2026-06-06)はtrue", isWeekendOrHoliday("20260606"), true);
eq("isWeekendOrHoliday: 平日(2026-06-01・月曜)はfalse", isWeekendOrHoliday("20260601"), false);
eq("★ isWeekendOrHoliday: 祝日(2026-06-... 該当なしのため2026-07-20海の日)はtrue", isWeekendOrHoliday("20260720"), true);
eq("extractDay: YYYYMMDDから日を抽出", extractDay("20260615"), 15);
eq("extractDay: 8桁未満は0", extractDay("2026"), 0);

// ── meetingMinutes (会議の時間。会議費 = 件数×単価 + 時間×同行時給 の後ろ半分) ──
{
  const ofr = (o: Partial<OfficeFormRecord>): OfficeFormRecord => ({
    employee_number: "1", record_type: "training", item_name: "会議", item_date: null,
    start_time: null, end_time: null, break_time: null, numeric_value: null,
    year_month: null, child_name: null, amount: null, ...o,
  } as OfficeFormRecord);
  eq("会議 60分", meetingMinutes([ofr({ start_time: "13:30", end_time: "14:30" })]), 60);
  eq("休憩を引く", meetingMinutes([ofr({ start_time: "13:00", end_time: "15:00", break_time: "0:30" })]), 90);
  eq("複数の会議を足す", meetingMinutes([ofr({ start_time: "9:00", end_time: "10:00" }), ofr({ start_time: "13:00", end_time: "13:30" })]), 90);
  eq("★ 件数型 (会議1件数) は時間に数えない", meetingMinutes([ofr({ record_type: "km", item_name: "会議1件数", numeric_value: 1 })]), 0);
  eq("★ 会議2件数・会議3件数 も数えない", meetingMinutes([ofr({ record_type: "km", item_name: "会議2件数", numeric_value: 1 })]), 0);
  eq("研修は数えない (研修手当で別に払う)", meetingMinutes([ofr({ item_name: "研修", start_time: "9:00", end_time: "10:00" })]), 0);
  eq("開始・終了が無ければ 0", meetingMinutes([ofr({})]), 0);
  eq("終了 <= 開始 は 0", meetingMinutes([ofr({ start_time: "10:00", end_time: "9:00" })]), 0);
  // ★ 負のコントロール: 直す前 (会議を一切数えない) と違う値になる
  eq("★★ 直す前は 0 / 直した後は 60 (=この検査は差を検出できる)",
    meetingMinutes([ofr({ start_time: "13:30", end_time: "14:30" })]) !== 0, true);
  // 実例: 四街道 2026-07 は 60分 × 同行時給 1,150円 = 1,150円
  eq("四街道 2026-07 の実例 60分 × 1,150円/時 = 1,150円",
    trainingPayAmount(meetingMinutes([ofr({ start_time: "18:00", end_time: "19:00" })]), 1150), 1150);
}

// ── resolveEmploymentType (給与形態・役職の月次履歴。2026-09-18) ──
{
  const emp = { salary_type: "時給", role_type: "パート" };
  eq("履歴の行が無ければ職員マスタの値", resolveEmploymentType(emp, null), { salary_type: "時給", role_type: "パート" });
  eq("行に値が無い (NULL) なら職員マスタの値", resolveEmploymentType(emp, { salary_type: null, role_type: null }), { salary_type: "時給", role_type: "パート" });
  eq("行に値があればそれ", resolveEmploymentType(emp, { salary_type: "月給", role_type: "提責" }), { salary_type: "月給", role_type: "提責" });
  eq("給与形態だけ入っていれば役職はマスタ", resolveEmploymentType(emp, { salary_type: "月給" }), { salary_type: "月給", role_type: "パート" });
  // 月ごとに active な行が変わる (仁見初江: 1970〜 月給 / 2026-04〜 時給。職員マスタは今の 時給)
  const rows = [
    { employee_id: "e1", effective_from: "1970-01-01", salary_type: "月給", role_type: "社員" },
    { employee_id: "e1", effective_from: "2026-04-01", salary_type: "時給", role_type: "パート" },
  ];
  const nimi = { salary_type: "時給", role_type: "パート" };
  eq("★ 仁見 2026-03 は 月給で計算する", resolveEmploymentType(nimi, buildActiveSalaryMap(rows, "2026-03-01").get("e1")).salary_type, "月給");
  eq("★ 仁見 2026-04 は 時給で計算する (境界の月)", resolveEmploymentType(nimi, buildActiveSalaryMap(rows, "2026-04-01").get("e1")).salary_type, "時給");
  eq("★ 仁見 2026-07 は 時給", resolveEmploymentType(nimi, buildActiveSalaryMap(rows, "2026-07-01").get("e1")).salary_type, "時給");
  // ★ 負のコントロール: 直す前 (職員マスタの今の値だけ) だと 3 月も時給になってしまう
  eq("★★ 直す前は 3 月も今の形態 (時給) = この検査は差を検出できる",
    nimi.salary_type !== resolveEmploymentType(nimi, buildActiveSalaryMap(rows, "2026-03-01").get("e1")).salary_type, true);
}

// ── 同行の端数は四捨五入 (2026-09-18) ──
eq("同行 45分×1,150円 = 862.5 → 863 (四捨五入)", visitPayAmount(45, 1150, "同行", null, null), 863);
eq("同行 75分×1,150円 = 1,437.5 → 1,438", visitPayAmount(75, 1150, "同行", null, null), 1438);
eq("同行 20分×1,150円 = 383.33 → 383", visitPayAmount(20, 1150, "同行", null, null), 383);
eq("★ 生活援助 45分×1,550円 = 1,162.5 → 1,162 (切り捨てのまま)", visitPayAmount(45, 1550, "生活援助", null, null), 1162);
eq("★ 身体生活 40分×1,900円 = 1,266.67 → 1,266 (切り捨てのまま)", visitPayAmount(40, 1900, "身体生活", null, null), 1266);
eq("★★ 直す前 (切り捨て) なら 862 = この検査は差を検出できる", visitPayAmount(45, 1150, "同行", null, null) !== Math.floor(45 / 60 * 1150), true);

// ── findKmAnomalies (距離の確認ライン。2026-09-18) ──
{
  const L = { commute_per_day: 30, trip_per_day: 60 };
  const r = (o: Partial<{ commute_km: number; trip_km: number; work_days: number }>) => ({ employee_number: "1", employee_name: "x", commute_km: 0, trip_km: 0, work_days: 20, ...o });
  eq("★ 船橋 金子 通勤km 22,816 ÷ 20日 = 1,140.8km/日 → 警告", findKmAnomalies([r({ commute_km: 22816 })], L).map((w) => [w.kind, w.per_day]), [["通勤", 1140.8]]);
  eq("普段の距離 (通勤 9.6km×20日 = 192km) は出さない", findKmAnomalies([r({ commute_km: 192 })], L).length, 0);
  eq("★ 境界: ちょうどライン (30km/日) は出さない / 超えたら出す", [findKmAnomalies([r({ commute_km: 600 })], L).length, findKmAnomalies([r({ commute_km: 601 })], L).length], [0, 1]);
  eq("出張も同じ (高品 櫻井 13,974km ÷ 21日 = 665.4km/日)", findKmAnomalies([r({ trip_km: 13974, work_days: 21 })], L).map((w) => w.per_day), [665.4]);
  eq("出勤日数 0 で距離だけある人は 1 日として見る", findKmAnomalies([r({ commute_km: 50, work_days: 0 })], L).length, 1);
  eq("★★ 距離 0 の人は出さない (= 誤警告しない)", findKmAnomalies([r({})], L).length, 0);
}

// ── isSundayOrHoliday (土日祝手当の 日曜・祝日だけ。2026-09-18) ──
eq("日曜 2026-07-05 は対象", isSundayOrHoliday("20260705"), true);
eq("★ 土曜 2026-07-04 は対象外 (袖ケ浦などは土曜を払わない)", isSundayOrHoliday("20260704"), false);
eq("★ 祝日 2026-07-20 (海の日・月曜) は対象 (実績の休日区分は「平日」でも)", isSundayOrHoliday("2026/07/20"), true);
eq("平日 2026-07-21 は対象外", isSundayOrHoliday("20260721"), false);
eq("★★ 土曜は 土日祝では対象・日曜祝日では対象外 (= 2 つの数え方の差を検出できる)", [isWeekendOrHoliday("20260704"), isSundayOrHoliday("20260704")], [true, false]);

// ── 月の途中で 時給 → 月給 (2026-09-18 user ルール。狩野直子 ちはら台 2026-03 で総括表と 1 円まで一致) ──
{
  const d = (serviceMinutes: number, workMinutes = 0, halfDay = false) => ({ serviceMinutes, workMinutes, halfDay });
  const kano = [390, 390, 240, 390, 360, 390, 390, 330].map((m) => d(m));
  eq("★ 狩野 3/21〜 8 日 (全日 サービス 3h 以上) = 8 日", midMonthWorkDays(kano, "社員"), 8);
  eq("社員 サービス 179 分 = 0.5 日 / 180 分 = 1 日", [midMonthWorkDays([d(179)], "社員"), midMonthWorkDays([d(180)], "社員")], [0.5, 1]);
  eq("提責 は 出勤簿の勤務時間 239 分 = 0.5 日 / 240 分 = 1 日 (サービス時間は見ない)", [midMonthWorkDays([d(600, 239)], "提責"), midMonthWorkDays([d(0, 240)], "提責")], [0.5, 1]);
  eq("半休の日は 0.5 日", midMonthWorkDays([d(400, 480, true)], "社員"), 0.5);
  const base = { base_personal_salary: 94000, skill_salary: 76000, position_allowance: 0, qualification_allowance: 0, tenure_allowance: 0, fixed_overtime_pay: 0,
    treatment_improvement: 80000, specific_treatment_improvement: 10000, treatment_subsidy: 20000 } as unknown as Parameters<typeof prorateMonthlyFixed>[0];
  const p = prorateMonthlyFixed(base, 8, false);
  eq("★ 狩野 本人給 94,000 → 560×8h×8日 = 35,840 (総括表)", p.base_personal_salary, 35840);
  eq("★ 狩野 職能給 76,000 → 452×8h×8日 = 28,928 (総括表)", p.skill_salary, 28928);
  eq("処遇改善関係は満額", [p.treatment_improvement, p.specific_treatment_improvement, p.treatment_subsidy], [80000, 10000, 20000]);
  eq("稼働 0 日なら処遇改善も 0", prorateMonthlyFixed(base, 0, false).treatment_improvement, 0);
  eq("★★ 暦日 (12/31) で割ると 36,387 になり総括表と合わない = この検査は日割りの方式の差を検出できる", Math.round(94000 * 12 / 31) !== p.base_personal_salary, true);
}

// ── 入浴件数 × 1.12h を介護超過に足す (おゆみ野の総括表の式。2026-09-18) ──
{
  eq("入浴 115 件 = 115 × 1.12h = 128.8h (7,728 分)", Math.round(bathVisitCareMinutes(115)), 7728);
  eq("0 件・マイナスは 0", [bathVisitCareMinutes(0), bathVisitCareMinutes(-3)], [0, 0]);
  const cop = (careMin: number) => careOvertimePay({ role_type: "社員", care_minutes: careMin, summary: { visitMinutes: 0 },
    settings: { care_overtime_threshold_hours: 120, care_overtime_unit_price: 2500 }, care_overtime_lower_tier: null } as unknown as Parameters<typeof careOvertimePay>[0]);
  eq("★ 福山 2026-07: 訪問 15.5h + 115 件 → 24.3h × 2,500 = 60,750 (総括表)", cop(15.5 * 60 + bathVisitCareMinutes(115)), 60750);
  eq("★ 緑川 2026-07: 92.125h + 30 件 = 125.725h → 14,313 (総括表。浮動小数で 14,312 にならない)", cop(92.125 * 60 + bathVisitCareMinutes(30)), 14313);
  eq("★★ 係数 1.1 だと 東條 は 2,500 円 (総括表 4,250) = 係数の違いを検出できる", cop(82.5 * 60 + 35 * 1.1 * 60) !== cop(82.5 * 60 + bathVisitCareMinutes(35)), true);
}

// ── 有給の付与ごとの日当: 前年度繰越を使い切るまでは前年度の日当 (2026-09-18 user ルール) ──
{
  const g = { grant_date: "2026-04-01", carry_days: 20, prev_rate: 997, cur_rate: 624 };
  eq("★ 保本 2026-08: 繰越 20 日のうち使用 2 日 → 1.5 日 × 前年度 997 = 1,496 (総括表)", paidLeaveAllowanceByGrant(1.5, 2, g, 0), 1496);
  const m = { grant_date: "2026-04-01", carry_days: 1, prev_rate: 9871, cur_rate: 9877 };
  eq("★ 松元 繰越 1 日で 4 月 3 日: 1 日 × 9,871 + 2 日 × 9,877 = 29,625 (月の途中で使い切る)", paidLeaveAllowanceByGrant(3, 0, m, 0), 29625);
  eq("使い切った後は今年度の日当だけ", paidLeaveAllowanceByGrant(2, 1, m, 0), 19754);
  eq("付与が無ければ 給与設定の単価", paidLeaveAllowanceByGrant(2, 0, null, 500), 1000);
  eq("日当が両方空なら 給与設定の単価", paidLeaveAllowanceByGrant(1, 0, { grant_date: "2026-04-01", carry_days: 5, prev_rate: null, cur_rate: null }, 700), 700);
  eq("有効な付与 = 付与日 <= 月末 の最新", activePaidLeaveGrant([{ ...g, grant_date: "2025-04-01" }, g], "2026-03-31")?.grant_date, "2025-04-01");
  eq("★★ 今年度の日当だけで払うと 保本は 936 円 (総括表 1,496) = 繰越の扱いの差を検出できる", Math.round(1.5 * 624) !== paidLeaveAllowanceByGrant(1.5, 2, g, 0), true);
}

// ── 有給単価は履歴を引き継ぐ (空の行で職員マスタに戻らない。2026-09-18) ──
{
  const rows = [
    { employee_id: "y", effective_from: "1970-01-01", paid_leave_unit_price: null },
    { employee_id: "y", effective_from: "2026-04-01", paid_leave_unit_price: 2416 },
    { employee_id: "y", effective_from: "2026-07-01", paid_leave_unit_price: null },
  ];
  const emp = { id: "y", paid_leave_unit_price: 7712 };
  eq("★ 米倉 2026-07: 7 月の行は空 → 4 月の 2,416 を引き継ぐ (総括表 1.5 日 3,624)", resolvePaidLeaveUnitPriceFromHistory(emp, rows, "2026-07-01"), 2416);
  eq("3 月は履歴に値が無い → 職員マスタ", resolvePaidLeaveUnitPriceFromHistory(emp, rows, "2026-03-01"), 7712);
  eq("0 も値として引き継ぐ", resolvePaidLeaveUnitPriceFromHistory(emp, [...rows, { employee_id: "y", effective_from: "2026-08-01", paid_leave_unit_price: 0 }], "2026-09-01"), 0);
  eq("★★ 有効な行だけ見ると 職員マスタ 7,712 に戻る = 引き継ぎの差を検出できる", resolvePaidLeaveUnitPriceFromHistory(emp, rows, "2026-07-01") !== 7712, true);
}

// ── 同行には夜朝の割増を付けない (2026-09-18) ──
eq("★ 同行 30分 夜朝 = 575 (割増なし。四街道 若菜 2026-07)", visitPayAmount(30, 1150, "同行", "夜朝", null), 575);
eq("身体介護 30分 夜朝 は割増あり = 1,050 + 263 = 1,313", visitPayAmount(30, 2100, "身体介護", "夜朝", null), 1313);
eq("★★ 割増を付けると 719 = 差を検出できる", visitPayAmount(30, 1150, "同行", "夜朝", null) !== 719, true);

// ── 欠勤控除 (2026-09-18 総括表 2026-03〜07 の 32 件から) ──
{
  const mp = (o: Record<string, unknown>) => ({ settings: { base_personal_salary: 94000, skill_salary: 60000, position_allowance: 0, qualification_allowance: 0, tenure_allowance: 0,
    treatment_improvement: 90000, specific_treatment_improvement: 10000, treatment_subsidy: 20000, fixed_overtime_pay: 0, special_bonus: 0 },
    summary: { workDays: 21, visitMinutes: 8625 }, ...o }) as unknown as Parameters<typeof absenceDeduction>[0];
  eq("★ やわた 鹿島 2026-07: (94,000+60,000)÷168×8×1日 = 7,333 (総括表)", absenceDeduction(mp({ absence_days: 1 })), 7333);
  eq("★ 事務員は 159h: 熊谷 190,000÷159×8×1 = 9,559", absenceDeduction(mp({ absence_days: 1, is_office_worker_for_deduction: true, settings: { base_personal_salary: 100000, skill_salary: 90000, position_allowance: 0, qualification_allowance: 0, tenure_allowance: 0, treatment_improvement: 0, specific_treatment_improvement: 0, treatment_subsidy: 14000, fixed_overtime_pay: 0, special_bonus: 0 } })), 9559);
  eq("半欠勤 0.5 日 = 3,666", absenceDeduction(mp({ absence_days: 0.5 })), 3666);
  eq("欠勤 0 日は 0", absenceDeduction(mp({ absence_days: 0 })), 0);
  eq("★ 1 日も出勤していない月は 固定給を全額 (274,000)", absenceDeduction(mp({ absence_days: 21, summary: { workDays: 0, visitMinutes: 0 } })), 274000);
  eq("★★ 固定給全部 (274,000) ÷ 21 で割ると 13,047 = 本人給+職能給 だけに掛ける差を検出できる", absenceDeduction(mp({ absence_days: 1 })) !== Math.floor(274000 / 21), true);
}

// ── 夜朝手当に深夜 × 500 円を足す (2026-09-18) ──
{
  const yp = (o: Record<string, unknown>) => ({ settings: { yocho_unit_price: 200 }, yocho_hours: 11.5, shinya_hours: 4, ...o }) as unknown as Parameters<typeof yochoAllowance>[0];
  eq("★ KT姉崎 渡邉 2026-07: 夜朝 11.5h × 200 + 深夜 4h × 500 = 4,300 (総括表)", yochoAllowance(yp({})), 4300);
  eq("深夜だけでも払う", yochoAllowance(yp({ yocho_hours: 0, shinya_hours: 0.5 })), 250);
  eq("提責 (夜朝単価 0) は 深夜も 0", yochoAllowance(yp({ settings: { yocho_unit_price: 0 } })), 0);
  eq("深夜の時間 = 時間帯が深夜の算定時間", shinyaHoursFromRecords([{ calc_duration: "002:00", time_period: "深夜" }, { calc_duration: "001:00", time_period: "早朝夜間" }]), 2);
  eq("★★ 深夜を足さないと 2,300 = 差を検出できる", yochoAllowance(yp({})) !== 2300, true);
}

// ── 出勤簿の無い社員の残業 = 日ごとの (訪問 + 移動 − 8h) (2026-09-18 仮説) ──
{
  const v = new Map([["d1", 450], ["d2", 390], ["d3", 300]]);
  const t = new Map([["d1", 3600], ["d2", 3600], ["d3", 600]]);
  eq("450+60−480 = 30 / 390+60 = 450 → 0 / 300+10 → 0 = 30 分", dailyOvertimeFromVisits(v, t), 30);
  eq("移動が無い日は訪問だけ", dailyOvertimeFromVisits(new Map([["d", 500]]), new Map()), 20);
  eq("★★ 月合計で 8h×日数 を引くと 0 になる = 日ごとに見る差を検出できる", dailyOvertimeFromVisits(v, t) !== Math.max(0, 450 + 390 + 300 + 60 + 60 + 10 - 480 * 3), true);
}

// ── 介護超過に足すのは HRD研修 だけ (研修 は足さない。2026-09-18) ──
{
  const tr = (item: string, s: string, e: string) => ({ record_type: "training", item_name: item, start_time: s, end_time: e, break_time: null }) as unknown as Parameters<typeof hrdTrainingMinutes>[0][number];
  const recs = [tr("HRD研修", "18:00", "19:00"), tr("研修", "19:00", "20:00")];
  eq("★ 高品 櫻井 2026-04: HRD 1h + 研修 1h → 介護時間に足すのは 60 分", hrdTrainingMinutes(recs), 60);
  eq("研修の手当の時間 (trainingMinutes) は 両方 120 分のまま", trainingMinutes(recs), 120);
  eq("★★ 両方足すと 120 = 差を検出できる", hrdTrainingMinutes(recs) !== trainingMinutes(recs), true);
}

console.log(`\n合格 ${pass} / ${pass + fail.length}`);
if (fail.length) { console.log("\n★ 不一致:"); for (const f of fail) console.log("   " + f); process.exit(1); }
console.log("\n⚠ この検証が証明していないこと: 出勤簿の集計・移動手当の距離算出自体は");
console.log("   verify-overtime-boundary.mts / verify-distance-calculator.mts で別途検証済み。");
console.log("   ここで証明していないのは distMap の中身の妥当性と実データでの妥当性。");
