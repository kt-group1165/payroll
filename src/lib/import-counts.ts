import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 「取り込み済みデータ」の 月 × 事業所 件数集計。
 *
 * payroll_service_records は 8 万行超あり、全件ページング (82 リクエスト逐次) だと
 * /csv-import の表示が数秒〜タイムアウト級に遅くなるため、GROUP BY を行う
 * RPC (migrations/payroll_import_count_functions_v1.sql) を優先で呼ぶ。
 * RPC 未適用環境では従来の全件ページングへ fallback する (遅いが動く)。
 */

export interface MonthOfficeCount {
  /** YYYYMM */
  month: string;
  office_number: string;
  count: number;
}

/** fallback 用: 全件ページングして (キー関数で) 件数を数える */
async function scanAndCount(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  keyOf: (row: Record<string, unknown>) => string,
): Promise<MonthOfficeCount[]> {
  const countMap = new Map<string, number>();
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .range(from, from + pageSize - 1);
    if (error) {
      console.warn(`[import-counts] ${table} fallback スキャン失敗:`, error.message);
      break;
    }
    if (!data || data.length === 0) break;
    for (const r of data as unknown as Record<string, unknown>[]) {
      const key = keyOf(r);
      countMap.set(key, (countMap.get(key) ?? 0) + 1);
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return [...countMap.entries()].map(([key, count]) => {
    const [month, office_number] = key.split("|");
    return { month, office_number, count };
  });
}

/** payroll_service_records の 月 × 事業所 件数 (新しい月順) */
export async function fetchServiceRecordCounts(
  supabase: SupabaseClient,
): Promise<MonthOfficeCount[]> {
  const { data, error } = await supabase.rpc("payroll_service_record_counts");
  let rows: MonthOfficeCount[];
  if (!error && data) {
    rows = (data as { processing_month: string; office_number: string; count: number }[]).map(
      (r) => ({ month: r.processing_month, office_number: r.office_number, count: Number(r.count) }),
    );
  } else {
    console.warn(
      "[import-counts] RPC payroll_service_record_counts 未適用 — 全件スキャンに fallback:",
      error?.message,
    );
    rows = await scanAndCount(
      supabase,
      "payroll_service_records",
      "processing_month,office_number",
      (r) => `${r.processing_month}|${r.office_number}`,
    );
  }
  return rows.sort(
    (a, b) => b.month.localeCompare(a.month) || a.office_number.localeCompare(b.office_number),
  );
}

/** payroll_attendance_records の 月 (YYYYMM) × 事業所 件数 */
export async function fetchAttendanceRecordCounts(
  supabase: SupabaseClient,
): Promise<MonthOfficeCount[]> {
  const { data, error } = await supabase.rpc("payroll_attendance_record_counts");
  if (!error && data) {
    return (data as { year: number; month: number; office_number: string; count: number }[]).map(
      (r) => ({
        month: `${r.year}${String(r.month).padStart(2, "0")}`,
        office_number: r.office_number,
        count: Number(r.count),
      }),
    );
  }
  console.warn(
    "[import-counts] RPC payroll_attendance_record_counts 未適用 — 全件スキャンに fallback:",
    error?.message,
  );
  return scanAndCount(
    supabase,
    "payroll_attendance_records",
    "year,month,office_number",
    (r) => `${r.year}${String(r.month).padStart(2, "0")}|${r.office_number}`,
  );
}

/** payroll_office_form_records の 月 × 事業所 件数 (新しい月順) */
export async function fetchOfficeFormRecordCounts(
  supabase: SupabaseClient,
): Promise<MonthOfficeCount[]> {
  const { data, error } = await supabase.rpc("payroll_office_form_record_counts");
  let rows: MonthOfficeCount[];
  if (!error && data) {
    rows = (data as { processing_month: string; office_number: string; count: number }[]).map(
      (r) => ({ month: r.processing_month, office_number: r.office_number, count: Number(r.count) }),
    );
  } else {
    console.warn(
      "[import-counts] RPC payroll_office_form_record_counts 未適用 — 全件スキャンに fallback:",
      error?.message,
    );
    rows = await scanAndCount(
      supabase,
      "payroll_office_form_records",
      "processing_month,office_number",
      (r) => `${r.processing_month}|${r.office_number}`,
    );
  }
  return rows.sort((a, b) => b.month.localeCompare(a.month));
}
