// 残業代計算の境界値検証 (純関数のみ・DB は一切触らない)
//
//   npx tsx scripts/verify-overtime-boundary.mts
//
// 労基法37条の割増率が実装どおりかを in-memory で確かめる。実データが薄い
// (payroll_kyotaku_attendance_records 401 行 / 出勤簿を持つのは実測 10 名) ので、
// データ量に依存しない形で計算そのものを固定するのが目的。
import {
  calcDaily,
  calcDailyListWithWeekly,
  calcMonthlySummary,
  extendedMonthRange,
} from "../src/lib/payroll/attendance-calc";
import { calcOvertimePayBreakdown } from "../src/lib/payroll/overtime-pay-calc";

let pass = 0;
const fail: string[] = [];
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fail.push(`${name}\n     期待 ${JSON.stringify(want)}\n     実際 ${JSON.stringify(got)}`);
};

// ── calcDaily ────────────────────────────────────────────────────────────
const day = (o: Record<string, unknown>) =>
  calcDaily({
    work_date: "2026-06-15", start_time: null, end_time: null,
    break_minutes: 0, is_legal_holiday: false, paid_leave_type: null, ...o,
  } as never);

// 8時間ちょうど → 日次残業 0 (境界)
eq("8h ちょうどは残業0",
  day({ start_time: "09:00", end_time: "18:00", break_minutes: 60 }).daily_overtime, 0);
// 8時間1分 → 1分
eq("8h+1分は残業1分",
  day({ start_time: "09:00", end_time: "18:01", break_minutes: 60 }).daily_overtime, 1);
// 法定休日は daily_overtime を立てない (1.35 と 1.25 の二重払い防止)
const hol = day({ start_time: "09:00", end_time: "20:00", break_minutes: 60, is_legal_holiday: true });
eq("法定休日: daily_overtime は 0", hol.daily_overtime, 0);
eq("法定休日: holiday_work = work_minutes", hol.holiday_work, hol.work_minutes);
eq("法定休日: work_minutes = 11h-1h = 600", hol.work_minutes, 600);
// 日跨ぎ
const cross = day({ start_time: "22:00", end_time: "06:00", break_minutes: 60 });
eq("日跨ぎ: work_minutes = 8h-1h = 420", cross.work_minutes, 420);
eq("日跨ぎ: 深夜は 22:00-05:00 の 420分 (休憩を引かない = 既知の簡略化)",
  cross.midnight_overtime, 420);
// 深夜帯に一切かからない
eq("日中のみ: 深夜0",
  day({ start_time: "09:00", end_time: "18:00", break_minutes: 60 }).midnight_overtime, 0);
// 時刻が無い
eq("時刻なしは全部0", day({}).work_minutes, 0);

// ── calcOvertimePayBreakdown ─────────────────────────────────────────────
// 時給 2,000 円になる設定 (base 320,000 / 所定 160h)
const salary = {
  base_personal_salary: 320000, skill_salary: 0, position_allowance: 0,
  qualification_allowance: 0, tenure_allowance: 0, treatment_improvement: 0,
  specific_treatment_improvement: 0, treatment_subsidy: 0,
  fixed_overtime_pay: 0, special_bonus: 0,
} as never;
const ot = {
  scheduled_hours_per_month: 160, include_base_personal_salary: true,
  include_skill_salary: false, include_position_allowance: false,
  include_qualification_allowance: false, include_tenure_allowance: false,
  include_treatment_improvement: false, include_specific_treatment: false,
  include_treatment_subsidy: false, include_fixed_overtime_pay: false,
  include_special_bonus: false,
} as never;
const sum = (o: Record<string, number>) =>
  ({ total_daily_overtime: 0, total_weekly_overtime: 0, total_midnight: 0, total_holiday: 0, ...o }) as never;

eq("時給 = 320000/160 = 2000",
  calcOvertimePayBreakdown(sum({}), salary, ot).hourlyRate, 2000);
// 60h ちょうど → 全部 1.25
const at60 = calcOvertimePayBreakdown(sum({ total_daily_overtime: 3600 }), salary, ot);
eq("60h ちょうど: 1.25 のみ", [at60.regularOvertimePay, at60.over60OvertimePay],
  [Math.round(60 * 2000 * 1.25), 0]);
// 60h + 1分 → 1分だけ 1.5
const over60 = calcOvertimePayBreakdown(sum({ total_daily_overtime: 3601 }), salary, ot);
eq("60h+1分: 超過1分が 1.5", [over60.regularOvertimePay, over60.over60OvertimePay],
  [Math.round(60 * 2000 * 1.25), Math.round((1 / 60) * 2000 * 1.5)]);
