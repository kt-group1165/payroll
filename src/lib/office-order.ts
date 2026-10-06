/**
 * 事業所の並び順 (2026-10-06 user)。
 *
 * 既定の順: まず法人の順 → 同じ法人の中は 種別の順 → 事業所番号。
 *   法人: 儀八 → 至誠堂 → ケイ・ティ・サービス → サービスワン → ムツミ (→ その他・未設定)
 *   種別: 居宅介護支援 → 訪問介護 → 訪問入浴 → 訪問看護 → 福祉用具貸与 → 薬局 (→ その他)
 *
 * 画面で並べ替えた順は payroll_offices.sort_order に持つ (小さいほど上)。
 * ★ sort_order が入っている事業所どうしは sort_order で、入っていない事業所は 既定の順で並べる
 *   (列を足す SQL の前でも 既定の順で並ぶ / 新しく足した事業所は 既定の位置の後ろに付く)。
 * SQL: migrations/payroll_offices_sort_order.sql (既定の順で sort_order を振る)
 */

/** 法人の並び (名前に含まれる語で判定。全角・半角・空白の違いは吸収する) */
export const COMPANY_ORDER = ["儀八", "至誠堂", "ケイ・ティ", "サービスワン", "ムツミ"] as const;
/** 種別の並び (payroll_offices.office_type) */
export const OFFICE_TYPE_ORDER = ["居宅介護支援", "訪問介護", "訪問入浴", "訪問看護", "福祉用具貸与", "薬局"] as const;

const norm = (s: string) => (s ?? "").normalize("NFKC").replace(/\s/g, "").replace(/[･・]/g, "・");

export function companyRank(companyName: string | null | undefined): number {
  const n = norm(companyName ?? "");
  if (!n) return COMPANY_ORDER.length + 1;            // 法人 未設定は 最後
  const i = COMPANY_ORDER.findIndex((k) => n.includes(norm(k)));
  return i < 0 ? COMPANY_ORDER.length : i;            // 知らない法人は 5 法人の後ろ
}

export function officeTypeRank(officeType: string | null | undefined): number {
  const i = OFFICE_TYPE_ORDER.findIndex((t) => t === (officeType ?? ""));
  return i < 0 ? OFFICE_TYPE_ORDER.length : i;
}

export type OrderableOffice = {
  office_number: string;
  office_type: string;
  sort_order?: number | null;
};

/** 既定の順の比較 */
export function compareOfficesDefault<T extends OrderableOffice>(a: T, b: T, companyNameOf: (o: T) => string | null | undefined): number {
  return companyRank(companyNameOf(a)) - companyRank(companyNameOf(b))
    || officeTypeRank(a.office_type) - officeTypeRank(b.office_type)
    || String(a.office_number).localeCompare(String(b.office_number));
}

/** 表示の比較: sort_order が両方にあれば それ、無ければ 既定の順 (sort_order のある方を先に) */
export function compareOffices<T extends OrderableOffice>(a: T, b: T, companyNameOf: (o: T) => string | null | undefined): number {
  const sa = a.sort_order ?? null, sb = b.sort_order ?? null;
  if (sa !== null && sb !== null && sa !== sb) return sa - sb;
  if (sa !== null && sb === null) return -1;
  if (sa === null && sb !== null) return 1;
  return compareOfficesDefault(a, b, companyNameOf);
}
