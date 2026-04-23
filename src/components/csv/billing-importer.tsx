"use client";

import { useCallback, useEffect, useState } from "react";
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

type OfficeLite = { id: string; office_number: string; name: string; short_name: string };

type FileResult = {
  file: File;
  type: BillingFileType | null;
  amountRows: BillingAmountItem[];
  unitRows: BillingUnitItem[];
  dailyRows: BillingDailyItem[];
  errors: string[];
  unresolvedOffices: string[]; // 事業所名が引き当てられなかった事業者名のリスト
};

/** 事業者名から office_number を引き当てる（括弧内の補足を除去、部分一致、略称一致も許容） */
function resolveOfficeNumber(rawName: string, offices: OfficeLite[]): string | null {
  const clean = (s: string) => (s ?? "").replace(/（.*?）/g, "").replace(/[\s\u3000]/g, "").toLowerCase();
  const target = clean(rawName);
  if (!target) return null;
  const eq = offices.find((o) => clean(o.name) === target || clean(o.short_name) === target);
  if (eq) return eq.office_number;
  const inc = offices.find((o) => clean(o.name).includes(target) || target.includes(clean(o.name)));
  if (inc) return inc.office_number;
  const sh = offices.find((o) => o.short_name && (target.includes(clean(o.short_name)) || clean(o.short_name).includes(target)));
  if (sh) return sh.office_number;
  return null;
}

