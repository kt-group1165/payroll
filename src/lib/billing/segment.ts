// 請求書での区分（介護保険 / 障害福祉 / 自費）を判定する

export type BillingSegment = "介護" | "障害" | "自費";

/**
 * service_records.service_category から請求書上の区分を判定する
 * - "(支)" で始まる もしくは "養育支援訪" → 障害福祉
 * - "自費" で始まる → 自費
 * - それ以外 → 介護保険
 */
export function categorizeBySegment(service_category: string | null | undefined): BillingSegment {
  const c = (service_category ?? "").trim();
  if (!c) return "介護";
  if (c.startsWith("(支)") || c === "養育支援訪") return "障害";
  if (c.startsWith("自費")) return "自費";
  return "介護";
}
