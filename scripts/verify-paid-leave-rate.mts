import { paidLeaveAllowanceByGrant, paidLeaveGrantHasZeroRate } from "../src/lib/payroll/payroll-calc";
type G = { grant_date: string; carry_days: number; prev_rate: number | null; cur_rate: number | null };
const g = (carry: number, prev: number | null, cur: number | null): G => ({ grant_date: "2026-04-01", carry_days: carry, prev_rate: prev, cur_rate: cur });
let ng = 0;
const t = (name: string, got: number, want: number) => {
  const ok = got === want;
  if (!ok) ng++;
  console.log(`  ${ok ? "PASS" : "★FAIL"}  ${name}  got=${got} want=${want}`);
};
console.log("=== paidLeaveAllowanceByGrant ===");
// ★ 実害が出た形: 付与の単価が 0、職員マスタに 9,425
t("橋本光代 202605 (carry9 prev0 cur0, master9425, 21日)", paidLeaveAllowanceByGrant(21, 0, g(9, 0, 0), 9425), 197925);
// これまで通り動くべきもの (回帰していないか)
t("付与なし → マスタ単価",                paidLeaveAllowanceByGrant(3, 0, null, 1000), 3000);
t("cur/prev とも null → マスタ単価",       paidLeaveAllowanceByGrant(3, 0, g(0, null, null), 1000), 3000);
t("cur だけあり (繰越0)",                 paidLeaveAllowanceByGrant(3, 0, g(0, null, 2000), 1000), 6000);
t("繰越2日は prev、残り1日は cur",         paidLeaveAllowanceByGrant(3, 0, g(2, 500, 2000), 1000), 3000);
t("繰越を先に2日使い済み → 全部 cur",      paidLeaveAllowanceByGrant(3, 2, g(2, 500, 2000), 1000), 6000);
t("cur が 0・prev は生きている",           paidLeaveAllowanceByGrant(2, 0, g(1, 800, 0), 1000), 1800);
t("prev が 0 → 同じ付与の cur に落ちる (元の ?? cur の意図。マスタには落ちない)", paidLeaveAllowanceByGrant(2, 0, g(1, 0, 2000), 1000), 4000);
t("0日は0円",                             paidLeaveAllowanceByGrant(0, 0, g(9, 0, 0), 9425), 0);
t("マスタも0なら0 (本当にデータが無い)",    paidLeaveAllowanceByGrant(5, 0, g(0, 0, 0), 0), 0);
console.log("\n=== paidLeaveGrantHasZeroRate (警告の判定) ===");
const b = (name: string, got: boolean, want: boolean) => { const ok = got === want; if (!ok) ng++; console.log(`  ${ok ? "PASS" : "★FAIL"}  ${name}  got=${got}`); };
b("cur0 prev0 → 警告",      paidLeaveGrantHasZeroRate(g(9, 0, 0)), true);
b("cur0 のみ → 警告",       paidLeaveGrantHasZeroRate(g(1, 800, 0)), true);
b("両方 null → 警告しない", paidLeaveGrantHasZeroRate(g(0, null, null)), false);
b("正常 → 警告しない",      paidLeaveGrantHasZeroRate(g(1, 800, 2000)), false);
b("付与なし → 警告しない",  paidLeaveGrantHasZeroRate(null), false);
console.log(ng === 0 ? "\n✓ 全部 PASS" : `\n★ ${ng} 件 FAIL`);
process.exit(ng === 0 ? 0 : 1);
