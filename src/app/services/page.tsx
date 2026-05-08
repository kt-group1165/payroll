import { createClient } from "@/lib/supabase/server";
import { OFFICE_MASTER_JOIN, flattenOfficeMaster } from "@/types/database";
import {
  ServicesContent,
  type ServiceCategory,
  type ServiceTypeMapping,
  type CategoryHourlyRate,
  type Office,
} from "./services-content";

/**
 * /services
 * サービスマスタ (3 タブ: 類型 / マッピング / 時給設定)。
 *
 * Server Component: 各タブの初期データを server-side で取得し、ServicesContent
 * (client) に props で渡す。各タブの保存・削除後は client 側で `router.refresh()`
 * を呼んで RSC を再評価。
 *
 * Perf: 旧 SSR 実装は payroll_service_records (年単位で数万行) を全件 paginate して
 * 「未マッピングコード」を計算していたため、初回 SSR が data 量に応じて何秒も遅延した。
 * 未マッピング集計は MappingsTab を開いたときに client 側 (lazy) で取得するよう移行。
 */
export default async function ServicesPage() {
  const supabase = await createClient();

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

  // 未マッピングは MappingsTab の useEffect で fetch (初回 SSR を高速化)
  return (
    <ServicesContent
      categories={categories}
      mappings={mappings}
      rates={rates}
      offices={offices}
    />
  );
}
