"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FileDropzone } from "./file-dropzone";
import {
  detectBillingFileType,
  parse01KaigoAmount, parse01ShogaiAmount,
  parse02KaigoUnit,   parse02ShogaiUnit,
  parse03KaigoDaily,  parse03ShogaiDaily,
  type BillingFileType,
  type BillingAmountItem, type BillingUnitItem, type BillingDailyItem,
} from "@/lib/csv/billing-parser";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";

type FileResult = {
  file: File;
  type: BillingFileType | null;
  amountRows: BillingAmountItem[];
  unitRows: BillingUnitItem[];
  dailyRows: BillingDailyItem[];
  errors: string[];
};

export function BillingImporter() {
  const [results, setResults] = useState<FileResult[]>([]);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState(false);

  const handleFilesSelected = useCallback(async (files: File[]) => {
    setImported(false);
    const newResults: FileResult[] = [];
    for (const f of files) {
      const type = detectBillingFileType(f.name);
      let amountRows: BillingAmountItem[] = [];
      let unitRows: BillingUnitItem[] = [];
      let dailyRows: BillingDailyItem[] = [];
      const errors: string[] = [];
      if (!type) {
        errors.push("ファイル名から種別が判定できません（01_介護_金額.CSV 形式で命名してください）");
      } else {
        try {
          if (type === "01_介護_金額") ({ data: amountRows } = await parse01KaigoAmount(f));
          else if (type === "01_障害_金額") ({ data: amountRows } = await parse01ShogaiAmount(f));
          else if (type === "02_介護_単位") ({ data: unitRows } = await parse02KaigoUnit(f));
          else if (type === "02_障害_単位") ({ data: unitRows } = await parse02ShogaiUnit(f));
          else if (type === "03_介護_利用日") ({ data: dailyRows } = await parse03KaigoDaily(f));
          else if (type === "03_障害_利用日") ({ data: dailyRows } = await parse03ShogaiDaily(f));
        } catch (e) {
          errors.push(`パースエラー: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      newResults.push({ file: f, type, amountRows, unitRows, dailyRows, errors });
    }
    setResults((prev) => [...prev, ...newResults]);
  }, []);

  const handleClear = () => {
    setResults([]);
    setImported(false);
  };

  const handleImport = async () => {
    const totalAmount = results.reduce((s, r) => s + r.amountRows.length, 0);
    const totalUnit = results.reduce((s, r) => s + r.unitRows.length, 0);
    const totalDaily = results.reduce((s, r) => s + r.dailyRows.length, 0);
    if (totalAmount + totalUnit + totalDaily === 0) { toast.error("取り込むデータがありません"); return; }
    if (!confirm(`金額${totalAmount}件 / 単位${totalUnit}件 / 利用日${totalDaily}件を取り込みますか？\n（同じ事業所×月×利用者の既存データは削除してから挿入します）`)) return;

    setImporting(true);
    try {
      // 事業所×月 ごとに既存データを削除してから再挿入（重複防止）
      // 対象: 各ファイルに含まれる (office_number, billing_month, segment) のユニーク組み合わせ
      type ScopeKey = { office_number: string; billing_month: string; segment: "介護" | "障害" };
      const scopes = new Set<string>();
      const scopeList: ScopeKey[] = [];
      const push = (s: ScopeKey) => {
        const k = `${s.segment}|${s.office_number}|${s.billing_month}`;
        if (!scopes.has(k) && s.billing_month) { scopes.add(k); scopeList.push(s); }
      };
      for (const r of results) {
        for (const a of r.amountRows) push({ segment: a.segment, office_number: a.office_number, billing_month: a.billing_month });
        for (const u of r.unitRows)   push({ segment: u.segment, office_number: u.office_number, billing_month: u.billing_month });
        for (const d of r.dailyRows)  if (d.billing_month) push({ segment: d.segment, office_number: d.office_number, billing_month: d.billing_month });
      }

      for (const s of scopeList) {
        await supabase.from("billing_amount_items").delete()
          .eq("segment", s.segment).eq("office_number", s.office_number).eq("billing_month", s.billing_month);
        await supabase.from("billing_unit_items").delete()
          .eq("segment", s.segment).eq("office_number", s.office_number).eq("billing_month", s.billing_month);
        await supabase.from("billing_daily_items").delete()
          .eq("segment", s.segment).eq("office_number", s.office_number).eq("billing_month", s.billing_month);
      }

      // INSERT (chunk)
      const chunk = 500;
      const insertAll = async <T,>(table: string, rows: T[]) => {
        for (let i = 0; i < rows.length; i += chunk) {
          const { error } = await supabase.from(table).insert(rows.slice(i, i + chunk));
          if (error) throw error;
        }
      };
      const allAmount = results.flatMap((r) => r.amountRows);
      const allUnit = results.flatMap((r) => r.unitRows);
      const allDaily = results.flatMap((r) => r.dailyRows);
      await insertAll("billing_amount_items", allAmount);
      await insertAll("billing_unit_items", allUnit);
      await insertAll("billing_daily_items", allDaily);

      toast.success(`金額${allAmount.length}件 / 単位${allUnit.length}件 / 利用日${allDaily.length}件を取り込みました`);
      setImported(true);
      setResults([]);
    } catch (e) {
      toast.error(`取り込みエラー: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImporting(false);
    }
  };

  const totalErrors = results.reduce((s, r) => s + r.errors.length, 0);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        介護ソフトから出力された請求データCSVを取り込みます。対応ファイル:
      </p>
      <ul className="text-xs text-muted-foreground ml-4 list-disc space-y-0.5">
        <li><b>01_介護_金額.CSV</b> / <b>01_障害_金額.CSV</b>: 請求金額（利用者負担額）</li>
        <li><b>02_介護_単位.CSV</b> / <b>02_障害_単位.CSV</b>: 単位数明細（内訳）</li>
        <li><b>03_介護_利用日.CSV</b> / <b>03_障害_利用日.CSV</b>: カレンダー用</li>
      </ul>
      <p className="text-xs text-muted-foreground">
        ファイル名から自動判別します。複数事業所・複数月を同時に投入可能。
        <br />
        同一(事業所×月)の既存データは削除されてから再挿入されます（重複防止）。
      </p>

      <FileDropzone
        onFilesSelected={handleFilesSelected}
        label="請求CSVファイルをドロップ"
        description="01_介護_金額.CSV, 02_介護_単位.CSV 等を複数まとめてドロップ可"
      />

      {results.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            {results.map((r, i) => (
              <Badge key={i} variant={r.errors.length > 0 ? "destructive" : "secondary"}>
                {r.file.name} ({r.type ?? "不明"})
                {r.amountRows.length > 0 && <> / 金額{r.amountRows.length}件</>}
                {r.unitRows.length > 0 && <> / 単位{r.unitRows.length}件</>}
                {r.dailyRows.length > 0 && <> / 利用日{r.dailyRows.length}件</>}
              </Badge>
            ))}
            <Button variant="ghost" size="sm" onClick={handleClear}>クリア</Button>
          </div>

          {totalErrors > 0 && (
            <Alert variant="destructive">
              <AlertDescription>
                {results.flatMap((r) => r.errors.map((e) => `${r.file.name}: ${e}`)).map((e, i) => (
                  <div key={i}>{e}</div>
                ))}
              </AlertDescription>
            </Alert>
          )}

          <Button onClick={handleImport} disabled={importing || imported}>
            {importing ? "取り込み中…" : imported ? "登録済み" : "データベースに登録"}
          </Button>
        </div>
      )}
    </div>
  );
}
