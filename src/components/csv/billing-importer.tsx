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

const BILLING_TYPE_LABELS: Record<BillingFileType, string> = {
  "01_介護_金額": "金額（介護）",
  "01_障害_金額": "金額（障害）",
  "02_介護_単位": "単位数（介護）",
  "02_障害_単位": "単位数（障害）",
  "03_介護_利用日": "利用日（介護）",
  "03_障害_利用日": "利用日（障害）",
};
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";

type OfficeLite = { id: string; office_number: string; shogai_office_number: string | null; name: string; short_name: string };

type FileResult = {
  file: File;
  type: BillingFileType | null;
  amountRows: BillingAmountItem[];
  unitRows: BillingUnitItem[];
  dailyRows: BillingDailyItem[];
  errors: string[];
};

/** 事業所エイリアス（office_billing_aliases テーブルと対応） */
type OfficeAlias = {
  id: string;
  office_id: string;
  kind: "shogai_number" | "shogai_name";
  value_raw: string;
  value_norm: string;
  value_name_raw: string;         // '' = 任意名にマッチする fallback
  value_name_norm: string;        // ''
};

/**
 * 未解決の事業者参照。
 * kind=number の場合、nameHint に CSV で同時に現れた事業者名を保持しておき、
 * 紐付け確定時に (番号 + 名前) 組で alias として永続化する。
 *
 * CSV側の名前が空の時 (nameHint === ""):
 *   - 異なるファイルで同じ番号が来た場合に分離するため、sourceFileName でも区別
 *   - UI上で manualName を手入力可能にして、それを alias として永続化できるようにする
 *   - manualName も空のままなら、今回の取り込み限りで適用、alias には保存しない
 */
type UnresolvedRef = {
  kind: "name" | "number";
  value: string;                  // 事業者名 or 障害事業所番号（CSVに入っていた値）
  nameHint?: string;              // 番号と同時にCSVで出た事業者名（空文字の場合あり）
  sourceFileName?: string;        // CSVが名前空だった時、どのファイルから来たかを記録（UI表示＆スコープ限定用）
  manualName?: string;            // ユーザーが UI で手入力した名前。空のままなら alias 保存しない
  pickedOfficeId: string | null;  // ユーザーが選んだ事業所id。未選択はnull
};

/**
 * fallback alias (value_name_norm='') で自動解決された行の記録。
 * CSVに事業者名がなかったため、過去の alias 設定のみを根拠に特定事業所にルーティングした。
 * 誤ルーティングの恐れがあるため、取り込み前にユーザー確認する。
 */
type FallbackHit = {
  csvNumber: string;
  csvName: string;
  resolvedOfficeId: string;
  resolvedOfficeName: string;
  sourceFileName: string;
};

/** 取り込み前のプレビューに表示するスコープごとの件数（DB既存 vs 新規） */
type ImportScopeSummary = {
  segment: "介護" | "障害";
  office_number: string;
  office_name: string;
  billing_month: string;
  currentAmount: number;
  currentUnit: number;
  currentDaily: number;
  newAmount: number;
  newUnit: number;
  newDaily: number;
  /** 既に発行済・入金済・調整済の行の件数（これがあると再取り込みでステータスが吹き飛ぶ） */
  lockedRows: number;
  /** ユーザーがこのスコープを取り込み対象から除外しているか */
  excluded?: boolean;
};

/**
 * 事業者名から office_number を引き当てる
 * 表記揺れ対策:
 *  - 全角英数/カナ ↔ 半角
 *  - 括弧内の補足（居宅介護）等を除去
 *  - 「ステーション」の有無
 *  - スペース無視
 */
function normalizeOfficeName(raw: string): string {
  if (!raw) return "";
  let s = raw.normalize("NFKC"); // 全角英数/カナ・半角カナの揺れ解消
  // 各種括弧内を除去: (), （）, 【】, 〔〕, 「」, 『』, 〈〉, 《》
  s = s.replace(/[（(][^）)]*[）)]/g, "");
  s = s.replace(/[【〔「『〈《][^】〕」』〉》]*[】〕」』〉》]/g, "");
  // 長音記号・ハイフン系を削除（ー, -, ‐, —, ━, 〜 等）
  s = s.replace(/[ー\-‐–—━]/g, "");
  // 空白除去
  s = s.replace(/[\s\u3000]/g, "");
  // 「ステーション」の有無ゆらぎ
  s = s.replace(/ステーション/g, "");
  // 大文字小文字ゆらぎ
  s = s.toLowerCase();
  return s;
}

/**
 * 介護保険事業所番号（office_number）から事業所を引き当て。
 * 注意: 過去は offices.shogai_office_number もここで直接マッチさせていたが、
 * 9999999999 のようなダミー番号が複数事業所で登録されていた場合に誤紐付けを起こすため廃止。
 * 障害番号は必ず `(番号 + 事業者名)` の alias 経由で特定する。
 */
function resolveOfficeByNumber(num: string, offices: OfficeLite[]): OfficeLite | null {
  if (!num) return null;
  return offices.find((o) => o.office_number === num) ?? null;
}

/**
 * エイリアス表から (番号, 事業者名) ペアで事業所を引き当てる。
 * 優先度:
 *   1) (番号, 名前) 完全一致の alias を最優先
 *   2) (番号, 名前NULL) = どの名前でも受け入れる fallback alias
 *   3) 名前だけの alias（kind=shogai_name）
 */
type AliasResolution = {
  office: OfficeLite | null;
  via: "exact" | "fallback" | "name" | null;  // どの方法で解決したか
};

/**
 * エイリアス表から (番号, 事業者名) ペアで事業所を引き当てる。
 * 優先度:
 *   1) (番号, 名前) 完全一致の alias
 *   2) 名前だけの alias (kind='shogai_name')
 *
 * 注: 旧仕様にあった「(番号, 名前=空) の fallback」は、誤紐付けを招くため廃止。
 *     同じ番号が複数事業所で使われている場合、必ず名前で区別するポリシー。
 */
function resolveOfficeByAlias(
  rawNumber: string,
  rawName: string,
  aliases: OfficeAlias[],
  offices: OfficeLite[],
): AliasResolution {
  const numNorm = (rawNumber ?? "").trim().toLowerCase();
  const nameNorm = rawName ? normalizeOfficeName(rawName) : "";

  if (numNorm && nameNorm) {
    // 1) (number, name) 両方一致のみ
    const exact = aliases.find((a) =>
      a.kind === "shogai_number" &&
      a.value_norm === numNorm &&
      a.value_name_norm === nameNorm
    );
    if (exact) return { office: offices.find((o) => o.id === exact.office_id) ?? null, via: "exact" };
  }
  if (nameNorm) {
    // 2) 名前だけの alias (番号が空のCSV向け)
    const byName = aliases.find((a) => a.kind === "shogai_name" && a.value_norm === nameNorm);
    if (byName) return { office: offices.find((o) => o.id === byName.office_id) ?? null, via: "name" };
  }
  return { office: null, via: null };
}

