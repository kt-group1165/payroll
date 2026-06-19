"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  ITEM_OPTIONS,
  type OfficeInputCategory,
  type OfficeInputEntry,
} from "@/lib/office-input/types";

/**
 * カテゴリ単位の折りたたみ section。
 * 行ごとに「項目名 dropdown + 値入力 + 削除ボタン」を表示。
 * 入力停止後 800ms で自動 upsert (= debounced)。
 */
export function CategorySection({
  category,
  entries,
  onAddRow,
  onUpdateLocal,
  onSaveEntry,
  onDeleteEntry,
}: {
  category: OfficeInputCategory;
  entries: OfficeInputEntry[];
  onAddRow: () => void;
  onUpdateLocal: (entryId: string, patch: Partial<OfficeInputEntry>) => void;
  onSaveEntry: (entry: OfficeInputEntry) => Promise<void> | void;
  onDeleteEntry: (entryId: string) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <section className="border rounded-md bg-background">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium hover:bg-muted/40 transition-colors"
      >
        <span>
          {open ? "▼" : "▶"} {category}
          <span className="ml-2 text-xs text-muted-foreground">
            ({entries.length}件)
          </span>
        </span>
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onAddRow();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
              e.preventDefault();
              onAddRow();
            }
          }}
          className="text-xs px-2 py-1 rounded-md border bg-background hover:bg-muted cursor-pointer"
        >
          + 追加
        </span>
      </button>

      {open && (
        <div className="border-t p-2 space-y-2">
          {entries.length === 0 ? (
            <div className="text-xs text-muted-foreground px-2 py-3">
              データがありません。「+ 追加」で行を作成してください。
            </div>
          ) : (
            entries.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                onUpdateLocal={onUpdateLocal}
                onSaveEntry={onSaveEntry}
                onDeleteEntry={onDeleteEntry}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

const SAVE_DEBOUNCE_MS = 800;

/**
 * 単一行コンポーネント。category ごとに表示する値入力欄を分岐。
 * 入力停止後 800ms で自動 upsert。
 */
function EntryRow({
  entry,
  onUpdateLocal,
  onSaveEntry,
  onDeleteEntry,
}: {
  entry: OfficeInputEntry;
  onUpdateLocal: (entryId: string, patch: Partial<OfficeInputEntry>) => void;
  onSaveEntry: (entry: OfficeInputEntry) => Promise<void> | void;
  onDeleteEntry: (entryId: string) => Promise<void> | void;
}) {
  const items = ITEM_OPTIONS[entry.category];

  // 自動保存 (= debounced)。entry の値が変わるたび timer 再起動。
  const lastSavedRef = useRef<string>(serialize(entry));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const current = serialize(entry);
    if (current === lastSavedRef.current) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      lastSavedRef.current = current;
      void onSaveEntry(entry);
    }, SAVE_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [entry, onSaveEntry]);

  const updateItem = useCallback(
    (item: string) => onUpdateLocal(entry.id, { item_name: item }),
    [entry.id, onUpdateLocal],
  );

  const isDraft = entry.id.startsWith("draft-");

  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(140px,1fr)_2fr_auto] gap-2 items-center p-2 rounded-md",
        isDraft ? "bg-amber-50" : "bg-muted/20",
      )}
    >
      {/* 項目名 dropdown */}
      <select
        value={entry.item_name}
        onChange={(e) => updateItem(e.target.value)}
        className="h-9 rounded-md border bg-background px-2 text-sm"
      >
        {items.includes(entry.item_name) ? null : (
          <option value={entry.item_name}>{entry.item_name}</option>
        )}
        {items.map((it) => (
          <option key={it} value={it}>
            {it}
          </option>
        ))}
      </select>

      {/* category 別の値入力 */}
      <div className="flex items-center gap-2 flex-wrap">
        {entry.category === "数値項目" && (
          <NumericField
            value={entry.numeric_value}
            onChange={(v) => onUpdateLocal(entry.id, { numeric_value: v })}
            label="値"
          />
        )}

        {entry.category === "時間項目" && (
          <TimeMinutesField
            value={entry.time_minutes}
            onChange={(v) => onUpdateLocal(entry.id, { time_minutes: v })}
          />
        )}

        {entry.category === "日付項目" && (
          <DateField
            value={entry.date_value}
            onChange={(v) => onUpdateLocal(entry.id, { date_value: v })}
          />
        )}

        {entry.category === "日時項目" && (
          <>
            <DateField
              value={entry.date_value}
              onChange={(v) => onUpdateLocal(entry.id, { date_value: v })}
            />
            <TimeField
              value={entry.start_time}
              onChange={(v) => onUpdateLocal(entry.id, { start_time: v })}
              label="開始"
            />
            <TimeField
              value={entry.end_time}
              onChange={(v) => onUpdateLocal(entry.id, { end_time: v })}
              label="終了"
            />
            <NumericField
              value={entry.break_minutes}
              onChange={(v) =>
                onUpdateLocal(entry.id, {
                  break_minutes: v === null ? null : Math.round(v),
                })
              }
              label="休憩(分)"
              integerOnly
            />
          </>
        )}

        {entry.category === "育児手当" && (
          <>
            <Input
              type="text"
              placeholder="お子さん名"
              value={entry.child_name ?? ""}
              onChange={(e) =>
                onUpdateLocal(entry.id, {
                  child_name: e.target.value || null,
                })
              }
              className="h-9 w-32"
            />
            <Input
              type="month"
              value={entry.reference_month ?? ""}
              onChange={(e) =>
                onUpdateLocal(entry.id, {
                  reference_month: e.target.value || null,
                })
              }
              className="h-9 w-36"
              title="参照月"
            />
            <NumericField
              value={entry.numeric_value}
              onChange={(v) => onUpdateLocal(entry.id, { numeric_value: v })}
              label="金額"
            />
          </>
        )}
      </div>

      {/* 削除ボタン */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => void onDeleteEntry(entry.id)}
        aria-label="削除"
        className="text-destructive hover:bg-destructive/10"
      >
        🗑
      </Button>
    </div>
  );
}

