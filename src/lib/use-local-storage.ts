"use client";

import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

// 同一タブ内の変更通知のため subscribers を保持
// (storage event は他タブからの変更しか発火しない)
const subscribers = new Map<string, Set<() => void>>();

function notify(key: string) {
  subscribers.get(key)?.forEach((cb) => cb());
}

function subscribe(key: string, callback: () => void): () => void {
  if (!subscribers.has(key)) subscribers.set(key, new Set());
  subscribers.get(key)!.add(callback);
  const handleStorage = (e: StorageEvent) => {
    if (e.key === key) callback();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", handleStorage);
  }
  return () => {
    subscribers.get(key)?.delete(callback);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorage);
    }
  };
}

/**
 * localStorage 永続化された state を SSR-safe に読み書きする hook。
 *
 * - SSR / 初回 render は `defaultValue` を返す (hydration mismatch 回避)
 * - hydrate 後は localStorage 値で再 render される (useSyncExternalStore による subscribe)
 * - setState は同一タブ + 他タブの subscriber に通知 + localStorage 書き込み
 *
 * 重要: getSnapshot は localStorage の raw 文字列をキャッシュし、変化が無ければ
 * 前回 parse 済みの value を返す (= useSyncExternalStore の Object.is 比較で
 * 同一 reference になる)。これが無いと parse が新 array/object を毎回返して
 * React #185 (Maximum update depth exceeded) を引き起こす。
 *
 * これにより `useState + useEffect で localStorage を読む` パターンの
 * react-hooks/set-state-in-effect disable が不要になる。
 */
export function useLocalStorage<T>(
  key: string,
  defaultValue: T,
  parse: (raw: string) => T,
  serialize: (value: T) => string = (v) => String(v),
): readonly [T, (value: T) => void] {
  // raw 文字列 → 解析済 value のキャッシュ。useRef なので render を跨いで保持。
  // 変化が無いときに前回と同じ value reference を返すために必要。
  const cacheRef = useRef<{ raw: string | null; value: T }>({
    raw: "__INIT__", // 初期化マーカー (実際の localStorage は string|null なので衝突しない)
    value: defaultValue,
  });

  // getSnapshot は render 中に呼ばれるたびに同じ reference を返さなければ
  // 無限ループする (useSyncExternalStore 仕様)。
  // key/defaultValue/parse が変わらない限り、同じ closure を返す。
  const getSnapshot = useMemo(
    () => () => {
      try {
        const stored = localStorage.getItem(key);
        if (stored === cacheRef.current.raw) {
          // raw 同一 → 前回 parse 済みの value reference を返す
          return cacheRef.current.value;
        }
        const next = stored != null ? parse(stored) : defaultValue;
        cacheRef.current = { raw: stored, value: next };
        return next;
      } catch {
        return defaultValue;
      }
    },
    // parse / defaultValue が変わったらキャッシュは無効化したいが、
    // 呼び出し側が inline 関数 / 配列を渡すと毎回新 reference になり再 build される。
    // 実用上は parse / defaultValue は安定している前提で、key の変化のみを再構築 trigger に。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  const value = useSyncExternalStore(
    (callback) => subscribe(key, callback),
    getSnapshot,
    () => defaultValue, // server snapshot
  );

  const setValue = useCallback(
    (next: T) => {
      try {
        localStorage.setItem(key, serialize(next));
      } catch {
        // localStorage が利用不可 (private mode 等) は無視
      }
      notify(key);
    },
    [key, serialize],
  );

  return [value, setValue] as const;
}
