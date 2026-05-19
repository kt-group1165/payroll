"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * 「YYYY年MM月」表示の clickable label。
 * クリックで自前の年月カレンダー popover を開く。
 *
 * 仕様:
 *   - 年は左右 (← →) ボタンで切替 (内部 state、選択せずに閉じれば revert)
 *   - 月は 3×4 のグリッドで「1月」〜「12月」表示。クリックで onChange + close
 *   - 現在の value の月は強調 (primary 色)
 *   - 当月 (= now) は太字 outline
 *   - 外側 click / Esc / 月 click で close
 *
 * popover は React Portal で document.body 直下に描画し、親の overflow:hidden に
 * クリップされないようにする。位置は trigger button の getBoundingClientRect() を
 * 計算して fixed 配置。
 */

type Props = {
  /** YYYY-MM */
  value: string;
  /** 月変更時 (next = YYYY-MM) */
  onChange: (next: string) => void;
  /** 外側 className (label) */
  className?: string;
  /** 表示テキストのフォーマッタ (default: "YYYY年MM月") */
  formatLabel?: (ym: string) => string;
};

function defaultFmt(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  return `${m[1]}年${m[2]}月`;
}

function parseYM(ym: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{1,2})$/.exec(ym);
  if (!m) return null;
  return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
}

function toYM(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function nowYM(): { year: number; month: number } {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

const POPOVER_WIDTH = 240;
const POPOVER_MIN_HEIGHT = 180;

export function MonthInputButton({
  value,
  onChange,
  className,
  formatLabel = defaultFmt,
}: Props) {
  const [open, setOpen] = useState(false);
  // popover 内部の表示中年。開く時に value の年で初期化。
  const initialYear = parseYM(value)?.year ?? new Date().getFullYear();
  const [pickerYear, setPickerYear] = useState<number>(initialYear);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // SSR 対策: 初回 SSR pass では open=false なので popover は描画されず、
  // createPortal も呼ばれない。click 後 (= hydration 済) のみ document.body にアクセス。

  // 位置計算: trigger の真下に表示。viewport からはみ出るなら反転や align 調整。
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const recalc = () => {
      const rect = triggerRef.current!.getBoundingClientRect();
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      // 水平: button 中央に合わせる
      let left = rect.left + rect.width / 2 - POPOVER_WIDTH / 2;
      if (left < 8) left = 8;
      if (left + POPOVER_WIDTH > viewportW - 8) left = viewportW - POPOVER_WIDTH - 8;
      // 垂直: button の下が原則。下に入らなければ上に。
      let top = rect.bottom + 4;
      if (top + POPOVER_MIN_HEIGHT > viewportH - 8) {
        top = rect.top - POPOVER_MIN_HEIGHT - 4;
        if (top < 8) top = 8;
      }
      setPos({ top, left });
    };
    recalc();
    window.addEventListener("resize", recalc);
    window.addEventListener("scroll", recalc, true);
    return () => {
      window.removeEventListener("resize", recalc);
      window.removeEventListener("scroll", recalc, true);
    };
  }, [open]);

  // 外側 click / Esc で close
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target instanceof Node ? e.target : null;
      if (!target) return;
      // trigger or popover 内なら閉じない
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selected = parseYM(value);
  const today = nowYM();

  const handlePick = (month: number) => {
    onChange(toYM(pickerYear, month));
    setOpen(false);
  };

  const popoverNode =
    open && pos ? (
      <div
        ref={popoverRef}
        role="dialog"
        aria-label="月選択"
        style={{ position: "fixed", top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
        className="z-[100] rounded-md border bg-background shadow-lg p-2 text-sm"
      >
        {/* 年ナビ */}
        <div className="flex items-center justify-between mb-2">
          <button
            type="button"
            onClick={() => setPickerYear((y) => y - 1)}
            className="rounded p-1 hover:bg-muted/60 cursor-pointer"
            title="前年"
            aria-label="前年"
          >
            ←
          </button>
          <span className="font-semibold tabular-nums">{pickerYear}年</span>
          <button
            type="button"
            onClick={() => setPickerYear((y) => y + 1)}
            className="rounded p-1 hover:bg-muted/60 cursor-pointer"
            title="次年"
            aria-label="次年"
          >
            →
          </button>
        </div>

        {/* 月グリッド 4×3 */}
        <div className="grid grid-cols-4 gap-1">
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
            const isSelected = selected?.year === pickerYear && selected?.month === m;
            const isToday = today.year === pickerYear && today.month === m;
            return (
              <button
                key={m}
                type="button"
                onClick={() => handlePick(m)}
                className={cn(
                  "rounded px-2 py-1.5 text-xs tabular-nums cursor-pointer transition-colors",
                  isSelected
                    ? "bg-primary text-primary-foreground font-semibold"
                    : isToday
                      ? "border border-primary text-foreground hover:bg-muted/60"
                      : "hover:bg-muted/60",
                )}
                aria-pressed={isSelected}
                aria-label={`${pickerYear}年${m}月`}
              >
                {m}月
              </button>
            );
          })}
        </div>
      </div>
    ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (open) {
            setOpen(false);
          } else {
            // 開く時は value の年で picker を初期化してから開く
            setPickerYear(parseYM(value)?.year ?? new Date().getFullYear());
            setOpen(true);
          }
        }}
        className={cn(
          "inline-flex items-center justify-center text-sm font-medium min-w-[6em] px-3 py-1.5 rounded-md hover:bg-muted/40 cursor-pointer select-none transition-colors",
          open && "bg-muted/40",
          className,
        )}
        title="クリックで月を選択"
      >
        {formatLabel(value)}
      </button>
      {popoverNode && typeof document !== "undefined" && createPortal(popoverNode, document.body)}
    </>
  );
}
