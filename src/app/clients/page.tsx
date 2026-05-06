import { createClient } from "@/lib/supabase/server";
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
 * Server Component: 全利用者 (ページング) と offices を server-side で取得し、
 * `<ClientsList>` (client component) に initial props で渡す。
 * 保存・削除・取込後は client 側で `router.refresh()` を呼んで RSC 再評価。
 */
export default async function ClientsPage() {
  const supabase = await createClient();
  const pageSize = 1000;

  // 並列で 1 ページ目 + offices を取得
  const [first, offRes] = await Promise.all([
    supabase
      .from("payroll_clients")
      .select("*")
      .order("client_number")
      .range(0, pageSize - 1),
    supabase.from("payroll_offices").select(`*, ${OFFICE_MASTER_JOIN}`),
  ]);

  const clients: Client[] = (first.data ?? []) as Client[];
  // 1000件超は順次取得 (server-side なので await blocking で問題なし)
  if (clients.length === pageSize) {
    let from = pageSize;
    while (true) {
      const { data } = await supabase
        .from("payroll_clients")
        .select("*")
        .order("client_number")
        .range(from, from + pageSize - 1);
      if (!data || data.length === 0) break;
      clients.push(...(data as Client[]));
      if (data.length < pageSize) break;
      from += pageSize;
    }
  }

  let offices: Office[] = [];
  if (offRes.data) {
    offices = flattenOfficeMaster(offRes.data as never) as unknown as Office[];
    offices.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  }

  return <ClientsList initialClients={clients} offices={offices} />;
}
