/**
 * 総括表 (① / ②) と 当方の 項目の対応 — scripts 共通 (2026-09-27 給与C が切り出し)。
 *
 * 元は check:soukatsu-item-gap (時給) / check:soukatsu-item-gap-monthly (月給) の中にあった定義 (給与D 作)。
 * check:soukatsu-cause が「その他」を項目で分けるのに同じ対応を使うため 逐語コピーせずに共通にした
 * (★ 逐語コピーは片方だけ直したときに乖離する)。★ 切り出しは挙動を変えていない:
 * 切り出しの前後で 2 本の出力が 1 文字も変わらないことを確かめた。
 *
 * ⚠ 時給と月給で「当方の項目」の作り方は別物。名前を分けてある (hourly* / monthly*)。
 * ⚠ 月給の「残業」は 項目ではなく 総支給 − 他の項目 の残差。
 */
import {
  hourlyTenure, weekendHolidayAllowanceAmount, weekendAllowanceMinutes,
  fixedTotal, travelFeeAmount, commuteFeeAmount, careOvertimePay, yochoAllowance, monthlyPaidLeaveAllowance, absenceDeduction,
  type HourlyPayroll, type MonthlyPayroll,
} from "../src/lib/payroll/payroll-calc.js";

export type Items = Record<string, number>;

/** ①② の数値。"10,000" のようなカンマ付き文字列も数値に直す。それ以外の文字列 ("1:00" 等) は 0 */
export const num = (v: unknown) => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?[\d,]+(\.\d+)?$/.test(v.trim())) return Number(v.replace(/,/g, ""));
  return 0;
};

/** ② の値。★ 同じ項目の列名が事業所で違うので 候補の列を見て 足さずに絶対値の最大を取る (残業総額 と 残業総額2 に同じ値が入っている行がある) */
export const l2Pick = (d: Record<string, unknown>, cols: readonly string[]): number => Math.max(0, ...cols.map((c) => Math.abs(num(d[c]))));

// ─────────────────────────────── 時給 (パート) ───────────────────────────────
export const HOURLY_ITEMS = ["本人給系", "初任者", "研修会議", "勤続", "処遇改善", "移動", "通信", "残業", "育児", "通勤", "出張"] as const;
export const HOURLY_NO_L1_COLUMN = ["有給", "事務"] as const;
export function hourlyItems(es: (HourlyPayroll & { grand_total?: number })[]): Items {
  const o: Items = {};
  const add = (k: string, v: number) => { o[k] = (o[k] ?? 0) + (v || 0); };
  for (const e of es) {
    add("本人給系", e.totalPay + weekendHolidayAllowanceAmount(weekendAllowanceMinutes(e), e.weekend_holiday_rate) + e.cancel_allowance + (e.tokubi_allowance ?? 0));
    add("初任者", e.shoninsha_pay ?? 0);
    add("研修会議", e.training_pay - (e.shoninsha_pay ?? 0) + e.meeting_fee);
    add("勤続", hourlyTenure(e)); add("処遇改善", e.treatment_subsidy); add("移動", e.travel_allowance);
    add("通信", e.communication_fee); add("残業", (e.overtime_pay ?? 0) + (e.legal_holiday_pay ?? 0));
    add("育児", e.childcare_allowance); add("通勤", e.commute_fee); add("出張", e.business_trip_fee);
    add("有給", e.paid_leave_allowance); add("事務", e.office_work_pay);
  }
  return o;
}
export const l1HourlyItems = (d: Record<string, unknown>): Items => ({
  本人給系: num(d["集計項目小計"]) + num(d["土日祝"]) + num(d["キャンセル手当（金額）"]) + num(d["特日"]),
  初任者: num(d["初任者研修費"]) + num(d["初任者調整費"]),
  研修会議: num(d["その他手当計"]), 勤続: num(d["勤続手当（パート）"]),
  処遇改善: num(d["ベースアップ加算手当"]) + num(d["処遇改善"]), 移動: num(d["移動手当"]), 通信: num(d["通信手当"]),
  残業: num(d["残業手当総額_パート"]), 育児: num(d["育児手当"]), 通勤: num(d["通勤費"]), 出張: num(d["出張費"]),
});

