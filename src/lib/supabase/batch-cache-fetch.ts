/**
 * 「まとめて再計算」の間だけ、決まった表の GET を使い回す fetch ラッパ (2026-09-27)。
 *
 * なぜ: 給与計算 (payroll/page.tsx calculateFor) は 1 件ごとに payroll_legacy_employee (1,656 行) を
 *   全件読む。138 事業所月を まとめて再計算すると 約 23 万行を読むことになる。
 *   ★ 計算の中身は 1 行も変えずに (= 画面から 1 件ずつ計算したときと同じ結果のまま)、読む回数だけ減らしたい。
 *
 * ★ 既定は OFF (素通し)。まとめて再計算の開始で ON、終了・中止で OFF にしてメモを捨てる。
 *   → 画面から 1 件ずつ計算するときの挙動は この仕組みを入れる前と同じ。
 * ⚠ 使い回してよいのは 計算中に書き換わらない表だけ (旧システムの取り込み表)。実績・入力・設定は入れない。
 * 参考: kaigo-app/src/lib/supabase/master-cache-fetch.ts (同じ型。あちらは常時 ON・TTL 付き)
 */

/** まとめて再計算の間だけ使い回してよい表 */
const BATCH_CACHEABLE_TABLES = new Set(["payroll_legacy_employee"]);

/** 復元するヘッダ (PostgREST の件数取得は content-range を見る) */
const KEEP_HEADERS = ["content-type", "content-range", "content-profile", "content-location"];

type Snapshot = { status: number; statusText: string; headers: [string, string][]; body: string };

let enabled = false;
const cache = new Map<string, Promise<Snapshot>>();

/** まとめて再計算の開始・終了で切り替える。切り替えるたびにメモを捨てる */
export function setBatchCache(on: boolean): void {
  enabled = on;
  cache.clear();
}

const urlOf = (input: RequestInfo | URL) => (typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
const tableOf = (url: string) => /\/rest\/v1\/([A-Za-z0-9_]+)/.exec(url)?.[1] ?? null;
const headerOf = (input: RequestInfo | URL, init: RequestInit | undefined, name: string) =>
  new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get(name) ?? "";
const toResponse = (s: Snapshot) => new Response(s.status === 204 || s.status === 205 ? null : s.body, { status: s.status, statusText: s.statusText, headers: s.headers });

export function createBatchCachingFetch(base: typeof fetch = fetch): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!enabled) return base(input, init);
    const url = urlOf(input);
    const table = tableOf(url);
    if (!table || !BATCH_CACHEABLE_TABLES.has(table)) return base(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET") { cache.clear(); return base(input, init); }
    if (init?.signal || (input instanceof Request && input.signal)) return base(input, init);
    // .range() / count は Range・Prefer ヘッダで結果が変わるのでキーに含める
    const key = [url, headerOf(input, init, "range"), headerOf(input, init, "prefer"), headerOf(input, init, "accept")].join("|");
    const hit = cache.get(key);
    if (hit) {
      try { return toResponse(await hit); } catch { cache.delete(key); return base(input, init); }
    }
    const p = (async (): Promise<Snapshot> => {
      const res = await base(input, init);
      const headers = KEEP_HEADERS.flatMap((h) => { const v = res.headers.get(h); return v ? ([[h, v]] as [string, string][]) : []; });
      const snap: Snapshot = { status: res.status, statusText: res.statusText, headers, body: await res.text() };
      if (!res.ok) cache.delete(key); // エラー応答はメモしない
      return snap;
    })();
    cache.set(key, p);
    try { return toResponse(await p); } catch (e) { cache.delete(key); throw e; }
  };
}
