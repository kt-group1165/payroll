"use client";

/**
 * 国保連 CSV (居宅介護支援) 取込 importer。
 *
 * - parser: @/lib/csv/kokuho-parser parseKokuhoCsv (commit 471294f)
 * - target: payroll_kyotaku_records (UNIQUE: office_number, service_month,
 *   detail_row_no, insured_number, service_code, staff_name)
 * - upsert は chunk 500 / ignoreDuplicates: true で再取込時に skip。
 *
 * meisai-importer 等の既存 importer と UI/interaction を揃える。
 * 違い:
 *   - parser は file 1 つずつ受ける (meisai は複数纏め parse)
 *   - 取込対象月の選択は不要 (service_month は CSV から導出)
 *   - import_batches には書かない (payroll_kyotaku_records は独立追跡)
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
  parseKokuhoCsv,
  type KokuhoCsvRow,
  type KokuhoParseError,
} from "@/lib/csv/kokuho-parser";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";

type Office = {
  id: string;
  office_number: string;
  name: string;
  short_name: string;
  office_type: string;
};

interface ParsedFile {
  fileName: string;
  rows: KokuhoCsvRow[];
  errors: KokuhoParseError[];
}

interface KyotakuImporterProps {
  /** tenant スコープ (payroll_kyotaku_records.tenant_id に書く) */
  tenantId: string;
  /**
   * 居宅介護支援 type の office 一覧。
   * 1 件のみなら自動選択、複数なら dropdown で選ばせる。
   */
  initialOffices: Office[];
}

export function KyotakuImporter({ tenantId, initialOffices }: KyotakuImporterProps) {
  const [parsedFiles, setParsedFiles] = useState<ParsedFile[]>([]);
  const [isParsing, setIsParsing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [imported, setImported] = useState(false);
  const [result, setResult] = useState<{ inserted: number; skipped: number } | null>(null);
  const [selectedOfficeId, setSelectedOfficeId] = useState<string>(
    () => (initialOffices.length === 1 ? initialOffices[0].id : ""),
  );

  const allRows: KokuhoCsvRow[] = parsedFiles.flatMap((f) => f.rows);
  const totalErrors = parsedFiles.reduce((s, f) => s + f.errors.length, 0);

  const handleFilesSelected = async (newFiles: File[]) => {
    setIsParsing(true);
    setImported(false);
    setResult(null);

    try {
      const parsed: ParsedFile[] = [];
      for (const f of newFiles) {
        const res = await parseKokuhoCsv(f);
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
          source_filename: pf.fileName,
          service_month: row.service_month,
          billing_month: row.billing_month,
          staff_name: row.staff_name,
          detail_row_no: row.detail_row_no,
          insured_number: row.insured_number,
          insured_name: row.insured_name,
          client_number: row.client_number,
          gender: row.gender,
          birth_date: row.birth_date,
          care_level: row.care_level,
          insurer_number: row.insurer_number,
          insurer_name: row.insurer_name,
          service_code: row.service_code,
          service_name: row.service_name,
          unit_total: row.unit_total,
          unit_price: row.unit_price,
          amount: row.amount,
          cert_start_date: row.cert_start_date,
          cert_end_date: row.cert_end_date,
          staff_number: row.staff_number,
          staff_identifier: row.staff_identifier,
          kyotaku_office_number: row.kyotaku_office_number,
          kyotaku_office_name: row.kyotaku_office_name,
          kyotaku_support_number: row.kyotaku_support_number,
          receiver_number: row.receiver_number,
        })),
      );

      // upsert を chunk 500 で。ignoreDuplicates: true なので
      // 同じ UNIQUE key (office_number, service_month, detail_row_no,
      // insured_number, service_code, staff_name) が既にあれば skip。
      const chunkSize = 500;
      let inserted = 0;
      let skipped = 0;
      const ONCONFLICT =
        "office_number,service_month,detail_row_no,insured_number,service_code,staff_name";

      for (let i = 0; i < records.length; i += chunkSize) {
        const chunk = records.slice(i, i + chunkSize);
        const { data, error } = await supabase
          .from("payroll_kyotaku_records")
          .upsert(chunk, {
            onConflict: ONCONFLICT,
            ignoreDuplicates: true,
          })
          .select("id");
        if (error) {
          toast.error(`登録エラー: ${error.message}`);
          setIsImporting(false);
          return;
        }
        const insertedInChunk = data?.length ?? 0;
        inserted += insertedInChunk;
        skipped += chunk.length - insertedInChunk;
      }

      setResult({ inserted, skipped });
      setImported(true);
      toast.success(`${inserted} 件 INSERT (${skipped} 件 skip)`);
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
        label="国保連 CSV をドロップ"
        description="居宅介護支援の国保連介護給付費請求 CSV (Shift-JIS) を選択またはドラッグ&ドロップ（複数可）"
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
                      <TableHead className="min-w-[90px]">提供月</TableHead>
                      <TableHead className="min-w-[100px]">担当者</TableHead>
                      <TableHead className="min-w-[110px]">利用者</TableHead>
                      <TableHead className="min-w-[80px]">要介護度</TableHead>
                      <TableHead className="min-w-[100px]">保険者</TableHead>
                      <TableHead className="min-w-[120px]">サービス</TableHead>
                      <TableHead className="min-w-[70px] text-right">単位</TableHead>
                      <TableHead className="min-w-[80px] text-right">請求額</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.map((row, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-xs">
                          {row.service_month.slice(0, 7)}
                        </TableCell>
                        <TableCell className="text-xs">{row.staff_name}</TableCell>
                        <TableCell className="text-xs">{row.insured_name ?? "—"}</TableCell>
                        <TableCell className="text-xs">{row.care_level ?? "—"}</TableCell>
                        <TableCell className="text-xs">{row.insurer_name ?? "—"}</TableCell>
                        <TableCell className="text-xs">{row.service_name ?? "—"}</TableCell>
                        <TableCell className="text-xs text-right">
                          {row.unit_total != null ? row.unit_total.toLocaleString() : "—"}
                        </TableCell>
                        <TableCell className="text-xs text-right">
                          {row.amount != null ? row.amount.toLocaleString() : "—"}
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
