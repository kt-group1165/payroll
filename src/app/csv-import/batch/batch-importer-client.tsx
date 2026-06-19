"use client";

/**
 * 一括取込 UI 本体 (Client Component)。
 *
 * フロー:
 *   1. フォルダ or 複数ファイルを drop
 *      - webkitGetAsEntry で再帰的に File を抽出 (= フォルダ drop 対応)
 *      - File 1 つずつ buffer 読み + UTF-8/SJIS 自動 decode
 *   2. detectFromText で 種別 / 事業所番号 / 年月 を推定
 *      - high  : ✓ 表示
 *      - medium: ⚠ 表示 (1 つ以上欠落)
 *      - low   : ✗ 表示 (種別不明)
 *   3. 各行で 種別 / 事業所 / 年月 を手動補完可能 (dropdown / 月 input)
 *   4. [全件取込実行] で順次 runImport を呼び出す
 *      - 1 件 fail でも他は続行 (= 部分成功サマリ)
 *      - billing は alias 解決が必要なため skip + 専用ページへの誘導
 *
 * 既存の /csv-import (tab 切替で 1 importer ずつ) は壊さない。
 */

import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import { detectFromText, decodeCsv } from "@/lib/csv-import/detect";
import { runImport, type FilePayload } from "@/lib/csv-import/handlers";
import { IMPORTER_LABELS, type ImporterKind, type DetectResult, type ProcessResult } from "@/lib/csv-import/types";
import type { BatchOffice } from "./page";

type FileEntryStatus = "pending" | "running" | "done" | "error";

type FileEntry = {
  id: string; // local uuid
  payload: FilePayload;
  detect: DetectResult;
  // user override (空なら detect の値を使う)
  overrideKind: ImporterKind | "unknown" | "";
  overrideOfficeNumber: string;
  overrideYearMonth: string; // YYYY-MM
  status: FileEntryStatus;
  result?: ProcessResult;
};

interface BatchImporterClientProps {
  offices: BatchOffice[];
  tenantId: string;
}

const KIND_OPTIONS: { value: ImporterKind | ""; label: string }[] = [
  { value: "", label: "(自動)" },
  { value: "kyotaku", label: IMPORTER_LABELS.kyotaku },
  { value: "yobou", label: IMPORTER_LABELS.yobou },
  { value: "meisai", label: IMPORTER_LABELS.meisai },
  { value: "billing", label: IMPORTER_LABELS.billing },
];

/** webkitGetAsEntry で再帰的に file を取り出す。 */
async function collectFilesFromDataTransferItems(
  items: DataTransferItemList,
): Promise<File[]> {
  const files: File[] = [];

  const readEntry = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      await new Promise<void>((resolve) => {
        (entry as FileSystemFileEntry).file(
          (f) => {
            if (f.name.toLowerCase().endsWith(".csv")) files.push(f);
            resolve();
          },
          () => resolve(),
        );
      });
      return;
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const readBatch = (): Promise<FileSystemEntry[]> =>
        new Promise((resolve) => {
          reader.readEntries(
            (entries) => resolve(entries),
            () => resolve([]),
          );
        });
      while (true) {
        const batch = await readBatch();
        if (batch.length === 0) break;
        for (const e of batch) await readEntry(e);
      }
    }
  };

  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  for (const e of entries) await readEntry(e);
  return files;
}

/** detect 結果の confidence に応じたバッジ。 */
function ConfidenceBadge({ d }: { d: DetectResult }) {
  if (d.confidence === "high") {
    return <span className="inline-block bg-green-100 text-green-800 text-[10px] rounded px-1.5 py-0.5">✓ 自動判定</span>;
  }
  if (d.confidence === "medium") {
    return <span className="inline-block bg-yellow-100 text-yellow-800 text-[10px] rounded px-1.5 py-0.5">⚠ 一部不足</span>;
  }
  return <span className="inline-block bg-red-100 text-red-800 text-[10px] rounded px-1.5 py-0.5">✗ 不明</span>;
}

