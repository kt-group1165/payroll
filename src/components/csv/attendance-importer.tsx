"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileDropzone } from "./file-dropzone";
import { parseAttendanceFiles } from "@/lib/csv/attendance-parser";
import type { ParsedAttendance, CsvParseResult } from "@/types/csv";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";

export function AttendanceImporter() {
  const [files, setFiles] = useState<File[]>([]);
  const [results, setResults] = useState<
    CsvParseResult<ParsedAttendance>[]
  >([]);
  const [allData, setAllData] = useState<ParsedAttendance[]>([]);
  const [isParsing, setIsParsing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [imported, setImported] = useState(false);

  const handleFilesSelected = async (newFiles: File[]) => {
    const csvFiles = [...files, ...newFiles];
    setFiles(csvFiles);
    setIsParsing(true);
    setImported(false);

    try {
      const { allData: parsed, results: parseResults } =
        await parseAttendanceFiles(csvFiles);
      setAllData(parsed);
      setResults(parseResults);
    } finally {
      setIsParsing(false);
    }
  };

  const handleClear = () => {
    setFiles([]);
    setResults([]);
    setAllData([]);
    setImported(false);
  };

  const handleImport = async () => {
    if (allData.length === 0) return;
    setIsImporting(true);

    try {
      // 重複チェック（既存データがあれば取り込み不可）
      const duplicates: string[] = [];
      for (const attendance of allData) {
        const { meta } = attendance;
        const { count } = await supabase
          .from("attendance_records")
          .select("id", { count: "exact", head: true })
          .eq("employee_number", meta.employeeNumber)
          .eq("year", meta.year)
          .eq("month", meta.month);
        if (count && count > 0) {
          duplicates.push(`${meta.employeeName}（${meta.year}年${meta.month}月）`);
        }
      }

      if (duplicates.length > 0) {
        toast.error(
          `以下のデータはすでに登録されています。労働時間管理画面でデータを削除してから取り込んでください。\n${duplicates.join("、")}`
        );
        setIsImporting(false);
        return;
      }

      for (const attendance of allData) {
        const { meta, rows } = attendance;

        // バッチ作成
        const { data: batch, error: batchError } = await supabase
          .from("import_batches")
          .insert({
            import_type: "attendance" as const,
            file_names: [
              `${meta.year}年${meta.month}月_${meta.employeeNumber}_${meta.employeeName}`,
            ],
            record_count: rows.length,
            processing_month: `${meta.year}${String(meta.month).padStart(2, "0")}`,
            office_number: meta.officeNumber,
            status: "pending" as const,
          })
          .select()
          .single();

        if (batchError || !batch) {
          toast.error(`バッチ作成エラー: ${batchError?.message}`);
          continue;
        }

        const records = rows.map((row) => ({
          import_batch_id: batch.id,
          office_number: meta.officeNumber,
          employee_number: meta.employeeNumber,
          employee_name: meta.employeeName,
          year: meta.year,
          month: meta.month,
          day: parseInt(row.日付, 10),
          day_of_week: row.曜日,
          substitute_date: row.振替日,
          work_note_1: row.勤務摘要,
          work_note_2: row.勤務摘要2,
          work_note_3: row.勤務摘要3,
          work_note_4: row.勤務摘要4,
          work_note_5: row.勤務摘要5,
          start_time_1: row.開始,
          end_time_1: row.終了,
          start_time_2: row.開始2,
          end_time_2: row.終了2,
          start_time_3: row.開始3,
          end_time_3: row.終了3,
          start_time_4: row.開始4,
          end_time_4: row.終了4,
          start_time_5: row.開始5,
          end_time_5: row.終了5,
          break_time: row.休憩,
          work_hours: row.勤務時間,
          commute_km: row.通勤km
            ? parseFloat(row.通勤km) || null
            : null,
          business_km: row.出張km
            ? parseFloat(row.出張km) || null
            : null,
          overtime_weekly: row.週残業 ?? "",
          overtime_daily: row.日残業 ?? "",
          holiday_work: row.休日 ?? "",
          legal_overtime: row.法内残業 ?? "",
          deduction: row.控除 ?? "",
          remarks: row.備考 ?? "",
        }));

        const { error: insertError } = await supabase
          .from("attendance_records")
          .insert(records);

        if (insertError) {
          await supabase
            .from("import_batches")
            .update({
              status: "error" as const,
              error_message: insertError.message,
            })
            .eq("id", batch.id);
          toast.error(
            `${meta.employeeName}のデータ登録エラー: ${insertError.message}`
          );
          continue;
        }

        await supabase
          .from("import_batches")
          .update({ status: "completed" as const })
          .eq("id", batch.id);
      }

      setImported(true);
      const totalRows = allData.reduce(
        (sum, a) => sum + a.rows.length,
        0
      );
      toast.success(
        `${allData.length}名分（${totalRows}日分）の出勤簿を登録しました`
      );
    } catch (e) {
      toast.error(
        `エラー: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setIsImporting(false);
    }
  };

  const totalErrors = results.reduce(
    (sum, r) => sum + r.errors.length,
    0
  );

  return (
    <div className="space-y-4">
      <FileDropzone
        onFilesSelected={handleFilesSelected}
        label="出勤簿CSVファイルをドロップ"
        description="出勤簿CSVファイルを選択またはドラッグ&ドロップ（複数可）"
      />

      {files.length > 0 && (
        <div className="space-y-4">
          {/* ファイル一覧 */}
          <div className="flex items-center gap-2 flex-wrap">
            {results.map((r, i) => (
              <Badge
                key={i}
                variant={
                  r.errors.length > 0 ? "destructive" : "secondary"
                }
              >
                {r.fileName}
                {r.data[0] &&
                  ` (${r.data[0].meta.employeeName} ${r.data[0].rows.length}日)`}
              </Badge>
            ))}
            <Button variant="ghost" size="sm" onClick={handleClear}>
              クリア
            </Button>
          </div>

          {/* エラー表示 */}
          {totalErrors > 0 && (
            <Alert variant="destructive">
              <AlertDescription>
                {results
                  .filter((r) => r.errors.length > 0)
                  .map((r) =>
                    r.errors.map((e, i) => (
                      <div key={`${r.fileName}-${i}`}>
                        {r.fileName}: {e}
                      </div>
                    ))
                  )}
              </AlertDescription>
            </Alert>
          )}

          {/* プレビュー */}
          {allData.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  {isParsing
                    ? "解析中..."
                    : `${allData.length}名分の出勤簿`}
                </p>
                <Button
                  onClick={handleImport}
                  disabled={isImporting || imported}
                >
                  {isImporting
                    ? "登録中..."
                    : imported
                      ? "登録済み"
                      : "データベースに登録"}
                </Button>
              </div>

              {allData.map((attendance, idx) => (
                <div key={idx}>
                  <h4 className="font-medium text-sm mb-2">
                    {attendance.meta.employeeName}（社員番号:{" "}
                    {attendance.meta.employeeNumber}）
                    {attendance.meta.year}年{attendance.meta.month}月
                  </h4>
                  <ScrollArea className="h-[300px] border rounded-md">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[40px]">日</TableHead>
                          <TableHead className="w-[30px]">曜</TableHead>
                          <TableHead className="w-[80px]">摘要</TableHead>
                          <TableHead className="w-[50px]">開始</TableHead>
                          <TableHead className="w-[50px]">終了</TableHead>
                          <TableHead className="w-[50px]">休憩</TableHead>
                          <TableHead className="w-[60px]">勤務時間</TableHead>
                          <TableHead className="w-[50px]">出張km</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {attendance.rows.map((row, i) => (
                          <TableRow key={i}>
                            <TableCell className="text-xs">
                              {row.日付}
                            </TableCell>
                            <TableCell className="text-xs">
                              {row.曜日}
                            </TableCell>
                            <TableCell className="text-xs">
                              {row.勤務摘要}
                            </TableCell>
                            <TableCell className="text-xs">
                              {row.開始}
                            </TableCell>
                            <TableCell className="text-xs">
                              {row.終了}
                            </TableCell>
                            <TableCell className="text-xs">
                              {row.休憩}
                            </TableCell>
                            <TableCell className="text-xs">
                              {row.勤務時間}
                            </TableCell>
                            <TableCell className="text-xs">
                              {row.出張km}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                  <p className="text-xs text-muted-foreground mt-1">
                    合計: 勤務{attendance.totals.workHours} / 出張
                    {attendance.totals.businessKm}km / 残業
                    {attendance.totals.overtimeHours}
                  </p>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
