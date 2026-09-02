// 残業代計算の境界値検証 (純関数のみ・DB は一切触らない)
//
//   npx tsx scripts/verify-overtime-boundary.mts
//
// 労基法37条の割増率が実装どおりかを in-memory で確かめる。実データが薄い
// (payroll_kyotaku_attendance_records 401 行 / 出勤簿を持つのは実測 10 名) ので、
// データ量に依存しない形で計算そのものを固定するのが目的。
import { calcDaily } from "../src/lib/payroll/attendance-calc";
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

console.log(`\n合格 ${pass} / ${pass + fail.length}`);
if (fail.length) { console.log("\n★ 不一致:"); for (const f of fail) console.log("   " + f); process.exit(1); }
console.log("⚠ この検証が証明していないこと: total_midnight/total_holiday の **集計側** (attendance-calc の");
console.log("   週次按分・法定休日 auto-detect・欠勤補填) と、実データでの妥当性。純関数の境界のみ。");
