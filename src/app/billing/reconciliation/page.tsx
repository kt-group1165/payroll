import { createClient } from "@/lib/supabase/server";
import { sortCompanies } from "@/lib/sort-companies";
import {
  COMPANY_MASTER_JOIN,
  OFFICE_MASTER_JOIN,
  flattenCompanyMaster,
  flattenOfficeMaster,
  type Company,
} from "@/types/database";
import { ReconciliationContent, type Row, type OfficeLite } from "./reconciliation-content";

/**
 * /billing/reconciliation
 * 突合・月次サマリダッシュボード。
 *
 * Server Component: ?company=<id>&month=YYYYMM の URL params で filter 駆動。
 * 法人・事業所・該当月の billing items を server-side で取得 (paginate)。
 * Client は filter UI を URL 更新で駆動するだけ。
 *
 * filter 未指定の場合: 法人は最初の 1 件、月は「全期間」(空)
 */
export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string; month?: string }>;
}) {
  const supabase = await createClient();
  const params = await searchParams;

  const [coRes, offRes] = await Promise.all([
    supabase.from("payroll_companies").select(`*, ${COMPANY_MASTER_JOIN}`),
    supabase
      .from("payroll_offices")
      .select(`id, office_number, short_name, company_id, ${OFFICE_MASTER_JOIN}`),
  ]);

  const companies: Company[] = coRes.data
    ? sortCompanies(flattenCompanyMaster(coRes.data as never) as unknown as Company[])
    : [];
  const offices: OfficeLite[] = offRes.data
    ? (flattenOfficeMaster(offRes.data as never) as unknown as OfficeLite[])
    : [];

  // 対象 companyId: URL 優先、なければ最初の 1 件
  const selectedCompanyId =
    params.company || (companies.length > 0 ? companies[0].id : "");
  const filterMonth = params.month || "";

  // 該当法人の事業所番号でフィルタした billing items を取得
  let rows: Row[] = [];
  if (selectedCompanyId) {
    const officeNums = offices
      .filter((o) => o.company_id === selectedCompanyId)
      .map((o) => o.office_number);
    if (officeNums.length > 0) {
      const all: Row[] = [];
      let from = 0;
      const pageSize = 1000;
      while (true) {
        let q = supabase
          .from("payroll_billing_amount_items")
          .select(
            "id, segment, office_number, client_number, client_name, billing_month, service_month, amount, invoiced_amount, paid_amount, billing_status, actual_issue_date, actual_withdrawal_date, parent_item_id, lifecycle_note, service_item",
          )
          .in("office_number", officeNums)
          .range(from, from + pageSize - 1);
        if (filterMonth) q = q.eq("billing_month", filterMonth);
        const { data } = await q;
        if (!data || data.length === 0) break;
        all.push(...(data as Row[]));
        if (data.length < pageSize) break;
        from += pageSize;
      }
      rows = all;
    }
  }

  return (
    <ReconciliationContent
      companies={companies}
      offices={offices}
      selectedCompanyId={selectedCompanyId}
      filterMonth={filterMonth}
      rows={rows}
    />
  );
}
