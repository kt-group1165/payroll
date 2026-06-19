import { createClient } from "@/lib/supabase/server";
import {
  OFFICE_MASTER_JOIN,
  flattenOfficeMaster,
  type Office,
} from "@/types/database";
import { OfficeInputContent } from "./office-input-content";

/**
 * /office-input
 * 事業所書式入力画面。既存 xlsm 「【中央】事業所書式完成（最新）.xlsm」の置換。
 *
 * Server Component: offices を server-side で取得し、
 * `<OfficeInputContent>` (client component) に initial props で渡す。
 * スタッフ一覧・エントリは client 側で動的に load (= 事業所/月 切替時に refetch)。
 */
export default async function OfficeInputPage() {
  const supabase = await createClient();

  const offRes = await supabase
    .from("payroll_offices")
    .select(`*, ${OFFICE_MASTER_JOIN}`);

  let offices: Office[] = [];
  if (offRes.data) {
    offices = flattenOfficeMaster(offRes.data as never) as unknown as Office[];
    offices.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  }

  return <OfficeInputContent offices={offices} />;
}