export function BillingImporter() {
  const [results, setResults] = useState<FileResult[]>([]);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState(false);
  const [offices, setOffices] = useState<OfficeLite[]>([]);
  // 取り込み済みデータの集計: key=`${segment}|${office_number}|${billing_month}` → {amount, unit, daily}
  const [existingMatrix, setExistingMatrix] = useState<Map<string, { amount: number; unit: number; daily: number }>>(new Map());

  const fetchExistingMatrix = useCallback(async () => {
    const m = new Map<string, { amount: number; unit: number; daily: number }>();
    const ensure = (k: string) => { if (!m.has(k)) m.set(k, { amount: 0, unit: 0, daily: 0 }); return m.get(k)!; };
    const pageSize = 1000;
    const scan = async (table: string, field: "amount" | "unit" | "daily") => {
      let from = 0;
      while (true) {
        const { data } = await supabase
          .from(table)
          .select("segment, office_number, billing_month")
          .range(from, from + pageSize - 1);
        if (!data || data.length === 0) break;
        for (const r of data as { segment: string; office_number: string | null; billing_month: string }[]) {
          if (!r.office_number || !r.billing_month) continue;
          const key = `${r.segment}|${r.office_number}|${r.billing_month}`;
          ensure(key)[field]++;
        }
        if (data.length < pageSize) break;
        from += pageSize;
      }
    };
    await scan("billing_amount_items", "amount");
    await scan("billing_unit_items", "unit");
    await scan("billing_daily_items", "daily");
    setExistingMatrix(m);
  }, []);

  useEffect(() => {
    supabase.from("offices").select("id, office_number, name, short_name").then(({ data }) => {
      if (data) setOffices(data as OfficeLite[]);
    });
    fetchExistingMatrix();
  }, [fetchExistingMatrix]);

  const handleClearScope = async (segment: string, office_number: string, billing_month: string, counts: { amount: number; unit: number; daily: number }) => {
    const off = offices.find((o) => o.office_number === office_number);
    const officeName = (off?.short_name || off?.name) ?? office_number;
    const label = `${billing_month.slice(0, 4)}年${parseInt(billing_month.slice(4, 6), 10)}月`;
    const total = counts.amount + counts.unit + counts.daily;
    if (!confirm(`${officeName} ${label} の${segment}データ（金額${counts.amount}件 / 単位${counts.unit}件 / 利用日${counts.daily}件、計${total}件）を削除しますか？`)) return;
    const where = { segment, office_number, billing_month };
    const q = (table: string) => supabase.from(table).delete().match(where);
    const [r1, r2, r3] = await Promise.all([q("billing_amount_items"), q("billing_unit_items"), q("billing_daily_items")]);
    if (r1.error || r2.error || r3.error) {
      toast.error(`削除エラー: ${(r1.error || r2.error || r3.error)!.message}`);
      return;
    }
    toast.success(`${officeName} ${label}(${segment}) を削除しました`);
    fetchExistingMatrix();
  };

  const handleFilesSelected = useCallback(async (files: File[]) => {
    setImported(false);
    const newResults: FileResult[] = [];
    for (const f of files) {
      const type = detectBillingFileType(f.name);
      let amountRows: BillingAmountItem[] = [];
      let unitRows: BillingUnitItem[] = [];
      let dailyRows: BillingDailyItem[] = [];
      const errors: string[] = [];
      const unresolvedOffices: string[] = [];
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

        // 事業所番号が空の行は、office_name（障害は事業者名）から引き当てる
        const unresolvedSet = new Set<string>();
        const resolveRow = <T extends { office_number: string; office_name?: string }>(r: T) => {
          if (r.office_number) return;
          const name = r.office_name ?? "";
          const num = resolveOfficeNumber(name, offices);
          if (num) r.office_number = num;
          else if (name) unresolvedSet.add(name);
        };
        for (const r of amountRows) resolveRow(r);
        for (const r of unitRows)   resolveRow(r as unknown as { office_number: string; office_name?: string });
        for (const r of dailyRows)  resolveRow(r as unknown as { office_number: string; office_name?: string });
        unresolvedOffices.push(...unresolvedSet);
      }
      newResults.push({ file: f, type, amountRows, unitRows, dailyRows, errors, unresolvedOffices });
    }
    setResults((prev) => [...prev, ...newResults]);
  }, [offices]);

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
      fetchExistingMatrix();
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

      {/* 取り込み済みデータの行列表示 */}
      {existingMatrix.size > 0 && (() => {
        const offSet = new Set<string>();
        const monthSet = new Set<string>();
        const segSet = new Set<string>();
        for (const k of existingMatrix.keys()) {
          const [seg, off, mm] = k.split("|");
          segSet.add(seg); offSet.add(off); monthSet.add(mm);
        }
        const segments = [...segSet].sort();
        const monthList = [...monthSet].sort().reverse();
        const officeList = [...offSet].sort((a, b) => {
          const oa = offices.find((o) => o.office_number === a);
          const ob = offices.find((o) => o.office_number === b);
          return ((oa?.short_name || oa?.name) ?? a).localeCompare((ob?.short_name || ob?.name) ?? b, "ja");
        });
        const fmtMonth = (m: string) => `${m.slice(0, 4)}/${m.slice(4, 6)}`;

        return (
          <div className="space-y-3">
            {segments.map((seg) => (
              <div key={seg} className="border rounded-md overflow-hidden">
                <div className="px-3 py-2 bg-muted/40 flex items-center justify-between">
                  <span className="text-sm font-medium">取り込み済みデータ — {seg}</span>
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
                      {officeList.map((officeNum) => {
                        const off = offices.find((o) => o.office_number === officeNum);
                        const officeName = (off?.short_name || off?.name) ?? officeNum;
                        // このsegmentでこの事業所に1件でもあるか確認
                        const hasAny = monthList.some((m) => existingMatrix.has(`${seg}|${officeNum}|${m}`));
                        if (!hasAny) return null;
                        return (
                          <tr key={officeNum} className="border-b last:border-b-0 hover:bg-muted/10">
                            <td className="px-3 py-1.5 sticky left-0 bg-background">{officeName}</td>
                            {monthList.map((m) => {
                              const c = existingMatrix.get(`${seg}|${officeNum}|${m}`);
                              return (
                                <td key={m} className="px-3 py-1.5 text-right whitespace-nowrap">
                                  {!c ? (
                                    <span className="text-muted-foreground/40">—</span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1" title={`金額${c.amount}件 / 単位${c.unit}件 / 利用日${c.daily}件`}>
                                      <span className="font-mono">{(c.amount + c.unit + c.daily).toLocaleString()}</span>
                                      <button
                                        onClick={() => handleClearScope(seg, officeNum, m, c)}
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
            ))}
          </div>
        );
      })()}

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

          {/* 障害CSVなどに事業所番号がないケース: 事業者名で引き当てできなかったものを警告 */}
          {(() => {
            const unresolved = [...new Set(results.flatMap((r) => r.unresolvedOffices))];
            if (unresolved.length === 0) return null;
            return (
              <Alert variant="destructive">
                <AlertDescription>
                  以下の事業者名から事業所が引き当てられませんでした。事業所一覧で該当する事業所の「正式名称」を確認するか、略称・名称の表記を合わせてください。該当行は office_number が空のまま登録されるので、/billing で金額が集計されません。
                  <ul className="mt-2 list-disc ml-5 text-xs">
                    {unresolved.map((n, i) => <li key={i}>{n}</li>)}
                  </ul>
                </AlertDescription>
              </Alert>
            );
          })()}

          <Button onClick={handleImport} disabled={importing || imported}>
            {importing ? "取り込み中…" : imported ? "登録済み" : "データベースに登録"}
          </Button>
        </div>
      )}
    </div>
  );
}
