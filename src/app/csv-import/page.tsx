import Link from "next/link";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MeisaiImporter } from "@/components/csv/meisai-importer";
import { AttendanceImporter } from "@/components/csv/attendance-importer";
import { OfficeFormImporter } from "@/components/csv/office-form-importer";
import { ClientImporter } from "@/components/csv/client-importer";
import { KyotakuImporter } from "@/components/csv/kyotaku-importer";
import { YobouImporter } from "@/components/csv/yobou-importer";
import { KaigoMeisaiImporter } from "@/components/kaigo/kaigo-meisai-importer";
import { DataSourceModeSwitch } from "@/components/kaigo/data-source-mode-switch";
import { getJissekiSourceMode } from "@/lib/app-settings";
import {
  fetchServiceRecordCounts,
  fetchAttendanceRecordCounts,
  fetchOfficeFormRecordCounts,
} from "@/lib/import-counts";
import { createClient } from "@/lib/supabase/server";
import { OFFICE_MASTER_JOIN, flattenOfficeMaster } from "@/types/database";

const KYOTAKU_TENANT_ID = "kt-group"; // payroll_kyotaku_records.tenant_id (seed と整合)

interface OfficeForImporters {
  id: string;
  office_number: string;
  name: string;
  short_name: string;
  office_type: string;
  office_id: string | null; // 共通 offices.id (kaigo 直接取込の事業所紐付けに使用)
}

// 件数集計は 8 万行超の全件ページングを避けるため RPC (GROUP BY) を使う
// (未適用環境は import-counts 内で従来スキャンへ fallback)

/**
 * /csv-import
 * CSV取り込みページ。3 つの importer (meisai / attendance / office_form) と
 * client importer を tab で並べる。3 importer の事業所一覧と既存件数集計は
 * Server Component で並列 fetch し、initial props として渡す。
 */
export default async function CsvImportPage() {
  const supabase = await createClient();

  const [officesRes, attendanceCounts, meisaiMonths, officeFormMonths, sourceMode] = await Promise.all([
    supabase
      .from("payroll_offices")
      .select(`id, office_number, short_name, office_type, office_id, ${OFFICE_MASTER_JOIN}`),
    fetchAttendanceRecordCounts(supabase),
    fetchServiceRecordCounts(supabase),
    fetchOfficeFormRecordCounts(supabase),
    getJissekiSourceMode(supabase),
  ]);

  const offices = (
    flattenOfficeMaster((officesRes.data ?? []) as never) as unknown as OfficeForImporters[]
  ).sort((a, b) => a.name.localeCompare(b.name, "ja"));

  // kaigo 直接取込の対象は kaigo-app に実績データがある業種のみ
  const kaigoPullOffices = offices.filter(
    (o) => o.office_type === "訪問介護" || o.office_type === "訪問入浴",
  );

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">実績データ取り込み</h2>
      <div className="mb-4">
        <DataSourceModeSwitch initialMode={sourceMode} />
      </div>
      <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm flex items-center justify-between gap-3 flex-wrap">
        <div>
          <span className="font-semibold">📂 フォルダごと一括取込したい場合</span>
          <span className="text-muted-foreground ml-2">
            このページは <span className="font-mono">1 ファイルずつ</span> の取込です。フォルダ drop は非対応。
          </span>
        </div>
        <Link
          href="/csv-import/batch"
          className="inline-flex items-center gap-1 px-3 py-1 rounded bg-blue-600 text-white text-xs hover:bg-blue-700"
        >
          一括取込 (フォルダ) ページへ →
        </Link>
      </div>
      <Tabs defaultValue={sourceMode === "kaigo" ? "kaigo" : "meisai"}>
        <TabsList>
          <TabsTrigger value="kaigo">介護システム連携</TabsTrigger>
          <TabsTrigger value="meisai">介護ソフトCSV</TabsTrigger>
          <TabsTrigger value="attendance">出勤簿</TabsTrigger>
          <TabsTrigger value="office_form">事業所書式</TabsTrigger>
          <TabsTrigger value="kyotaku">居宅介護支援</TabsTrigger>
          <TabsTrigger value="yobou">介護予防</TabsTrigger>
          <TabsTrigger value="clients">利用者</TabsTrigger>
        </TabsList>
        <TabsContent value="kaigo" className="mt-4">
          {sourceMode === "csv" && (
            <p className="mb-3 text-xs rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
              現在は <span className="font-semibold">CSV 取込モード</span>です。介護システム直接取込も実行できますが、
              運用を切り替える場合は上のスイッチで「介護システム直接モード」にしてください。
            </p>
          )}
          <KaigoMeisaiImporter initialOffices={kaigoPullOffices} />
        </TabsContent>
        <TabsContent value="meisai" className="mt-4">
          {sourceMode === "kaigo" && (
            <p className="mb-3 text-xs rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
              現在は <span className="font-semibold">介護システム直接モード</span>です。CSV 取込も実行できますが、
              同じ月 × 事業所に両方から取り込むと重複します。
            </p>
          )}
          <MeisaiImporter
            initialOffices={offices}
            initialExistingMonths={meisaiMonths}
          />
        </TabsContent>
        <TabsContent value="attendance" className="mt-4">
          <AttendanceImporter
            initialOffices={offices}
            initialExistingCounts={attendanceCounts}
          />
        </TabsContent>
        <TabsContent value="office_form" className="mt-4">
          <OfficeFormImporter
            initialOffices={offices}
            initialExistingMonths={officeFormMonths}
          />
        </TabsContent>
        <TabsContent value="kyotaku" className="mt-4">
          <KyotakuImporter
            tenantId={KYOTAKU_TENANT_ID}
            initialOffices={offices.filter((o) => o.office_type === "居宅介護支援")}
          />
        </TabsContent>
        <TabsContent value="yobou" className="mt-4">
          <YobouImporter
            tenantId={KYOTAKU_TENANT_ID}
            initialOffices={offices.filter((o) => o.office_type === "居宅介護支援")}
          />
        </TabsContent>
        <TabsContent value="clients" className="mt-4">
          <ClientImporter />
        </TabsContent>
      </Tabs>
    </div>
  );
}
