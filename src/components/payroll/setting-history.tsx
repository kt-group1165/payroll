"use client";

/**
 * アプリ設定 (payroll_app_setting_history) の履歴を 表で見せる (2026-10-06 user「履歴持つべきものは全部・画面で閲覧」)。
 *
 * 値の形は設定ごとに違う ({事業所: 時給} / {rates: {事業所: 円}} / {offices: [..]} / {事業所: [職員番号]} …) ので
 * 「列 = 値の中の場所 (事業所など)」に平らにして HistoryTable に渡す。前の行から変わったセルに色が付く。
 * 事業所番号は 事業所名に読み替える (officeNames)。
 */
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { HistoryButton, HistoryTable, type HistoryColumn } from "@/components/payroll/history-table";

type Flat = Record<string, string>;
export type SettingHistoryRow = { effective_from: string; flat: Flat };

/** 値を「場所 → 文字」に平らにする。配列は 並べて 1 つの文字に (集合として比べたいので並べ替える) */
export function flattenSettingValue(value: unknown, prefix = ""): Flat {
  const out: Flat = {};
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    out[prefix || "値"] = value.map(String).sort().join(", ");
    return out;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix} / ${k}` : k;
      Object.assign(out, flattenSettingValue(v, path));
    }
    return out;
  }
  out[prefix || "値"] = String(value);
  return out;
}

export async function loadSettingHistory(key: string): Promise<SettingHistoryRow[]> {
  const { data, error } = await supabase
    .from("payroll_app_setting_history")
    .select("effective_from, value")
    .eq("key", key)
    .order("effective_from");
  if (error) throw new Error(error.message);
  return ((data ?? []) as { effective_from: string; value: unknown }[]).map((r) => ({ effective_from: r.effective_from, flat: flattenSettingValue(r.value) }));
}

/** 列見出し: 中の事業所番号を 事業所名に (「rates / 1270201922」→「rates / 花見川」)。rates/offices/modes/prices/tiers の包みは外す */
function columnLabel(path: string, officeNames: Map<string, string>): string {
  return path
    .split(" / ")
    .filter((seg, i, arr) => !(i === 0 && arr.length > 1 && ["rates", "offices", "modes", "prices", "tiers"].includes(seg)))
    .map((seg) => officeNames.get(seg) ?? (seg === "offices" || seg === "値" ? "事業所" : seg === "sunday_holiday_only" ? "日祝だけの事業所" : seg))
    .join(" / ");
}

export function settingHistoryColumns(rows: SettingHistoryRow[], officeNames: Map<string, string>): HistoryColumn<SettingHistoryRow>[] {
  const paths = [...new Set(rows.flatMap((r) => Object.keys(r.flat)))].sort();
  return paths.map((p) => ({
    key: p,
    label: columnLabel(p, officeNames),
    value: (r: SettingHistoryRow) => r.flat[p] ?? null,
    format: (r: SettingHistoryRow) => {
      const v = r.flat[p];
      if (v == null) return "—";
      return v.split(", ").map((x) => officeNames.get(x) ?? x).join(", ");
    },
  }));
}

/** 事業所番号 → 名前 (略称があれば略称) */
export function useOfficeNames(): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let alive = true;
    supabase.from("payroll_offices").select("office_number, short_name, master:offices!office_id(name)").then(({ data, error }) => {
      if (!alive) return;
      if (error) { console.error("office names read failed:", error.message); return; }
      const m = new Map<string, string>();
      for (const o of (data ?? []) as unknown as { office_number: string; short_name: string | null; master: { name: string } | null }[]) {
        m.set(o.office_number, o.short_name || o.master?.name || o.office_number);
      }
      setNames(m);
    });
    return () => { alive = false; };
  }, []);
  return names;
}

/** 1 つの設定の履歴の表 (開いた時点で読む) */
export function SettingHistoryTable({ settingKey, officeNames }: { settingKey: string; officeNames: Map<string, string> }) {
  const [rows, setRows] = useState<SettingHistoryRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadSettingHistory(settingKey).then((r) => { if (alive) setRows(r); }).catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [settingKey]);
  if (err) return <p className="text-sm text-destructive">履歴を読めませんでした: {err}</p>;
  if (!rows) return <p className="text-sm text-muted-foreground">読み込み中…</p>;
  return <HistoryTable rows={rows} columns={settingHistoryColumns(rows, officeNames)} />;
}

/** 「履歴」ボタン (設定画面に置く用) */
export function SettingHistoryButton({ settingKey, title, officeNames }: { settingKey: string; title: string; officeNames: Map<string, string> }) {
  return (
    <HistoryButton<SettingHistoryRow>
      title={title}
      label="履歴を見る"
      load={() => loadSettingHistory(settingKey)}
      columnsFrom={(rows) => settingHistoryColumns(rows, officeNames)}
    />
  );
}
