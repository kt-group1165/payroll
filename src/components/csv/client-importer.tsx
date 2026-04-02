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

type ImportRow = ParsedClient & { office_id: string | null; error?: string };

export function ClientImporter() {
  const [results, setResults] = useState<ClientParseResult[]>([]);
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [offices, setOffices] = useState<Office[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [imported, setImported] = useState(false);

  useEffect(() => {
    supabase.from("offices").select("*").then(({ data }) => {
      if (data) setOffices(data as Office[]);
    });
  }, []);

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

    // 事業所名でoffice_idを解決
    const rows: ImportRow[] = allData.map((d) => {
      const matched = offices.find((o) =>
        o.name.includes(d.office_name) || d.office_name.includes(o.name)
      );
      return {
        ...d,
        office_id: matched?.id ?? null,
        error: matched ? undefined : `事業所「${d.office_name}」未マッチ`,
      };
    });
    setImportRows(rows);
  }, [offices]);

  const handleClear = () => {
    setResults([]);
    setImportRows([]);
    setImported(false);
  };

  const handleImport = async () => {
    const valid = importRows.filter((r) => r.office_id);
    if (valid.length === 0) { toast.error("インポートできる行がありません"); return; }
    setIsImporting(true);

    const payload = valid.map((r) => ({
      client_number: r.client_number,
      name: r.name,
      address: r.address,
      office_id: r.office_id!,
    }));

    const chunkSize = 500;
    let success = 0, fail = 0;
    for (let i = 0; i < payload.length; i += chunkSize) {
      const { error } = await supabase
        .from("clients")
        .upsert(payload.slice(i, i + chunkSize), { onConflict: "client_number" });
      if (error) fail += Math.min(chunkSize, payload.length - i);
      else success += Math.min(chunkSize, payload.length - i);
    }

    setIsImporting(false);
    setImported(true);
    if (fail === 0) toast.success(`${success}件をインポートしました`);
    else toast.warning(`${success}件成功、${fail}件失敗`);
  };

  const totalErrors = results.reduce((s, r) => s + r.errors.length, 0);
  const preview = importRows.slice(0, 100);

  return (
    <div className="space-y-4">
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
                  {importRows.length}件（うち事業所未マッチ {importRows.filter(r => !r.office_id).length}件）
                </p>
                <Button onClick={handleImport} disabled={isImporting || imported}>
                  {isImporting ? "登録中..." : imported ? "登録済み" : "データベースに登録"}
                </Button>
              </div>

              <ScrollArea className="h-[400px] border rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>利用者番号</TableHead>
                      <TableHead>氏名</TableHead>
                      <TableHead>住所</TableHead>
                      <TableHead>担当事業所</TableHead>
                      <TableHead>状態</TableHead>
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
                            ? <span className="text-yellow-700">{r.error}</span>
                            : <span className="text-green-700">OK</span>
                          }
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
