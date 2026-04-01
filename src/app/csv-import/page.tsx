import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MeisaiImporter } from "@/components/csv/meisai-importer";
import { AttendanceImporter } from "@/components/csv/attendance-importer";

export default function CsvImportPage() {
  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">CSV取り込み</h2>
      <Tabs defaultValue="meisai">
        <TabsList>
          <TabsTrigger value="meisai">介護ソフトCSV</TabsTrigger>
          <TabsTrigger value="attendance">出勤簿</TabsTrigger>
        </TabsList>
        <TabsContent value="meisai" className="mt-4">
          <MeisaiImporter />
        </TabsContent>
        <TabsContent value="attendance" className="mt-4">
          <AttendanceImporter />
        </TabsContent>
      </Tabs>
    </div>
  );
}
