"use client";

import { useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * 「YYYY年MM月」表示の clickable label。
 * クリックでブラウザ標準の月選択 picker (Chrome/Edge では native popup) を開く。
 *
 * 実装:
 *   - 透明 `<input type="month">` を label 内に絶対配置
 *   - クリック領域全体が input なので、Chrome/Edge では即 picker 表示
 *   - showPicker() でも programmatic に開ける (modern browser)
 */

type Props = {
  /** YYYY-MM */
  value: string;
  /** 月変更時 (next = YYYY-MM) */
  onChange: (next: string) => void;
  /** label 表示の幅と padding を持つラッパ class (= 既存の "前月 [ここ] 次月" の中央 cell と同形) */
  className?: string;
  /** 表示テキストのフォーマッタ (default: "YYYY年MM月") */
  formatLabel?: (ym: string) => string;
};

function defaultFmt(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  return `${m[1]}年${m[2]}月`;
}

export function MonthInputButton({
  value,
  onChange,
  className,
  formatLabel = defaultFmt,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <label
      className={cn(
        // 既存の "min-w-[6em] text-center font-medium" に hover 効果 + cursor
        "relative inline-flex items-center justify-center text-sm font-medium min-w-[6em] px-2 py-1 cursor-pointer rounded-md hover:bg-muted/40 select-none",
        className,
      )}
      title="クリックで月を選択"
      onClick={() => {
        // showPicker() があれば programmatic に開く (Chrome/Edge では透明 input click でも開くが念のため)
        const inp = inputRef.current;
        if (inp && typeof inp.showPicker === "function") {
          try {
            inp.showPicker();
          } catch {
            // user gesture 制約等で throw した場合は label の natural click にフォールバック
          }
        }
      }}
    >
      <span>{formatLabel(value)}</span>
      <input
        ref={inputRef}
        type="month"
        value={value}
        onChange={(e) => {
          if (e.target.value) onChange(e.target.value);
        }}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        // tabIndex は default のまま (= キーボード操作も可)
      />
    </label>
  );
}
