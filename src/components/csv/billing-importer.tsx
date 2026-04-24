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
 */
type UnresolvedRef = {
  kind: "name" | "number";
  value: string;                  // 事業者名 or 障害事業所番号（CSVに入っていた値）
  nameHint?: string;              // 番号と同時にCSVで出た事業者名（alias 登録用、任意）
  pickedOfficeId: string | null;  // ユーザーが選んだ事業所id。未選択はnull
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

/** 事業所番号（介護 or 障害）から事業所を引き当て */
function resolveOfficeByNumber(num: string, offices: OfficeLite[]): OfficeLite | null {
  if (!num) return null;
  return offices.find((o) => o.office_number === num)
      ?? offices.find((o) => o.shogai_office_number && o.shogai_office_number === num)
      ?? null;
}

/**
 * エイリアス表から (番号, 事業者名) ペアで事業所を引き当てる。
 * 優先度:
 *   1) (番号, 名前) 完全一致の alias を最優先
 *   2) (番号, 名前NULL) = どの名前でも受け入れる fallback alias
 *   3) 名前だけの alias（kind=shogai_name）
 */
function resolveOfficeByAlias(
  rawNumber: string,
  rawName: string,
  aliases: OfficeAlias[],
  offices: OfficeLite[],
): OfficeLite | null {
  const numNorm = (rawNumber ?? "").trim().toLowerCase();
  const nameNorm = rawName ? normalizeOfficeName(rawName) : "";

  if (numNorm) {
    // 1) (number, name) 両方一致
    if (nameNorm) {
      const exact = aliases.find((a) =>
        a.kind === "shogai_number" &&
        a.value_norm === numNorm &&
        a.value_name_norm === nameNorm
      );
      if (exact) return offices.find((o) => o.id === exact.office_id) ?? null;
    }
    // 2) (number, 名前=空) = 任意名を受け入れる fallback
    const byNumOnly = aliases.find((a) =>
      a.kind === "shogai_number" &&
      a.value_norm === numNorm &&
      (!a.value_name_norm || a.value_name_norm === "")
    );
    if (byNumOnly) return offices.find((o) => o.id === byNumOnly.office_id) ?? null;
  }
  if (nameNorm) {
    // 3) 名前だけの alias
    const byName = aliases.find((a) => a.kind === "shogai_name" && a.value_norm === nameNorm);
    if (byName) return offices.find((o) => o.id === byName.office_id) ?? null;
  }
  return null;
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

  const fetchAliases = useCallback(async () => {
    const { data, error } = await supabase
      .from("office_billing_aliases")
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
    await scan("billing_amount_items", "amount");
    await scan("billing_unit_items", "unit");
    await scan("billing_daily_items", "daily");
    setExistingMatrix(m);
  }, []);

  useEffect(() => {
    supabase.from("offices").select("id, office_number, shogai_office_number, name, short_name").then(({ data }) => {
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
    const [r1, r2, r3] = await Promise.all([q("billing_amount_items"), q("billing_unit_items"), q("billing_daily_items")]);
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
    // 番号のキー: `${number}||${name ?? ""}` 別々の名前ヒントで同じ番号が来たら個別の未解決扱い
    const unresolvedNumPairs = new Map<string, { value: string; nameHint?: string }>();
    const unresolvedNames = new Set<string>();

    const resolveRow = <T extends { office_number: string; office_name?: string }>(r: T) => {
      const numStr = (r.office_number ?? "").trim();
      const nameStr = (r.office_name ?? "").trim();

      if (numStr) {
        // 1) 番号ベース: 介護番号 or 障害番号（offices テーブル直接）
        const direct = resolveOfficeByNumber(numStr, offices);
        if (direct) { r.office_number = direct.office_number; return; }
        // 2) エイリアス: (番号, 名前) ペアで引く
        const byAlias = resolveOfficeByAlias(numStr, nameStr, aliases, offices);
        if (byAlias) { r.office_number = byAlias.office_number; return; }
        // 3) 未解決（名前ヒントつき）
        const key = `${numStr}||${nameStr}`;
        if (!unresolvedNumPairs.has(key)) {
          unresolvedNumPairs.set(key, { value: numStr, nameHint: nameStr || undefined });
        }
        return;
      }
      // 番号なし → 名前だけで試す
      if (!nameStr) return;
      // 1) エイリアス（名前のみ）
      const byAlias = resolveOfficeByAlias("", nameStr, aliases, offices);
      if (byAlias) { r.office_number = byAlias.office_number; return; }
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
    };
  }, [offices, aliases]);

  const mergeUnresolved = (
    numPairs: { value: string; nameHint?: string }[],
    names: string[],
  ) => {
    setUnresolvedRefs((prev) => {
      // 重複判定キーは (kind, value, nameHint) の組。同じ番号でも名前ヒントが違えば別エントリ。
      const keyOf = (r: UnresolvedRef) => `${r.kind}:${r.value}::${r.nameHint ?? ""}`;
      const existing = new Map(prev.map((r) => [keyOf(r), r]));
      for (const p of numPairs) {
        const ref: UnresolvedRef = { kind: "number", value: p.value, nameHint: p.nameHint, pickedOfficeId: null };
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

  const handleFilesSelected = useCallback(async (files: File[]) => {
    setImported(false);
    const newResults: FileResult[] = [];
    const newUnresolvedNumPairs: { value: string; nameHint?: string }[] = [];
    const newUnresolvedNames: string[] = [];
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
        } catch (e) {
          errors.push(`パースエラー: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      newResults.push({ file: f, type, amountRows, unitRows, dailyRows, errors });
    }
    setResults((prev) => [...prev, ...newResults]);
    mergeUnresolved(newUnresolvedNumPairs, newUnresolvedNames);
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
    } catch (e) {
      setResults((prev) => prev.map((r, i) => i === index
        ? { ...r, type: newType, amountRows: [], unitRows: [], dailyRows: [], errors: [`パースエラー: ${e instanceof Error ? e.message : String(e)}`] }
        : r));
    }
  }, [parseByType, results]);

  const handleClear = () => {
    setResults([]);
    setUnresolvedRefs([]);
    setImported(false);
  };

  const handleImport = async () => {
    // 未選択の未解決参照があれば警告（無視して進める選択肢も残す）
    const pendingRefs = unresolvedRefs.filter((r) => !r.pickedOfficeId);
    if (pendingRefs.length > 0) {
      if (!confirm(`未解決の事業者が${pendingRefs.length}件あります。該当行は office_number が空のまま登録されます（集計で表示されません）。このまま取り込みますか？`)) return;
    }

    // 未解決マッピングを適用: (番号, 事業者名) ペアごとに office_number を書き換え
    // キーは `${number}||${nameHint}` で照合（同じ番号でも名前ヒントが違えば別事業所にルーティング可）
    const pairMap = new Map<string, string>();     // `${numNorm}||${nameNorm}` → office_number
    const numberOnlyMap = new Map<string, string>(); // nameHint なしで紐付けられた番号
    const nameMap = new Map<string, string>();     // nameNorm → office_number
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
        const nameNorm = ref.nameHint ? normalizeOfficeName(ref.nameHint) : "";
        if (nameNorm) {
          pairMap.set(`${numNorm}||${nameNorm}`, off.office_number);
        } else {
          numberOnlyMap.set(numNorm, off.office_number);
        }
        // エイリアス永続化
        newAliases.push({
          office_id: off.id,
          kind: "shogai_number",
          value_raw: ref.value,
          value_norm: numNorm,
          value_name_raw: ref.nameHint ?? "",
          value_name_norm: nameNorm,
        });
        // 後方互換: offices.shogai_office_number も更新（/offices 編集画面での表示用）
        if (off.shogai_office_number !== ref.value) {
          shogaiUpdates.push({ officeId: off.id, shogaiNum: ref.value });
        }
      } else {
        const nameNorm = normalizeOfficeName(ref.value);
        nameMap.set(nameNorm, off.office_number);
        newAliases.push({
          office_id: off.id,
          kind: "shogai_name",
          value_raw: ref.value,
          value_norm: nameNorm,
          value_name_raw: "",
          value_name_norm: "",
        });
      }
    }

    const applyMap = <T extends { office_number: string; office_name?: string }>(rows: T[]) => {
      for (const r of rows) {
        const numStr = (r.office_number ?? "").trim().toLowerCase();
        const nameStr = r.office_name ? normalizeOfficeName(r.office_name) : "";
        // 既に正しい介護番号なら何もしない
        if (!numStr && !nameStr) continue;
        // 1) (番号, 名前) ペア
        if (numStr && nameStr && pairMap.has(`${numStr}||${nameStr}`)) {
          r.office_number = pairMap.get(`${numStr}||${nameStr}`)!; continue;
        }
        // 2) 番号のみ
        if (numStr && numberOnlyMap.has(numStr)) {
          r.office_number = numberOnlyMap.get(numStr)!; continue;
        }
        // 3) 名前のみ
        if (!numStr && nameStr && nameMap.has(nameStr)) {
          r.office_number = nameMap.get(nameStr)!; continue;
        }
      }
    };
    for (const r of results) {
      applyMap(r.amountRows);
      applyMap(r.unitRows);
      applyMap(r.dailyRows);
    }

    const totalAmount = results.reduce((s, r) => s + r.amountRows.length, 0);
    const totalUnit = results.reduce((s, r) => s + r.unitRows.length, 0);
    const totalDaily = results.reduce((s, r) => s + r.dailyRows.length, 0);
    if (totalAmount + totalUnit + totalDaily === 0) { toast.error("取り込むデータがありません"); return; }
    if (pendingRefs.length === 0 && !confirm(`金額${totalAmount}件 / 単位${totalUnit}件 / 利用日${totalDaily}件を取り込みますか？\n（同じ事業所×月×利用者の既存データは削除してから挿入します）`)) return;

    setImporting(true);
    try {
      // エイリアス永続化（(番号, 名前) ペアで事業所を記憶）
      if (newAliases.length > 0) {
        const { error } = await supabase.from("office_billing_aliases").upsert(newAliases, {
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
        const { error } = await supabase.from("offices").update({ shogai_office_number: u.shogaiNum }).eq("id", u.officeId);
        if (error) console.error("shogai_office_number 更新エラー", error);
      }
      if (shogaiUpdates.length > 0) {
        // 最新のofficesを再取得（以降の取り込みで同じ番号が自動解決されるように）
        const { data: refreshed } = await supabase.from("offices").select("id, office_number, shogai_office_number, name, short_name");
        if (refreshed) setOffices(refreshed as OfficeLite[]);
      }

      // 事業所×月 ごとに既存データを削除してから再挿入（重複防止）
      type ScopeKey = { office_number: string; billing_month: string; segment: "介護" | "障害" };
      const scopes = new Set<string>();
      const scopeList: ScopeKey[] = [];
      const push = (s: ScopeKey) => {
        if (!s.office_number || !s.billing_month) return;
        const k = `${s.segment}|${s.office_number}|${s.billing_month}`;
        if (!scopes.has(k)) { scopes.add(k); scopeList.push(s); }
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
      // billing_unit_items / billing_daily_items の DB カラムには office_name が無いため除外
      const stripOfficeName = <T extends { office_name?: string }>(rows: T[]): Omit<T, "office_name">[] =>
        rows.map((r) => {
          const copy = { ...r } as T;
          delete copy.office_name;
          return copy;
        });
      const allUnit = stripOfficeName(results.flatMap((r) => r.unitRows));
      const allDaily = stripOfficeName(results.flatMap((r) => r.dailyRows));
      await insertAll("billing_amount_items", allAmount);
      await insertAll("billing_unit_items", allUnit);
      await insertAll("billing_daily_items", allDaily);

      toast.success(`金額${allAmount.length}件 / 単位${allUnit.length}件 / 利用日${allDaily.length}件を取り込みました`);
      setImported(true);
      setResults([]);
      setUnresolvedRefs([]);
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
          {unresolvedRefs.length > 0 && (
            <div className="border border-yellow-300 rounded-md bg-yellow-50 p-3 space-y-2">
              <p className="text-sm font-medium text-yellow-900">
                ⚠ CSV内の以下の事業者を、どの事業所と紐付けるか選択してください
              </p>
              <p className="text-xs text-yellow-800">
                ・<b>事業所番号</b>＋<b>事業者名</b>の組で記憶されるため、同じ番号が別事業所のCSVで出てきても誤紐付けされません。次回以降は自動で解決されます。<br />
                ・<b>事業者名</b>のみの場合も、次回以降は自動解決されます。/offices で正式名称・略称を合わせるとファジーマッチが効きます。
              </p>
              <table className="w-full text-xs">
                <thead className="bg-yellow-100/60">
                  <tr>
                    <th className="text-left px-2 py-1 font-medium">種別</th>
                    <th className="text-left px-2 py-1 font-medium">CSVの値</th>
                    <th className="text-left px-2 py-1 font-medium">事業者名（ヒント）</th>
                    <th className="text-left px-2 py-1 font-medium">紐付け先の事業所</th>
                  </tr>
                </thead>
                <tbody>
                  {unresolvedRefs.map((ref, i) => (
                    <tr key={i} className="border-t border-yellow-200">
                      <td className="px-2 py-1">
                        {ref.kind === "number" ? <span className="text-purple-700">障害番号</span> : <span className="text-blue-700">事業者名</span>}
                      </td>
                      <td className="px-2 py-1 font-mono">{ref.value}</td>
                      <td className="px-2 py-1 text-muted-foreground">
                        {ref.kind === "number"
                          ? (ref.nameHint ? ref.nameHint : <span className="text-muted-foreground/60">（CSVに名前なし）</span>)
                          : <span className="text-muted-foreground/60">—</span>}
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
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <Button onClick={handleImport} disabled={importing || imported}>
            {importing ? "取り込み中…" : imported ? "登録済み" : "データベースに登録"}
          </Button>
        </div>
      )}
    </div>
  );
}
