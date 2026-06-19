/**
 * /csv-import/batch
 *
 * フォルダドラッグで複数 CSV を一気に取込むページ。
 * 既存 importer (kyotaku / yobou / meisai / billing) を tab 切替で 1 つずつ取り込んでいた
 * 旧 UI とは別物。判定 → 補完 → 一括実行 のフローを提供する。
 *
 * Server Component で payroll_offices を fetch し、Client Component に props として渡す。
 */

import { BatchImporterClient } from "./batch-importer-client";
import { createClient } from "@/lib/supabase/server";
import { OFFICE_MASTER_JOIN, flattenOfficeMaster } from "@/types/database";

const KYOTAKU_TENANT_ID = "kt-group";

export type BatchOffice = {
  id: string;
  office_number: string;
  name: string;
  short_name: string;
  office_type: string;
};

export default async function CsvImportBatchPage() {
  const supabase = await createClient();
  const { data: officesRaw } = await supabase
    .from("payroll_offices")
    .select(`id, office_number, short_name, office_type, ${OFFICE_MASTER_JOIN}`);
  const offices = (
    flattenOfficeMaster((officesRaw ?? []) as never) as unknown as BatchOffice[]
  ).sort((a, b) => a.name.localeCompare(b.name, "ja"));

  return (
    <div>
      <h2 className="text-2xl font-bold mb-2">実績ファイル 一括取込</h2>
      <p className="text-sm text-muted-foreground mb-6">
        フォルダごとドラッグして、複数 CSV を一気に取込みます。
        種別 / 事業所番号 / 年月 はファイル名と中身から自動判定し、判定できないものは手動で補完してください。
      </p>
      <BatchImporterClient offices={offices} tenantId={KYOTAKU_TENANT_ID} />
    </div>
  );
}
