"use client";

import useSWR from "swr";
import { supabase } from "@/lib/supabase";
import { OFFICE_MASTER_JOIN, flattenOfficeMaster } from "@/types/database";

/**
 * 居宅介護支援 事業所一覧 取得 hook (SWR ベース)。
 *
 * 撤去の容易さ:
 *   - SWR は本ファイル内部のみで使用。
 *   - 撤去する際は本 hook を `useState + useEffect` 版に書き換えるだけで
 *     呼び出し側 (KyotakuAttendanceContent) は変更不要。
 *
 * Cache key: `"kyotaku-offices"` (引数なし、global 固定)
 */

// =====================================================================
// 型 (component と共有するため export)
// =====================================================================

export type KyotakuOffice = {
  id: string;
  office_number: string;
  short_name: string;
  name: string;
  /** 1週間の起算曜日 (0=日, 1=月, ..., 6=土) */
  work_week_start: number;
};

// =====================================================================
// fetcher
// =====================================================================

async function fetchKyotakuOffices(): Promise<KyotakuOffice[]> {
  const { data, error } = await supabase
    .from("payroll_offices")
    .select(
      `id, office_number, short_name, office_type, work_week_start, ${OFFICE_MASTER_JOIN}`,
    )
    .eq("office_type", "居宅介護支援");
  if (error) throw error;
  const flat = flattenOfficeMaster(data as never) as unknown as KyotakuOffice[];
  flat.sort((a, b) => a.office_number.localeCompare(b.office_number));
  return flat;
}

// =====================================================================
// 公開 hook
// =====================================================================

export type UseKyotakuOfficesResult = {
  offices: KyotakuOffice[];
  isLoading: boolean;
  error: Error | null;
  mutate: () => void;
};

export function useKyotakuOffices(): UseKyotakuOfficesResult {
  const { data, error, isLoading, mutate } = useSWR<KyotakuOffice[]>(
    "kyotaku-offices",
    fetchKyotakuOffices,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: true,
      keepPreviousData: true,
    },
  );
  return {
    offices: data ?? [],
    isLoading,
    error: error ?? null,
    mutate: () => {
      void mutate();
    },
  };
}
