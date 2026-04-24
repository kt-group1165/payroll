import type { Company } from "@/types/database";

/**
 * 会社一覧の表示順。
 * 「ムツミ商事」は実質的にグループ外の扱いなので常に一番最後に置く。
 * それ以外は 50音順（日本語ロケール）で並べる。
 */
export function sortCompanies<T extends { name: string }>(companies: T[]): T[] {
  return [...companies].sort(compareCompanies);
}

export function compareCompanies<T extends { name: string }>(a: T, b: T): number {
  const aLast = isDeprioritized(a.name);
  const bLast = isDeprioritized(b.name);
  if (aLast !== bLast) return aLast ? 1 : -1;
  return a.name.localeCompare(b.name, "ja");
}

function isDeprioritized(name: string): boolean {
  // 全半角・スペース差異を吸収
  const n = (name ?? "").normalize("NFKC").replace(/\s/g, "");
  return n.includes("ムツミ") || n.includes("むつみ商事");
}

// 利便性のため Company 型の再エクスポート
export type { Company };
