// 残業設定 (payroll_overtime_settings) の履歴を 対象月の値に解決する。2026-10-06
//
// 表は (job_type, effective_from) で一意 (migrations/payroll_unit_price_history.sql)。
// 対象月で有効な行 = effective_from <= 対象月の 1 日 の中で最新 (事業所の単価・給与設定と同じ規約)。
//
// ⚠ 2026-10-06 まで 画面の保存が 1970-01-01 の行を その場で UPDATE していた (= 過去の月の残業単価まで変わる)。
//   読む側も job_type だけで Map にしていたので、行が 2 つ以上になると どちらを使うか不定だった。
//   → 書く側は 改定月の行を足す、読む側は ここで月を指定して解決する。

/** job_type ごとに 対象月で有効な行を選ぶ */
export function buildActiveOvertimeMap<T extends { job_type: string; effective_from?: string | null }>(
  rows: T[],
  monthStart: string,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const r of rows) {
    const eff = r.effective_from ?? "1970-01-01";
    if (eff > monthStart) continue;
    const cur = map.get(r.job_type);
    if (!cur || eff > (cur.effective_from ?? "1970-01-01")) map.set(r.job_type, r);
  }
  return map;
}

/** 1 つの job_type だけ欲しいとき */
export function activeOvertimeRow<T extends { job_type: string; effective_from?: string | null }>(
  rows: T[],
  jobType: string,
  monthStart: string,
): T | null {
  return buildActiveOvertimeMap(rows.filter((r) => r.job_type === jobType), monthStart).get(jobType) ?? null;
}