// 日次+週次を合算して 60h 判定するか
const split = calcOvertimePayBreakdown(sum({ total_daily_overtime: 1800, total_weekly_overtime: 1801 }), salary, ot);
eq("日次+週次を合算して60hを判定", split.over60OvertimePay, Math.round((1 / 60) * 2000 * 1.5));
// 深夜は 0.25 のみ
eq("深夜は割増 0.25 のみ",
  calcOvertimePayBreakdown(sum({ total_midnight: 600 }), salary, ot).midnightExtraPay,
  Math.round(10 * 2000 * 0.25));
// 法定休日は 1.35 (本体込み)
eq("法定休日は 1.35",
  calcOvertimePayBreakdown(sum({ total_holiday: 600 }), salary, ot).holidayPay,
  Math.round(10 * 2000 * 1.35));
// 法定休日 × 深夜 = 1.35 + 0.25 = 1.60
const hm = calcOvertimePayBreakdown(sum({ total_holiday: 600, total_midnight: 600 }), salary, ot);
eq("法休×深夜 = 1.60 相当", hm.holidayPay + hm.midnightExtraPay, Math.round(10 * 2000 * 1.6));
// 所定時間 0 → 空 (0除算しない)
eq("所定0は空を返す",
  calcOvertimePayBreakdown(sum({ total_daily_overtime: 600 }),
    salary, { ...(ot as object), scheduled_hours_per_month: 0 } as never).totalOvertimePay, 0);
// 固定残業代 0 のときは超過警告を出さない
const noFixed = calcOvertimePayBreakdown(sum({ total_daily_overtime: 600 }), salary, ot);
eq("固定残業代0なら isExceeding=false", noFixed.isExceeding, false);
// 固定残業代を超えたら警告
const withFixed = calcOvertimePayBreakdown(sum({ total_daily_overtime: 600 }),
  { ...(salary as object), fixed_overtime_pay: 1000 } as never, ot);
eq("固定残業代を超えたら isExceeding=true", withFixed.isExceeding, true);
eq("超過額 = 実残業代 - 固定", withFixed.exceedAmount, withFixed.totalOvertimePay - 1000);
// salary/ot が null
eq("salary が null なら空", calcOvertimePayBreakdown(sum({}), null, ot).totalOvertimePay, 0);
eq("ot が null なら空", calcOvertimePayBreakdown(sum({}), salary, null).totalOvertimePay, 0);

// ── 集計側 (calcDailyListWithWeekly) ─────────────────────────────────────
// ⚠ 法定休日は **日曜で固定** (2026-07-31 user 確定 / order-app が正本)。
//   日曜に出勤しても、その週に休みがあれば通常労働。週内に日曜が無い (月跨ぎで
//   欠けている) 場合だけ最終日にフォールバックする。
//   ★ 2026-09-03 に 3 app を order-app に揃えたので、**期待値を「最終日 (土)」から
//     「日曜」に直した**。それ以前は payroll だけ週最終日 = 土曜になっていた。
//   実測 (2026-09-03): payroll_offices 59 件すべて work_week_start = 0 (日曜起算)。
const rec = (d: string, o: Record<string, unknown> = {}) =>
  ({
    work_date: d, start_time: "09:00", end_time: "18:00", break_minutes: 60,
    is_legal_holiday: false, paid_leave_type: null, substitute_for_date: null, ...o,
  }) as never;

// 2026-06-07(日) 〜 06-13(土) の 7 日。日曜起算なので 1 週ちょうど。
const week = ["07", "08", "09", "10", "11", "12", "13"].map((d) => rec(`2026-06-${d}`));
const full = calcDailyListWithWeekly(week, 0);
// week[0] = 2026-06-07(日)。日曜が法定休日になる (最終日 06-13(土) ではない)
eq("★ 休み無しの週: 日曜が法定休日労働になる",
  [full[0].holiday_work > 0, full[0].daily_overtime], [true, 0]);
eq("★ 休み無しの週: 日曜以外は法定休日にしない",
  full.slice(1).every((d) => d.holiday_work === 0), true);
// 週内に日曜が無い (月跨ぎで欠けている) ときだけ最終日にフォールバック
const noSunday = ["08", "09", "10", "11", "12", "13", "14"].map((d) => rec(`2026-06-${d}`));
const fb = calcDailyListWithWeekly(noSunday, 1); // 月曜起算 = 06-08(月)〜06-14(日)
eq("週内に日曜があれば (月曜起算でも) 日曜が法定休日",
  [fb[6].holiday_work > 0, fb.slice(0, 6).every((d) => d.holiday_work === 0)], [true, true]);

