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
      .select("id, name, address, business_number")
      .order("name"),
    supabase
      .from("payroll_companies")
      .select(`*, ${COMPANY_MASTER_JOIN}`)
      .order("created_at"),
  ]);

  const offices: Office[] = offRes.data
    ? (flattenOfficeMaster(offRes.data as never) as unknown as Office[])
    : [];
  const masters: MasterOffice[] = (mastersRes.data as MasterOffice[] | null) ?? [];
  const companies: Company[] = coRes.data
    ? sortCompanies(flattenCompanyMaster(coRes.data as never) as unknown as Company[])
    : [];

  return (
    <OfficesList
      initialOffices={offices}
      masters={masters}
      initialCompanies={companies}
    />
  );
}
