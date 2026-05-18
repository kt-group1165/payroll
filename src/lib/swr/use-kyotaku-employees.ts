"use client";

import useSWR from "swr";
import { supabase } from "@/lib/supabase";

/**
 * 選択 office に紐づく職員 (payroll_employees) 一覧 取得 hook (SWR ベース)。
 *
 * 撤去の容易さ:
 *   - SWR は本ファイル内部のみ。撤去時は内部書換のみで呼び出し側不変。
 *
 * Cache key: `kyotaku-employees:${officeId}` / officeId が空文字 or null なら fetch しない。
 */

// =====================================================================
// 型
// =====================================================================

export type KyotakuEmployeeRow = {
  id: string;
  name: string;
  office_id: string;
};

// =====================================================================
// fetcher
// =====================================================================

async function fetchKyotakuEmployees(
  officeId: string,
): Promise<KyotakuEmployeeRow[]> {
  const { data, error } = await supabase
    .from("payroll_employees")
    .select("id, name, office_id")
    .eq("office_id", officeId)
    .order("name");
  if (error) throw error;
  return (data ?? []) as KyotakuEmployeeRow[];
}

// =====================================================================
// 公開 hook
// =====================================================================

export type UseKyotakuEmployeesResult = {
  employees: KyotakuEmployeeRow[];
  isLoading: boolean;
  error: Error | null;
  mutate: () => void;
};

export function useKyotakuEmployees(
  officeId: string,
): UseKyotakuEmployeesResult {
  const key = officeId ? `kyotaku-employees:${officeId}` : null;
  const { data, error, isLoading, mutate } = useSWR<KyotakuEmployeeRow[]>(
    key,
    () => fetchKyotakuEmployees(officeId),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: true,
      keepPreviousData: true,
    },
  );
  return {
    employees: data ?? [],
    isLoading,
    error: error ?? null,
    mutate: () => {
      void mutate();
    },
  };
}
