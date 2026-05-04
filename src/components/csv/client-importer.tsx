"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileDropzone } from "./file-dropzone";
import { parseClientFile, type ParsedClient, type ClientParseResult } from "@/lib/csv/client-parser";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import type { Office } from "@/types/database";

type ImportRow = ParsedClient & { office_id: string | null; office_display: string; error?: string };

export function ClientImporter() {
  const [results, setResults] = useState<ClientParseResult[]>([]);
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [offices, setOffices] = useState<Office[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [imported, setImported] = useState(false);

  useEffect(() => {
    supabase.from("offices").select("*").order("name").then(({ data }) => {
      if (!data) return;
      setOffices(data as Office[]);
    });
  }, []);

  // CSVの「担当事業所名称」を Office にマッチさせる（正式名・略称・正規化名で試行）
  const resolveOfficeByName = useCallback((name: string): Office | null => {
    const norm = (s: string) => (s ?? "").replace(/[\s\u3000]/g, "").toLowerCase();
    const target = norm(name);
    if (!target) return null;
    return (
      offices.find((o) => norm(o.name) === target) ??
      offices.find((o) => o.short_name && norm(o.short_name) === target) ??
      offices.find((o) => norm(o.name).includes(target) || target.includes(norm(o.name))) ??
      null
    );
  }, [offices]);

  const handleFilesSelected = useCallback(async (files: File[]) => {
    setImported(false);
    const allResults: ClientParseResult[] = [];
    const allData: ParsedClient[] = [];
    for (const f of files) {
      const r = await parseClientFile(f);
      allResults.push(r);
      allData.push(...r.data);
    }
    setResults(allResults);
    setImportRows(allData.map((d) => {
      const off = resolveOfficeByName(d.office_name);
      return {
        ...d,
        office_id: off?.id ?? null,
        office_display: off ? (off.short_name || off.name) : d.office_name,
        error: off ? undefined : `事業所「${d.office_name || "(空)"}」が未登録`,
      };
    }));
  }, [resolveOfficeByName]);

  const handleClear = () => {
    setResults([]);
    setImportRows([]);
    setImported(false);
  };

  const handleImport = async () => {
    const valid = importRows.filter((r) => r.office_id && !r.error);
    if (valid.length === 0) { toast.error("インポートできる行がありません"); return; }
    setIsImporting(true);

    // (client_number, office_id) で重複排除（最後の値が勝つ）
    const dedupMap = new Map<string, { client_number: string; name: string; address: string; office_id: string }>();
    for (const r of valid) {
      const key = `${r.office_id}|${r.client_number}`;
      dedupMap.set(key, {
        client_number: r.client_number,
        name: r.name,
        address: r.address,
        office_id: r.office_id!,
      });
    }
    const payload = Array.from(dedupMap.values());

    const chunkSize = 500;
    let success = 0, fail = 0;
    for (let i = 0; i < payload.length; i += chunkSize) {
      const { error } = await supabase
        .from("clients")
        .upsert(payload.slice(i, i + chunkSize), { onConflict: "client_number,office_id" });
      if (error) { console.error(error); fail += Math.min(chunkSize, payload.length - i); }
      else success += Math.min(chunkSize, payload.length - i);
    }

    setIsImporting(false);
    setImported(true);
    if (fail === 0) toast.success(`${success}件をインポートしました`);
    else toast.warning(`${success}件成功、${fail}件失敗`);
  };

  const totalErrors = results.reduce((s, r) => s + r.errors.length, 0);
  const preview = importRows.slice(0, 100);
  const validCount = importRows.filter((r) => r.office_id && !r.error).length;
  const unresolvedCount = importRows.length - validCount;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        CSVの「担当事業所名称」列から各行の事業所を自動判定して取り込みます。
        複数事業所のデータが混在したCSVでも一括取り込み可能です。
      </p>

      <FileDropzone
        onFilesSelected={handleFilesSelected}
        label="利用者データCSVファイルをドロップ"
        description="利用者データCSVを選択またはドラッグ&ドロップ（複数可）"
      />

      {results.length > 0 && (
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
                {results.flatMap((r) => r.errors).map((e, i) => <div key={i}>{e}</div>)}
              </AlertDescription>
            </Alert>
          )}

          {importRows.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  {importRows.length}件
                  {unresolvedCount > 0 && (
                    <span className="text-yellow-600 ml-2">
                      （{unresolvedCount}件は事業所未解決のためスキップ）
                    </span>
                  )}
                </p>
                <Button onClick={handleImport} disabled={isImporting || imported || validCount === 0}>
                  {isImporting ? "登録中..." : imported ? "登録済み" : `データベースに登録（${validCount}件）`}
                </Button>
              </div>

              <ScrollArea className="h-[400px] border rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>利用者番号</TableHead>
                      <TableHead>氏名</TableHead>
                      <TableHead>住所</TableHead>
                      <TableHead>担当事業所（CSV値）</TableHead>
                      <TableHead>解決先</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.map((r, i) => (
                      <TableRow key={i} className={r.error ? "bg-yellow-50" : ""}>
                        <TableCell className="font-mono text-xs">{r.client_number}</TableCell>
                        <TableCell>{r.name}</TableCell>
                        <TableCell className="text-xs">{r.address}</TableCell>
                        <TableCell className="text-xs">{r.office_name}</TableCell>
                        <TableCell className="text-xs">
                          {r.error
                            ? <span className="text-yellow-700">⚠ {r.error}</span>
                            : <span className="text-green-700">{r.office_display}</span>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {importRows.length > 100 && (
                  <p className="p-2 text-center text-sm text-muted-foreground">
                    ...他 {importRows.length - 100}件（プレビューは先頭100件）
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
