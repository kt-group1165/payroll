import { createClient } from "@/lib/supabase/server";
import { fetchAllPagesParallel } from "@/lib/fetch-all";
import {
  OFFICE_MASTER_JOIN,
  flattenOfficeMaster,
  type Client,
  type Office,
} from "@/types/database";
import { ClientsList } from "./clients-list";

/**
 * /clients
 * 利用者一覧 + 編集 dialog + CSV import/export。
 *
 * Server Component: 全利用者と offices を server-side で取得し、`<ClientsList>`
 * (client component) に initial props で渡す。保存・削除・取込後は client 側で
 * `router.refresh()` を呼んで RSC 再評価。
 *
 * Perf: payroll_clients は kt-group 実測 9,000 行超。順次 page-loop だと round trip
 * が 10 連続で数秒の wait に直結するため、count + Promise.all で全 page を並列発火。
 */
export default async function ClientsPage() {
  const supabase = await createClient();

  const [clients, offRes] = await Promise.all([
    fetchAllPagesParallel<Client>(
      () => supabase.from("payroll_clients").select("*", { count: "exact", head: true }),
      (from, to) =>
        supabase
          .from("payroll_clients")
          .select("*")
          .order("client_number")
          .range(from, to) as unknown as PromiseLike<{ data: Client[] | null }>,
    ),
    supabase.from("payroll_offices").select(`*, ${OFFICE_MASTER_JOIN}`),
  ]);

  let offices: Office[] = [];
  if (offRes.data) {
    offices = flattenOfficeMaster(offRes.data as never) as unknown as Office[];
    offices.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  }

  return <ClientsList initialClients={clients} offices={offices} />;
}
