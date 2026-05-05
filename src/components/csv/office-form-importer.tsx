"use client";

import { useState, useEffect, useCallback } from "react";
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
import { parseOfficeFormFile } from "@/lib/csv/office-form-parser";
import type { OfficeFormRecord, CsvParseResult } from "@/types/csv";
import { supabase } from "@/lib/supabase";
import { OFFICE_MASTER_JOIN, flattenOfficeMaster } from "@/types/database";
import { toast } from "sonner";

const RECORD_TYPE_LABELS: Record<string, string> = {
  leave:     "休暇",
  training:  "研修",
  km:        "km",
  childcare: "育児手当",
};

type Office = { id: string; name: string; short_name: string; office_number: string };

export function OfficeFormImporter() {
  const [files, setFiles] = useState<File[]>([]);
  const [results, setResults] = useState<CsvParseResult<OfficeFormRecord>[]>([]);
  const [allData, setAllData] = useState<OfficeFormRecord[]>([]);
  const [isParsing, setIsParsing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [imported, setImported] = useState(false);
  const [offices, setOffices] = useState<Office[]>([]);
  const [existingMonths, setExistingMonths] = useState<{ month: string; office_number: string; count: number }[]>([]);
  const [selectedProcessingMonth, setSelectedProcessingMonth] = useState<string>(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });

  const fetchExistingMonths = useCallback(async () => {
    // office_form_recordsは毎月増えていくため1000件上限対応のページング取得
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
    const sorted = [...countMap.entries()]
      .map(([key, count]) => {
        const [month, office_number] = key.split("__");
        return { month, office_number, count };
      })
      .sort((a, b) => b.month.localeCompare(a.month));
    setExistingMonths(sorted);
  }, []);

  useEffect(() => {
    fetchExistingMonths();
    supabase.from("payroll_offices").select(`id, short_name, office_number, ${OFFICE_MASTER_JOIN}`)
      .then(({ data }) => {
        const flattened = flattenOfficeMaster(data as never) as unknown as Office[];
        flattened.sort((a, b) => a.name.localeCompare(b.name, "ja"));
        setOffices(flattened);
      });
  }, [fetchExistingMonths]);

  const handleClearMonth = async (month: string, office_number: string, count: number) => {
    const label = `${month.slice(0, 4)}年${parseInt(month.slice(4, 6), 10)}月`;
    const _o = offices.find((o) => o.office_number === office_number);
    const officeName = (_o?.short_name || _o?.name) ?? office_number;
    if (!confirm(`${officeName} ${label}の事業所書式データ（${count}件）を削除しますか？`)) return;
    const { error } = await supabase
      .from("payroll_office_form_records")
      .delete()
      .eq("processing_month", month)
      .eq("office_number", office_number);
    if (error) { toast.error(`削除エラー: ${error.message}`); return; }
    toast.success(`${officeName} ${label}のデータを削除しました`);
    fetchExistingMonths();
  };

  const handleFilesSelected = async (newFiles: File[]) => {
    setIsParsing(true);
    setImported(false);
    const all: OfficeFormRecord[] = [];
    const res: CsvParseResult<OfficeFormRecord>[] = [];
    for (const f of newFiles) {
      const r = await parseOfficeFormFile(f);
      res.push(r);
      all.push(...r.data);
    }
    setFiles((prev) => [...prev, ...newFiles]);
    setResults((prev) => [...prev, ...res]);
    setAllData((prev) => [...prev, ...all]);
    setIsParsing(false);
  };

  const handleClear = () => {
    setFiles([]);
    setResults([]);
    setAllData([]);
    setImported(false);
  };

  const handleImport = async () => {
    if (allData.length === 0) return;
    if (!selectedProcessingMonth) { toast.error("処理月を選択してください"); return; }
    setIsImporting(true);

    try {
      const processingMonth = selectedProcessingMonth.replace("-", "");
      const officeNumber    = allData[0]?.office_number ?? "";

      const { data: batch, error: batchError } = await supabase
        .from("payroll_import_batches")
        .insert({
          import_type: "office_form" as const,
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

      const chunkSize = 500;
      for (let i = 0; i < allData.length; i += chunkSize) {
        const chunk = allData.slice(i, i + chunkSize);
        const records = chunk.map((r) => ({
          import_batch_id: batch.id,
          office_number: r.office_number,
          employee_number: r.employee_number,
          processing_month: processingMonth,
          record_type: r.record_type,
          item_name: r.item_name,
          item_date: r.item_date ?? null,
          start_time: r.start_time ?? null,
          end_time: r.end_time ?? null,
          break_time: r.break_time ?? null,
          numeric_value: r.numeric_value ?? null,
          year_month: r.year_month ?? null,
          child_name: r.child_name ?? null,
          amount: r.amount ?? null,
        }));

        const { error: insertError } = await supabase
          .from("payroll_office_form_records")
          .insert(records);

        if (insertError) {
          await supabase
            .from("payroll_import_batches")
            .update({ status: "error" as const, error_message: insertError.message })
            .eq("id", batch.id);
          toast.error(`登録エラー: ${insertError.message}`);
          return;
        }
      }

      await supabase
        .from("payroll_import_batches")
        .update({ status: "completed" as const })
        .eq("id", batch.id);

      setImported(true);
      toast.success(`${allData.length}件の事業所書式データを登録しました`);
      fetchExistingMonths();
    } catch (e) {
      toast.error(`エラー: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsImporting(false);
    }
  };

  const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);
  const monthLabel = selectedProcessingMonth
    ? `${selectedProcessingMonth.slice(0, 4)}年${parseInt(selectedProcessingMonth.slice(5, 7), 10)}月`
    : "";

  const preview = allData.slice(0, 100);

  return (
    <div className="space-y-4">
      {/* 取り込み済みデータ（事業所 × 月 の行列表示） */}
      {existingMonths.length > 0 && (() => {
        const byOfficeMonth = new Map<string, number>();
        const officeSet = new Set<string>();
        const monthSet = new Set<string>();
        for (const { month, office_number, count } of existingMonths) {
          byOfficeMonth.set(`${office_number}|${month}`, count);
          officeSet.add(office_number);
          monthSet.add(month);
        }
        const monthList = [...monthSet].sort().reverse();
        const officeList = [...officeSet].sort((a, b) => {
          const _oa = offices.find((o) => o.office_number === a);
          const _ob = offices.find((o) => o.office_number === b);
          return ((_oa?.short_name || _oa?.name) ?? a).localeCompare((_ob?.short_name || _ob?.name) ?? b, "ja");
        });
        const fmtMonth = (m: string) => `${m.slice(0, 4)}/${m.slice(4, 6)}`;
        const grandTotal = [...byOfficeMonth.values()].reduce((s, n) => s + n, 0);

        return (
          <div className="border rounded-md overflow-hidden">
            <div className="px-3 py-2 bg-muted/40 flex items-center justify-between">
              <span className="text-sm font-medium">取り込み済みデータ</span>
              <span className="text-xs text-muted-foreground">
                {officeList.length}事業所 × {monthList.length}ヶ月・総{grandTotal.toLocaleString()}件
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/20 border-b">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-medium sticky left-0 bg-muted/20 z-10 min-w-[180px]">事業所</th>
                    {monthList.map((m) => (
                      <th key={m} className="text-right px-3 py-1.5 font-medium whitespace-nowrap">{fmtMonth(m)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {officeList.map((office_number) => {
                    const _oc = offices.find((o) => o.office_number === office_number);
                    const officeName = (_oc?.short_name || _oc?.name) ?? office_number;
                    return (
                      <tr key={office_number} className="border-b last:border-b-0 hover:bg-muted/10">
                        <td className="px-3 py-1.5 sticky left-0 bg-background">{officeName}</td>
                        {monthList.map((m) => {
                          const count = byOfficeMonth.get(`${office_number}|${m}`);
                          return (
                            <td key={m} className="px-3 py-1.5 text-right whitespace-nowrap">
                              {count == null ? (
                                <span className="text-muted-foreground/40">—</span>
                              ) : (
                                <span className="inline-flex items-center gap-1">
                                  <span className="font-mono">{count.toLocaleString()}</span>
                                  <button
                                    onClick={() => handleClearMonth(m, office_number, count)}
                                    className="text-destructive hover:text-destructive/80 text-[10px] ml-0.5"
                                    title="この月のデータを削除"
                                  >
                                    ✕
                                  </button>
                                </span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      <div className="flex items-center gap-3">
        <label className="text-sm font-medium whitespace-nowrap">処理月</label>
        <input
          type="month"
          className="border rounded px-3 py-1.5 text-sm bg-background"
          value={selectedProcessingMonth}
          onChange={(e) => setSelectedProcessingMonth(e.target.value)}
        />
        {monthLabel && <span className="text-sm text-muted-foreground">{monthLabel}分として登録します</span>}
      </div>

      <FileDropzone
        onFilesSelected={handleFilesSelected}
        label="事業所書式CSVファイルをドロップ"
        description="事業所書式CSVファイルを選択またはドラッグ&ドロップ（複数可）"
      />

      {files.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            {results.map((r, i) => (
              <Badge key={i} variant={r.errors.length > 0 ? "destructive" : "secondary"}>
                {r.fileName} ({r.data.length}件)
              </Badge>
            ))}
            <Button variant="ghost" size="sm" onClick={handleClear}>クリア</Button>
          </div>

          {totalErrors > 0 && (
            <Alert variant="destructive">
              <AlertDescription>
                {results.filter((r) => r.errors.length > 0).map((r) =>
                  r.errors.map((e, i) => (
                    <div key={`${r.fileName}-${i}`}>{r.fileName}: {e}</div>
                  ))
                )}
              </AlertDescription>
            </Alert>
          )}

          {allData.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  {isParsing ? "解析中..." : `${allData.length}件（${monthLabel}）`}
                </p>
                <Button onClick={handleImport} disabled={isImporting || imported}>
                  {isImporting ? "登録中..." : imported ? "登録済み" : "データベースに登録"}
                </Button>
              </div>

              <ScrollArea className="h-[400px] border rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>社員番号</TableHead>
                      <TableHead>種別</TableHead>
                      <TableHead>項目名</TableHead>
                      <TableHead>日付</TableHead>
                      <TableHead>開始</TableHead>
                      <TableHead>終了</TableHead>
                      <TableHead className="text-right">数値</TableHead>
                      <TableHead>年月</TableHead>
                      <TableHead>金額</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.map((r, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-xs font-mono">{r.employee_number}</TableCell>
                        <TableCell className="text-xs">
                          <span className="px-1.5 py-0.5 rounded-full bg-muted text-xs">
                            {RECORD_TYPE_LABELS[r.record_type]}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs">{r.item_name}</TableCell>
                        <TableCell className="text-xs">{r.item_date ?? "—"}</TableCell>
                        <TableCell className="text-xs">{r.start_time ?? "—"}</TableCell>
                        <TableCell className="text-xs">{r.end_time ?? "—"}</TableCell>
                        <TableCell className="text-xs text-right">
                          {r.numeric_value != null ? r.numeric_value.toLocaleString() : "—"}
                        </TableCell>
                        <TableCell className="text-xs">{r.year_month ?? "—"}</TableCell>
                        <TableCell className="text-xs">
                          {r.amount != null ? r.amount.toLocaleString() + "円" : "—"}
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
