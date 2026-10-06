"use client";

/**
 * 月ごとの履歴 (effective_from を持つ設定) を 1 つの表で見せる部品 (2026-10-06 user
 * 「基本月次のデータ持ってるものは履歴が見れるようにしてほしい。ボタン押したら出るとかでもいい」)。
 *
 * ・行 = いつから (effective_from の古い順)。1970-01-01 / 2000-01-01 は「初期値」と出す
 * ・列 = 項目。前の行から変わったセルだけ 色を付ける (何が改定されたか一目で分かるように)
 * ・値の出し方は 呼出側が format で決める (円/分・%・曜日 など 項目ごとに違うため)
 */
import { Fragment, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type HistoryColumn<R> = {
  key: string;
  label: string;
  /** 値 → 表示。省略時は数値・文字列をそのまま (null は —) */
  format?: (row: R) => ReactNode;
  /** 変わったかどうかの比較に使う値。省略時は row[key] */
  value?: (row: R) => unknown;
};

const isInitial = (d: string) => d <= "2000-01-01";
export const effectiveLabel = (d: string) =>
  isInitial(d) ? "初期値" : `${d.slice(0, 4)}年${Number(d.slice(5, 7))}月分から`;

export function HistoryTable<R extends { effective_from: string }>({
  rows, columns, emptyText = "履歴がありません",
}: {
  rows: R[];
  columns: HistoryColumn<R>[];
  emptyText?: string;
}) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  const sorted = [...rows].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  const val = (c: HistoryColumn<R>, r: R) => (c.value ? c.value(r) : (r as Record<string, unknown>)[c.key]);
  const show = (c: HistoryColumn<R>, r: R): ReactNode => {
    if (c.format) return c.format(r);
    const v = val(c, r);
    return v == null || v === "" ? "—" : String(v);
  };
  return (
    <div className="overflow-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/60">
          <tr>
            <th className="whitespace-nowrap px-2 py-1.5 text-left font-semibold">いつから</th>
            {columns.map((c) => (
              <th key={c.key} className="whitespace-nowrap px-2 py-1.5 text-right font-semibold">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const prev = i > 0 ? sorted[i - 1] : null;
            return (
              <tr key={`${r.effective_from}-${i}`} className="border-t">
                <td className="whitespace-nowrap px-2 py-1.5 font-medium">{effectiveLabel(r.effective_from)}</td>
                {columns.map((c) => {
                  const changed = prev !== null && JSON.stringify(val(c, prev) ?? null) !== JSON.stringify(val(c, r) ?? null);
                  return (
                    <td key={c.key} className={`whitespace-nowrap px-2 py-1.5 text-right ${changed ? "bg-amber-100 font-semibold dark:bg-amber-900/40" : ""}`}>
                      {show(c, r)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="px-2 py-1 text-xs text-muted-foreground">色の付いたセル = 前の行から変わった値</p>
    </div>
  );
}

/** 「履歴を見る」ボタン + ダイアログ。開いたときに load() で読む (一覧の表示を重くしないため) */
export function HistoryButton<R extends { effective_from: string }>({
  title, load, columns, size = "sm", label = "履歴",
}: {
  title: string;
  load: () => Promise<R[]>;
  columns: HistoryColumn<R>[];
  size?: "sm" | "default";
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<R[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const openIt = async () => {
    setOpen(true); setRows(null); setErr(null);
    try { setRows(await load()); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <Fragment>
      <Button variant="ghost" size={size} onClick={openIt} title={`${title} の履歴を見る`}>{label}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-4xl max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{title} の履歴</DialogTitle></DialogHeader>
          {err ? <p className="text-sm text-destructive">履歴を読めませんでした: {err}</p>
            : rows === null ? <p className="text-sm text-muted-foreground">読み込み中…</p>
              : <HistoryTable rows={rows} columns={columns} />}
        </DialogContent>
      </Dialog>
    </Fragment>
  );
}