// ── ★ 代休 / 未入力 — 2026-09-03 に order-app へ揃えたぶん ──────────────
// substitute_for_date が set の日は「代休 (= 休み扱い、所定 0h)」。
// ⚠ 揃える前の payroll は逆に読んで **所定 8h を強制**していたので、
//   代休の日がまるごと欠勤になり控除が立っていた (実データで 15 日該当)。
const daikyu = calcDailyListWithWeekly(
  [rec("2026-06-03", { start_time: null, end_time: null, substitute_for_date: "2026-05-05" })], 0);
eq("★ 代休の日 (substitute_for_date あり) は所定 0h", daikyu[0].scheduled_minutes, 0);
eq("★ 代休の日は欠勤にしない", daikyu[0].absence_minutes, 0);

// 完全未入力の平日は欠勤にしない (2026-07-29 user 確定)。
// 月の途中で「これから来る平日」が欠勤として積み上がるのを防ぐ。
const mikinyu = calcDailyListWithWeekly(
  [rec("2026-06-03", { start_time: null, end_time: null })], 0);
eq("★ 完全未入力の平日は欠勤にしない", mikinyu[0].absence_minutes, 0);
// 逆に、短く働いた日はちゃんと欠勤が立つ (上を「何でも 0」にしていないことの確認)
const tanjikan = calcDailyListWithWeekly([rec("2026-06-03", { end_time: "14:00" })], 0);
eq("★ 短時間勤務の平日は欠勤が立つ (4h)", tanjikan[0].absence_minutes, 240);

// 1 日でも休み (work_minutes=0) があれば auto-detect しない
const withRest = calcDailyListWithWeekly(
  week.map((r, i) => (i === 3 ? rec("2026-06-10", { start_time: null, end_time: null }) : r)), 0);
eq("週に休みが1日でもあれば法定休日を自動付与しない",
  withRest.every((d) => d.holiday_work === 0), true);

// 週次残業: 8h/日 × 6 日 = 48h → 40h 超過分 8h が weekly_overtime
const six = ["07", "08", "09", "10", "11", "12"].map((d) => rec(`2026-06-${d}`));
const w6 = calcDailyListWithWeekly(six, 0);
eq("8h×6日 = 48h → 週次残業 合計 8h",
  w6.reduce((s, d) => s + d.weekly_overtime, 0), 8 * 60);

// ── なぜ呼出側が extendedMonthRange を使わなければならないか (回帰ガード) ──
//   calcDailyListWithWeekly は **渡された記録だけ** で週 40h を積む。暦月で切った
//   記録をそのまま渡すと、月をまたぐ週が分断されて週次残業が消える。
//   ⚠ 本番はこれを踏んでいない: use-kyotaku-summary が extendedMonthRange で
//     **週全体を含む範囲**を取ってから渡している。ここはその前提を固定するための試験で、
//     「今バグっている」という意味ではない。
const may = ["2026-05-31"].map((d) => rec(d));                       // 日曜 1 日
const jun = ["01", "02", "03", "04", "05"].map((d) => rec(`2026-06-${d}`)); // 月〜金 5 日
eq("暦月で切ると 5月側 (1日) の週次残業は 0",
  calcDailyListWithWeekly(may, 0).reduce((s, d) => s + d.weekly_overtime, 0), 0);
eq("暦月で切ると 6月側 (5日=40h ちょうど) の週次残業も 0",
  calcDailyListWithWeekly(jun, 0).reduce((s, d) => s + d.weekly_overtime, 0), 0);
// → 同じ 6 日 48h でも、暦月で分けると 8h ぶんの週次残業が出ない。
//   だから extendedMonthRange が要る。以下でその範囲が週境界に揃うことを確かめる。
const ext = extendedMonthRange("2026-06", 0);
eq("extendedMonthRange: 週起算(日)から週末(土)まで広げる",
  [new Date(`${ext.start}T00:00:00Z`).getUTCDay(), new Date(`${ext.end}T00:00:00Z`).getUTCDay()],
  [0, 6]);
eq("extendedMonthRange: 月初・月末を必ず含む",
  [ext.start <= "2026-06-01", ext.end >= "2026-06-30"], [true, true]);

// 有給: full は所定 0 / 欠勤 0、かつ効果労働時間に 8h クレジット
const withLeave = calcDailyListWithWeekly(
  [rec("2026-06-08", { start_time: null, end_time: null, paid_leave_type: "full" })], 0);
