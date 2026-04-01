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
import { parseMeisaiFiles } from "@/lib/csv/meisai-parser";
import type { MeisaiRow, CsvParseResult } from "@/types/csv";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";

export function MeisaiImporter() {
  const [files, setFiles] = useState<File[]>([]);
  const [results, setResults] = useState<CsvParseResult<MeisaiRow>[]>([]);
  const [allData, setAllData] = useState<MeisaiRow[]>([]);
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
        await parseMeisaiFiles(csvFiles);
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
      // バッチ作成
      const processingMonth =
        allData[0]?.処理月 ?? "";
      const officeNumber =
        allData[0]?.事業所番号 ?? "";

      const { data: batch, error: batchError } = await supabase
        .from("import_batches")
        .insert({
          import_type: "meisai" as const,
          file_names: files.map((f) => f.name),
          record_count: allData.length,
          processing_month: processingMonth,
          office_number: officeNumber,
          status: "pending" as const,
        })
        .select()
        .single();

      if (batchError || !batch) {
        toast.error(`バッチ作成エラー: ${batchError?.message}`);
        return;
      }

      // データを500件ずつ分割して挿入
      const chunkSize = 500;
      for (let i = 0; i < allData.length; i += chunkSize) {
        const chunk = allData.slice(i, i + chunkSize);
        const records = chunk.map((row) => ({
          import_batch_id: batch.id,
          office_number: row.事業所番号,
          office_name: row.事業者名,
          processing_month: row.処理月,
          employee_number: row.職員番号,
          employee_name: row.職員名.replace(/　様$/, "").replace(/　$/, ""),
          period_start: row.開始日,
          period_end: row.終了日,
          service_date: row.日付,
          dispatch_start_time: row.派遣開始時間,
          dispatch_end_time: row.派遣終了時間,
          client_name: row.利用者名,
          service_type: row.サービス,
          actual_start_time: row.実時刻開始時間,
          actual_end_time: row.実時刻終了時間,
          actual_duration: row.実時間,
          calc_start_time: row.算定開始時刻,
          calc_end_time: row.算定終了時刻,
          calc_duration: row.算定時間,
          holiday_type: row.休日区分,
          time_period: row.時間帯,
          service_category: row.サービス型,
          amount: row.金額 ? parseInt(row.金額, 10) || null : null,
          transport_fee: row.交通費
            ? parseInt(row.交通費, 10) || null
            : null,
          phone_fee: row.電話代
            ? parseInt(row.電話代, 10) || null
            : null,
          adjustment_fee: row.調整費
            ? parseInt(row.調整費, 10) || null
            : null,
          meeting_fee: row.会議費
            ? parseInt(row.会議費, 10) || null
            : null,
          training_fee: row.研修
            ? parseInt(row.研修, 10) || null
            : null,
          other_allowance: row.その他手当
            ? parseInt(row.その他手当, 10) || null
            : null,
          total: row.合計 ? parseInt(row.合計, 10) || null : null,
          accompanied_visit: row.同行訪問 ?? "",
          client_number: row.利用者番号,
          service_code: row.サービスコード,
        }));

        const { error: insertError } = await supabase
          .from("service_records")
          .insert(records);

        if (insertError) {
          await supabase
            .from("import_batches")
            .update({
              status: "error" as const,
              error_message: insertError.message,
            })
            .eq("id", batch.id);
          toast.error(`データ登録エラー: ${insertError.message}`);
          return;
        }
      }

      // バッチを完了に更新
      await supabase
        .from("import_batches")
        .update({ status: "completed" as const })
        .eq("id", batch.id);

      setImported(true);
      toast.success(
        `${allData.length}件のサービス実績を登録しました`
      );
    } catch (e) {
      toast.error(
        `エラー: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setIsImporting(false);
    }
  };

  const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);

  return (
    <div className="space-y-4">
      <FileDropzone
        onFilesSelected={handleFilesSelected}
        label="介護ソフトCSVファイルをドロップ"
        description="MEISAI_xxxxx.csv ファイルを選択またはドラッグ&ドロップ（複数可）"
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
                {r.fileName} ({r.data.length}件)
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

          {/* プレビューテーブル */}
          {allData.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  {isParsing
                    ? "解析中..."
                    : `${allData.length}件のレコード`}
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

              <ScrollArea className="h-[400px] border rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[60px]">日付</TableHead>
                      <TableHead className="min-w-[80px]">職員番号</TableHead>
                      <TableHead className="min-w-[100px]">職員名</TableHead>
                      <TableHead className="min-w-[80px]">開始</TableHead>
                      <TableHead className="min-w-[80px]">終了</TableHead>
                      <TableHead className="min-w-[100px]">利用者</TableHead>
                      <TableHead className="min-w-[80px]">サービス</TableHead>
                      <TableHead className="min-w-[60px]">時間</TableHead>
                      <TableHead className="min-w-[100px]">
                        サービス型
                      </TableHead>
                      <TableHead className="min-w-[60px] text-right">
                        金額
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {allData.slice(0, 100).map((row, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-xs">
                          {row.日付.replace(/^\d{4}\//, "")}
                        </TableCell>
                        <TableCell className="text-xs">
                          {row.職員番号}
                        </TableCell>
                        <TableCell className="text-xs">
                          {row.職員名.replace(/　様$/, "")}
                        </TableCell>
                        <TableCell className="text-xs">
                          {row.派遣開始時間}
                        </TableCell>
                        <TableCell className="text-xs">
                          {row.派遣終了時間}
                        </TableCell>
                        <TableCell className="text-xs">
                          {row.利用者名}
                        </TableCell>
                        <TableCell className="text-xs">
                          {row.サービス}
                        </TableCell>
                        <TableCell className="text-xs">
                          {row.算定時間}
                        </TableCell>
                        <TableCell className="text-xs">
                          {row.サービス型}
                        </TableCell>
                        <TableCell className="text-xs text-right">
                          {row.金額 ? `${Number(row.金額).toLocaleString()}` : "-"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {allData.length > 100 && (
                  <p className="p-2 text-center text-sm text-muted-foreground">
                    ...他 {allData.length - 100}件（プレビューは先頭100件）
                  </p>
                )}
              </ScrollArea>
            </>
          )}
        </div>
      )}
    </div>
  );
}
