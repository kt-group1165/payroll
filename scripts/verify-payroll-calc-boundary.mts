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
import {
  hasTenureQualification,
  computeTenureAllowance,
  computeTenureRate,
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
  monthlyGrandTotal,
  hourlyTenure,
  hourlyTotalPay,
  weekendHolidayAllowanceAmount,
  travelAllowanceAmount,
  adjustedCommuteDistanceM,
  businessTripFeeAmount,
  normalizeYM,
  computeChildcareAllowance,
  computeMeetingFee,
  treatmentSubsidyAmount,
  cancelAllowanceAmount,
  paidLeaveAllowanceAmount,
  communicationFeeAmount,
  hourlyCommuteFeeAmount,
  hourlyBusinessTripFeeAmount,
  hourlyRecordPay,
  type SalarySettings,
  type OvertimeSetting,
  type MonthlyPayroll,
  type HourlyPayroll,
  type AttendanceSummary,
  type OfficeFormRecord,
} from "../src/lib/payroll/payroll-calc";

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
eq("時給 訪問介護 勤続5年ちょうど (境界) = 20円/h",
  computeTenureRate(true, 60, "訪問介護"), 20);
eq("時給 訪問介護 勤続4年11ヶ月 (59ヶ月) はまだ10円/h",
  computeTenureRate(true, 59, "訪問介護"), 10);
eq("時給 訪問看護も訪問介護と同じ単価体系",
  computeTenureRate(true, 60, "訪問看護"), 20);
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
  ...over,
});
eq("fixedTotal = 各手当の単純合計",
  fixedTotal(salary()), 200000 + 10000 + 5000 + 3000 + 1000 + 8000 + 2000 + 1000 + 20000 + 0);

const summary = (over: Partial<AttendanceSummary> = {}): AttendanceSummary => ({
  workDays: 0, helperDays: 0, paidLeave: 0, halfLeave: 0, specialLeave: 0,
  workHoursMin: 0, overtimeMinutes: 0, recordCount: 0, accompaniedCount: 0,
  visitMinutes: 0, hrdCount: 0, hrdMinutes: 0, meetingCount: 0,
  commuteKmTotal: 0, businessKmTotal: 0, weekendHolidayMinutes: 0,
  weekendHolidayAccompaniedMinutes: 0, visitMinutesExcludingAccompanied: 0,
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
    business_trip_fee: 500, childcare_allowance: 300, yocho_hours: 2,
  });
  const expect =
    fixedTotal(p.settings!) +
    (p.bonus_paid ? p.settings!.bonus_amount : 0) +
    travelFeeAmount(p) + commuteFeeAmount(p) +
    p.business_trip_fee + p.childcare_allowance +
    careOvertimePay(p) + yochoAllowance(p) +
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
  business_trip_fee: 0, records: [], totalMinutes: 0, totalPay: 0, unmappedCount: 0,
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
    business_trip_fee: 700, error_adjustment: -50,
  });
  eq("hourlyTotalPay = 各要素の合算 (恒等式)", hourlyTotalPay(e),
    e.totalPay + hourlyTenure(e) + e.treatment_subsidy + e.paid_leave_allowance +
    e.cancel_allowance + e.travel_allowance + e.communication_fee + e.meeting_fee +
    e.childcare_allowance + e.commute_fee + e.business_trip_fee + e.error_adjustment);
}

// ★ 土日祝手当は hourlyTotalPay に含まれない (意図的な仕様。業務判断待ち)。
//   ここで「入っていない」ことを固定する。含めるようになったらこのテストが落ちる。
{
  const base = hourly({ totalPay: 10000 });
  const withWeekend = hourly({ totalPay: 10000, summary: summary({ weekendHolidayMinutes: 600 }) });
  eq("★ 土日祝手当(600分=10,000円相当)があっても hourlyTotalPay は変わらない",
    hourlyTotalPay(withWeekend), hourlyTotalPay(base));
  eq("weekendHolidayAllowanceAmount 自体は 600分→1,000円を返す (表示用の値自体は正しい)",
    weekendHolidayAllowanceAmount(600), 1000);
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
eq("有給手当: 2.5日×1000円 (半休を含む端数)", paidLeaveAllowanceAmount(2.5, 1000), 2500);

eq("通信手当: 社保加入なら0円固定 (時間に関わらず)", communicationFeeAmount(true, 999999), 0);
eq("通信手当: 未加入・0分は0円", communicationFeeAmount(false, 0), 0);
eq("★ 通信手当: 未加入・ちょうど50h(3000分) は境界含まず500円", communicationFeeAmount(false, 3000), 500);
eq("★ 通信手当: 未加入・50h+1分(3001分) は1000円", communicationFeeAmount(false, 3001), 1000);
eq("通信手当: 未加入・1分でも勤務あれば500円", communicationFeeAmount(false, 1), 500);

eq("通勤費(時給): 10km×100円/km", hourlyCommuteFeeAmount(10, 100), 1000);
eq("出張費(時給): 5km×200円/km", hourlyBusinessTripFeeAmount(5, 200), 1000);

eq("実績1件の支給額: 60分×時給2000円 = 2000円", hourlyRecordPay(60, 2000), 2000);
eq("実績1件の支給額: 30分×時給2000円 = 1000円 (端数切り上げ丸め)", hourlyRecordPay(30, 2000), 1000);
eq("★ 実績1件の支給額: 単価が引けない(null)場合は null (未マッピング扱い)", hourlyRecordPay(60, null), null);

console.log(`\n合格 ${pass} / ${pass + fail.length}`);
if (fail.length) { console.log("\n★ 不一致:"); for (const f of fail) console.log("   " + f); process.exit(1); }
console.log("\n⚠ この検証が証明していないこと: 出勤簿の集計・移動手当の距離算出自体は");
console.log("   verify-overtime-boundary.mts / verify-distance-calculator.mts で別途検証済み。");
console.log("   ここで証明していないのは distMap の中身の妥当性と実データでの妥当性。");
