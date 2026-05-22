// kyotaku-plan-accumulator.ts
// 居宅介護支援ケアマネ プラン手当 半期締め支給 (semi_annual) の helper。
//
// 仕様:
//   - 1〜6 月分の差額を 9 月に一括支給 → period_start='YYYY-01' / period_end='YYYY-06' / payout='YYYY-09'
//   - 7〜12 月分の差額を 翌 3 月に一括支給 → period_start='YYYY-07' / period_end='YYYY-12' / payout='(Y+1)-03'
//   - その他の月は ¥0 出力、内部的に積立額に加算 (確定時のみ)
//
// 純関数のみ / 副作用なし / test 容易な形。

export type PlanCyclePeriod = {
  /** 'YYYY-MM' 形式 (例: '2026-01' or '2026-07') */
  period_start: string;
  /** 'YYYY-MM' 形式 (例: '2026-06' or '2026-12') */
  period_end: string;
  /** 'YYYY-MM' 形式 (例: '2026-09' or '2027-03') */
  payout_month: string;
};

function splitYM(monthStart: string): { y: number; m: number } | null {
  // YYYY-MM-DD or YYYY-MM 形式に対応
  const m = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(monthStart);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isFinite(y) || !Number.isFinite(mo)) return null;
  if (mo < 1 || mo > 12) return null;
  return { y, m: mo };
}

function fmtYM(y: number, m: number): string {
  return `${y}-${String(m).padStart(2, "0")}`;
}

/**
 * 指定の月が属する半期 (period_start / period_end / payout_month) を返す。
 *
 * - 1〜6 月 (= 同 year 上半期) → period [Y-01, Y-06], payout Y-09
 * - 7〜12 月 (= 同 year 下半期) → period [Y-07, Y-12], payout (Y+1)-03
 *
 * monthStart 形式: 'YYYY-MM-DD' (通常 YYYY-MM-01) or 'YYYY-MM'。
 * パースに失敗したら null は返さず例外を投げる (caller の責任で正しい形式を渡す)。
 */
export function getPlanCyclePeriod(monthStart: string): PlanCyclePeriod {
  const split = splitYM(monthStart);
  if (!split) {
    throw new Error(`invalid month: ${monthStart}`);
  }
  const { y, m } = split;
  if (m >= 1 && m <= 6) {
    return {
      period_start: fmtYM(y, 1),
      period_end: fmtYM(y, 6),
      payout_month: fmtYM(y, 9),
    };
  }
  // 7-12
  return {
    period_start: fmtYM(y, 7),
    period_end: fmtYM(y, 12),
    payout_month: fmtYM(y + 1, 3),
  };
}

/**
 * 指定月が「半期締めの支給月」(= 9 月 or 3 月) か。
 *
 * monthStart 形式: 'YYYY-MM-DD' or 'YYYY-MM'。
 * パース失敗時は false (= 支給月ではない) を返す。
 */
export function isPlanPayoutMonth(monthStart: string): boolean {
  const split = splitYM(monthStart);
  if (!split) return false;
  return split.m === 3 || split.m === 9;
}
