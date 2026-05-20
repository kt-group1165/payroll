"use client";

import useSWR from "swr";
import { supabase } from "@/lib/supabase";

/**
 * 居宅介護支援 出勤簿 月単位データ (件数 + 加算明細) 取得 hook
 *
 * Cache key: `kyotaku-att-monthly:${employeeId}:${month}`
 *
 * Tables:
 *   - payroll_kyotaku_attendance_monthly        (1 row per emp+month)
 *   - payroll_kyotaku_attendance_monthly_kasan  (N rows per emp+month)
 *
 * 撤去容易性: SWR は本ファイル内部のみ。
 */

export type KyotakuMonthlyRow = {
  id: string | null; // null = まだ DB に無い (新規)
  kaigo_count: number;
  yobou_count: number;
};

export type KyotakuKasanRow = {
  id: string | null;
  sort_order: number;
  /** 規定加算 (200/300/400/450/600/750/900) または null (= 自由記述行) */
  kasan_unit: number | null;
  /** 件数 (規定加算行) */
  kasan_count: number | null;
  /** 自由記述ラベル */
  free_label: string | null;
  /** 自由記述 金額 (円) */
  free_amount: number | null;
};

export type UseKyotakuMonthlyResult = {
  monthly: KyotakuMonthlyRow;
  kasanRows: KyotakuKasanRow[];
  isLoading: boolean;
  error: Error | null;
  mutate: () => void;
};

const EMPTY_MONTHLY: KyotakuMonthlyRow = {
  id: null,
  kaigo_count: 0,
  yobou_count: 0,
};

async function fetchMonthly(
  employeeId: string,
  month: string,
): Promise<{ monthly: KyotakuMonthlyRow; kasanRows: KyotakuKasanRow[] }> {
  const monthStart = `${month}-01`;

  const [{ data: mRow, error: mErr }, { data: kRows, error: kErr }] =
    await Promise.all([
      supabase
        .from("payroll_kyotaku_attendance_monthly")
        .select("id, kaigo_count, yobou_count")
        .eq("employee_id", employeeId)
        .eq("month_start", monthStart)
        .maybeSingle(),
      supabase
        .from("payroll_kyotaku_attendance_monthly_kasan")
        .select("id, sort_order, kasan_unit, kasan_count, free_label, free_amount")
        .eq("employee_id", employeeId)
        .eq("month_start", monthStart)
        .order("sort_order", { ascending: true }),
    ]);

  // Table 未 apply の可能性: error が出ても空 fallback
  if (mErr) {
    if (/does not exist|schema cache/i.test(mErr.message)) {
      return { monthly: EMPTY_MONTHLY, kasanRows: [] };
    }
    throw mErr;
  }
  if (kErr) {
    if (/does not exist|schema cache/i.test(kErr.message)) {
      return {
        monthly: (mRow as KyotakuMonthlyRow | null) ?? EMPTY_MONTHLY,
        kasanRows: [],
      };
    }
    throw kErr;
  }

  return {
    monthly: (mRow as KyotakuMonthlyRow | null) ?? EMPTY_MONTHLY,
    kasanRows: (kRows ?? []) as KyotakuKasanRow[],
  };
}

export function useKyotakuMonthly(
  employeeId: string | null,
  month: string | null,
): UseKyotakuMonthlyResult {
  const key =
    employeeId && month ? `kyotaku-att-monthly:${employeeId}:${month}` : null;
  const { data, error, isLoading, mutate } = useSWR(
    key,
    () => fetchMonthly(employeeId!, month!),
    { revalidateOnFocus: false, keepPreviousData: false },
  );
  return {
    monthly: data?.monthly ?? EMPTY_MONTHLY,
    kasanRows: data?.kasanRows ?? [],
    isLoading,
    error: error ?? null,
    mutate: () => {
      void mutate();
    },
  };
}
