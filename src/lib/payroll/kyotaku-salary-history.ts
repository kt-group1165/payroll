import type { EmployeeSetting } from "./kyotaku-calc";
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
  // 総括表 (ケアマネ) の項目 (2026-10-19。payroll_kyotaku_salary_soukatsu_items.sql)
  care_plan_fixed?: number | null;
  position_allowance?: number | null;
  kinzoku_type?: number | null;
  kinzoku_unit?: number | null;
  kinzoku_care_unit?: number | null;
  guarantee_amount?: number | null;
  guarantee_until?: string | null;
  commute_cap?: number | null;
};

/** 給与設定の行の列 (select に使う)。画面・総括表で同じ列を読むため 1 か所にまとめる (2026-10-19) */
export const KYOTAKU_SALARY_COLUMNS =
  "id, tenant_id, employee_id, effective_from, honnin_kyu, shokuno_kyu, kotei_zangyo, shikaku_teate, kotei, tokutei_shogu, kaigo_rate, shien_rate, plan_payment_cycle, care_plan_fixed, position_allowance, kinzoku_type, kinzoku_unit, kinzoku_care_unit, guarantee_amount, guarantee_until, commute_cap";

/**
 * その月で有効な給与設定の行 → 計算に渡す 1 人ぶんの設定 (EmployeeSetting)。行が無ければ null の設定
 * (resolveSetting の 既定の基本給 250,000 円に落ちる。ケアプラン固定は undefined = 従来どおり)。
 */
export function kyotakuSettingFromSalary(staffName: string, active: KyotakuSalary | null): EmployeeSetting {
  return {
    staff_name: staffName,
    honnin_kyu: active ? active.honnin_kyu : null,
    shokuno_kyu: active ? active.shokuno_kyu : null,
    kotei_zangyo: active ? active.kotei_zangyo : null,
    shikaku_teate: active ? active.shikaku_teate : null,
    kotei: active ? active.kotei : null,
    tokutei_shogu: active ? active.tokutei_shogu : null,
    kaigo_rate: active ? active.kaigo_rate : null,
    shien_rate: active ? active.shien_rate : null,
    ...(active && "care_plan_fixed" in active ? {
      care_plan_fixed: active.care_plan_fixed ?? null,
      position_allowance: active.position_allowance ?? null,
      kinzoku_type: active.kinzoku_type ?? null,
      kinzoku_unit: active.kinzoku_unit ?? null,
      guarantee_amount: active.guarantee_amount ?? null,
      guarantee_until: active.guarantee_until ?? null,
      commute_cap: active.commute_cap ?? null,
    } : {}),
  };
}

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
