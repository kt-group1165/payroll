import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  MeisaiImporter,
  type MeisaiExistingMonth,
} from "@/components/csv/meisai-importer";
import {
  AttendanceImporter,
  type AttendanceExistingCount,
} from "@/components/csv/attendance-importer";
import {
  OfficeFormImporter,
  type OfficeFormExistingMonth,
} from "@/components/csv/office-form-importer";
import { ClientImporter } from "@/components/csv/client-importer";
import { createClient } from "@/lib/supabase/server";
import { OFFICE_MASTER_JOIN, flattenOfficeMaster } from "@/types/database";

interface OfficeForImporters {
  id: string;
  office_number: string;
  name: string;
  short_name: string;
  office_type: string;
}

type SupabaseLike = Awaited<ReturnType<typeof createClient>>;

async function fetchAttendanceCounts(supabase: SupabaseLike): Promise<AttendanceExistingCount[]> {
  const counts = new Map<string, number>();
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from("payroll_attendance_records")
      .select("year, month, office_number")
      .range(from, from + pageSize - 1);
    if (!data || data.length === 0) break;
    for (const r of data as { year: number; month: number; office_number: string }[]) {
      const ym = `${r.year}${String(r.month).padStart(2, "0")}`;
      const key = `${ym}|${r.office_number}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return [...counts.entries()].map(([k, count]) => {
    const [month, office_number] = k.split("|");
    return { month, office_number, count };
  });
}

async function fetchMeisaiMonths(supabase: SupabaseLike): Promise<MeisaiExistingMonth[]> {
  const countMap = new Map<string, number>();
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from("payroll_service_records")
      .select("processing_month,office_number")
      .range(from, from + pageSize - 1);
    if (!data || data.length === 0) break;
    for (const r of data as { processing_month: string; office_number: string }[]) {
      const key = `${r.processing_month}__${r.office_number}`;
      countMap.set(key, (countMap.get(key) ?? 0) + 1);
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return [...countMap.entries()]
    .map(([key, count]) => {
      const [month, office_number] = key.split("__");
      return { month, office_number, count };
    })
    .sort((a, b) => b.month.localeCompare(a.month) || a.office_number.localeCompare(b.office_number));
}

async function fetchOfficeFormMonths(supabase: SupabaseLike): Promise<OfficeFormExistingMonth[]> {
  const countMap = new Map<string, number>();
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from("payroll_office_form_records")
      .select("processing_month,office_number")
      .range(from, from + pageSize - 1);
    if (!data || data.length === 0) break;
    for (const r of data as { processing_month: string; office_number: string }[]) {
      const key = `${r.processing_month}__${r.office_number}`;
      countMap.set(key, (countMap.get(key) ?? 0) + 1);
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return [...countMap.entries()]
    .map(([key, count]) => {
      const [month, office_number] = key.split("__");
      return { month, office_number, count };
    })
    .sort((a, b) => b.month.localeCompare(a.month));
}

/**
 * /csv-import
 * CSV取り込みページ。3 つの importer (meisai / attendance / office_form) と
 * client importer を tab で並べる。3 importer の事業所一覧と既存件数集計は
 * Server Component で並列 fetch し、initial props として渡す。
 */
export default async function CsvImportPage() {
  const supabase = await createClient();

  const [officesRes, attendanceCounts, meisaiMonths, officeFormMonths] = await Promise.all([
    supabase
      .from("payroll_offices")
      .select(`id, office_number, short_name, office_type, ${OFFICE_MASTER_JOIN}`),
    fetchAttendanceCounts(supabase),
    fetchMeisaiMonths(supabase),
    fetchOfficeFormMonths(supabase),
  ]);

  const offices = (
    flattenOfficeMaster((officesRes.data ?? []) as never) as unknown as OfficeForImporters[]
  ).sort((a, b) => a.name.localeCompare(b.name, "ja"));

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">CSV取り込み</h2>
      <Tabs defaultValue="meisai">
        <TabsList>
          <TabsTrigger value="meisai">介護ソフトCSV</TabsTrigger>
          <TabsTrigger value="attendance">出勤簿</TabsTrigger>
          <TabsTrigger value="office_form">事業所書式</TabsTrigger>
          <TabsTrigger value="clients">利用者</TabsTrigger>
        </TabsList>
        <TabsContent value="meisai" className="mt-4">
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
        <TabsContent value="clients" className="mt-4">
          <ClientImporter />
        </TabsContent>
      </Tabs>
    </div>
  );
}
