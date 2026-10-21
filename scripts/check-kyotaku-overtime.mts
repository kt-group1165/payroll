/**
 * 居宅 (ケアマネ) の残業代 (固定残業代を超えた分) の検査 (2026-10-21)。DB を使わない純関数の検査。
 *
 *   npm run check:kyotaku-overtime
 *
 * 見るもの:
 *   ① 毎日 9:00-18:00 (休憩 60 分 = 8 時間) なら 残業代 0
 *   ② 毎日 9:00-20:00 (10 時間) なら 時間外 2h × 日数 × 時給 × 1.25 − 固定残業代
 *   ③ ★ 負のコントロール: 固定残業代が 実残業代より大きいと 0 (超えた分だけ払う)
 *   ④ 給与の計算 (calcSalary) に overtime_pay を渡すと 総支給に足される
 *   ⑤ 時給の元: 残業設定の include_* が true の手当 (役職手当を含む) の合計 ÷ 所定時間
 *   ⑥ 育児手当 (2026-10-21): 保育料 × 40% + 幼稚園 × 20%、上限 20,000、総支給に足される
 * 2026-06〜09 の実データでは 89〜93 人全員が 0 円 (総括表の残業総額も全員 0)。全部 0 だと効いているか分からないので ここで鳴らす。
 */
import { kyotakuOvertimeFor, type OvertimeSettingRow } from "../src/lib/payroll/kyotaku-overtime.js";
import { calcSalary, kyotakuChildcareAllowance } from "../src/lib/payroll/kyotaku-calc.js";
import type { AttendanceRecord } from "../src/lib/payroll/attendance-calc.js";
import type { KyotakuSalary } from "../src/lib/payroll/kyotaku-salary-history.js";

let fail = 0;
const ok = (cond: boolean, label: string) => { console.log(`  ${cond ? "o" : "✗"} ${label}`); if (!cond) fail++; };

const ot: OvertimeSettingRow[] = [{
  job_type: "居宅介護支援", effective_from: "1970-01-01", scheduled_hours_per_month: 160,
  include_base_personal_salary: true, include_skill_salary: true, include_position_allowance: true, include_qualification_allowance: true,
  include_tenure_allowance: true, include_treatment_improvement: false, include_specific_treatment: true, include_treatment_subsidy: false,
  include_fixed_overtime_pay: false, include_special_bonus: false,
}];
const sal = (kotei_zangyo: number): KyotakuSalary => ({
  id: "s", tenant_id: "t", employee_id: "e", effective_from: "2026-01-01", honnin_kyu: 100000, shokuno_kyu: 115300, kotei_zangyo,
  shikaku_teate: 15000, kotei: 0, tokutei_shogu: 17000, kaigo_rate: 9000, shien_rate: 3000, position_allowance: 12700,
} as KyotakuSalary);
// 2026-06 の平日 (月〜金) 22 日
const weekdays = Array.from({ length: 30 }, (_, i) => `2026-06-${String(i + 1).padStart(2, "0")}`).filter((d) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w >= 1 && w <= 5; });
const days = (end: string): AttendanceRecord[] => weekdays.map((d) => ({ work_date: d, start_time: "09:00", end_time: end, break_minutes: 60, is_legal_holiday: false, paid_leave_type: null, substitute_for_date: null }));
const rate = (100000 + 115300 + 12700 + 15000 + 0 + 17000) / 160; // 1,625 円/時

console.log("=== check:kyotaku-overtime (居宅の残業代 = 固定残業代を超えた分) ===");
const a = kyotakuOvertimeFor(days("18:00"), 0, "2026-06", new Set(), sal(34700), ot).breakdown;
ok(a.totalOvertimePay === 0 && a.exceedAmount === 0, `① 毎日 8 時間なら 0 (実残業代 ${a.totalOvertimePay})`);

const b = kyotakuOvertimeFor(days("20:00"), 0, "2026-06", new Set(), sal(34700), ot).breakdown;
const expectTotal = Math.round(weekdays.length * 2 * rate * 1.25);
ok(Math.round(b.hourlyRate) === Math.round(rate), `⑤ 時給 = (本人給+職能給+役職+資格+勤続+特定) ÷ 160 = ${Math.round(rate)} (計算 ${Math.round(b.hourlyRate)})`);
ok(b.totalOvertimePay === expectTotal, `② 毎日 10 時間 (${weekdays.length} 日 × 2h) → 実残業代 ${expectTotal} (計算 ${b.totalOvertimePay})`);
ok(b.exceedAmount === expectTotal - 34700, `② 払う額 = ${expectTotal} − 固定 34,700 = ${expectTotal - 34700} (計算 ${b.exceedAmount})`);

const c = kyotakuOvertimeFor(days("20:00"), 0, "2026-06", new Set(), sal(200000), ot).breakdown;
ok(c.exceedAmount === 0 && c.totalOvertimePay === expectTotal, `③ 固定残業代 200,000 > 実残業代 ${c.totalOvertimePay} なら 払う額 0 (計算 ${c.exceedAmount})`);

const cfg = (overtime_pay?: number) => ({
  settings: [{ staff_name: "X", honnin_kyu: 100000, shokuno_kyu: 115300, kotei_zangyo: 34700, shikaku_teate: 15000, kotei: 0, tokutei_shogu: 17000, kaigo_rate: 0, shien_rate: 0 }],
  units: [], rates: [], monthlyExtras: overtime_pay ? [{ staff_name: "X", service_month: "2026-06-01", overtime_pay }] : [],
});
const without = calcSalary([], "X", "2026-06-01", cfg()), withOt = calcSalary([], "X", "2026-06-01", cfg(b.exceedAmount));
ok(withOt.overtime === b.exceedAmount && withOt.total - without.total === b.exceedAmount, `④ 給与の総支給に足される (+${withOt.total - without.total})`);

// 育児手当 (保育料 × 40% / 幼稚園 × 20% / 上限 20,000)。総括表 ケアマネ の実例: 関谷 貴子 3,840 = 9,600 × 40%
ok(kyotakuChildcareAllowance(9600, 0) === 3840, `⑥ 育児手当 保育料 9,600 → 3,840 (計算 ${kyotakuChildcareAllowance(9600, 0)})`);
ok(kyotakuChildcareAllowance(0, 10000) === 2000, `⑥ 幼稚園 10,000 → 2,000 (計算 ${kyotakuChildcareAllowance(0, 10000)})`);
ok(kyotakuChildcareAllowance(60000, 0) === 20000, `⑥ 上限 20,000 (保育料 60,000 → ${kyotakuChildcareAllowance(60000, 0)})`);
const cc = calcSalary([], "X", "2026-06-01", { ...cfg(), monthlyExtras: [{ staff_name: "X", service_month: "2026-06-01", childcare_fee: 9600 }] });
ok(cc.childcare === 3840 && cc.total - without.total === 3840, `⑥ 給与の総支給に足される (+${cc.total - without.total})`);

console.log(fail ? `\nFAIL ${fail}` : "\nPASS");
process.exit(fail ? 1 : 0);
