import { createClient } from "@/lib/supabase/server";
import { sortCompanies } from "@/lib/sort-companies";
import {
  COMPANY_MASTER_JOIN,
  flattenCompanyMaster,
  type Company,
} from "@/types/database";
import { WithdrawalsContent, type BillingRow } from "./withdrawals-content";

/**
 * /billing/withdrawals
 * 引落結果（不可データ）取り込み画面。
 *
 * Server Component: ?company=<id>&month=YYYYMM の URL params で filter 駆動。
 * 法人一覧 + 対象月の invoiced/overdue billing items を server-side で取得。
 * CSV 取込・実行は client 側 (file 操作 + 個別 row update)。
 */
export default async function WithdrawalsImportPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string; month?: string }>;
}) {
  const supabase = await createClient();
  const params = await searchParams;

  const { data: coData } = await supabase
    .from("payroll_companies")
    .select(`*, ${COMPANY_MASTER_JOIN}`);
  const companies: Company[] = coData
    ? sortCompanies(flattenCompanyMaster(coData as never) as unknown as Company[])
    : [];

  const selectedCompanyId =
    params.company || (companies.length > 0 ? companies[0].id : "");
  const billingMonth = params.month || "";

  let invoicedRows: BillingRow[] = [];
  if (selectedCompanyId && billingMonth) {
    const { data: offData } = await supabase
      .from("payroll_offices")
      .select("office_number")
      .eq("company_id", selectedCompanyId);
    const officeNums = ((offData ?? []) as { office_number: string }[]).map((o) => o.office_number);
    if (officeNums.length > 0) {
      const { data } = await supabase
        .from("payroll_billing_amount_items")
        .select(
          "id, segment, office_number, client_number, client_name, billing_month, invoiced_amount, amount, billing_status",
        )
        .eq("billing_month", billingMonth)
        .in("office_number", officeNums)
        .in("billing_status", ["invoiced", "overdue"])
        .limit(10000);
      invoicedRows = (data ?? []) as BillingRow[];
    }
  }

  return (
    <WithdrawalsContent
      companies={companies}
      selectedCompanyId={selectedCompanyId}
      billingMonth={billingMonth}
      invoicedRows={invoicedRows}
    />
  );
}
