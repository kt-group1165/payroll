/**
 * 給与計算 サンプルの検証 — DB → 集計 → 残業代 の経路を通す
 *
 *   npx tsx scripts/payroll-sample-check.mts
 *
 * ⚠ 期待値は **手計算で独立に導出**したもの (3-2)。
 * ⚠ 画面が使うのと **同じ関数** (calcMonthlySummary / calcOvertimePayBreakdown) を呼ぶ。
 *
 * サンプル未投入なら **分母 0 と明記してスキップ** (0 件を合格と言わない)。
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { calcMonthlySummary, type AttendanceRecord } from "@/lib/payroll/attendance-calc";
import { calcOvertimePayBreakdown } from "@/lib/payroll/overtime-pay-calc";

const env: Record<string, string> = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log("⚠ SUPABASE_SERVICE_ROLE_KEY が無いのでスキップ (anon だと RLS で 0 行になり誤判定する)");
  process.exit(0);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const MONTH = "2026-12";
const HOURLY = 2000;          // 本人給10万 + 職能給22万 = 32万 / 所定160h
const SALARY = {
  base_personal_salary: 100000, skill_salary: 220000, position_allowance: 0,
  qualification_allowance: 0, tenure_allowance: 0, treatment_improvement: 0,
  specific_treatment_improvement: 0, treatment_subsidy: 0,
  fixed_overtime_pay: 0, special_bonus: 0,
};
const OT_SETTING = {
  scheduled_hours_per_month: 160,
  include_base_personal_salary: true, include_skill_salary: true,
  include_position_allowance: false, include_qualification_allowance: false,
  include_tenure_allowance: false, include_treatment_improvement: false,
  include_specific_treatment: false, include_treatment_subsidy: false,
  include_fixed_overtime_pay: false, include_special_bonus: false,
};

let ng = 0, n = 0;
const eq = (label: string, a: unknown, b: unknown) => {
  n++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) ng++;
  console.log(`    ${ok ? "OK " : "NG "} ${label.padEnd(38)} 実際=${JSON.stringify(a)} 期待=${JSON.stringify(b)}`);
};

const { data: emps, error: ee } = await sb.from("payroll_employees")
  .select("id, employee_number, name").like("employee_number", "ZP%").order("employee_number");
if (ee) throw new Error(`payroll_employees: ${ee.message}`);
console.log(`【分母】サンプル職員 ${(emps ?? []).length} 名`);
if (!emps?.length) {
  console.log("⚠ 分母 0 — サンプル未投入。**合格とは言わない**");
  console.log("   node migrations/seed_sample_payroll_c.mjs --execute (kaigo-app 側) で投入");
  process.exit(0);
}
const { data: recs, error: re } = await sb.from("payroll_kyotaku_attendance_records")
  .select("employee_id, work_date, start_time, end_time, break_minutes, is_legal_holiday, paid_leave_type, substitute_for_date")
  .in("employee_id", emps.map((e) => e.id)).order("work_date");
if (re) throw new Error(`attendance: ${re.message}`);
console.log(`【分母】出勤簿 ${(recs ?? []).length} 行\n`);

const toRec = (r: Record<string, unknown>): AttendanceRecord => ({
  work_date: String(r.work_date),
  start_time: r.start_time ? String(r.start_time).slice(0, 5) : null,
  end_time: r.end_time ? String(r.end_time).slice(0, 5) : null,
  break_minutes: Number(r.break_minutes ?? 0),
  is_legal_holiday: !!r.is_legal_holiday,
  paid_leave_type: (r.paid_leave_type ?? null) as "full" | "half" | null,
  substitute_for_date: r.substitute_for_date ? String(r.substitute_for_date) : null,
});

const byEmp = new Map<string, AttendanceRecord[]>();
for (const r of recs ?? []) {
  const k = String(r.employee_id);
  if (!byEmp.has(k)) byEmp.set(k, []);
  byEmp.get(k)!.push(toRec(r as Record<string, unknown>));
}

const results: Record<string, { sum: ReturnType<typeof calcMonthlySummary>; ot: ReturnType<typeof calcOvertimePayBreakdown> }> = {};
for (const e of emps) {
  const list = byEmp.get(e.id) ?? [];
  // 週起算 0 (日曜)。monthFilter で 2026-12 のぶんだけ積む (月またぎ週の按分は全体で計算される)
  const sum = calcMonthlySummary(list, 0, MONTH);
  const ot = calcOvertimePayBreakdown(sum, SALARY, OT_SETTING);
  results[e.employee_number] = { sum, ot };
}

const show = (no: string, title: string) => {
  const r = results[no];
  console.log(`\n  ── ${no} ${title} ──`);
  console.log(`     実労働 ${r.sum.total_work} 分 / 日次残業 ${r.sum.total_daily_overtime} / 週次残業 ${r.sum.total_weekly_overtime}`);
  console.log(`     深夜 ${r.sum.total_midnight} / 法定休日 ${r.sum.total_holiday} / 欠勤 ${r.sum.total_absence} / 有給 ${r.sum.total_paid_leave_days} 日`);
  console.log(`     時給 ${r.ot.hourlyRate} / 通常OT ${r.ot.regularOvertimePay} / 60h超OT ${r.ot.over60OvertimePay} / 深夜 ${r.ot.midnightExtraPay} / 法休 ${r.ot.holidayPay}`);
  console.log(`     残業代 合計 ${r.ot.totalOvertimePay} / 固定残業代 ${r.ot.fixedOvertimePay} / 超過額 ${r.ot.exceedAmount}`);
  return r;
};

console.log("══ ① 月 60h の境界 ══");
{
  // ⚠ **最初の期待値は誤っていた。**「12h×15 日 = 日次残業 3,600 分」と置いたが、
  //   15 日連続勤務なので **7 日揃った週の最終日が法定休日労働に自動判定**され、
  //   その 1 日 (12h) が daily_overtime から holiday_work へ移る。
  //   実装が正しく、私の設計が「法定休日の自動判定」を考えていなかった (3-9)。
  //   → 日次 4h×14 = 3,360 分 / 法定休日 720 分 (12/12 土) / 週次 480 分
  //   60h の判定は **日次 + 週次** の合算なので 3,360 + 480 = 3,840 分 > 3,600。
  const a = show("ZP01", "12h×15日 連続 (法定休日が自動で付く)");
  eq("日次残業 (法休に移った 1 日を除く)", a.sum.total_daily_overtime, 4 * 60 * 14);
  eq("★ 法定休日 = 12h × 1 日 (7日揃った週の最終日)", a.sum.total_holiday, 12 * 60);
  eq("週次残業", a.sum.total_weekly_overtime, 480);
  eq("通常OT = 60h × 2,000 × 1.25 で頭打ち", a.ot.regularOvertimePay, 60 * HOURLY * 1.25);
  const excessA = a.sum.total_daily_overtime + a.sum.total_weekly_overtime - 3600;
  eq("★ 60h 超 = (日次+週次) − 3,600 分 を 1.5 倍", a.ot.over60OvertimePay, Math.round((excessA / 60) * HOURLY * 1.5));
  // ⚠ 12 * 2000 * 1.35 は JS の浮動小数で **32400.000000000004** になる。
  //   実装は round しており正しい。期待値の書き方のほうが誤っていた。
  eq("法定休日手当 = 12h × 2,000 × 1.35 (round)", a.ot.holidayPay, Math.round(12 * HOURLY * 1.35));

  const b = show("ZP02", "同じ + 1 分");
  eq("日次残業 = ZP01 + 1 分", b.sum.total_daily_overtime, a.sum.total_daily_overtime + 1);
  eq("★ 通常OT は 60h ぶんで頭打ち (変わらない)", b.ot.regularOvertimePay, 60 * HOURLY * 1.25);
  const excessB = b.sum.total_daily_overtime + b.sum.total_weekly_overtime - 3600;
  eq("★ 1 分ぶんだけ 60h超 が増える", b.ot.over60OvertimePay - a.ot.over60OvertimePay,
    Math.round((excessB / 60) * HOURLY * 1.5) - Math.round((excessA / 60) * HOURLY * 1.5));
  eq("★ 増分は 1 分 × 2,000 × 1.5 = 50 円", b.ot.over60OvertimePay - a.ot.over60OvertimePay, 50);
}

console.log("\n══ ② 深夜 (0 時またぎ) ══");
{
  const c = show("ZP03", "22:00-06:00 ×4 日");
  eq("実労働 = 8h × 4 日", c.sum.total_work, 8 * 60 * 4);
  eq("★ 深夜 = 22:00-05:00 の 7h × 4 日", c.sum.total_midnight, 7 * 60 * 4);
  eq("深夜割増 = 28h × 2,000 × 0.25", c.ot.midnightExtraPay, 28 * HOURLY * 0.25);
  eq("日次残業 (8h ちょうどなので 0)", c.sum.total_daily_overtime, 0);
}

console.log("\n══ ③ ★ 欠勤 — 控除額が動くか ══");
{
  const e = show("ZP04", "平日 5 日を 4h だけ勤務 (所定 8h)");
  eq("実労働 = 4h × 5 日", e.sum.total_work, 4 * 60 * 5);
  eq("★ 欠勤 = 4h × 5 日 = 1,200 分", e.sum.total_absence, 4 * 60 * 5);
  eq("残業は無い", e.ot.totalOvertimePay, 0);
  console.log(`     ★ **欠勤 ${e.sum.total_absence} 分が集計されている。**`);
  console.log(`        しかし payroll/page.tsx の monthlyGrandTotal は`);
  console.log(`        fixedTotal + 賞与 + 交通費 + 通勤費 + 出張費 + 育児 + 介護残業 + 夜長 + 残業超過`);
  console.log(`        で構成され、**欠勤の項が 1 つも無い** (grep 実測)。`);
  console.log(`        → **控除額は動かない。警告すらしない (労務チェック一覧に載るだけ)。**`);
}

console.log("\n══ ④ 月またぎ週 + 法定休日 ══");
{
  const f = show("ZP05", "11/30(月) 〜 12/6(日) の 7 日連続勤務");
  console.log(`     ⚠ monthFilter=2026-12 なので 11/30 は集計に含まれないが、`);
  console.log(`        週次残業の按分は 11/30 を含む週全体で計算される`);
  // ⚠ 週起算は **日曜**。11/30(月)〜12/6(日) は 11/29(日) を含む週と 12/6 の週にまたがり、
  //   11/29 は勤務していないので「7 日揃った週」にならない → 法定休日は付かない。**正しい**。
  eq("★ 月またぎ週では法定休日が付かない (11/29 が未勤務)", f.sum.total_holiday, 0);
  eq("週次残業が月またぎ週で按分されている", f.sum.total_weekly_overtime, 480);
}

console.log("\n══ ⑤ 異常系 (純関数) ══");
{
  const empty = calcMonthlySummary([], 0, MONTH);
  eq("記録 0 件の月次サマリ", empty.total_work, 0);
  const zeroHours = calcOvertimePayBreakdown(
    { total_work: 600, total_daily_overtime: 600, total_weekly_overtime: 0, total_midnight: 0, total_holiday: 0, total_absence: 0, total_paid_leave_days: 0 },
    SALARY, { ...OT_SETTING, scheduled_hours_per_month: 0 });
  eq("★ 所定 0h (0 除算) → 残業代 0", zeroHours.totalOvertimePay, 0);
  const nullSalary = calcOvertimePayBreakdown(
    { total_work: 600, total_daily_overtime: 600, total_weekly_overtime: 0, total_midnight: 0, total_holiday: 0, total_absence: 0, total_paid_leave_days: 0 },
    null, OT_SETTING);
  eq("★ 給与設定なし → 残業代 0", nullSalary.totalOvertimePay, 0);
}

console.log(`\n══ 検査 ${n} 件 / NG ${ng} 件 ══`);
// ⚠ 2026-09-05 是正: ng を数えるだけで exit code に反映していなかった (billing-issue-check.mts と同じ穴)。
process.exitCode = ng > 0 ? 1 : 0;