// ─── 値入力サブコンポーネント ────────────────────────────────

function NumericField({
  value,
  onChange,
  label,
  integerOnly,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  label: string;
  integerOnly?: boolean;
}) {
  return (
    <label className="flex items-center gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Input
        type="number"
        step={integerOnly ? 1 : "any"}
        value={value ?? ""}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") {
            onChange(null);
            return;
          }
          const n = Number(raw);
          if (Number.isNaN(n)) return;
          onChange(n);
        }}
        className="h-9 w-28"
      />
    </label>
  );
}

function TimeMinutesField({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  // 表示は HH:MM、内部は分。
  const [text, setText] = useState<string>(minutesToHHMM(value));
  const lastValueRef = useRef<number | null>(value);

  // 外部 value 変更時に表示を同期 (= 自動保存後など)
  useEffect(() => {
    if (value !== lastValueRef.current) {
      setText(minutesToHHMM(value));
      lastValueRef.current = value;
    }
  }, [value]);

  return (
    <label className="flex items-center gap-1 text-sm">
      <span className="text-muted-foreground">時間 (HH:MM)</span>
      <Input
        type="text"
        inputMode="numeric"
        placeholder="00:00"
        value={text}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          const parsed = parseHHMM(raw);
          if (parsed !== undefined) {
            lastValueRef.current = parsed;
            onChange(parsed);
          }
        }}
        onBlur={() => {
          // blur 時に表示を canonical 化
          setText(minutesToHHMM(lastValueRef.current));
        }}
        className="h-9 w-24"
      />
    </label>
  );
}

function DateField({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <Input
      type="date"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className="h-9 w-36"
    />
  );
}

function TimeField({
  value,
  onChange,
  label,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  label: string;
}) {
  // DB の TIME は HH:MM:SS が返ってくる場合あり → HH:MM に切詰めて input に渡す
  const display = value ? value.slice(0, 5) : "";
  return (
    <label className="flex items-center gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Input
        type="time"
        value={display}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-9 w-24"
      />
    </label>
  );
}

// ─── helpers ────────────────────────────────────────────

function minutesToHHMM(m: number | null | undefined): string {
  if (m === null || m === undefined || Number.isNaN(m)) return "";
  const sign = m < 0 ? "-" : "";
  const abs = Math.abs(m);
  const h = Math.floor(abs / 60);
  const mm = abs % 60;
  return `${sign}${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function parseHHMM(s: string): number | undefined {
  // 受け入れフォーマット: "H:MM" / "HH:MM" / "HMM" / 数字のみ (= 分)
  const trimmed = s.trim();
  if (trimmed === "") return undefined;
  const colonMatch = /^(-?)(\d{1,3}):([0-5]?\d)$/.exec(trimmed);
  if (colonMatch) {
    const sign = colonMatch[1] === "-" ? -1 : 1;
    const h = parseInt(colonMatch[2], 10);
    const mm = parseInt(colonMatch[3], 10);
    return sign * (h * 60 + mm);
  }
  return undefined;
}

/**
 * 値の serialize。debounce 比較用 (= 入力中に同じ値が再 set されても保存しない)。
 */
function serialize(e: OfficeInputEntry): string {
  return JSON.stringify({
    item: e.item_name,
    n: e.numeric_value,
    t: e.time_minutes,
    d: e.date_value,
    s: e.start_time,
    en: e.end_time,
    b: e.break_minutes,
    c: e.child_name,
    r: e.reference_month,
    no: e.notes,
  });
}
