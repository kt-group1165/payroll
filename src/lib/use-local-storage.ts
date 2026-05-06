"use client";

import { useCallback, useSyncExternalStore } from "react";

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
 * これにより `useState + useEffect で localStorage を読む` パターンの
 * react-hooks/set-state-in-effect disable が不要になる。
 */
export function useLocalStorage<T>(
  key: string,
  defaultValue: T,
  parse: (raw: string) => T,
  serialize: (value: T) => string = (v) => String(v),
): readonly [T, (value: T) => void] {
  const value = useSyncExternalStore(
    (callback) => subscribe(key, callback),
    () => {
      try {
        const stored = localStorage.getItem(key);
        return stored != null ? parse(stored) : defaultValue;
      } catch {
        return defaultValue;
      }
    },
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
