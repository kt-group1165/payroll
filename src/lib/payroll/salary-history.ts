// salary-history.ts
// 給与設定の履歴化 (effective_from 方式) 共通 helper
//
// 設計方針:
//   - payroll_salary_settings は append-only。employee_id × effective_from で
//     一意。編集時は UPDATE せず新 row INSERT する。
//   - 対象月で active な行 = effective_from <= 対象月 の最新行
//   - 純関数のみ。caller 側で全件 fetch して in-memory で filter する想定
//     (employee_id × effective_from の小さい table のため)
//
// 命名規約:
//   - monthStart: 'YYYY-MM-DD' の DATE 形式文字列。対象月の 1 日を渡す。
//   - rows: 同 employee 外の row が混ざっていても OK (内部で filter)。

/** salary-history.ts が要求する最小限の row shape。具体型は呼出側で拡張可。 */
export type SalaryHistoryRow = {
  employee_id: string;
  effective_from: string; // 'YYYY-MM-DD'
};

/**
 * 対象月で active な給与設定 row を 1 つ返す。
 *
 * - rows は同 employee 外を含んでよい (内部で filter)。
 * - effective_from <= monthStart の中で最新 (DESC) を返す。
 * - 該当無しなら null。
 *
 * @param rows           全件 (or 同 employee の全件) の salary rows
 * @param employeeId     対象 employee の id
 * @param monthStart     'YYYY-MM-DD' 形式。対象月の 1 日を渡す (e.g. '2025-01-01')
 */
export function getActiveSalary<T extends SalaryHistoryRow>(
  rows: T[],
  employeeId: string,
  monthStart: string,
): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (r.employee_id !== employeeId) continue;
    if (r.effective_from > monthStart) continue;
    if (!best || r.effective_from > best.effective_from) best = r;
  }
  return best;
}

/**
 * 全件 rows から「employee_id → 対象月で active な row」の Map を作る。
 * 給与計算 loop で何度も getActiveSalary を呼ぶより 1 pass で済む。
 *
 * 対象月引数が無い (= 現在の最新を引きたい) 場合は monthStart に
 * 十分未来の date (例: '9999-12-31') を渡せばよい。
 */
export function buildActiveSalaryMap<T extends SalaryHistoryRow>(
  rows: T[],
  monthStart: string,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const r of rows) {
    if (r.effective_from > monthStart) continue;
    const cur = map.get(r.employee_id);
    if (!cur || r.effective_from > cur.effective_from) map.set(r.employee_id, r);
  }
  return map;
}

/**
 * 「現在の最新」を引くための便利関数。
 * UI 編集用に「とりあえず一番新しい設定が欲しい」場面で使う。
 * 履歴 row が effective_from = 未来 を持っていてもそれが返ってくる点に注意。
 */
export function getLatestSalary<T extends SalaryHistoryRow>(
  rows: T[],
  employeeId: string,
): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (r.employee_id !== employeeId) continue;
    if (!best || r.effective_from > best.effective_from) best = r;
  }
  return best;
}

/**
 * employee_id ごとの「現在の最新 row」 Map。
 * /salary 一覧で「各人の最新設定」を表示する用途。
 */
export function buildLatestSalaryMap<T extends SalaryHistoryRow>(rows: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const r of rows) {
    const cur = map.get(r.employee_id);
    if (!cur || r.effective_from > cur.effective_from) map.set(r.employee_id, r);
  }
  return map;
}

/**
 * selectedMonth ('YYYYMM') を monthStart ('YYYY-MM-01') に正規化する utility。
 * payroll/page.tsx の selectedMonth (YYYYMM) を helper に渡す前に通す。
 */
export function selectedMonthToMonthStart(selectedMonth: string): string {
  // 期待形式: "YYYYMM"
  const y = selectedMonth.slice(0, 4);
  const m = selectedMonth.slice(4, 6);
  return `${y}-${m}-01`;
}