eq("全有給の日は 欠勤 0 / 所定 0",
  [withLeave[0].absence_minutes, withLeave[0].scheduled_minutes], [0, 0]);
const halfLeave = calcDailyListWithWeekly(
  [rec("2026-06-08", { start_time: "09:00", end_time: "13:00", break_minutes: 0, paid_leave_type: "half" })], 0);
eq("半有給の所定は 4h", halfLeave[0].scheduled_minutes, 4 * 60);

// ── calcMonthlySummary (2026-09-05 追加) ─────────────────────────────────
// ⚠ この関数自体は payroll-sample-check.mts でも実データ突合しているが、
//   **サンプル未投入だと分母0でスキップされる** (この環境では現に分母0)。
//   calcMonthlySummary の中身は calcDailyListWithWeekly (境界値は上でテスト済み) の
//   結果を「月合計」に潰すだけの薄いラッパーで、そのラップ自体のロジックは
//   ①monthFilter (対象月だけ合計に含める。週計算には拡張範囲の日も使う) と
//   ②total_paid_leave_days の加算 の2つだけ。ここが今まで純関数の境界値では
//   未検証だった (= AttendanceSummary が「合計されている」ことの検証)。
// 実際の呼び出し元 (use-kyotaku-summary.ts) は extendedMonthRange で月またぎの
// 週を含む範囲を取得し、calcMonthlySummary(records, weekStart, month) に渡している
// (=下のケースは production の実際の呼び出しパターンそのまま)。
const monthRec = (d: string, o: Record<string, unknown> = {}) =>
  ({ work_date: d, start_time: "09:00", end_time: "18:00", break_minutes: 60,
    is_legal_holiday: false, paid_leave_type: null, substitute_for_date: null, ...o }) as never;

// 5/31(日) + 6/1〜6/5(月〜金) の6日、すべて8h勤務。同じ週(日曜起算)にまたがる。
// 週計算: 5/31から累積し、6/5で 2400分(40h)を超えて 480分(8h)が weekly_overtime になる。
const extendedRecords = ["2026-05-31", "2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"].map((d) => monthRec(d));
const monthSum = calcMonthlySummary(extendedRecords, 0, "2026-06");
eq("★ monthFilter: 5/31 (前月) は total_work から除外される (6日ぶんの480分×5=2400分)",
  monthSum.total_work, 480 * 5);
eq("★ monthFilter: だが 5/31 は週の累積計算には使われ、6/5 に週次残業480分(8h)が乗る",
  monthSum.total_weekly_overtime, 480);
eq("日次残業は無し (各日ちょうど8h)", monthSum.total_daily_overtime, 0);

// total_paid_leave_days: full=+1 / half=+0.5 の加算
const leaveRecords = [
  monthRec("2026-06-01", { start_time: null, end_time: null, paid_leave_type: "full" }),
  monthRec("2026-06-02", { start_time: "09:00", end_time: "13:00", break_minutes: 0, paid_leave_type: "half" }),
  monthRec("2026-06-03"), // 通常勤務 (加算されない)
];
const leaveSum = calcMonthlySummary(leaveRecords, 0, "2026-06");
eq("★ total_paid_leave_days = full(1) + half(0.5) + 通常(0) = 1.5",
  leaveSum.total_paid_leave_days, 1.5);

// monthFilter が無い (undefined) ときは records 全部を合計する (呼出元の一部が使う形)
const noFilterSum = calcMonthlySummary(extendedRecords, 0);
eq("★ monthFilter 省略時は 6日分すべて total_work に入る (480*6)",
  noFilterSum.total_work, 480 * 6);

console.log(`\n合格 ${pass} / ${pass + fail.length}`);
if (fail.length) { console.log("\n★ 不一致:"); for (const f of fail) console.log("   " + f); process.exit(1); }
console.log("");
console.log("⚠ この検証が証明していないこと:");
console.log("   ・欠勤分数を **金額に変える側** (呼出元)。月給者/時給者の出し分けはこの lib には無い");
console.log("     (calcDailyListWithWeekly は salary_type を一切見ない)");
console.log("   ・「残業時間も欠勤の補填源にする」が賃金全額払いの原則に照らして妥当か (運用ポリシー)");
console.log("   ・日曜を法定休日とすること自体の妥当性 (就業規則。2026-07-31 user 確定として実装)");
console.log("   ・実データでの妥当性 (出勤簿を持つ職員は実測 10 名。実データ突合は別途");
console.log("     payroll-sample-check.mts が担当するが、この環境ではその前提データが無く動いていない)");