function resolveOfficeNumber(rawName: string, offices: OfficeLite[]): string | null {
  const target = normalizeOfficeName(rawName);
  if (!target) return null;
  // 完全一致
  const eq = offices.find((o) => normalizeOfficeName(o.name) === target || normalizeOfficeName(o.short_name ?? "") === target);
  if (eq) return eq.office_number;
  // 含む関係
  const inc = offices.find((o) => {
    const on = normalizeOfficeName(o.name);
    return on && (on.includes(target) || target.includes(on));
  });
  if (inc) return inc.office_number;
  // 略称での含む関係
  const sh = offices.find((o) => {
    const sn = normalizeOfficeName(o.short_name ?? "");
    return sn && (sn.includes(target) || target.includes(sn));
  });
  if (sh) return sh.office_number;
  return null;
}

export function BillingImporter() {
  const [results, setResults] = useState<FileResult[]>([]);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState(false);
  const [offices, setOffices] = useState<OfficeLite[]>([]);
  const [aliases, setAliases] = useState<OfficeAlias[]>([]);
  const [existingMatrix, setExistingMatrix] = useState<Map<string, { amount: number; unit: number; daily: number }>>(new Map());
  // 未解決の事業者参照（名前 or 障害番号）。ユーザーが事業所を選ぶと office_number に解決される。
  const [unresolvedRefs, setUnresolvedRefs] = useState<UnresolvedRef[]>([]);
  // fallback alias で自動解決された行の情報（警告表示用）
  const [fallbackHits, setFallbackHits] = useState<FallbackHit[]>([]);
  // 取り込み前のプレビュー（既存 vs 新規の件数比較）
  const [preview, setPreview] = useState<ImportScopeSummary[] | null>(null);
  // プレビュー内でサンプル行展開中のスコープキー (`${segment}|${office_number}|${billing_month}`)
  const [expandedScope, setExpandedScope] = useState<string | null>(null);

  const fetchAliases = useCallback(async () => {
    const { data, error } = await supabase
      .from("payroll_office_billing_aliases")
      .select("id, office_id, kind, value_raw, value_norm, value_name_raw, value_name_norm");
    if (error) {
      // テーブル未作成でも致命的にはしない（旧動作にフォールバック）
      console.warn("office_billing_aliases 取得失敗（マイグレーション未適用の可能性）:", error.message);
      setAliases([]);
      return;
    }
    setAliases((data ?? []) as OfficeAlias[]);
  }, []);

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
    await scan("payroll_billing_amount_items", "amount");
    await scan("payroll_billing_unit_items", "unit");
    await scan("payroll_billing_daily_items", "daily");
    setExistingMatrix(m);
  }, []);

  useEffect(() => {
    supabase.from("payroll_offices").select("id, office_number, shogai_office_number, name, short_name").then(({ data }) => {
      if (data) setOffices(data as OfficeLite[]);
    });
    fetchAliases();
    fetchExistingMatrix();
  }, [fetchExistingMatrix, fetchAliases]);

  const handleClearScope = async (segment: string, office_number: string, billing_month: string, counts: { amount: number; unit: number; daily: number }) => {
    const off = offices.find((o) => o.office_number === office_number);
    const officeName = (off?.short_name || off?.name) ?? office_number;
    const label = `${billing_month.slice(0, 4)}年${parseInt(billing_month.slice(4, 6), 10)}月`;
    const total = counts.amount + counts.unit + counts.daily;
    if (!confirm(`${officeName} ${label} の${segment}データ（金額${counts.amount}件 / 単位${counts.unit}件 / 利用日${counts.daily}件、計${total}件）を削除しますか？`)) return;
    const where = { segment, office_number, billing_month };
    const q = (table: string) => supabase.from(table).delete().match(where);
    const [r1, r2, r3] = await Promise.all([q("payroll_billing_amount_items"), q("payroll_billing_unit_items"), q("payroll_billing_daily_items")]);
    if (r1.error || r2.error || r3.error) {
      toast.error(`削除エラー: ${(r1.error || r2.error || r3.error)!.message}`);
      return;
    }
    toast.success(`${officeName} ${label}(${segment}) を削除しました`);
    fetchExistingMatrix();
  };

  // 単一ファイルを指定タイプで解析する共通関数
  // 各行のoffice_numberを、介護番号／障害番号／事業者名 の順で解決し、介護番号に正規化する。
  // 解決できなかったものは (kind: "number" | "name", value) として返す。
  const parseByType = useCallback(async (f: File, type: BillingFileType) => {
    let amountRows: BillingAmountItem[] = [];
    let unitRows: BillingUnitItem[] = [];
    let dailyRows: BillingDailyItem[] = [];
    if (type === "01_介護_金額") ({ data: amountRows } = await parse01KaigoAmount(f));
    else if (type === "01_障害_金額") ({ data: amountRows } = await parse01ShogaiAmount(f));
    else if (type === "02_介護_単位") ({ data: unitRows } = await parse02KaigoUnit(f));
    else if (type === "02_障害_単位") ({ data: unitRows } = await parse02ShogaiUnit(f));
    else if (type === "03_介護_利用日") ({ data: dailyRows } = await parse03KaigoDaily(f));
    else if (type === "03_障害_利用日") ({ data: dailyRows } = await parse03ShogaiDaily(f));

    // 未解決の (番号, 名前) ペア・(名前のみ) を重複排除しつつ記録
    // 番号のキー:
    //   - nameHint あり: `${number}||${name}` （同じ番号でも名前が違えば別扱い）
    //   - nameHint 空:   `${number}||__empty__||${fileName}` （同じ番号でも別ファイルから来たら別扱い）
    const unresolvedNumPairs = new Map<string, { value: string; nameHint?: string; sourceFileName?: string }>();
    const unresolvedNames = new Set<string>();
    // fallback alias で自動解決された参照（警告対象）
    // key = `${numStr}||${nameStr}||${officeId}||${fileName}`
    const fallbackHits = new Map<string, FallbackHit>();

    const resolveRow = <T extends { office_number: string; office_name?: string }>(r: T) => {
      const numStr = (r.office_number ?? "").trim();
      const nameStr = (r.office_name ?? "").trim();

      if (numStr) {
        // 1) 番号ベース: 介護番号 or 障害番号（offices テーブル直接）
        const direct = resolveOfficeByNumber(numStr, offices);
        if (direct) { r.office_number = direct.office_number; return; }
        // 2) エイリアス: (番号, 名前) ペアで引く
        const aliasRes = resolveOfficeByAlias(numStr, nameStr, aliases, offices);
        if (aliasRes.office) {
          r.office_number = aliasRes.office.office_number;
          if (aliasRes.via === "fallback") {
            // CSVに名前がないが、fallback alias でルーティングされたケース → 警告対象
            const key = `${numStr}||${nameStr}||${aliasRes.office.id}||${f.name}`;
            if (!fallbackHits.has(key)) {
              fallbackHits.set(key, {
                csvNumber: numStr,
                csvName: nameStr,
                resolvedOfficeId: aliasRes.office.id,
                resolvedOfficeName: aliasRes.office.short_name || aliasRes.office.name,
                sourceFileName: f.name,
              });
            }
          }
          return;
        }
        // 3) 未解決
        const key = nameStr
          ? `${numStr}||${nameStr}`
          : `${numStr}||__empty__||${f.name}`;
        if (!unresolvedNumPairs.has(key)) {
          unresolvedNumPairs.set(key, {
            value: numStr,
            nameHint: nameStr || undefined,
            sourceFileName: nameStr ? undefined : f.name,
          });
        }
        return;
      }
      // 番号なし → 名前だけで試す
      if (!nameStr) return;
      // 1) エイリアス（名前のみ）
      const aliasRes = resolveOfficeByAlias("", nameStr, aliases, offices);
      if (aliasRes.office) { r.office_number = aliasRes.office.office_number; return; }
      // 2) offices テーブルの名前ファジーマッチ
      const num = resolveOfficeNumber(nameStr, offices);
      if (num) { r.office_number = num; return; }
      unresolvedNames.add(nameStr);
    };
    for (const r of amountRows) resolveRow(r);
    for (const r of unitRows)   resolveRow(r);
    for (const r of dailyRows)  resolveRow(r);
    return {
      amountRows,
      unitRows,
      dailyRows,
      unresolvedNumPairs: [...unresolvedNumPairs.values()],
      unresolvedNames: [...unresolvedNames],
      fallbackHits: [...fallbackHits.values()],
    };
  }, [offices, aliases]);

  const mergeUnresolved = (
    numPairs: { value: string; nameHint?: string; sourceFileName?: string }[],
    names: string[],
  ) => {
    setUnresolvedRefs((prev) => {
      // 重複判定キー:
      //   - kind=number で nameHint あり: (kind, value, nameHint)
      //   - kind=number で nameHint 空:   (kind, value, __empty__, sourceFileName) ← ファイル別に分離
      //   - kind=name: (kind, value)
      const keyOf = (r: UnresolvedRef) => {
        if (r.kind === "name") return `name:${r.value}`;
        if (r.nameHint) return `number:${r.value}::${r.nameHint}`;
        return `number:${r.value}::__empty__::${r.sourceFileName ?? ""}`;
      };
      const existing = new Map(prev.map((r) => [keyOf(r), r]));
      for (const p of numPairs) {
        const ref: UnresolvedRef = {
          kind: "number",
          value: p.value,
          nameHint: p.nameHint,
          sourceFileName: p.sourceFileName,
          pickedOfficeId: null,
        };
        const k = keyOf(ref);
        if (!existing.has(k)) existing.set(k, ref);
      }
      for (const n of names) {
        const ref: UnresolvedRef = { kind: "name", value: n, pickedOfficeId: null };
        const k = keyOf(ref);
        if (!existing.has(k)) existing.set(k, ref);
      }
      return [...existing.values()];
    });
  };

  const mergeFallbackHits = (hits: FallbackHit[]) => {
    setFallbackHits((prev) => {
      const keyOf = (h: FallbackHit) => `${h.csvNumber}|${h.csvName}|${h.resolvedOfficeId}|${h.sourceFileName}`;
      const map = new Map(prev.map((h) => [keyOf(h), h]));
      for (const h of hits) if (!map.has(keyOf(h))) map.set(keyOf(h), h);
      return [...map.values()];
    });
  };

  const handleFilesSelected = useCallback(async (files: File[]) => {
    setImported(false);
    const newResults: FileResult[] = [];
    const newUnresolvedNumPairs: { value: string; nameHint?: string; sourceFileName?: string }[] = [];
    const newUnresolvedNames: string[] = [];
    const newFallbackHits: FallbackHit[] = [];
    for (const f of files) {
      const type = await detectBillingFileType(f);
      let amountRows: BillingAmountItem[] = [];
      let unitRows: BillingUnitItem[] = [];
      let dailyRows: BillingDailyItem[] = [];
      const errors: string[] = [];
      if (!type) {
        errors.push("種別を判別できませんでした。下のプルダウンで手動選択してください");
      } else {
        try {
          const parsed = await parseByType(f, type);
          amountRows = parsed.amountRows;
          unitRows = parsed.unitRows;
          dailyRows = parsed.dailyRows;
          newUnresolvedNumPairs.push(...parsed.unresolvedNumPairs);
          newUnresolvedNames.push(...parsed.unresolvedNames);
          newFallbackHits.push(...parsed.fallbackHits);
        } catch (e) {
          errors.push(`パースエラー: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      newResults.push({ file: f, type, amountRows, unitRows, dailyRows, errors });
    }
    setResults((prev) => [...prev, ...newResults]);
    mergeUnresolved(newUnresolvedNumPairs, newUnresolvedNames);
    mergeFallbackHits(newFallbackHits);
  }, [parseByType]);

  // 手動で種別を変更した際の再解析
  const updateFileType = useCallback(async (index: number, newType: BillingFileType) => {
    const target = results[index];
    if (!target) return;
    try {
      const parsed = await parseByType(target.file, newType);
      setResults((prev) => prev.map((r, i) => i === index
        ? { ...r, type: newType, errors: [], amountRows: parsed.amountRows, unitRows: parsed.unitRows, dailyRows: parsed.dailyRows }
        : r));
      mergeUnresolved(parsed.unresolvedNumPairs, parsed.unresolvedNames);
      mergeFallbackHits(parsed.fallbackHits);
    } catch (e) {
      setResults((prev) => prev.map((r, i) => i === index
        ? { ...r, type: newType, amountRows: [], unitRows: [], dailyRows: [], errors: [`パースエラー: ${e instanceof Error ? e.message : String(e)}`] }
        : r));
    }
  }, [parseByType, results]);

  const handleClear = () => {
    setResults([]);
    setUnresolvedRefs([]);
    setFallbackHits([]);
    setPreview(null);
    setImported(false);
  };

  /**
   * マッピング（未解決参照・alias永続化情報）を組み立てて、各 results 行の office_number を書き換える。
   * 戻り値: alias永続化リスト, shogai更新リスト, CSV→DB行数サマリ（プレビュー用）
   */
  const resolveAndApplyMappings = () => {
    type PerFileRef = { numNorm: string; officeNumber: string };
    const pairMap = new Map<string, string>();
    const nameMap = new Map<string, string>();
    const perFileNumberRefs = new Map<string, PerFileRef[]>();
    const shogaiUpdates: { officeId: string; shogaiNum: string }[] = [];
    const newAliases: {
      office_id: string;
      kind: "shogai_number" | "shogai_name";
      value_raw: string;
      value_norm: string;
      value_name_raw: string;
      value_name_norm: string;
    }[] = [];

    for (const ref of unresolvedRefs) {
      if (!ref.pickedOfficeId) continue;
      const off = offices.find((o) => o.id === ref.pickedOfficeId);
      if (!off) continue;
      if (ref.kind === "number") {
        const numNorm = ref.value.trim().toLowerCase();
        const effectiveName = (ref.manualName ?? "").trim() || ref.nameHint || "";
        const nameNorm = effectiveName ? normalizeOfficeName(effectiveName) : "";
        if (nameNorm) {
          pairMap.set(`${numNorm}||${nameNorm}`, off.office_number);
          newAliases.push({
            office_id: off.id, kind: "shogai_number",
            value_raw: ref.value, value_norm: numNorm,
            value_name_raw: effectiveName, value_name_norm: nameNorm,
          });
        } else {
          const file = ref.sourceFileName ?? "";
          const arr = perFileNumberRefs.get(file) ?? [];
          arr.push({ numNorm, officeNumber: off.office_number });
          perFileNumberRefs.set(file, arr);
        }
        if (off.shogai_office_number !== ref.value) {
          shogaiUpdates.push({ officeId: off.id, shogaiNum: ref.value });
        }
      } else {
        const nameNorm = normalizeOfficeName(ref.value);
        nameMap.set(nameNorm, off.office_number);
        newAliases.push({
          office_id: off.id, kind: "shogai_name",
          value_raw: ref.value, value_norm: nameNorm,
          value_name_raw: "", value_name_norm: "",
        });
      }
    }

    const applyMapForFile = <T extends { office_number: string; office_name?: string }>(rows: T[], fileName: string) => {
      const fileRefs = perFileNumberRefs.get(fileName) ?? [];
      for (const r of rows) {
        const numStr = (r.office_number ?? "").trim().toLowerCase();
        const nameStr = r.office_name ? normalizeOfficeName(r.office_name) : "";
        if (!numStr && !nameStr) continue;
        if (numStr && nameStr && pairMap.has(`${numStr}||${nameStr}`)) {
          r.office_number = pairMap.get(`${numStr}||${nameStr}`)!; continue;
        }
        if (numStr) {
          const hit = fileRefs.find((x) => x.numNorm === numStr);
          if (hit) { r.office_number = hit.officeNumber; continue; }
        }
        if (!numStr && nameStr && nameMap.has(nameStr)) {
          r.office_number = nameMap.get(nameStr)!; continue;
        }
      }
    };
    for (const r of results) {
      applyMapForFile(r.amountRows, r.file.name);
      applyMapForFile(r.unitRows, r.file.name);
      applyMapForFile(r.dailyRows, r.file.name);
    }

    return { newAliases, shogaiUpdates };
  };

  /**
   * プレビュー表示: 各 (segment, office_number, billing_month) スコープごとに
   * DB の既存件数と新規件数を比較するサマリを組み立てる
   */
  const handlePreview = async () => {
    // 未選択の未解決参照があれば警告（無視して進める選択肢も残す）
    const pendingRefs = unresolvedRefs.filter((r) => !r.pickedOfficeId);
    if (pendingRefs.length > 0) {
      if (!confirm(`未解決の事業者が${pendingRefs.length}件あります。該当行は office_number が空のまま登録されます（集計で表示されません）。このまま進めますか？`)) return;
    }

    // マッピング解決を実施（rows の office_number を書き換え）
    resolveAndApplyMappings();

    // 新規行数をスコープごとに集計（取り込みは「提供年月」ベース）
    type ScopeCounts = { amount: number; unit: number; daily: number };
    const newCounts = new Map<string, ScopeCounts>();
    const keyOf = (segment: string, office_number: string, service_month: string) =>
      `${segment}|${office_number}|${service_month}`;
    const ensure = (k: string) => {
      if (!newCounts.has(k)) newCounts.set(k, { amount: 0, unit: 0, daily: 0 });
      return newCounts.get(k)!;
    };
    // 各行の scope は service_month (無ければ billing_month をフォールバック)
    const scopeOf = (r: { billing_month: string; service_month?: string }) => r.service_month || r.billing_month;
    for (const r of results) {
      for (const a of r.amountRows) { const sm = scopeOf(a); if (a.office_number && sm) ensure(keyOf(a.segment, a.office_number, sm)).amount++; }
      for (const u of r.unitRows)   { const sm = scopeOf(u); if (u.office_number && sm) ensure(keyOf(u.segment, u.office_number, sm)).unit++; }
      for (const d of r.dailyRows)  { const sm = scopeOf(d); if (d.office_number && sm) ensure(keyOf(d.segment, d.office_number, sm)).daily++; }
    }

    if (newCounts.size === 0) {
      toast.error("取り込み対象のデータがありません");
      return;
    }

    // DB の既存件数をスコープごとに取得（service_month ベース）
    const fetchCount = async (table: string, segment: string, office_number: string, service_month: string) => {
      const { count } = await supabase
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("segment", segment)
        .eq("office_number", office_number)
        .eq("service_month", service_month);
      return count ?? 0;
    };
    // 「発行済・入金済・調整済」等の再取り込みで失われる行の数
    const fetchLockedCount = async (segment: string, office_number: string, service_month: string) => {
      const { count } = await supabase
        .from("payroll_billing_amount_items")
        .select("id", { count: "exact", head: true })
        .eq("segment", segment)
        .eq("office_number", office_number)
        .eq("service_month", service_month)
        .in("billing_status", ["invoiced", "paid", "overdue", "adjustment"]);
      return count ?? 0;
    };

    const summaries: ImportScopeSummary[] = [];
    for (const [k, nc] of newCounts) {
      const [segment, office_number, service_month] = k.split("|") as ["介護" | "障害", string, string];
      const [currentAmount, currentUnit, currentDaily, lockedRows] = await Promise.all([
        fetchCount("payroll_billing_amount_items", segment, office_number, service_month),
        fetchCount("payroll_billing_unit_items", segment, office_number, service_month),
        fetchCount("payroll_billing_daily_items", segment, office_number, service_month),
        fetchLockedCount(segment, office_number, service_month),
      ]);
      const off = offices.find((o) => o.office_number === office_number);
      summaries.push({
        segment, office_number, billing_month: service_month, // UI上は「月」として service_month を表示
        office_name: (off?.short_name || off?.name) ?? office_number,
        currentAmount, currentUnit, currentDaily,
        newAmount: nc.amount, newUnit: nc.unit, newDaily: nc.daily,
        lockedRows,
      });
    }
    // 表示順: 事業所名 → 月 → 区分
    summaries.sort((a, b) => {
      const na = a.office_name.localeCompare(b.office_name, "ja");
      if (na !== 0) return na;
      if (a.billing_month !== b.billing_month) return a.billing_month.localeCompare(b.billing_month);
      return a.segment.localeCompare(b.segment);
    });

    setPreview(summaries);
  };

  /** プレビュー確認後の実際の取り込み */
  const executeImport = async () => {
    // resolveAndApplyMappings は既にプレビュー時点で呼ばれているが、念のため再適用（alias永続化情報は必要）
    const { newAliases, shogaiUpdates } = resolveAndApplyMappings();

    const totalAmount = results.reduce((s, r) => s + r.amountRows.length, 0);
    const totalUnit = results.reduce((s, r) => s + r.unitRows.length, 0);
    const totalDaily = results.reduce((s, r) => s + r.dailyRows.length, 0);
    if (totalAmount + totalUnit + totalDaily === 0) { toast.error("取り込むデータがありません"); return; }

    // 確定済行があれば追加で confirm（プレビューでも表示しているが二重セーフティ）
    const lockedTotal = (preview ?? []).reduce((s, p) => s + p.lockedRows, 0);
    if (lockedTotal > 0) {
      if (!confirm(
        `⚠️ 発行済・入金済等の行が ${lockedTotal} 件あります。\n` +
        `取り込むと、それらの発行日・入金日・調整行が削除されます。\n\n` +
        `本当に取り込みますか？`
      )) return;
    }

    setImporting(true);
    try {
      // エイリアス永続化（(番号, 名前) ペアで事業所を記憶）
      if (newAliases.length > 0) {
        const { error } = await supabase.from("payroll_office_billing_aliases").upsert(newAliases, {
          onConflict: "kind,value_norm,value_name_norm",
          ignoreDuplicates: false,
        });
        if (error) {
          console.error("office_billing_aliases 保存エラー", error);
          // テーブル未作成などの場合でも取り込み自体は継続させる（旧 shogai_office_number 更新で fallback）
          toast.warning(`エイリアス保存に失敗（${error.message}）。shogai_office_number のみ更新します。`);
        } else {
          // 最新エイリアスを再取得
          fetchAliases();
        }
      }

      // 後方互換: offices.shogai_office_number を更新（/offices 編集画面での表示用）
      for (const u of shogaiUpdates) {
        const { error } = await supabase.from("payroll_offices").update({ shogai_office_number: u.shogaiNum }).eq("id", u.officeId);
        if (error) console.error("shogai_office_number 更新エラー", error);
      }
      if (shogaiUpdates.length > 0) {
        // 最新のofficesを再取得（以降の取り込みで同じ番号が自動解決されるように）
        const { data: refreshed } = await supabase.from("payroll_offices").select("id, office_number, shogai_office_number, name, short_name");
        if (refreshed) setOffices(refreshed as OfficeLite[]);
      }

      // 除外スコープの Set を構築（プレビュー UI で外されたもの、月は service_month ベース）
      const excludedScopes = new Set<string>();
      for (const s of preview ?? []) {
        if (s.excluded) excludedScopes.add(`${s.segment}|${s.office_number}|${s.billing_month}`);
      }
      const isExcluded = (segment: string, office_number: string, month: string) =>
        excludedScopes.has(`${segment}|${office_number}|${month}`);

      // 事業所×提供月 ごとに既存データを削除してから再挿入（重複防止）
      type ScopeKey = { office_number: string; service_month: string; segment: "介護" | "障害" };
      const scopes = new Set<string>();
      const scopeList: ScopeKey[] = [];
      const push = (s: ScopeKey) => {
        if (!s.office_number || !s.service_month) return;
        if (isExcluded(s.segment, s.office_number, s.service_month)) return;
        const k = `${s.segment}|${s.office_number}|${s.service_month}`;
        if (!scopes.has(k)) { scopes.add(k); scopeList.push(s); }
      };
      const sm = (r: { billing_month: string; service_month?: string }) => r.service_month || r.billing_month;
      for (const r of results) {
        for (const a of r.amountRows) push({ segment: a.segment, office_number: a.office_number, service_month: sm(a) });
        for (const u of r.unitRows)   push({ segment: u.segment, office_number: u.office_number, service_month: sm(u) });
        for (const d of r.dailyRows)  { const m = sm(d); if (m) push({ segment: d.segment, office_number: d.office_number, service_month: m }); }
      }

      for (const s of scopeList) {
        await supabase.from("payroll_billing_amount_items").delete()
          .eq("segment", s.segment).eq("office_number", s.office_number).eq("service_month", s.service_month);
        await supabase.from("payroll_billing_unit_items").delete()
          .eq("segment", s.segment).eq("office_number", s.office_number).eq("service_month", s.service_month);
        await supabase.from("payroll_billing_daily_items").delete()
          .eq("segment", s.segment).eq("office_number", s.office_number).eq("service_month", s.service_month);
      }

      // INSERT (chunk)
      const chunk = 500;
      const insertAll = async <T,>(table: string, rows: T[]) => {
        for (let i = 0; i < rows.length; i += chunk) {
          const { error } = await supabase.from(table).insert(rows.slice(i, i + chunk));
          if (error) throw error;
        }
      };
      // 除外スコープの行は INSERT からも除く (service_month ベース)
      const filterNotExcluded = <T extends { segment: "介護" | "障害"; office_number: string; billing_month: string; service_month?: string }>(rows: T[]) =>
        rows.filter((r) => !isExcluded(r.segment, r.office_number, r.service_month || r.billing_month));
      const allAmount = filterNotExcluded(results.flatMap((r) => r.amountRows));
      // billing_unit_items / billing_daily_items の DB カラムには office_name が無いため除外
      const stripOfficeName = <T extends { office_name?: string }>(rows: T[]): Omit<T, "office_name">[] =>
        rows.map((r) => {
          const copy = { ...r } as T;
          delete copy.office_name;
          return copy;
        });
      const allUnit = stripOfficeName(filterNotExcluded(results.flatMap((r) => r.unitRows)));
      const allDaily = stripOfficeName(filterNotExcluded(results.flatMap((r) => r.dailyRows)));
      await insertAll("payroll_billing_amount_items", allAmount);
      await insertAll("payroll_billing_unit_items", allUnit);
      await insertAll("payroll_billing_daily_items", allDaily);

      toast.success(`金額${allAmount.length}件 / 単位${allUnit.length}件 / 利用日${allDaily.length}件を取り込みました`);
      setImported(true);
      setResults([]);
      setUnresolvedRefs([]);
      setFallbackHits([]);
      setPreview(null);
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
          <div className="border rounded-md divide-y">
            {results.map((r, i) => (
              <div key={i} className={`px-3 py-2 flex items-center gap-3 flex-wrap text-sm ${r.errors.length > 0 ? "bg-red-50" : ""}`}>
                <span className="font-mono text-xs truncate max-w-[280px]" title={r.file.name}>{r.file.name}</span>
                <select
                  className="border rounded px-2 py-1 text-xs bg-background"
                  value={r.type ?? ""}
                  onChange={(e) => {
                    const v = e.target.value as BillingFileType | "";
                    if (v) updateFileType(i, v);
                  }}
                >
                  <option value="" disabled>種別を選択</option>
                  {(Object.keys(BILLING_TYPE_LABELS) as BillingFileType[]).map((k) => (
                    <option key={k} value={k}>{BILLING_TYPE_LABELS[k]}</option>
                  ))}
                </select>
                <span className="text-xs text-muted-foreground">
                  {r.amountRows.length > 0 && <>金額{r.amountRows.length}件 </>}
                  {r.unitRows.length > 0 && <>単位{r.unitRows.length}件 </>}
                  {r.dailyRows.length > 0 && <>利用日{r.dailyRows.length}件 </>}
                  {r.amountRows.length + r.unitRows.length + r.dailyRows.length === 0 && <>—</>}
                </span>
                {r.errors.length > 0 && (
                  <span className="text-xs text-red-700">{r.errors.join(" / ")}</span>
                )}
                <button
                  className="ml-auto text-xs text-red-600 hover:text-red-800"
                  onClick={() => {
                    const removedFile = r.file.name;
                    setResults((prev) => prev.filter((_, j) => j !== i));
                    // 削除したファイルだけに依存する未解決参照・fallback を落とす
                    setUnresolvedRefs((prev) => prev.filter((x) => !(x.sourceFileName === removedFile)));
                    setFallbackHits((prev) => prev.filter((x) => x.sourceFileName !== removedFile));
                  }}
                  title="このファイルを一覧から外す"
                >
                  ✕ 削除
                </button>
              </div>
            ))}
            <div className="px-3 py-2 bg-muted/20 flex justify-end">
              <Button variant="ghost" size="sm" onClick={handleClear}>全てクリア</Button>
            </div>
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

          {/* 未解決の事業者参照: 該当の事業所を選択してもらう */}
          {unresolvedRefs.length > 0 && (() => {
            // 同じ番号が複数の名前で出てきた場合を把握（ユーザーに気づかせる）
            const numCounts = new Map<string, number>();
            for (const ref of unresolvedRefs) {
              if (ref.kind !== "number") continue;
              numCounts.set(ref.value, (numCounts.get(ref.value) ?? 0) + 1);
            }
            return (
              <div className="border border-yellow-300 rounded-md bg-yellow-50 p-3 space-y-2">
                <p className="text-sm font-medium text-yellow-900">
                  ⚠ CSV内の以下の事業者を、どの事業所と紐付けるか選択してください
                </p>
                <p className="text-xs text-yellow-800">
                  ・紐付けは <b>「番号 + 事業者名」の組ごと</b> に個別に判断できます（複数事業所合算CSVでも事業所ごとに違う紐付け先を選べます）。<br />
                  ・記憶されるのも (番号 + 名前) ペアなので、同じ番号が別事業所のCSVで来ても誤紐付けしません。<br />
                  ・CSVに事業者名が無い場合、ファイル単位で分けて表示されます。手入力すれば恒久登録、空なら今回限り。
                </p>
                <table className="w-full text-xs">
                  <thead className="bg-yellow-100/60">
                    <tr>
                      <th className="text-left px-2 py-1 font-medium w-16">種別</th>
                      <th className="text-left px-2 py-1 font-medium">事業所番号</th>
                      <th className="text-left px-2 py-1 font-medium">事業者名</th>
                      <th className="text-left px-2 py-1 font-medium">紐付け先の事業所</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unresolvedRefs.map((ref, i) => {
                      const sameNumMulti = ref.kind === "number" && (numCounts.get(ref.value) ?? 0) > 1;
                      return (
                        <tr key={i} className="border-t border-yellow-200 align-top">
                          <td className="px-2 py-1 whitespace-nowrap">
                            {ref.kind === "number" ? (
                              <span className="text-purple-700">事業所番号</span>
                            ) : (
                              <span className="text-blue-700">事業者名</span>
                            )}
                          </td>
                          <td className="px-2 py-1">
                            {ref.kind === "number" ? (
                              <div>
                                <span className="font-mono font-medium">{ref.value}</span>
                                {sameNumMulti && (
                                  <span className="ml-1 text-[10px] text-orange-700 bg-orange-100 border border-orange-300 rounded px-1">
                                    同番号の別事業所あり
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-muted-foreground/60">—</span>
                            )}
                          </td>
                          <td className="px-2 py-1">
                            {ref.kind === "number" ? (
                              ref.nameHint ? (
                                <div>
                                  <span className="inline-block bg-green-100 text-green-900 rounded px-2 py-1 text-[11px] font-medium">
                                    📋 {ref.nameHint}
                                  </span>
                                  <p className="text-[9px] text-muted-foreground mt-0.5">CSVの事業所名</p>
                                  {ref.sourceFileName && (
                                    <p className="text-[9px] text-muted-foreground mt-0.5">📄 {ref.sourceFileName}</p>
                                  )}
                                </div>
                              ) : (
                                <div className="space-y-1">
                                  {ref.sourceFileName && (
                                    <p className="text-[11px] bg-blue-100 text-blue-900 rounded px-2 py-1 font-medium inline-block">
                                      📄 {ref.sourceFileName}
                                    </p>
                                  )}
                                  <input
                                    type="text"
                                    className="border rounded px-2 py-0.5 text-xs bg-background w-full min-w-[180px]"
                                    placeholder="事業者名を入力（任意）"
                                    value={ref.manualName ?? ""}
                                    onChange={(e) => {
                                      const v = e.target.value;
                                      setUnresolvedRefs((prev) => prev.map((x, j) => j === i ? { ...x, manualName: v } : x));
                                    }}
                                  />
                                  <p className="text-[9px] text-muted-foreground">
                                    ※ CSVに事業所名列が無いかパースできませんでした
                                  </p>
                                </div>
                              )
                            ) : (
                              <span className="font-medium">{ref.value}</span>
                            )}
                          </td>
                          <td className="px-2 py-1">
                            <select
                              className="border rounded px-2 py-0.5 text-xs bg-background min-w-[280px]"
                              value={ref.pickedOfficeId ?? ""}
                              onChange={(e) => {
                                const v = e.target.value || null;
                                setUnresolvedRefs((prev) => prev.map((x, j) => j === i ? { ...x, pickedOfficeId: v } : x));
                              }}
                            >
                              <option value="">（選択してください）</option>
                              {offices
                                .slice()
                                .sort((a, b) => ((a.short_name || a.name) ?? "").localeCompare((b.short_name || b.name) ?? "", "ja"))
                                .map((o) => (
                                  <option key={o.id} value={o.id}>
                                    {o.short_name || o.name}（{o.office_number}{o.shogai_office_number ? ` / 障害:${o.shogai_office_number}` : ""}）
                                  </option>
                                ))}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })()}

          {/* fallback alias で自動解決された行の警告 */}
          {fallbackHits.length > 0 && (
            <div className="border border-orange-300 rounded-md bg-orange-50 p-3 space-y-2">
              <p className="text-sm font-medium text-orange-900">
                ⚠ CSVに事業者名がない行が、過去のエイリアス設定から自動で事業所に紐付けられました
              </p>
              <p className="text-xs text-orange-800">
                この判定が正しくない場合、取り込むと本来別事業所のデータが上書きされる恐れがあります。<br />
                不安なら、/offices の「障害福祉事業所番号」や office_billing_aliases を見直してください。
              </p>
              <table className="w-full text-xs">
                <thead className="bg-orange-100/60">
                  <tr>
                    <th className="text-left px-2 py-1">CSVの番号</th>
                    <th className="text-left px-2 py-1">自動紐付け先</th>
                    <th className="text-left px-2 py-1">ファイル</th>
                  </tr>
                </thead>
                <tbody>
                  {fallbackHits.map((h, i) => (
                    <tr key={i} className="border-t border-orange-200">
                      <td className="px-2 py-1 font-mono">{h.csvNumber}</td>
                      <td className="px-2 py-1">{h.resolvedOfficeName}</td>
                      <td className="px-2 py-1 text-muted-foreground">{h.sourceFileName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <Button onClick={handlePreview} disabled={importing || imported}>
            {importing ? "取り込み中…" : imported ? "登録済み" : "取り込みプレビュー"}
          </Button>
        </div>
      )}

      {/* ─── 取り込みプレビューダイアログ ─── */}
      {preview && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => !importing && setPreview(null)}>
          <div className="bg-background border rounded-lg max-w-5xl w-full max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b">
              <h3 className="text-lg font-semibold">取り込みプレビュー</h3>
              <p className="text-xs text-muted-foreground mt-1">
                以下の範囲で<b>既存データを削除 → 新規挿入</b>します。
                削除件数が新規件数より大幅に多い行は<span className="text-red-700 font-medium">赤</span>で警告表示します（誤紐付けの可能性）。
              </p>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <table className="w-full text-xs border-collapse">
                <thead className="bg-muted/40 sticky top-0">
                  <tr>
                    <th className="border px-2 py-1 text-center w-10">取込</th>
                    <th className="border px-2 py-1 text-left">事業所</th>
                    <th className="border px-2 py-1 text-left w-16">区分</th>
                    <th className="border px-2 py-1 text-left w-20">月</th>
                    <th className="border px-2 py-1 text-right w-24" colSpan={2}>金額 (既存→新規)</th>
                    <th className="border px-2 py-1 text-right w-24" colSpan={2}>単位 (既存→新規)</th>
                    <th className="border px-2 py-1 text-right w-24" colSpan={2}>利用日 (既存→新規)</th>
                    <th className="border px-2 py-1 text-center w-20">ステータス</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((s, i) => {
                    // 警告判定: 既存件数 >> 新規件数 で消失リスク高
                    const dangerAmount = s.currentAmount > 0 && s.newAmount === 0;
                    const dangerUnit = s.currentUnit > 0 && s.newUnit === 0;
                    const dangerDaily = s.currentDaily > 0 && s.newDaily === 0;
                    const bigDropAmount = s.currentAmount > s.newAmount * 2 && s.currentAmount > 10;
                    const bigDropUnit = s.currentUnit > s.newUnit * 2 && s.currentUnit > 10;
                    const bigDropDaily = s.currentDaily > s.newDaily * 2 && s.currentDaily > 10;
                    const hasLocked = s.lockedRows > 0;
                    const hasWarning = dangerAmount || dangerUnit || dangerDaily || bigDropAmount || bigDropUnit || bigDropDaily || hasLocked;
                    const isExcl = !!s.excluded;
                    const scopeKey = `${s.segment}|${s.office_number}|${s.billing_month}`;
                    const isExpanded = expandedScope === scopeKey;

                    // サンプル行を集める (新規=CSV由来)
                    type SampleRow = { file: string; kind: "金額" | "単位" | "利用日"; client_number: string; client_name: string; raw_hint: string };
                    const samples: SampleRow[] = [];
                    if (isExpanded) {
                      for (const r of results) {
                        for (const a of r.amountRows) {
                          if (a.segment === s.segment && a.office_number === s.office_number && a.billing_month === s.billing_month) {
                            samples.push({ file: r.file.name, kind: "金額", client_number: a.client_number, client_name: a.client_name || "", raw_hint: `請求年月=${a.raw?.["請求年月"] ?? a.raw?.["処理年月"] ?? "?"}` });
                            if (samples.length >= 10) break;
                          }
                        }
                        for (const u of r.unitRows) {
                          if (samples.length >= 10) break;
                          if (u.segment === s.segment && u.office_number === s.office_number && u.billing_month === s.billing_month) {
                            samples.push({ file: r.file.name, kind: "単位", client_number: u.client_number, client_name: u.client_name || "", raw_hint: `請求年月=${u.raw?.["請求年月"] ?? u.raw?.["処理年月"] ?? u.raw?.["サービス提供年月"] ?? "?"}` });
                          }
                        }
                        for (const d of r.dailyRows) {
                          if (samples.length >= 10) break;
                          if (d.segment === s.segment && d.office_number === s.office_number && d.billing_month === s.billing_month) {
                            samples.push({ file: r.file.name, kind: "利用日", client_number: d.client_number, client_name: d.client_name || "", raw_hint: `` });
                          }
                        }
                        if (samples.length >= 10) break;
                      }
                    }

                    return (
                      <>
                        <tr key={i} className={isExcl ? "bg-gray-200 text-muted-foreground line-through" : hasLocked ? "bg-yellow-100" : hasWarning ? "bg-red-50" : ""}>
                          <td className="border px-2 py-1 text-center">
                            <input
                              type="checkbox"
                              checked={!isExcl}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                setPreview((prev) => prev ? prev.map((p, j) => j === i ? { ...p, excluded: !checked } : p) : prev);
                              }}
                              title="取り込み対象に含める/除外する"
                            />
                          </td>
                          <td className="border px-2 py-1">
                            <button
                              className="text-left hover:underline text-blue-700"
                              onClick={() => setExpandedScope(isExpanded ? null : scopeKey)}
                              title="クリックで新規行のサンプルを表示"
                            >
                              {isExpanded ? "▼ " : "▶ "}{s.office_name}
                            </button>
                          </td>
                          <td className="border px-2 py-1">{s.segment}</td>
                          <td className="border px-2 py-1 font-mono">{`${s.billing_month.slice(0, 4)}/${s.billing_month.slice(4, 6)}`}</td>
                          <td className="border px-2 py-1 text-right font-mono">{s.currentAmount}</td>
                          <td className={`border px-2 py-1 text-right font-mono ${!isExcl && (dangerAmount || bigDropAmount) ? "text-red-700 font-bold" : ""}`}>→ {s.newAmount}</td>
                          <td className="border px-2 py-1 text-right font-mono">{s.currentUnit}</td>
                          <td className={`border px-2 py-1 text-right font-mono ${!isExcl && (dangerUnit || bigDropUnit) ? "text-red-700 font-bold" : ""}`}>→ {s.newUnit}</td>
                          <td className="border px-2 py-1 text-right font-mono">{s.currentDaily}</td>
                          <td className={`border px-2 py-1 text-right font-mono ${!isExcl && (dangerDaily || bigDropDaily) ? "text-red-700 font-bold" : ""}`}>→ {s.newDaily}</td>
                          <td className="border px-2 py-1 text-center">
                            {isExcl ? (
                              <span className="text-[10px] bg-gray-400 text-white rounded px-1.5 py-0.5">除外</span>
                            ) : hasLocked ? (
                              <span className="inline-flex items-center gap-0.5 bg-yellow-200 text-yellow-900 rounded px-1.5 py-0.5 text-[10px] font-medium">
                                🔒 {s.lockedRows}件確定済
                              </span>
                            ) : (
                              <span className="text-muted-foreground/60 text-[10px]">—</span>
                            )}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td colSpan={11} className="border px-2 py-2 bg-blue-50">
                              <p className="text-[11px] font-medium text-blue-900 mb-1">このスコープの新規行サンプル (最大10件) — どのCSVのどの行が {s.billing_month.slice(0, 4)}/{s.billing_month.slice(4, 6)} として判定されたかを確認</p>
                              {samples.length === 0 ? (
                                <p className="text-[11px] text-muted-foreground">新規行はありません（既存データの方が多いスコープです）</p>
                              ) : (
                                <table className="w-full text-[11px]">
                                  <thead className="bg-blue-100">
                                    <tr>
                                      <th className="px-1 py-0.5 text-left">ファイル</th>
                                      <th className="px-1 py-0.5 text-left">種類</th>
                                      <th className="px-1 py-0.5 text-left">利用者番号</th>
                                      <th className="px-1 py-0.5 text-left">利用者名</th>
                                      <th className="px-1 py-0.5 text-left">元の月表記</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {samples.map((sr, k) => (
                                      <tr key={k} className="border-t border-blue-200">
                                        <td className="px-1 py-0.5 font-mono">{sr.file}</td>
                                        <td className="px-1 py-0.5">{sr.kind}</td>
                                        <td className="px-1 py-0.5 font-mono">{sr.client_number}</td>
                                        <td className="px-1 py-0.5">{sr.client_name}</td>
                                        <td className="px-1 py-0.5 text-muted-foreground">{sr.raw_hint}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
              <p className="text-[11px] text-muted-foreground mt-2">
                ・「取込」のチェックを外すと、そのスコープは DELETE も INSERT もしません（既存データも保持）。<br />
                ・意図しない月が混入している場合、チェックを外して取り込めます。
              </p>

              {/* 確定済行の警告 */}
              {(() => {
                const lockedTotal = preview.reduce((s, p) => s + p.lockedRows, 0);
                if (lockedTotal === 0) return null;
                return (
                  <div className="mt-3 p-3 border border-yellow-400 bg-yellow-50 rounded text-xs">
                    <p className="font-bold text-yellow-900 mb-1">⚠️ 発行済み・入金済み等の行が {lockedTotal} 件含まれています</p>
                    <p className="text-yellow-900">
                      この取り込みは対象月×事業所のデータを <b>全て削除して再作成</b> するため、以下の情報が失われます:
                    </p>
                    <ul className="list-disc ml-5 mt-1 text-yellow-900">
                      <li>発行済ステータス（invoiced）、発行日</li>
                      <li>入金済ステータス（paid）、入金日、入金額</li>
                      <li>引落不可ステータス（overdue）</li>
                      <li>手動で作成した過誤調整行（adjustment）</li>
                    </ul>
                    <p className="mt-1 text-yellow-900">
                      通常運用では同月のCSVを再取り込みしません。間違って再取り込みしようとしている場合は <b>キャンセル</b> してください。<br />
                      本当に過去月のデータをリセットしたい場合のみ続行してください。
                    </p>
                  </div>
                );
              })()}

              {/* fallback 警告をプレビュー内にも再表示 */}
              {fallbackHits.length > 0 && (
                <div className="mt-3 p-2 border border-orange-300 bg-orange-50 rounded text-xs space-y-1">
                  <p className="font-medium text-orange-900">⚠ fallback alias で自動紐付けされた行:</p>
                  {fallbackHits.map((h, i) => (
                    <div key={i} className="text-orange-800">
                      <span className="font-mono">{h.csvNumber}</span> → {h.resolvedOfficeName} <span className="text-muted-foreground">(from {h.sourceFileName})</span>
                    </div>
                  ))}
                </div>
              )}

              {(() => {
                const hasAnyWarning = preview.some((s) => {
                  const dropA = s.currentAmount > 0 && (s.newAmount === 0 || s.currentAmount > s.newAmount * 2);
                  const dropU = s.currentUnit > 0 && (s.newUnit === 0 || s.currentUnit > s.newUnit * 2);
                  const dropD = s.currentDaily > 0 && (s.newDaily === 0 || s.currentDaily > s.newDaily * 2);
                  return dropA || dropU || dropD;
                });
                if (!hasAnyWarning) return null;
                return (
                  <div className="mt-3 p-2 border border-red-400 bg-red-50 rounded text-xs">
                    <p className="font-medium text-red-800">⚠ 既存データが失われる可能性があります</p>
                    <p className="text-red-700 mt-1">
                      赤表示の行は「既存件数が新規件数より大幅に多い」状態です。本当にこの範囲で削除してよいかを確認してから実行してください。
                      不安な場合はキャンセルして、未解決参照や事業者名の紐付けを見直すことを推奨します。
                    </p>
                  </div>
                );
              })()}
            </div>
            <div className="p-4 border-t flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setPreview(null)} disabled={importing}>
                キャンセル
              </Button>
              <Button onClick={executeImport} disabled={importing}>
                {importing ? "取り込み中…" : "この内容で取り込み実行"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
