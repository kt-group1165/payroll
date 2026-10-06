// サービスコード → 類型 の対応 (payroll_service_type_mappings) を 対象月の値に解決する。2026-10-06
//
// 表は (service_code, effective_from) で一意 (migrations/payroll_settings_history_all.sql)。
// 対象月で有効な行 = effective_from <= 対象月の 1 日 の中で最新 (単価・給与設定と同じ規約)。
// ★ 以前は service_code だけで一意で、類型を付け替えると 過去の月の時給の区分まで変わった。

export type MappingRow = { service_code: string; category_id: string; effective_from?: string | null };

const eff = (r: { effective_from?: string | null }) => r.effective_from ?? "1970-01-01";

/** service_code ごとに 対象月で有効な行 */
export function buildActiveMappingRows<T extends MappingRow>(rows: T[], monthStart: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const r of rows) {
    if (eff(r) > monthStart) continue;
    const cur = map.get(r.service_code);
    if (!cur || eff(r) > eff(cur)) map.set(r.service_code, r);
  }
  return map;
}

/** service_code → category_id (給与計算・サービス記録一覧が使う形) */
export function buildActiveMappingMap(rows: MappingRow[], monthStart: string): Map<string, string> {
  return new Map([...buildActiveMappingRows(rows, monthStart)].map(([code, r]) => [code, r.category_id]));
}
