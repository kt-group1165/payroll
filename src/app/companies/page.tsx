import { createClient } from "@/lib/supabase/server";
import { sortCompanies } from "@/lib/sort-companies";
import {
  COMPANY_MASTER_JOIN,
  flattenCompanyMaster,
  type Company,
} from "@/types/database";
import { CompaniesList, type MasterCompany } from "./companies-list";

/**
 * /companies
 * 法人一覧 + 編集ダイアログ。
 *
 * Server Component: companies + masters を await で取得し、編集 UI は
 * `<CompaniesList>` (client component) に initial props で渡す。保存・削除後の
 * refetch は client 側で `router.refresh()` を呼んで RSC を再評価。
 */
export default async function CompaniesPage() {
  const supabase = await createClient();
  const [coRes, mastersRes] = await Promise.all([
    supabase
      .from("payroll_companies")
      .select(`*, ${COMPANY_MASTER_JOIN}`)
      .order("created_at"),
    supabase
      .from("companies")
      .select("id, name, address, phone")
      .order("name"),
  ]);
  const companies: Company[] = coRes.data
    ? sortCompanies(flattenCompanyMaster(coRes.data as never) as unknown as Company[])
    : [];
  const masters: MasterCompany[] = (mastersRes.data as MasterCompany[] | null) ?? [];

  return <CompaniesList initialCompanies={companies} masters={masters} />;
}
