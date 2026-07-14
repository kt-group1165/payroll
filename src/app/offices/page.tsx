import { createClient } from "@/lib/supabase/server";
import { sortCompanies } from "@/lib/sort-companies";
import {
  COMPANY_MASTER_JOIN,
  OFFICE_MASTER_JOIN,
  flattenCompanyMaster,
  flattenOfficeMaster,
  type Company,
  type Office,
} from "@/types/database";
import { OfficesList, type MasterOffice } from "./offices-list";

/**
 * /offices
 * 事業所一覧 + 編集ダイアログ + CSV import/export。
 *
 * Server Component: offices / masters / companies を await で取得し、
 * 編集 UI は `<OfficesList>` (client component) に initial props で渡す。
 * 保存・削除・取込後の refetch は client 側で `router.refresh()` を呼んで
 * RSC を再評価。
 */
export default async function OfficesPage() {
  const supabase = await createClient();
  const [offRes, mastersRes, coRes] = await Promise.all([
    supabase
      .from("payroll_offices")
      .select(`*, ${OFFICE_MASTER_JOIN}`)
      .order("created_at"),
    supabase
      .from("offices")
      .select("id, name, address, business_number, short_name, service_type, is_active, company_id")
      .order("name"),
    supabase
      .from("payroll_companies")
      .select(`*, ${COMPANY_MASTER_JOIN}`)
      .order("created_at"),
  ]);

  const fetchErrors = [
    offRes.error && `事業所: ${offRes.error.message}`,
    mastersRes.error && `共通マスタ: ${mastersRes.error.message}`,
    coRes.error && `法人: ${coRes.error.message}`,
  ].filter((e): e is string => !!e);
  if (fetchErrors.length > 0) {
    console.error("offices page fetch failed:", fetchErrors.join(" / "));
  }

  const offices: Office[] = offRes.data
    ? (flattenOfficeMaster(offRes.data as never) as unknown as Office[])
    : [];
  const masters: MasterOffice[] = (mastersRes.data as MasterOffice[] | null) ?? [];
  const companies: Company[] = coRes.data
    ? sortCompanies(flattenCompanyMaster(coRes.data as never) as unknown as Company[])
    : [];

  return (
    <>
      {fetchErrors.length > 0 && (
        <p className="mb-4 rounded border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          データ取得エラー: {fetchErrors.join(" / ")}
        </p>
      )}
      <OfficesList
        initialOffices={offices}
        masters={masters}
        initialCompanies={companies}
      />
    </>
  );
}
