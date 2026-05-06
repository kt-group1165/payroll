import { createClient } from "@/lib/supabase/server";
import { sortCompanies } from "@/lib/sort-companies";
import {
  COMPANY_MASTER_JOIN,
  OFFICE_MASTER_JOIN,
  flattenCompanyMaster,
  flattenOfficeMaster,
  type Company,
  type Client,
  type Payment,
} from "@/types/database";
import {
  BillingContent,
  type BillingSegment,
  type OfficeLite,
  type PaymentMethod,
  type TableRow,
} from "./billing-content";

type AmountRow = {
  segment: BillingSegment;
  office_number: string;
  client_number: string;
  client_name: string;
  billing_month: string;
  service_month: string | null;
  amount: number;
  invoiced_amount: number | null;
  paid_amount: number | null;
  billing_status: string | null;
};

function prevMonth(yyyymm: string): string {
  const y = parseInt(yyyymm.slice(0, 4), 10);
  const m = parseInt(yyyymm.slice(4, 6), 10);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * /billing
 * 請求一覧 (利用者×事業所×区分別の月次サマリ)。
 *
 * Server Component: ?company=<id>&office=<num>&month=YYYYMM の URL params で
 * filter 駆動。法人 + 事業所 + 利用者 + 月候補 + 該当月分の billing_amount_items +
 * payments を server で取得し、computeRows の集計ロジックも server-side で実行。
 * 結果の TableRow[] を BillingContent (client) に props で渡す。
 *
 * client 側の filter (search / paymentMethod / outstandingOnly) は client-side
 * で表示行を絞り込む (data fetch には影響しない)。
 */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string; office?: string; month?: string }>;
}) {
  const supabase = await createClient();
  const params = await searchParams;

  // 法人 + 事業所
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

  // 利用者 (paginate)
  const clients: Client[] = [];
  {
    let from = 0;
    while (true) {
      const { data } = await supabase.from("payroll_clients").select("*").range(from, from + 999);
      if (!data || data.length === 0) break;
      clients.push(...(data as Client[]));
      if (data.length < 1000) break;
      from += 1000;
    }
  }

  // 月候補
  const availableMonths: string[] = [];
  {
    const monthsSet = new Set<string>();
    let from = 0;
    while (true) {
      const { data } = await supabase
        .from("payroll_billing_amount_items")
        .select("billing_month")
        .range(from, from + 999);
      if (!data || data.length === 0) break;
      for (const r of data) monthsSet.add((r as { billing_month: string }).billing_month);
      if (data.length < 1000) break;
      from += 1000;
    }
    availableMonths.push(...[...monthsSet].sort().reverse());
  }

  // filter values: URL 優先、未指定時は default
  const selectedCompanyId =
    params.company || (companies.length > 0 ? companies[0].id : "");
  const selectedOfficeNum = params.office || "";
  const selectedMonth = params.month || (availableMonths[0] ?? "");

  // 月リスト (選択月 + 過去6ヶ月)
  const monthColumns: string[] = [];
  if (selectedMonth) {
    let m = selectedMonth;
    for (let i = 0; i < 7; i++) {
      monthColumns.push(m);
      m = prevMonth(m);
    }
  }

  // データ集計 (computeRows 移植)
  let rows: TableRow[] = [];
  if (selectedCompanyId && monthColumns.length > 0) {
    const companyOffices = offices
      .filter((o) => o.company_id === selectedCompanyId)
      .filter((o) => !selectedOfficeNum || o.office_number === selectedOfficeNum);
    const companyOfficeIds = new Set(companyOffices.map((o) => o.id));
    const companyOfficeNums = companyOffices.map((o) => o.office_number);

    if (companyOfficeNums.length > 0) {
      const allAmounts: AmountRow[] = [];
      let from = 0;
      while (true) {
        const { data } = await supabase
          .from("payroll_billing_amount_items")
          .select(
            "segment, office_number, client_number, client_name, billing_month, service_month, amount, invoiced_amount, paid_amount, billing_status",
          )
          .in("office_number", companyOfficeNums)
          .range(from, from + 999);
        if (!data || data.length === 0) break;
        allAmounts.push(...(data as AmountRow[]));
        if (data.length < 1000) break;
        from += 1000;
      }

      const { data: payData } = await supabase
        .from("payroll_payments")
        .select("*")
        .eq("company_id", selectedCompanyId);
      const payments = (payData ?? []) as Payment[];

      const companyClients = clients.filter((c) => companyOfficeIds.has(c.office_id));
      const clientByNumber = new Map<string, Client>();
      for (const c of companyClients) clientByNumber.set(c.client_number, c);

      const map = new Map<string, TableRow>();
      const latestMonthForKey = new Map<string, string>();
      const monthSet = new Set(monthColumns);
      for (const a of allAmounts) {
        const off = offices.find((o) => o.office_number === a.office_number);
        const officeName = (off?.short_name || off?.name) ?? a.office_number;
        const key = `${a.office_number}|${a.client_number}|${a.segment}`;
        const c = clientByNumber.get(a.client_number);
        const resolvedName = a.client_name?.trim() || c?.name || a.client_number;
        if (!map.has(key)) {
          map.set(key, {
            client_number: a.client_number,
            client_name: resolvedName,
            furigana: "",
            office_number: a.office_number,
            office_name: officeName,
            segment: a.segment,
            payment_method: (c?.payment_method as PaymentMethod) ?? "",
            monthlyAmounts: {},
            monthlyStatus: {},
            totalBilled: 0,
            totalPaid: 0,
            outstanding: 0,
          });
          latestMonthForKey.set(key, a.billing_month ?? "");
        } else {
          const prev = latestMonthForKey.get(key) ?? "";
          if ((a.billing_month ?? "") >= prev) {
            const r = map.get(key)!;
            r.client_name = resolvedName;
            r.office_name = officeName;
            latestMonthForKey.set(key, a.billing_month ?? "");
          }
        }
        const r = map.get(key)!;
        r.totalBilled += a.amount ?? 0;
        if (monthSet.has(a.billing_month)) {
          r.monthlyAmounts[a.billing_month] = (r.monthlyAmounts[a.billing_month] ?? 0) + (a.amount ?? 0);
          const statusPriority: Record<string, number> = {
            overdue: 7, invoiced: 6, paid: 5, adjustment: 4, deferred: 3, cancelled: 2, scheduled: 1, draft: 0,
          };
          const prevSt = r.monthlyStatus[a.billing_month];
          const cur = a.billing_status ?? "scheduled";
          if (!prevSt || (statusPriority[cur] ?? 0) > (statusPriority[prevSt] ?? 0)) {
            r.monthlyStatus[a.billing_month] = cur;
          }
        }
      }

      // 入金合算 + 売掛金残額計算
      const paidByClient = new Map<string, number>();
      for (const p of payments) {
        paidByClient.set(p.client_number, (paidByClient.get(p.client_number) ?? 0) + p.amount);
      }
      const outstandingByClient = new Map<string, number>();
      const addOutstanding = (cn: string, v: number) => {
        outstandingByClient.set(cn, (outstandingByClient.get(cn) ?? 0) + v);
      };
      for (const a of allAmounts) {
        const st = a.billing_status ?? "scheduled";
        const inv = a.invoiced_amount ?? a.amount ?? 0;
        const pay = a.paid_amount ?? 0;
        const amt = a.amount ?? 0;
        switch (st) {
          case "invoiced":
          case "overdue":
            addOutstanding(a.client_number, inv);
            break;
          case "paid":
            addOutstanding(a.client_number, inv - pay);
            break;
          case "adjustment":
            addOutstanding(a.client_number, amt);
            break;
          default:
            break;
        }
      }
      const clientOutstanding = new Map<string, number>();
      for (const [cn, bal] of outstandingByClient) {
        const extraPaid = paidByClient.get(cn) ?? 0;
        clientOutstanding.set(cn, bal - extraPaid);
      }

      const result = [...map.values()].map((r) => ({
        ...r,
        totalPaid: paidByClient.get(r.client_number) ?? 0,
        outstanding: clientOutstanding.get(r.client_number) ?? 0,
      }));

      result.sort((a, b) => {
        const byName = a.client_name.localeCompare(b.client_name, "ja");
        if (byName !== 0) return byName;
        const byOffice = a.office_name.localeCompare(b.office_name, "ja");
        if (byOffice !== 0) return byOffice;
        const segOrder: Record<BillingSegment, number> = { 介護: 0, 障害: 1, 自費: 2 };
        return segOrder[a.segment] - segOrder[b.segment];
      });
      rows = result;
    }
  }

  return (
    <BillingContent
      companies={companies}
      offices={offices}
      availableMonths={availableMonths}
      selectedCompanyId={selectedCompanyId}
      selectedOfficeNum={selectedOfficeNum}
      selectedMonth={selectedMonth}
      monthColumns={monthColumns}
      rows={rows}
    />
  );
}
