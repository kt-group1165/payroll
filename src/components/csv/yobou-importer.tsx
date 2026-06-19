"use client";

/**
 * 介護予防支援 件数 CSV 取込 importer。
 *
 * - parser: @/lib/csv/yobou-parser parseYobouCsv
 * - target: payroll_kyotaku_yobou_records
 *           (UNIQUE: office_number, service_month, billing_month, staff_name)
 * - upsert は chunk 500 / ignoreDuplicates: true で再取込時に skip。
 *
 * kyotaku-importer.tsx を base に作成。違い:
 *   - parser は独自フォーマット (1 row = staff × 提供月 × 請求月 の集約)
 *   - 取込 source は 'csv' 固定 (手入力 tab は 'manual' で別 path)
 */

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
import {
  parseYobouCsv,
  type YobouCsvRow,
  type YobouParseError,
} from "@/lib/csv/yobou-parser";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProcessResult } from "@/lib/csv-import/types";

/**
 * batch UI 向けの process 関数。UI の handleImport の INSERT ロジックを抜き出した。
 * 既存 UI からは呼んでおらず、UI 単発取込の挙動は不変。
 */
export async function processYobouCsvFromBuffer(
  buffer: ArrayBuffer,
  opts: {
    tenantId: string;
    officeNumber: string;
    sourceFilename: string;
    supabase: SupabaseClient;
  },
): Promise<ProcessResult> {
  const parseRes = await parseYobouCsv(buffer);
  if (parseRes.errors.length > 0 && parseRes.rows.length === 0) {
    return {
      inserted: 0,
      skipped: 0,
      failed: 0,
      errors: parseRes.errors.slice(0, 5).map((e) => `行 ${e.line}: ${e.reason}`),
    };
  }

  const records = parseRes.rows.map((row) => ({
    tenant_id: opts.tenantId,
    office_number: opts.officeNumber,
    source: "csv" as const,
    source_filename: opts.sourceFilename,
    service_month: row.service_month,
    billing_month: row.billing_month,
    staff_name: row.staff_name,
    yobou1_count: row.yobou1_count,
    yobou2_count: row.yobou2_count,
  }));

  const ONCONFLICT = "office_number,service_month,billing_month,staff_name";
  const chunkSize = 500;
  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    const { data, error } = await opts.supabase
      .from("payroll_kyotaku_yobou_records")
      .upsert(chunk, { onConflict: ONCONFLICT, ignoreDuplicates: true })
      .select("id");
    if (error) {
      failed += chunk.length;
      console.warn(
        `[processYobouCsvFromBuffer] ${opts.sourceFilename} chunk ${i}-${i + chunk.length} 失敗:`,
        error.message,
      );
      if (errors.length < 5) errors.push(error.message);
      continue;
    }
    const insertedInChunk = data?.length ?? 0;
    inserted += insertedInChunk;
    skipped += chunk.length - insertedInChunk;
  }

  return { inserted, skipped, failed, errors };
}

type Office = {
  id: string;
  office_number: string;
  name: string;
  short_name: string;
  office_type: string;
};

interface ParsedFile {
  fileName: string;
  rows: YobouCsvRow[];
  errors: YobouParseError[];
}

interface YobouImporterProps {
  /** tenant スコープ (payroll_kyotaku_yobou_records.tenant_id に書く) */
  tenantId: string;
  /**
   * 居宅介護支援 type の office 一覧。
   * 1 件のみなら自動選択、複数なら dropdown で選ばせる。
   */
  initialOffices: Office[];
}

