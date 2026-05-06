import { createClient } from "@/lib/supabase/server";
import { OFFICE_MASTER_JOIN, flattenOfficeMaster } from "@/types/database";
import {
  ServicesContent,
  type ServiceCategory,
  type ServiceTypeMapping,
  type UnmappedService,
  type CategoryHourlyRate,
  type Office,
} from "./services-content";

/**
 * /services
 * サービスマスタ (3 タブ: 類型 / マッピング / 時給設定)。
 *
 * Server Component: 各タブの初期データを server-side で取得し、ServicesContent
 * (client) に props で渡す。各タブの保存・削除後は client 側で
 * `router.refresh()` を呼んで RSC を再評価。
 *
 * 未マッピング集計 (service_records 全件 paginate して service_type_mappings に
 * 含まれない service_code を抽出) も server-side で実施。1000 件単位で
 * paginate するため初回 SSR が data 量に応じて遅くなる点に注意。
 */
export default async function ServicesPage() {
  const supabase = await createClient();
  const pageSize = 1000;

  const [catRes, mapRes, rateRes, offRes] = await Promise.all([
    supabase.from("payroll_service_categories").select("*").order("sort_order"),
    supabase
      .from("payroll_service_type_mappings")
      .select("*, service_categories(name)")
      .order("service_code"),
    supabase
      .from("payroll_category_hourly_rates")
      .select("*, offices:payroll_offices!office_id(short_name, master:offices!office_id(name)), service_categories(name)")
      .order("created_at"),
    supabase
      .from("payroll_offices")
      .select(`id, office_number, short_name, office_type, ${OFFICE_MASTER_JOIN}`),
  ]);

  const categories: ServiceCategory[] = (catRes.data ?? []) as ServiceCategory[];
  const mappings: ServiceTypeMapping[] = (mapRes.data ?? []) as ServiceTypeMapping[];
  const rates: CategoryHourlyRate[] = (rateRes.data ?? []) as CategoryHourlyRate[];

  let offices: Office[] = [];
  if (offRes.data) {
    offices = flattenOfficeMaster(offRes.data as never) as unknown as Office[];
    offices.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  }

  // 未マッピング集計: service_records 全件 paginate
  const mappedCodes = new Set(mappings.map((m) => m.service_code));
  const codeNameMap = new Map<string, string>();
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from("payroll_service_records")
      .select("service_code,service_type")
      .order("id")
      .range(from, from + pageSize - 1);
    if (!data || data.length === 0) break;
    for (const r of data) {
      const row = r as { service_code: string; service_type: string };
      const code = row.service_code;
      const name = row.service_type;
      if (code && code.trim() && !codeNameMap.has(code)) {
        codeNameMap.set(code, name || "");
      }
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }
  const unmapped: UnmappedService[] = [];
  for (const [code, name] of codeNameMap) {
    if (!mappedCodes.has(code)) {
      unmapped.push({ service_code: code, service_name: name });
    }
  }
  unmapped.sort((a, b) => a.service_code.localeCompare(b.service_code));

  return (
    <ServicesContent
      categories={categories}
      mappings={mappings}
      unmapped={unmapped}
      rates={rates}
      offices={offices}
    />
  );
}
