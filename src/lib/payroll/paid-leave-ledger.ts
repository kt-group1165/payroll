/**
 * 有給管理簿 (有給管理 画面) の計算。純関数だけ (2026-10-08)。
 *
 * Box 03_有給/<法人>/<年度>/<事業所>.xlsm の「有給管理簿」シートと同じ列を出す:
 *   付与日 / 消化期限 (付与日から 1 年。年 5 日の取得義務の期限) / 年 5 日の義務と残り /
 *   有給日数 (前年度繰越 + 今年度付与) / 消化日数 / 残日数 / 前年度 (繰越の残・日当) / 今年度 (付与の残・日当) /
 *   4 月〜3 月の使用日数
 * 使った日は 繰越 (前年度) から先に減らす (給与計算の日当の決め方 paidLeaveAllowanceByGrant と同じ順)。
 */

/** 年度 (4 月始まり)。'2026-07-15' → 2026 / '2027-02-01' → 2026 */
export function fiscalYearOf(date: string): number {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  return m >= 4 ? y : y - 1;
}

/** 年度の 12 か月 ('YYYYMM'、4 月〜3 月) */
export function fiscalMonths(fy: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < 12; i++) {
    const ym = fy * 12 + 3 + i; // 4 月 = index 3
    out.push(`${Math.floor(ym / 12)}${String((ym % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

/** 'YYYY-MM-DD' に n か月足して 1 日引いた日 (付与日 2026-04-01 → 2027-03-31) */
export function addMonthsMinusOneDay(date: string, months: number): string {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)), d = Number(date.slice(8, 10));
  const t = new Date(Date.UTC(y, m - 1 + months, d));
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

/** 付与日から 1 年の 12 か月 ('YYYYMM') = 消化日数を数える月 */
export function grantYearMonths(grantDate: string): string[] {
  const base = Number(grantDate.slice(0, 4)) * 12 + Number(grantDate.slice(5, 7)) - 1;
  return Array.from({ length: 12 }, (_, i) => {
    const ym = base + i;
    return `${Math.floor(ym / 12)}${String((ym % 12) + 1).padStart(2, "0")}`;
  });
}

/**
 * 年 5 日の取得義務の日数。付与日数が 10 日以上の人だけ 5 日 (労基法 39 条 7 項)。
 * ★ 付与日数が分からない (grant_days 空) ときは null = 判定できない
 */
export function obligationDays(grantDays: number | null | undefined): number | null {
  if (grantDays == null) return null;
  return grantDays >= 10 ? 5 : 0;
}

/** 使った日数を 繰越 → 今年度付与 の順に減らした残り */
export function allocatePaidLeave(carryDays: number, grantDays: number, used: number): {
  carryLeft: number; grantLeft: number; remaining: number; over: number;
} {
  const fromCarry = Math.min(used, carryDays);
  const fromGrant = Math.min(used - fromCarry, grantDays);
  const over = Math.max(0, used - fromCarry - fromGrant);
  const carryLeft = carryDays - fromCarry, grantLeft = grantDays - fromGrant;
  return { carryLeft, grantLeft, remaining: carryLeft + grantLeft, over };
}

/** 0.5 刻みの日数の表示 ("1" / "0.5" / "2.5") */
export function fmtDays(n: number): string {
  return String(Math.round(n * 2) / 2);
}
