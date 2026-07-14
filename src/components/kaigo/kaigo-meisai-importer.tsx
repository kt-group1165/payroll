"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
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
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import {
  buildKaigoMeisaiRecords,
  type KaigoBuildResult,
} from "@/lib/kaigo-import/build-records";

interface Office {
  id: string;
  office_number: string;
  name: string;
  short_name: string;
  office_type: string;
  /** 共通 offices.id (payroll_offices.office_id) */
  office_id: string | null;
}

interface KaigoMeisaiImporterProps {
  /** 訪問介護 / 訪問入浴 の事業所のみ渡す */
  initialOffices: Office[];
}

/**
 * kaigo-app 直接モードの取込パネル (= snapshot pull)。
 *
 * 「取り込み / 更新」押下時点の kaigo 実績を payroll_service_records へコピーする。
 * リアルタイム参照はしない — 取込後に kaigo 側を修正しても、再度「更新」する
 * までは給与計算に影響しない (memory: project_payroll_kaigo_snapshot_pull.md)。
 */
export function KaigoMeisaiImporter({ initialOffices }: KaigoMeisaiImporterProps) {
  const [offices] = useState<Office[]>(initialOffices);
  const [selectedOfficeId, setSelectedOfficeId] = useState(() =>
    initialOffices.length === 1 ? initialOffices[0].id : "",
  );
  const [selectedMonth, setSelectedMonth] = useState<string>(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [existingCount, setExistingCount] = useState<number | null>(null);
  const [preview, setPreview] = useState<KaigoBuildResult | null>(null);
  const [isBuilding, setIsBuilding] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const selectedOffice = offices.find((o) => o.id === selectedOfficeId);
  const processingMonth = selectedMonth.replace("-", "");

  const fetchExistingCount = useCallback(async () => {
    if (!selectedOffice || !processingMonth) return;
    const { count, error } = await supabase
      .from("payroll_service_records")
      .select("id", { count: "exact", head: true })
      .eq("processing_month", processingMonth)
      .eq("office_number", selectedOffice.office_number);
    if (error) {
      console.warn("[kaigo-importer] 既存件数取得失敗:", error.message);
      setExistingCount(null);
      return;
    }
    setExistingCount(count ?? 0);
  }, [selectedOffice, processingMonth]);

  const handlePreview = async () => {
    if (!selectedOffice) {
      toast.error("事業所を選択してください");
      return;
    }
    setIsBuilding(true);
    setPreview(null);
    try {
      await fetchExistingCount();
      const result = await buildKaigoMeisaiRecords(
        supabase,
        {
          payrollOfficeId: selectedOffice.id,
          officeNumber: selectedOffice.office_number,
          commonOfficeId: selectedOffice.office_id,
          officeType: selectedOffice.office_type,
          officeName: selectedOffice.name,
        },
        processingMonth,
      );
      setPreview(result);
      if (result.rows.length === 0) {
        toast.info("対象月の実績確定データがありません");
      }
    } catch (e) {
      toast.error(`プレビュー失敗: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsBuilding(false);
    }
  };

  const handleImport = async () => {
    if (!selectedOffice || !preview || preview.rows.length === 0) return;
    const label = `${selectedMonth.replace("-", "年")}月`;
    const officeName = selectedOffice.short_name || selectedOffice.name;
    if ((existingCount ?? 0) > 0) {
      if (
        !confirm(
          `${officeName} ${label}には既に ${existingCount} 件の実績データがあります。\n削除してから kaigo-app の実績 ${preview.rows.length} 件で置き換えます (更新)。よろしいですか？`,
        )
      )
        return;
    } else if (
      !confirm(`${officeName} ${label}に kaigo-app の実績 ${preview.rows.length} 件を取り込みます。よろしいですか？`)
    ) {
      return;
    }

    setIsImporting(true);
    try {
      // 1) 既存 (月 × 事業所) を削除して置き換え (= 更新)
      const { error: delError } = await supabase
        .from("payroll_service_records")
        .delete()
        .eq("processing_month", processingMonth)
        .eq("office_number", selectedOffice.office_number);
      if (delError) {
        toast.error(`既存データ削除エラー: ${delError.message}`);
        return;
      }

      // 2) batch 作成
      const { data: batch, error: batchError } = await supabase
        .from("payroll_import_batches")
        .insert({
          import_type: "kaigo_meisai" as const,
          file_names: [`kaigo-app snapshot (${preview.source})`],
          record_count: preview.rows.length,
          processing_month: processingMonth,
          office_number: selectedOffice.office_number,
          status: "pending" as const,
        })
        .select()
        .single();
      if (batchError || !batch) {
        console.warn("[kaigo-importer] batch 作成失敗:", batchError?.message);
        toast.error(
          `バッチ作成エラー: ${batchError?.message ?? "unknown"} (migration payroll_data_source_mode_v1.sql 未適用の可能性)`,
        );
        return;
      }

      // 3) chunk INSERT (失敗時は batch を error にして即停止)
      const chunkSize = 500;
      for (let i = 0; i < preview.rows.length; i += chunkSize) {
        const chunk = preview.rows
          .slice(i, i + chunkSize)
          .map((r) => ({ ...r, import_batch_id: batch.id }));
        const { error: insertError } = await supabase
          .from("payroll_service_records")
          .insert(chunk);
        if (insertError) {
          console.warn(
            `[kaigo-importer] chunk ${i}-${i + chunk.length} INSERT 失敗 (batch=${batch.id}):`,
            insertError.message,
          );
          await supabase
            .from("payroll_import_batches")
            .update({ status: "error" as const, error_message: insertError.message })
            .eq("id", batch.id);
          toast.error(
            `データ登録エラー (${i}/${preview.rows.length} 件登録済、残り未登録): ${insertError.message}`,
          );
          return;
        }
      }

      await supabase
        .from("payroll_import_batches")
        .update({ status: "completed" as const })
        .eq("id", batch.id);

      // 4) snapshot 履歴 (監査用)。失敗しても取込自体は成立しているため warn のみ
      const { data: userData } = await supabase.auth.getUser();
      const { error: snapError } = await supabase.from("payroll_kaigo_snapshots").insert({
        import_batch_id: batch.id,
        processing_month: processingMonth,
        office_number: selectedOffice.office_number,
        office_id: selectedOffice.office_id,
        source: preview.source,
        source_record_count: preview.sourceCount,
        inserted_count: preview.rows.length,
        skipped: preview.skipped,
        taken_by: userData?.user?.email ?? null,
      });
      if (snapError) {
        console.warn("[kaigo-importer] snapshot 履歴の記録失敗:", snapError.message);
        toast.warning(`取込は完了しましたが履歴の記録に失敗: ${snapError.message}`);
      }

      toast.success(`${officeName} ${label}: kaigo-app 実績 ${preview.rows.length} 件を取り込みました`);
      setPreview(null);
      fetchExistingCount();
    } catch (e) {
      toast.error(`エラー: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <Alert>
        <AlertDescription className="text-xs leading-relaxed">
          kaigo-app (介護管理システム) の実績確定データ
          {"（訪問介護 = 実績確定シフト / 訪問入浴 = 確定済み入浴記録）"}
          を、ボタン押下時点の内容で給与明細データにコピーします (snapshot 取込)。
          取込後に kaigo-app 側を修正した場合は、再度「取り込み / 更新」を押すまで給与計算に反映されません。
        </AlertDescription>
      </Alert>

      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium whitespace-nowrap">事業所</label>
          <select
            className="border rounded px-2 py-1 text-sm bg-background"
            value={selectedOfficeId}
            onChange={(e) => {
              setSelectedOfficeId(e.target.value);
              setPreview(null); // 選択変更でプレビューは無効化 (取り違え防止)
              setExistingCount(null);
            }}
          >
            <option value="">選択してください</option>
            {offices.map((o) => (
              <option key={o.id} value={o.id}>
                {(o.short_name || o.name)}（{o.office_type}）
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium whitespace-nowrap">対象月</label>
          <input
            type="month"
            value={selectedMonth}
            onChange={(e) => {
              setSelectedMonth(e.target.value);
              setPreview(null);
              setExistingCount(null);
            }}
            className="border rounded px-2 py-1 text-sm"
          />
        </div>
        <Button onClick={handlePreview} disabled={isBuilding || !selectedOfficeId}>
          {isBuilding ? "kaigo-app から読込中..." : "プレビュー"}
        </Button>
      </div>

      {selectedOffice && existingCount !== null && existingCount > 0 && (
        <p className="text-xs text-muted-foreground">
          この月 × 事業所には既に {existingCount.toLocaleString()} 件の実績データがあります。
          取込実行時は削除してから置き換えます (更新)。
        </p>
      )}

      {preview && (
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-sm">
              kaigo 実績 <span className="font-mono">{preview.sourceCount.toLocaleString()}</span> 件 →
              給与明細 <span className="font-mono font-semibold">{preview.rows.length.toLocaleString()}</span> 行
              {preview.skipped.length > 0 && (
                <span className="text-destructive ml-2">
                  (除外 {preview.skipped.length} 件)
                </span>
              )}
            </p>
            <Button onClick={handleImport} disabled={isImporting || preview.rows.length === 0}>
              {isImporting
                ? "取込中..."
                : (existingCount ?? 0) > 0
                  ? "取り込み / 更新 (置き換え)"
                  : "取り込み"}
            </Button>
          </div>

          {preview.warnings.length > 0 && (
            <Alert>
              <AlertDescription>
                {preview.warnings.map((w, i) => (
                  <div key={i} className="text-xs">⚠ {w}</div>
                ))}
              </AlertDescription>
            </Alert>
          )}

          {preview.skipped.length > 0 && (
            <Alert variant="destructive">
              <AlertDescription>
                <div className="text-xs font-medium mb-1">
                  以下は取込対象から除外されます (kaigo-app 側の担当設定 / payroll 職員マスタを確認):
                </div>
                {preview.skipped.slice(0, 20).map((s, i) => (
                  <div key={i} className="text-xs">
                    [{s.reason}] {s.detail}
                  </div>
                ))}
                {preview.skipped.length > 20 && (
                  <div className="text-xs mt-1">...他 {preview.skipped.length - 20} 件</div>
                )}
              </AlertDescription>
            </Alert>
          )}

          {preview.rows.length > 0 && (
            <ScrollArea className="h-[400px] border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[80px]">日付</TableHead>
                    <TableHead className="min-w-[80px]">職員番号</TableHead>
                    <TableHead className="min-w-[100px]">職員名</TableHead>
                    <TableHead className="min-w-[60px]">開始</TableHead>
                    <TableHead className="min-w-[60px]">終了</TableHead>
                    <TableHead className="min-w-[100px]">利用者</TableHead>
                    <TableHead className="min-w-[100px]">サービス</TableHead>
                    <TableHead className="min-w-[60px]">時間</TableHead>
                    <TableHead className="min-w-[80px]">コード</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.rows.slice(0, 100).map((row, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-xs">{row.service_date.replace(/^\d{4}\//, "")}</TableCell>
                      <TableCell className="text-xs">{row.employee_number}</TableCell>
                      <TableCell className="text-xs">{row.employee_name}</TableCell>
                      <TableCell className="text-xs">{row.dispatch_start_time}</TableCell>
                      <TableCell className="text-xs">{row.dispatch_end_time}</TableCell>
                      <TableCell className="text-xs">{row.client_name}</TableCell>
                      <TableCell className="text-xs">{row.service_type}</TableCell>
                      <TableCell className="text-xs">{row.calc_duration}</TableCell>
                      <TableCell className="text-xs">{row.service_code || "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {preview.rows.length > 100 && (
                <p className="p-2 text-center text-sm text-muted-foreground">
                  ...他 {preview.rows.length - 100} 件（プレビューは先頭100件）
                </p>
              )}
            </ScrollArea>
          )}
        </div>
      )}
    </div>
  );
}