export function YobouImporter({ tenantId, initialOffices }: YobouImporterProps) {
  const [parsedFiles, setParsedFiles] = useState<ParsedFile[]>([]);
  const [isParsing, setIsParsing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [imported, setImported] = useState(false);
  const [result, setResult] = useState<{ inserted: number; skipped: number } | null>(null);
  const [selectedOfficeId, setSelectedOfficeId] = useState<string>(
    () => (initialOffices.length === 1 ? initialOffices[0].id : ""),
  );

  const allRows: YobouCsvRow[] = parsedFiles.flatMap((f) => f.rows);
  const totalErrors = parsedFiles.reduce((s, f) => s + f.errors.length, 0);

  const handleFilesSelected = async (newFiles: File[]) => {
    setIsParsing(true);
    setImported(false);
    setResult(null);

    try {
      const parsed: ParsedFile[] = [];
      for (const f of newFiles) {
        const res = await parseYobouCsv(f);
        parsed.push({ fileName: f.name, rows: res.rows, errors: res.errors });
      }
      setParsedFiles((prev) => [...prev, ...parsed]);
    } finally {
      setIsParsing(false);
    }
  };

  const handleClear = () => {
    setParsedFiles([]);
    setImported(false);
    setResult(null);
  };

  const handleImport = async () => {
    if (allRows.length === 0) return;
    if (!selectedOfficeId) {
      toast.error("事業所を選択してください");
      return;
    }
    const selectedOffice = initialOffices.find((o) => o.id === selectedOfficeId);
    if (!selectedOffice) {
      toast.error("選択された事業所が見つかりません");
      return;
    }
    const officeNumber = selectedOffice.office_number;

    setIsImporting(true);

    try {
      // 1 file = 1 source_filename。複数 file 時はそれぞれの payload を生成して結合。
      const records = parsedFiles.flatMap((pf) =>
        pf.rows.map((row) => ({
          tenant_id: tenantId,
          office_number: officeNumber,
          source: "csv" as const,
          source_filename: pf.fileName,
          service_month: row.service_month,
          billing_month: row.billing_month,
          staff_name: row.staff_name,
          yobou1_count: row.yobou1_count,
          yobou2_count: row.yobou2_count,
        })),
      );

      // upsert を chunk 500 で。ignoreDuplicates: true なので
      // 同じ UNIQUE key (office_number, service_month, billing_month, staff_name)
      // が既にあれば skip。
      // chunk 単位の失敗は即停止せず集計表示 (部分失敗の可視化)。
      const chunkSize = 500;
      let inserted = 0;
      let skipped = 0;
      let failed = 0;
      const errMessages: string[] = [];
      const ONCONFLICT =
        "office_number,service_month,billing_month,staff_name";

      for (let i = 0; i < records.length; i += chunkSize) {
        const chunk = records.slice(i, i + chunkSize);
        const { data, error } = await supabase
          .from("payroll_kyotaku_yobou_records")
          .upsert(chunk, {
            onConflict: ONCONFLICT,
            ignoreDuplicates: true,
          })
          .select("id");
        if (error) {
          failed += chunk.length;
          console.warn(
            `[yobou-importer] chunk ${i}-${i + chunk.length} 登録失敗:`,
            error.message,
          );
          if (errMessages.length < 3) errMessages.push(error.message);
          continue;
        }
        const insertedInChunk = data?.length ?? 0;
        inserted += insertedInChunk;
        skipped += chunk.length - insertedInChunk;
      }

      setResult({ inserted, skipped });
      setImported(true);
      if (failed > 0) {
        toast.error(
          `${records.length} 件中 ${inserted} 件 INSERT / ${skipped} 件 skip / ${failed} 件 失敗 (詳細はコンソール: ${errMessages.join(" / ")})`,
        );
      } else {
        toast.success(`${inserted} 件 INSERT (${skipped} 件 skip)`);
      }
    } catch (e) {
      toast.error(`エラー: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsImporting(false);
    }
  };

  const preview = allRows.slice(0, 30);

  return (
    <div className="space-y-4">
      {/* 事業所選択 (居宅介護支援が 1 件なら自動選択 / 複数なら dropdown) */}
      {initialOffices.length === 0 ? (
        <Alert variant="destructive">
          <AlertDescription>
            居宅介護支援事業所が登録されていません。先にマスタを登録してください。
          </AlertDescription>
        </Alert>
      ) : initialOffices.length === 1 ? (
        <div className="text-sm text-muted-foreground">
          取込先事業所:{" "}
          <span className="font-medium text-foreground">
            {initialOffices[0].short_name || initialOffices[0].name}
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-sm font-medium whitespace-nowrap">事業所</label>
          <select
            className="border rounded px-2 py-1 text-sm bg-background"
            value={selectedOfficeId}
            onChange={(e) => setSelectedOfficeId(e.target.value)}
          >
            <option value="">選択してください</option>
            {initialOffices.map((o) => (
              <option key={o.id} value={o.id}>
                {o.short_name || o.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <FileDropzone
        onFilesSelected={handleFilesSelected}
        label="介護予防件数 CSV をドロップ"
        description="独自フォーマット (提供年月 / 請求年月 / 担当ケアマネ / 要支援1件数 / 要支援2件数) の CSV を選択またはドラッグ&ドロップ（複数可、UTF-8 / Shift-JIS 自動判定）"
      />

      {parsedFiles.length > 0 && (
        <div className="space-y-4">
          {/* ファイル一覧 */}
          <div className="flex items-center gap-2 flex-wrap">
            {parsedFiles.map((f, i) => (
              <Badge key={i} variant={f.errors.length > 0 ? "destructive" : "secondary"}>
                {f.fileName} ({f.rows.length}件)
              </Badge>
            ))}
            <Button variant="ghost" size="sm" onClick={handleClear}>
              クリア
            </Button>
          </div>

          {/* パースエラー (赤バナー) */}
          {totalErrors > 0 && (
            <Alert variant="destructive">
              <AlertDescription>
                {parsedFiles
                  .filter((f) => f.errors.length > 0)
                  .map((f) =>
                    f.errors.map((e, i) => (
                      <div key={`${f.fileName}-${i}`}>
                        {f.fileName} (行 {e.line}): {e.reason}
                      </div>
                    )),
                  )}
              </AlertDescription>
            </Alert>
          )}

          {/* 取込結果 */}
          {result && (
            <Alert>
              <AlertDescription>
                ✓ {result.inserted} 件 INSERT ({result.skipped} 件 skip)
              </AlertDescription>
            </Alert>
          )}

          {/* プレビュー */}
          {allRows.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  {isParsing ? "解析中..." : `${allRows.length} 件のレコード`}
                </p>
                <Button
                  onClick={handleImport}
                  disabled={
                    isImporting ||
                    imported ||
                    !selectedOfficeId ||
                    initialOffices.length === 0
                  }
                >
                  {isImporting ? "取込中..." : imported ? "取込済み" : "取込実行"}
                </Button>
              </div>

              <ScrollArea className="h-[400px] border rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[100px]">提供年月</TableHead>
                      <TableHead className="min-w-[100px]">請求年月</TableHead>
                      <TableHead className="min-w-[110px]">担当ケアマネ</TableHead>
                      <TableHead className="min-w-[90px] text-right">要支援1件数</TableHead>
                      <TableHead className="min-w-[90px] text-right">要支援2件数</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.map((row, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-xs">
                          {row.service_month.slice(0, 7)}
                        </TableCell>
                        <TableCell className="text-xs">
                          {row.billing_month.slice(0, 7)}
                        </TableCell>
                        <TableCell className="text-xs">{row.staff_name}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums">
                          {row.yobou1_count.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-xs text-right tabular-nums">
                          {row.yobou2_count.toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {allRows.length > 30 && (
                  <p className="p-2 text-center text-sm text-muted-foreground">
                    ...他 {allRows.length - 30} 件（プレビューは先頭 30 件）
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
