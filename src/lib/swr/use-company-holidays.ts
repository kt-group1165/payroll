"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { supabase } from "@/lib/supabase";

/**
 * 会社休日 (payroll_company_holidays) 取得 hook (SWR ベース)。
 *
 * 撤去の容易さ:
 *   - SWR は本ファイル内部のみ。撤去時は内部書換のみで呼び出し側不変。
 *
 * Cache key:
 *   - 引数 year を指定: `company-holidays:{year}` (その年だけ)
 *   - 引数 year を省略: `company-holidays:all` (全期間)
 *
 * 返り値:
 *   - holidayDates: Set<string>  (YYYY-MM-DD 形式、attendance-calc 互換)
 *   - holidays:     Holiday[]   (date/name など UI 表示用)
 *
 * 設計上は tenant_id = 'kt-group' 固定 (他 hook と同パターン)。
 * Table 未 apply 時は error 握り潰し → 空 array fallback。
 */

// =====================================================================
// 型
// =====================================================================

export type CompanyHoliday = {
  id: string;
  tenant_id: string;
  holiday_date: string; // YYYY-MM-DD
  name: string;
  note: string | null;
  created_at: string;
  updated_at: string;
};

const TENANT_ID = "kt-group";

// =====================================================================
// fetcher
// =====================================================================

async function fetchCompanyHolidays(
  year?: number,
): Promise<CompanyHoliday[]> {
  let q = supabase
    .from("payroll_company_holidays")
    .select("*")
    .eq("tenant_id", TENANT_ID)
    .order("holiday_date");
  if (year !== undefined) {
    q = q.gte("holiday_date", `${year}-01-01`).lte("holiday_date", `${year}-12-31`);
  }
  const { data, error } = await q;
  // 旧挙動と互換: table 未 apply 時は空 fallback (throw しない)
  if (error) return [];
  return (data ?? []) as CompanyHoliday[];
}

// =====================================================================
// 公開 hook
// =====================================================================

export type UseCompanyHolidaysResult = {
  /** YYYY-MM-DD の Set。attendance-calc.companyHolidayDates にそのまま渡せる */
  holidayDates: Set<string>;
  /** 一覧 (date 昇順) */
  holidays: CompanyHoliday[];
  /** date → name の map (tooltip 表示用) */
  nameByDate: Map<string, string>;
  isLoading: boolean;
  error: Error | null;
  mutate: () => void;
};

export function useCompanyHolidays(year?: number): UseCompanyHolidaysResult {
  const key = year !== undefined ? `company-holidays:${year}` : "company-holidays:all";
  const { data, error, isLoading, mutate } = useSWR<CompanyHoliday[]>(
    key,
    () => fetchCompanyHolidays(year),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: true,
      keepPreviousData: true,
    },
  );

  // data が undefined のときも安定した identity を返すため useMemo で wrap
  const holidays = useMemo<CompanyHoliday[]>(() => data ?? [], [data]);
  const holidayDates = useMemo(
    () => new Set(holidays.map((h) => h.holiday_date)),
    [holidays],
  );
  const nameByDate = useMemo(() => {
    const m = new Map<string, string>();
    for (const h of holidays) m.set(h.holiday_date, h.name);
    return m;
  }, [holidays]);

  return {
    holidayDates,
    holidays,
    nameByDate,
    isLoading,
    error: error ?? null,
    mutate: () => {
      void mutate();
    },
  };
}
