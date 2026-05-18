"use client";

import useSWR from "swr";
import { supabase } from "@/lib/supabase";
import { OFFICE_MASTER_JOIN, flattenOfficeMaster } from "@/types/database";

/**
 * payroll_offices 一覧取得 hook (SWR ベース)。
 *
 * 撤去の容易さ:
 *   - 本ファイルが SWR を使う唯一の場所 (use-kyotaku-summary.ts と並ぶ集約点)。
 *   - 撤去するときは本ファイル内部を `useState + useEffect` に書き換えるだけで
 *     呼び出し側 (payroll-summary/page.tsx など) は変更不要。
 *
 * Cache key: `"payroll-offices"` (引数なしで全 office)
 */

// =====================================================================
// 型 (component と共有するため export)
// =====================================================================

export type OfficeForPayroll = {
  id: string;
  office_number: string;
  short_name: string;
  name: string;
  office_type: string;
  work_week_start: number;
};

// =====================================================================
// fetcher (SWR から呼ばれる)
// =====================================================================

async function fetchPayrollOffices(): Promise<OfficeForPayroll[]> {
  const { data, error } = await supabase
    .from("payroll_offices")
    .select(`id, office_number, short_name, office_type, work_week_start, ${OFFICE_MASTER_JOIN}`);
  if (error) throw error;
  const flat = flattenOfficeMaster(data as never) as unknown as OfficeForPayroll[];
  flat.sort((a, b) => a.office_number.localeCompare(b.office_number));
  return flat;
}

// =====================================================================
// 公開 hook
// =====================================================================

export type UsePayrollOfficesResult = {
  offices: OfficeForPayroll[];
  isLoading: boolean;
  error: Error | null;
};

export function usePayrollOffices(): UsePayrollOfficesResult {
  const { data, error, isLoading } = useSWR<OfficeForPayroll[]>(
    "payroll-offices",
    fetchPayrollOffices,
    {
      // 一度取得した cache を維持しつつ、focus/再 mount で background revalidate
      revalidateOnFocus: false,
      revalidateOnReconnect: true,
      keepPreviousData: true,
    },
  );
  return {
    offices: data ?? [],
    isLoading,
    error: error ?? null,
  };
}