// ─────────────────────────────── 月給 (提責・社員・事務員) ───────────────────────────────
export const MONTHLY_ITEMS = ["本人給", "職能給", "役職", "資格", "勤続", "固定残業", "処遇改善", "特定処遇改善", "ベースアップ", "出張", "通勤", "育児", "介護超過", "夜朝深夜", "特日", "欠勤控除", "残業"] as const;
export const MONTHLY_NO_L1_COLUMN = ["有給", "泊まり", "報奨金"] as const;
export function monthlyItems(es: MonthlyPayroll[]): Items {
  const o: Items = {};
  const add = (k: string, v: number) => { o[k] = (o[k] ?? 0) + (v || 0); };
  for (const p of es) {
    const s = p.settings;
    if (!s) continue;
    add("本人給", s.base_personal_salary); add("職能給", s.skill_salary); add("役職", s.position_allowance); add("資格", s.qualification_allowance);
    add("勤続", s.tenure_allowance); add("固定残業", s.fixed_overtime_pay); add("処遇改善", s.treatment_improvement);
    add("特定処遇改善", s.specific_treatment_improvement); add("ベースアップ", s.treatment_subsidy);
    add("出張", travelFeeAmount(p) + p.business_trip_fee); add("通勤", commuteFeeAmount(p)); add("育児", p.childcare_allowance);
    // 事務員の介護分は ② の「介護」列に入る (熊谷 1272404508|260402|202608 ¥40,852)
    add("介護超過", careOvertimePay(p) + (p.office_worker_care_pay ?? 0)); add("夜朝深夜", yochoAllowance(p)); add("特日", p.tokubi_allowance ?? 0);
    add("欠勤控除", absenceDeduction(p));
    add("有給", monthlyPaidLeaveAllowance(p)); add("泊まり", p.overnight_allowance ?? 0);
    add("報奨金", (p.bonus_paid ? s.bonus_amount : 0) + s.special_bonus);
    // 超過残業は 総支給から他の項目を引いた残り (overtimeExcessPay は残業設定の表が要るので 保存された総支給から逆算する)
    const others = fixedTotal(s) + (p.bonus_paid ? s.bonus_amount : 0) + travelFeeAmount(p) + commuteFeeAmount(p) + p.business_trip_fee
      + (p.overnight_allowance ?? 0) + p.childcare_allowance + careOvertimePay(p) + yochoAllowance(p) + monthlyPaidLeaveAllowance(p)
      + (p.tokubi_allowance ?? 0) + (p.office_worker_care_pay ?? 0) - absenceDeduction(p) + (p.adjustment ?? 0);
    add("残業", Number((p as MonthlyPayroll & { grand_total?: number }).grand_total ?? 0) - others);
  }
  return o;
}
export const l1MonthlyItems = (d: Record<string, unknown>): Items => ({
  本人給: num(d["本人給"]), 職能給: num(d["職能給"]), 役職: num(d["役職手当"]), 資格: num(d["資格手当"]), 勤続: num(d["勤続手当"]),
  固定残業: num(d["固定残業手当"]), 処遇改善: num(d["処遇改善"]), 特定処遇改善: num(d["特定処遇改善"]), ベースアップ: num(d["ベースアップ加算手当"]),
  出張: num(d["出張費"]), 通勤: num(d["通勤費"]), 育児: num(d["育児手当"]), 介護超過: num(d["介護超過"]), 夜朝深夜: num(d["夜朝"]) + num(d["深夜_3"]),
  特日: num(d["特日"]), 欠勤控除: Math.abs(num(d["欠勤控除"])),
  残業: Math.max(0, num(d["残業手当総額"]) - num(d["固定残業手当"])),
});
/** 当方の項目 → ② (支払用) の列。★ 同じ項目の列名が事業所で違う (特定処遇改善 は 4 通り。2026-09-27 に 1 つ落として 1199 を誤って「② は 0」と出した) */
export const L2_MONTHLY_COLS: Record<string, string[]> = {
  本人給: ["本人給"], 職能給: ["職能給"], 役職: ["役職手当"], 資格: ["資格手当"], 勤続: ["勤続手当"], 固定残業: ["固定残業代"],
  処遇改善: ["処遇改善手当"], 特定処遇改善: ["特別処遇改善手当", "特定処遇改善手当", "特別処遇改善", "特定処遇改善"], ベースアップ: ["処遇改善補助金手当"],
  出張: ["出張費"], 通勤: ["通勤費"], 育児: ["育児手当"], 介護超過: ["介護"], 夜朝深夜: ["・夜朝・深夜"], 特日: ["・特日"],
  欠勤控除: ["欠勤控除"], 残業: ["残業総額", "残業総額2"],
};
