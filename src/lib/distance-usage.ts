import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Google Distance Matrix API の月間利用上限 (2026-09-17)
 *
 * ── なぜ要るか ──────────────────────────────────────────────────────────
 *   Google Cloud 側の割り当ては「1日」「1分」単位しかなく、月単位で止められない。
 *   予算アラートは通知だけで API は止まらない。
 *   → 給与システムが Google を呼んだ件数 (= 課金単位の element 数) を
 *     payroll_distance_api_usage に記録し、月の上限を超える呼出はしない。
 *
 *   上限は payroll_app_settings の key="distance_api_monthly_limit" (value {limit})。
 *   未設定なら DEFAULT_MONTHLY_LIMIT。
 */

export const DISTANCE_API_MONTHLY_LIMIT_KEY = "distance_api_monthly_limit";
export const DEFAULT_MONTHLY_LIMIT = 10000;

/** 日本時間の今月 "YYYY-MM"。サーバ (Vercel) は UTC なので Intl で JST を明示する */
export function usageMonthJst(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  return `${y}-${m}`;
}

/**
 * 今月あと何件呼べるかで、送るチャンクを先頭から何個まで許すかを決める。
 * チャンクは途中で割らない (1 チャンク = 1 リクエスト。一部だけ送ると区間が欠ける)。
 * @returns 送ってよいチャンク数
 */
export function allowedChunkCount(chunkSizes: number[], used: number, limit: number): number {
  let remaining = limit - used;
  let n = 0;
  for (const size of chunkSizes) {
    if (size > remaining) break;
    remaining -= size;
    n++;
  }
  return n;
}

export async function getMonthlyLimit(sb: SupabaseClient): Promise<{ limit: number; error: string | null }> {
  const { data, error } = await sb
    .from("payroll_app_settings")
    .select("value")
    .eq("key", DISTANCE_API_MONTHLY_LIMIT_KEY)
    .maybeSingle();
  if (error) return { limit: DEFAULT_MONTHLY_LIMIT, error: error.message };
  const v = (data?.value as { limit?: number } | null)?.limit;
  return { limit: typeof v === "number" && v >= 0 ? v : DEFAULT_MONTHLY_LIMIT, error: null };
}

/** 今月すでに Google に送った件数。取れなければ error を返す (呼出側は Google を呼ばない) */
export async function getMonthlyUsed(sb: SupabaseClient, month: string): Promise<{ used: number; error: string | null }> {
  let used = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("payroll_distance_api_usage")
      .select("elements")
      .eq("usage_month", month)
      .order("id")
      .range(from, from + 999);
    if (error) return { used: 0, error: error.message };
    for (const r of data ?? []) used += (r as { elements: number }).elements ?? 0;
    if (!data || data.length < 1000) break;
  }
  return { used, error: null };
}
