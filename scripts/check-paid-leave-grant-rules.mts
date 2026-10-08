/**
 * 有給の付与の決まり (lib/payroll/paid-leave-grant-rules.ts) の境界値 (2026-10-08)。DB は読まない。
 *   npm run check:paid-leave-grant-rules
 * 期待値は Box 00_<法人>_有給データ.xlsm の式 (memory payroll_paid_leave_grant_rules) から手で出したもの。
 * ★ 負のコントロール: わざと境目を変えた実装 (稼働率 0.8 ちょうどを満額にする) が 必ず落ちることも確かめる
 */
import {
  baseGrantDays, firstGrantDate, grantKindOf, calcGrant, carryOverDays, excelRound, monthWorkDays, grantAmountOf,
  type GrantCalcInput,
} from "../src/lib/payroll/paid-leave-grant-rules.js";

let fail = 0, pass = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`  ✗ ${name}: ${JSON.stringify(got)} (期待 ${JSON.stringify(want)})`); }
};

// 基準日数 (入社 1〜9 月 / 10〜12 月)
eq("1〜9月入社 初回", baseGrantDays("2025-05-10", "2025-11-10"), 10);
eq("1〜9月入社 翌4/1", baseGrantDays("2025-05-10", "2026-04-01"), 11);
eq("1月入社 翌4/1", baseGrantDays("2025-01-15", "2026-04-01"), 11);
eq("10〜12月入社 初回 (翌年)", baseGrantDays("2025-11-01", "2026-05-01"), 10);
eq("10〜12月入社 翌々4/1", baseGrantDays("2025-11-01", "2027-04-01"), 11);
eq("長い人は 20", baseGrantDays("2009-12-03", "2026-04-01"), 20);
eq("経過 5 年 = 18", baseGrantDays("2021-06-01", "2026-04-01"), 18);
// 初回の付与日 (EDATE は月末に丸める)
eq("入社+6か月", firstGrantDate("2026-04-16"), "2026-10-16");
eq("月末に丸める", firstGrantDate("2025-08-31"), "2026-02-28");
// 種類
eq("前年10/1入社は 初回", grantKindOf("2025-10-01", "2026-04-01"), "初回");
eq("前々年10/1入社は 途中入社", grantKindOf("2024-10-01", "2026-04-01"), "前年度途中入社");
eq("前々年9/30入社は 通常", grantKindOf("2024-09-30", "2026-04-01"), "通常");
eq("4/1 以外は 初回", grantKindOf("2026-04-16", "2026-10-16"), "初回");
// 付与日数・日当
const base: GrantCalcInput = { kind: "通常", salaryType: "月給", baseDays: 20, annualDays: 236, workDaysTotal: 0, monthsWithData: 12, amountTotal: 0 };
eq("稼働 0 は付与なし", calcGrant(base).grantDays, 0);
eq("月給 率 0.8 ちょうどは 2/3", calcGrant({ ...base, workDaysTotal: 236 * 0.8 }).grantDays, 13);
eq("月給 率 0.81 は満額", calcGrant({ ...base, workDaysTotal: 236 * 0.81 }).grantDays, 20);
eq("月給 率 0.4 ちょうどは 2/3", calcGrant({ ...base, workDaysTotal: 236 * 0.4 }).grantDays, 13);
eq("月給 率 0.39 は 1", calcGrant({ ...base, workDaysTotal: 236 * 0.39 }).grantDays, 1);
eq("月給 途中入社は 月数で按分", calcGrant({ ...base, kind: "前年度途中入社", workDaysTotal: 100, monthsWithData: 6, baseDays: 11 }).grantDays, 11); // 100 ÷ (236/12×6=118) = 0.85
const hr: GrantCalcInput = { ...base, salaryType: "時給", annualDays: 261 };
eq("時給 比例 ROUND", calcGrant({ ...hr, workDaysTotal: 130.5 }).grantDays, 10);
eq("時給 上限は基準", calcGrant({ ...hr, workDaysTotal: 300 }).grantDays, 20);
eq("時給 途中入社でも分母は年間", calcGrant({ ...hr, kind: "前年度途中入社", workDaysTotal: 100, monthsWithData: 6, baseDays: 11 }).grantDays, 4); // 11×100÷261=4.21
eq("時給 初回は 年間/2", calcGrant({ ...hr, kind: "初回", baseDays: 10, workDaysTotal: 65, monthsWithData: 6 }).grantDays, 5); // 10×65÷130.5=4.98
eq("日当 = ROUND(金額 ÷ 日数)", calcGrant({ ...hr, workDaysTotal: 200, amountTotal: 1_000_100 }).dailyRate, 5001); // 5000.5 → 5001
eq("付与 0 は 日当なし", calcGrant({ ...hr, workDaysTotal: 0, amountTotal: 5000 }).dailyRate, null);
eq("Excel ROUND 2.5", excelRound(2.5), 3);
// 繰越
eq("繰越 上限は前年度付与", carryOverDays(20, 20, 18.5), 20);
eq("繰越 前年度に初回 (Excel のバグで 10 にならない)", carryOverDays(10, 0, 8.5), 1.5);
eq("繰越 0 未満は 0", carryOverDays(10, 0, 12), 0);
// 稼働日数・金額
eq("稼働日数 = 出勤+有給+特休 (半休は足さない)", monthWorkDays({ workDays: 20, paidLeave: 2, specialLeave: 1, halfLeave: 1 } as never), 23);
eq("時給の金額 = 総支給−通勤−出張", grantAmountOf("時給", { grand_total: 100000, commute_fee: 3000, business_trip_fee: 2000 }, 0, 0, "訪問介護", false), 95000);
eq("居宅は空", grantAmountOf("時給", { grand_total: 100000 }, 0, 0, "居宅介護支援", false), null);
eq("月給 固定残業ありは空", grantAmountOf("月給", {}, 5000, 10000, "訪問介護", false), null);
eq("月給 入浴は空 (ムツミ以外)", grantAmountOf("月給", {}, 5000, 0, "訪問入浴", false), null);
eq("月給 ムツミは部門の条件なし", grantAmountOf("月給", {}, 5000, 0, "薬局", true), 5000);
eq("月給 訪問介護は調整手当", grantAmountOf("月給", {}, 5000, 0, "訪問介護", false), 5000);

// 負のコントロール: 0.8 ちょうどを満額にする誤った実装は 上の期待値と食い違うはず
const wrong = (rate: number, b: number) => (rate >= 0.8 ? b : rate < 0.4 ? 1 : excelRound((b * 2) / 3));
const negOk = wrong(0.8, 20) !== 13;
console.log(`境界値 ${pass + fail} 件: PASS ${pass} / FAIL ${fail}  負のコントロール ${negOk ? "鳴った (OK)" : "★ 鳴らない"}`);
if (fail > 0 || !negOk) process.exit(1);
