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
// ⚠ 週起算日・法定休日をどの曜日にするかは **就業規則で決まる**。ここで確かめるのは
//   「実装がどう動くか」だけで、「それが正しいか」は user 判断 (DECISIONS_PENDING)。
//   実測 (2026-09-03): payroll_offices 59 件すべて work_week_start = 0 (日曜起算)。
const rec = (d: string, o: Record<string, unknown> = {}) =>
  ({
    work_date: d, start_time: "09:00", end_time: "18:00", break_minutes: 60,
    is_legal_holiday: false, paid_leave_type: null, substitute_for_date: null, ...o,
  }) as never;

// 2026-06-07(日) 〜 06-13(土) の 7 日。日曜起算なので 1 週ちょうど。
const week = ["07", "08", "09", "10", "11", "12", "13"].map((d) => rec(`2026-06-${d}`));
const full = calcDailyListWithWeekly(week, 0);
eq("休み無しの週: 最終日 (土) が法定休日労働になる",
  [full[6].holiday_work > 0, full[6].daily_overtime], [true, 0]);
eq("休み無しの週: 最終日以外は法定休日にしない",
  full.slice(0, 6).every((d) => d.holiday_work === 0), true);

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

console.log(`\n合格 ${pass} / ${pass + fail.length}`);
if (fail.length) { console.log("\n★ 不一致:"); for (const f of fail) console.log("   " + f); process.exit(1); }
console.log("");
console.log("⚠ この検証が証明していないこと:");
console.log("   ・欠勤分数を **金額に変える側** (呼出元)。月給者/時給者の出し分けはこの lib には無い");
console.log("     (calcDailyListWithWeekly は salary_type を一切見ない)");
console.log("   ・「残業時間も欠勤の補填源にする」が賃金全額払いの原則に照らして妥当か (運用ポリシー)");
console.log("   ・法定休日をどの曜日にするか (就業規則。実装は 週の最終日 = 日曜起算なら土曜)");
console.log("   ・実データでの妥当性 (出勤簿を持つ職員は実測 10 名)");
