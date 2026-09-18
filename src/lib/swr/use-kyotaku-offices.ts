"use client";

import useSWR from "swr";
import { supabase } from "@/lib/supabase";

/**
 * 出勤簿の対象事業所 一覧 hook (kaigo-app の出勤簿と同じ。2026-09-18 に給与計算システムにも 訪問介護・訪問入浴 を入れた)。
 *
 * kaigo-app の出勤簿は 居宅介護支援 / 訪問介護 / 訪問入浴 の 3 業態を扱う
 * (福祉用具 + 本社は order-app 側。project_app_business_mapping 参照)。
 *
 * office_type で月次セクションの表示を分ける:
 *   - 居宅介護支援: 日次 + 月次 (件数・ケアマネ加算)
 *   - 訪問介護 / 訪問入浴: 日次のみ
 *
 * Cache key: `"attendance-offices"` (引数なし、global 固定)
 */

// payroll-app @/types/database の OFFICE_MASTER_JOIN / flattenOfficeMaster を inline 移植
const OFFICE_MASTER_JOIN = "master:offices!office_id(name, address)";

function flattenOfficeMaster<
  T extends { master?: { name?: string | null; address?: string | null } | null },
>(rows: T[] | null | undefined): (Omit<T, "master"> & { name: string; address: string })[] {
  return (rows ?? []).map(({ master, ...rest }) => ({
    ...(rest as Omit<T, "master">),
    name: master?.name ?? "",
    address: master?.address ?? "",
  }));
}

export type KyotakuOffice = {
  id: string;
  office_number: string;
  short_name: string;
  /** 居宅介護支援 / 訪問介護 / 訪問入浴 */
  office_type: string;
  name: string;
  /** 1週間の起算曜日 (0=日, 1=月, ..., 6=土) */
  work_week_start: number;
};

const OFFICE_TYPES = ["居宅介護支援", "訪問介護", "訪問入浴"] as const;

async function fetchAttendanceOffices(): Promise<KyotakuOffice[]> {
  const { data, error } = await supabase
    .from("payroll_offices")
    .select(
      `id, office_number, short_name, office_type, work_week_start, ${OFFICE_MASTER_JOIN}`,
    )
    .in("office_type", [...OFFICE_TYPES]);
  if (error) throw error;
  const flat = flattenOfficeMaster(data as never) as unknown as KyotakuOffice[];
  // 業態 → 事業所番号順 (居宅を先頭に)
  const typeOrder = new Map(OFFICE_TYPES.map((t, i) => [t as string, i]));
  flat.sort(
    (a, b) =>
      (typeOrder.get(a.office_type) ?? 9) - (typeOrder.get(b.office_type) ?? 9) ||
      a.office_number.localeCompare(b.office_number),
  );
  return flat;
}

export type UseKyotakuOfficesResult = {
  offices: KyotakuOffice[];
  isLoading: boolean;
  error: Error | null;
  mutate: () => void;
};

// 参照安定化用 (毎 render 新 [] を返すと consumer の effect/memo が毎回発火する)
const EMPTY_OFFICES: KyotakuOffice[] = [];

export function useKyotakuOffices(): UseKyotakuOfficesResult {
  const { data, error, isLoading, mutate } = useSWR<KyotakuOffice[]>(
    "attendance-offices",
    fetchAttendanceOffices,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: true,
      keepPreviousData: true,
    },
  );
  return {
    offices: data ?? EMPTY_OFFICES,
    isLoading,
    error: error ?? null,
    mutate: () => {
      void mutate();
    },
  };
}