export function BatchImporterClient({ offices, tenantId }: BatchImporterClientProps) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  /** 種別 → 候補事業所 (kyotaku/yobou は 居宅介護支援 のみ、それ以外は全件) */
  const officesByKind = useMemo(() => {
    const kyotaku = offices.filter((o) => o.office_type === "居宅介護支援");
    return {
      kyotaku,
      yobou: kyotaku,
      meisai: offices,
      billing: offices,
    } as Record<ImporterKind, BatchOffice[]>;
  }, [offices]);

  const addFiles = useCallback(async (files: File[]) => {
    const next: FileEntry[] = [];
    let skippedEmpty = 0;
    for (const f of files) {
      try {
        const buffer = await f.arrayBuffer();
        // detect は decoded text を使う (UTF-8 / SJIS 自動判定)
        // 注: kyotaku/meisai は Shift-JIS 固定だが、detect では BOM / fatal 判定で SJIS 経由になる
        const text = decodeCsv(buffer);
        const detect = detectFromText(text, f.name);
        // ヘッダーのみ (= 0 行 or 1 行) は取込対象外 → 一覧に入れない
        if (detect.rowCount <= 0) {
          skippedEmpty++;
          continue;
        }
        next.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          payload: { file: f, buffer, text },
          detect,
          overrideKind: "",
          overrideOfficeNumber: "",
          overrideYearMonth: "",
          status: "pending",
        });
      } catch (e) {
        console.warn(`[batch] ${f.name} 読み込み失敗:`, e);
        toast.error(`${f.name}: 読み込み失敗 (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    if (next.length > 0) {
      setEntries((prev) => [...prev, ...next]);
      const skipMsg = skippedEmpty > 0 ? ` (空 CSV ${skippedEmpty} 件はスキップ)` : "";
      toast.success(`${next.length} 件追加 (合計 ${entries.length + next.length} 件)${skipMsg}`);
    } else if (skippedEmpty > 0) {
      toast.info(`${skippedEmpty} 件すべて空 CSV のためスキップ`);
    }
  }, [entries.length]);

  /** drop ハンドラ: フォルダ再帰展開を試み、ダメなら file list を直接使う */
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const items = e.dataTransfer.items;
    if (items && items.length > 0 && typeof items[0].webkitGetAsEntry === "function") {
      const files = await collectFilesFromDataTransferItems(items);
      if (files.length > 0) {
        await addFiles(files);
        return;
      }
    }
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.name.toLowerCase().endsWith(".csv"),
    );
    if (files.length > 0) await addFiles(files);
  }, [addFiles]);

  const handleFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).filter((f) =>
      f.name.toLowerCase().endsWith(".csv"),
    );
    if (files.length > 0) await addFiles(files);
    e.target.value = ""; // reset
  }, [addFiles]);

  const removeEntry = (id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  };

  const updateEntry = (id: string, patch: Partial<FileEntry>) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  };

  /** entry から最終的な kind / officeNumber / yearMonth を決める。 */
  const resolveEntry = (entry: FileEntry): {
    kind: ImporterKind | "unknown";
    officeNumber: string;
    yearMonth: string;
  } => {
    // overrideKind が "" (= 自動) なら detect の kind を使う
    const kind: ImporterKind | "unknown" = entry.overrideKind === "" ? entry.detect.kind : entry.overrideKind;
    const officeNumber = entry.overrideOfficeNumber || entry.detect.officeNumber || "";
    const yearMonth = entry.overrideYearMonth || entry.detect.yearMonth || "";
    return { kind, officeNumber, yearMonth };
  };

  const runAll = async () => {
    if (entries.length === 0) {
      toast.error("ファイルがありません");
      return;
    }
    setIsRunning(true);
    setProgress({ done: 0, total: entries.length });

    let done = 0;
    // 1 件ずつ順次処理 (= DB 負荷 / トースト見やすさ)
    for (const entry of entries) {
      const { kind, officeNumber, yearMonth } = resolveEntry(entry);
      // 取込可能か判定
      if (kind === "unknown") {
        updateEntry(entry.id, {
          status: "error",
          result: { inserted: 0, skipped: 0, failed: 0, errors: ["種別が不明 (手動で選んでください)"] },
        });
        done++;
        setProgress({ done, total: entries.length });
        continue;
      }
      if (kind === "billing") {
        updateEntry(entry.id, {
          status: "error",
          result: { inserted: 0, skipped: 0, failed: 0, errors: ["請求 CSV は /billing/import で取込んでください"] },
        });
        done++;
        setProgress({ done, total: entries.length });
        continue;
      }
      if (!officeNumber) {
        updateEntry(entry.id, {
          status: "error",
          result: { inserted: 0, skipped: 0, failed: 0, errors: ["事業所番号が未指定"] },
        });
        done++;
        setProgress({ done, total: entries.length });
        continue;
      }
      if (!yearMonth) {
        updateEntry(entry.id, {
          status: "error",
          result: { inserted: 0, skipped: 0, failed: 0, errors: ["年月が未指定"] },
        });
        done++;
        setProgress({ done, total: entries.length });
        continue;
      }

      updateEntry(entry.id, { status: "running" });
      try {
        const result = await runImport(kind, entry.payload, {
          tenantId,
          officeNumber,
          yearMonth,
          supabase,
        });
        const status: FileEntryStatus = result.failed > 0 || result.errors.length > 0 ? "error" : "done";
        updateEntry(entry.id, { status, result });
      } catch (e) {
        console.warn(`[batch] ${entry.payload.file.name} 実行失敗:`, e);
        updateEntry(entry.id, {
          status: "error",
          result: {
            inserted: 0,
            skipped: 0,
            failed: 0,
            errors: [e instanceof Error ? e.message : String(e)],
          },
        });
      }
      done++;
      setProgress({ done, total: entries.length });
    }

    setIsRunning(false);
    // サマリ
    let totalInserted = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    setEntries((prev) => {
      for (const e of prev) {
        if (e.result) {
          totalInserted += e.result.inserted;
          totalFailed += e.result.failed;
          totalSkipped += e.result.skipped;
        }
      }
      return prev;
    });
    if (totalFailed > 0) {
      toast.error(`合計 INSERT=${totalInserted} / skip=${totalSkipped} / fail=${totalFailed}`);
    } else {
      toast.success(`合計 INSERT=${totalInserted} / skip=${totalSkipped}`);
    }
  };

  const clearAll = () => {
    if (isRunning) return;
    setEntries([]);
    setProgress(null);
  };

  // ── 一括設定 (= 未入力 cell に同じ事業所/年月をまとめて流し込む) ───────────
  const [bulkOffice, setBulkOffice] = useState<string>("");
  const [bulkYearMonth, setBulkYearMonth] = useState<string>("");

  const applyBulk = (mode: "missing" | "overwrite") => {
    if (isRunning) return;
    if (!bulkOffice && !bulkYearMonth) {
      toast.error("事業所 か 年月 を選択してください");
      return;
    }
    setEntries((prev) => prev.map((e) => {
      const next: Partial<FileEntry> = {};
      if (bulkOffice) {
        // missing: detect + override の両方が空のときだけ書く
        const current = e.overrideOfficeNumber || (e.detect.officeNumber ?? "");
        if (mode === "overwrite" || !current) next.overrideOfficeNumber = bulkOffice;
      }
      if (bulkYearMonth) {
        const current = e.overrideYearMonth || (e.detect.yearMonth ?? "");
        if (mode === "overwrite" || !current) next.overrideYearMonth = bulkYearMonth;
      }
      return { ...e, ...next };
    }));
    toast.success(`一括適用 (${mode === "overwrite" ? "全件上書き" : "未入力のみ"})`);
  };

  // 一括設定で表示する事業所候補 = 全事業所 (種別不明エントリ含むため)
  const bulkOfficeOptions = offices;

  return (
    <div className="space-y-4">
      {/* dropzone */}
      <label
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        className={`block border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
          isDragOver ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50"
        }`}
      >
        <input
          type="file"
          accept=".csv"
          multiple
          // @ts-expect-error: webkitdirectory は標準 React 型に未定義だが Chrome/Edge で動く
          webkitdirectory=""
          onChange={handleFileInputChange}
          className="hidden"
        />
        <div className="text-4xl mb-2">📂</div>
        <p className="font-medium">フォルダ or 複数 CSV をここにドロップ</p>
        <p className="text-sm text-muted-foreground mt-1">
          または クリックでフォルダ選択 (サブフォルダも再帰的に読み込みます)
        </p>
      </label>

      {/* 個別ファイル選択 (フォルダではなくファイルだけ選びたい場合) */}
      <div className="flex justify-end">
        <label className="text-xs text-muted-foreground underline cursor-pointer">
          <input
            type="file"
            accept=".csv"
            multiple
            onChange={handleFileInputChange}
            className="hidden"
          />
          複数ファイル選択 (フォルダではなく)
        </label>
      </div>

      {entries.length > 0 && (
        <>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="text-sm">
              ファイル一覧 (<span className="font-mono">{entries.length}</span> 件)
              {progress && (
                <span className="ml-3 text-xs text-muted-foreground">
                  進捗: {progress.done} / {progress.total}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={clearAll} disabled={isRunning}>
                全クリア
              </Button>
              <Button onClick={runAll} disabled={isRunning}>
                {isRunning ? "取込中..." : "全件取込実行"}
              </Button>
            </div>
          </div>

          {/* 一括設定バー: 未入力 or 全件上書きで 事業所/年月 をまとめて流し込む */}
          <div className="border rounded-md bg-blue-50/40 px-3 py-2 flex items-center gap-2 flex-wrap text-xs">
            <span className="text-muted-foreground font-medium whitespace-nowrap">一括設定</span>
            <select
              className="border rounded px-1.5 py-1 bg-background text-xs"
              value={bulkOffice}
              onChange={(e) => setBulkOffice(e.target.value)}
              disabled={isRunning}
            >
              <option value="">事業所 (選択)</option>
              {bulkOfficeOptions.map((o) => (
                <option key={o.id} value={o.office_number}>
                  {o.short_name || o.name} ({o.office_number})
                </option>
              ))}
            </select>
            <input
              type="month"
              className="border rounded px-1.5 py-1 bg-background text-xs"
              value={bulkYearMonth}
              onChange={(e) => setBulkYearMonth(e.target.value)}
              disabled={isRunning}
            />
            <Button size="sm" variant="outline" onClick={() => applyBulk("missing")} disabled={isRunning}>
              未入力に適用
            </Button>
            <Button size="sm" variant="outline" onClick={() => applyBulk("overwrite")} disabled={isRunning}>
              全件上書き
            </Button>
          </div>

          {/*
            コンパクト table 風レイアウト:
              ファイル (ファイル名 + バッジ + 行数) / 種別 / 事業所 / 年月 / ✕
            グリッド: minmax 指定で横幅可変。md 以上で 1 行表示、sm 以下は折り返し。
            不足 (種別/事業所/年月) は cell 単位で赤枠、行全体は薄赤背景でひと目で分かるように。
          */}
          <div className="border rounded-md overflow-hidden">
            {/* 列ヘッダー (sticky) */}
            <div className="hidden md:grid grid-cols-[minmax(220px,1.8fr)_140px_minmax(220px,2fr)_130px_28px] gap-2 items-center px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/40 border-b">
              <div>ファイル</div>
              <div>種別</div>
              <div>事業所</div>
              <div>年月</div>
              <div></div>
            </div>

            <div className="divide-y">
              {entries.map((entry) => {
                const { kind, officeNumber, yearMonth } = resolveEntry(entry);
                const kindOk = kind !== "unknown";
                const officeOk = !!officeNumber;
                const yearMonthOk = !!yearMonth;
                const canRun = kindOk && officeOk && yearMonthOk && kind !== "billing";
                const kindOffices = kind !== "unknown" && kind !== "billing"
                  ? officesByKind[kind]
                  : offices;
                const rowBg =
                  entry.status === "done" ? "bg-green-50/60" :
                  entry.status === "error" ? "bg-red-50/60" :
                  entry.status === "running" ? "bg-blue-50/60" :
                  (!canRun && kind !== "billing") ? "bg-amber-50/40" :
                  "";

                return (
                  <div
                    key={entry.id}
                    className={`grid grid-cols-1 md:grid-cols-[minmax(220px,1.8fr)_140px_minmax(220px,2fr)_130px_28px] gap-2 items-center px-3 py-1.5 text-xs ${rowBg}`}
                  >
                    {/* ファイル: 名前 + 状態 badge + 行数 */}
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-mono truncate" title={entry.payload.file.name}>
                        {entry.payload.file.name}
                      </span>
                      <ConfidenceBadge d={entry.detect} />
                      <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                        {entry.detect.rowCount}行
                      </span>
                      {entry.status === "running" && (
                        <span className="text-[10px] text-blue-700 whitespace-nowrap">処理中…</span>
                      )}
                      {entry.status === "done" && entry.result && (
                        <span className="text-[10px] text-green-700 whitespace-nowrap" title={`INSERT ${entry.result.inserted} / skip ${entry.result.skipped}`}>
                          ✓ {entry.result.inserted}
                        </span>
                      )}
                      {entry.status === "error" && entry.result && (
                        <span className="text-[10px] text-red-700 truncate" title={entry.result.errors[0] ?? `fail=${entry.result.failed}`}>
                          ✗ {entry.result.errors[0] ?? `fail=${entry.result.failed}`}
                        </span>
                      )}
                    </div>

                    {/* 種別 */}
                    <select
                      className={`border rounded px-1.5 py-1 text-xs bg-background w-full ${kindOk ? "" : "border-red-400"}`}
                      value={entry.overrideKind || ""}
                      onChange={(e) => updateEntry(entry.id, {
                        overrideKind: e.target.value as ImporterKind | "",
                        overrideOfficeNumber: "",
                      })}
                      disabled={isRunning}
                    >
                      {KIND_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.value === "" && entry.detect.kind !== "unknown"
                            ? `${IMPORTER_LABELS[entry.detect.kind as ImporterKind] ?? "不明"} (自動)`
                            : opt.label}
                        </option>
                      ))}
                    </select>

                    {/* 事業所 */}
                    <select
                      className={`border rounded px-1.5 py-1 text-xs bg-background w-full ${officeOk ? "" : "border-red-400"}`}
                      value={entry.overrideOfficeNumber || (entry.detect.officeNumber ?? "")}
                      onChange={(e) => updateEntry(entry.id, { overrideOfficeNumber: e.target.value })}
                      disabled={isRunning || kind === "billing"}
                    >
                      <option value="">(選択)</option>
                      {kindOffices.map((o) => (
                        <option key={o.id} value={o.office_number}>
                          {o.short_name || o.name} ({o.office_number})
                        </option>
                      ))}
                    </select>

                    {/* 年月 */}
                    <input
                      type="month"
                      className={`border rounded px-1.5 py-1 text-xs bg-background w-full ${yearMonthOk ? "" : "border-red-400"}`}
                      value={entry.overrideYearMonth || (entry.detect.yearMonth ?? "")}
                      onChange={(e) => updateEntry(entry.id, { overrideYearMonth: e.target.value })}
                      disabled={isRunning}
                    />

                    {/* 削除 */}
                    <button
                      onClick={() => removeEntry(entry.id)}
                      disabled={isRunning}
                      title="削除"
                      className="text-red-600 hover:text-red-800 disabled:opacity-30 text-base leading-none"
                    >
                      ✕
                    </button>

                    {/* billing 警告 (= 行下に小さく表示。table を崩さないため grid 全 col span) */}
                    {kind === "billing" && (
                      <p className="md:col-span-5 text-[10px] text-orange-700 -mt-0.5">
                        ※ 請求 CSV は /billing/import で取込んでください
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 結果サマリ */}
          {entries.some((e) => e.status === "done" || e.status === "error") && !isRunning && (
            <Alert>
              <AlertDescription>
                <div className="text-sm">
                  完了 {entries.filter((e) => e.status === "done").length} 件 /
                  エラー {entries.filter((e) => e.status === "error").length} 件 /
                  未処理 {entries.filter((e) => e.status === "pending").length} 件
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  合計 INSERT:{" "}
                  <span className="font-mono">
                    {entries.reduce((s, e) => s + (e.result?.inserted ?? 0), 0)}
                  </span>{" "}
                  / skip:{" "}
                  <span className="font-mono">
                    {entries.reduce((s, e) => s + (e.result?.skipped ?? 0), 0)}
                  </span>{" "}
                  / fail:{" "}
                  <span className="font-mono">
                    {entries.reduce((s, e) => s + (e.result?.failed ?? 0), 0)}
                  </span>
                </div>
              </AlertDescription>
            </Alert>
          )}
        </>
      )}
    </div>
  );
}
