// kyotaku-salary-history.ts
// 居宅介護支援ケアマネ給与設定 (履歴付) 用 helper。
//
// DB: payroll_kyotaku_salary (effective_from を持つ append-only 履歴 table)
// migration: apps/payroll-app/migrations/payroll_salary_history.sql
//
// reader は 月文字列 (YYYY-MM-01) を渡し、その時点で active な row (=
// effective_from <= 月 のうち最新) を取り出す。pure function なので test 容易。

/** payroll_kyotaku_salary row。
 * NULL を持たない (INT NOT NULL DEFAULT 0) ので number で固定。 */
export type KyotakuSalary = {
  id: string;
  tenant_id: string;
  employee_id: string;
  /** YYYY-MM-DD (DB DATE)。初期 backfill row は '1970-01-01' */
  effective_from: string;
  honnin_kyu: number;
  shokuno_kyu: number;
  kotei_zangyo: number;
  shikaku_teate: number;
  kotei: number;
  tokutei_shogu: number;
  /** 要介護単価 (円/件) */
  kaigo_rate: number;
  /** 要支援単価 (円/件) */
  shien_rate: number;
  /** プラン手当の支給サイクル (default 'monthly')。
   *  - 'monthly': 毎月支給 (既存挙動)
   *  - 'semi_annual': 1-6月分を9月、7-12月分を翌3月にまとめて支給
   *  DB migration `payroll_kyotaku_plan_cycle.sql` 適用前は undefined になり得るので
   *  reader は `?? 'monthly'` で fallback する。 */
  plan_payment_cycle?: "monthly" | "semi_annual";
};

/**
 * 指定 employee の rows から、対象月 (monthStart) で active な row を返す。
 *
 * - active = effective_from <= monthStart の中で effective_from 最新の row
 * - 該当無し (= 全 row が monthStart より未来) は null
 * - rows は呼び出し側で employee 越境を含んでも良い (内部で filter する)
 *
 * monthStart 形式: YYYY-MM-DD (通常は YYYY-MM-01)。
 *   - effective_from と文字列比較で大小判定可能 (YYYY-MM-DD は lexicographic で
 *     ordering と一致)。
 *
 * 純関数 / 副作用なし。
 */
export function getActiveKyotakuSalary(
  rows: KyotakuSalary[],
  employeeId: string,
  monthStart: string,
): KyotakuSalary | null {
  let best: KyotakuSalary | null = null;
  for (const r of rows) {
    if (r.employee_id !== employeeId) continue;
    if (r.effective_from > monthStart) continue;
    if (best === null || r.effective_from > best.effective_from) {
      best = r;
    }
  }
  return best;
}
