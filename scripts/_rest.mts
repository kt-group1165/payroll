/**
 * scripts から PostgREST を叩くための共通ヘルパー (2026-09-26)。
 *
 * 【なぜ作ったか】
 * scripts 側には共通のものが無く、毎回その場で `const q = async (u) => fetch(...)` を書いていた。
 * ★ そのせいで **PostgREST の 1000 行上限**を 2026-09-26 の 1 日だけで 3 回踏んだ:
 * ```
 * payroll_soukatsu_rows      3,815 行 → 1,000 で切れ「全員 総括表に居ない」という偽陽性を出した
 * payroll_legacy_employee    1,656 行 → 1,000 で切れ「一意に引けるのは 13 名」と過少に報告した
 * payroll_employees          1,194 名 → 1,000 で切れ件数を誤って報告した
 * ```
 * ★ いずれも **落ちない**。黙って足りない行で計算が進む。警告文では防げないので道具側で防ぐ。
 *
 * 【使い方】
 * ```ts
 * import { restAll, restOne, restCount } from "./_rest";
 * const rows = await restAll<Row>("payroll_soukatsu_rows?select=office_number,row_data");  // 全件 (自動ページング)
 * const one  = await restOne<Row>("payroll_offices?select=id&office_number=eq.1270501180"); // 1 行だけ
 * const n    = await restCount("payroll_employees?select=id&salary_type=eq.月給");          // 件数だけ
 * ```
 *
 * ⚠ `restAll` は order を自分で付ける (既定 `id`)。**order 無しのページングは行が抜ける**ので、
 *   呼び出し側が order を書いていたらそれを尊重し、無ければ足す。
 * ⚠ 1 ページしか読まない `restPage` もあるが、**ちょうど 1000 行返ったら警告を出す** (切れている疑い)。
 */
import { readFileSync } from "node:fs";

const env: Record<string, string> = {};
for (const p of ["../kaigo-app/.env.local", ".env.local", "apps/kaigo-app/.env.local"]) {
  let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
export const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const KEY = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!SB_URL || !KEY) throw new Error("★ NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が読めません (.env.local を確認)");
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const PAGE = 1000;
/** 1 回の fetch の待ち時間。Supabase が詰まったときに 45 秒待つより 早く諦めて再試行するほうが速い */
const TIMEOUT_MS = 30_000;

async function call(url: string, extra: Record<string, string> = {}): Promise<Response> {
  let lastErr: unknown = null;
  // ★ Supabase が一時的に詰まることがある (2026-09-26 に実際に起きた)。3 回まで待って再試行する
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${SB_URL}/rest/v1/${url}`, { headers: { ...H, ...extra }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (r.ok || (r.status >= 400 && r.status < 500)) return r;   // 4xx は再試行しても同じ
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) { lastErr = e; }
    if (i < 2) await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
  }
  throw new Error(`★ ${url.slice(0, 80)} の取得に 3 回失敗: ${String(lastErr)}`);
}

/** 1 ページだけ読む。★ ちょうど PAGE 行返ったら「切れている疑い」を警告する */
export async function restPage<T>(query: string): Promise<T[]> {
  const r = await call(query);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(`★ 配列が返りませんでした (${query.slice(0, 80)}): ${JSON.stringify(j).slice(0, 200)}`);
  if (j.length === PAGE) {
    console.warn(`⚠ ${query.split("?")[0]} が ちょうど ${PAGE} 行返りました。**1000 行上限で切れている可能性があります**。restAll を使ってください`);
  }
  return j as T[];
}

/** 件数だけ取る (行は読まない)。母数を出すときはこれを使う */
export async function restCount(query: string): Promise<number> {
  const r = await call(query, { Prefer: "count=exact", Range: "0-0" });
  const cr = r.headers.get("content-range") ?? "";
  const n = Number(cr.split("/")[1]);
  if (!Number.isFinite(n)) throw new Error(`★ 件数が読めません (${query.slice(0, 80)}): content-range=${cr}`);
  return n;
}

/**
 * 全件取る。★ 1000 行上限を自動で越える。
 * @param query "table?select=..." 形式。order が無ければ `&order=id` を足す
 * @param orderBy order が無いときに使う列 (既定 "id")
 */
export async function restAll<T>(query: string, orderBy = "id"): Promise<T[]> {
  const ordered = /[?&]order=/.test(query) ? query : `${query}${query.includes("?") ? "&" : "?"}order=${orderBy}`;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const r = await call(`${ordered}&offset=${from}&limit=${PAGE}`);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(`★ 配列が返りませんでした (${ordered.slice(0, 80)}): ${JSON.stringify(j).slice(0, 200)}`);
    out.push(...(j as T[]));
    if (j.length < PAGE) break;
  }
  return out;
}

/** 1 行だけ欲しいとき。0 行なら null、2 行以上なら例外 (絞りが足りない) */
export async function restOne<T>(query: string): Promise<T | null> {
  const rows = await restPage<T>(`${query}${query.includes("?") ? "&" : "?"}limit=2`);
  if (rows.length === 0) return null;
  if (rows.length > 1) throw new Error(`★ 1 行のつもりが 2 行以上返りました (${query.slice(0, 80)})。絞りが足りません`);
  return rows[0];
}

/**
 * ★ 職員番号は **事業所をまたぐと重複する**。必ず (office_number, employee_number) の対で引くこと。
 * 2026-09-26 に 指示役と給与A が 2 人ともこの罠を踏んだ
 * (加瀬真紀江 → 野口養子 / 稲葉香織 → 後藤雅代 / 五十嵐尚子 → 久保田明美 と取り違えた)。
 */
export const empKey = (officeNumber: string, employeeNumber: string | number): string =>
  `${officeNumber}|${String(employeeNumber ?? "").replace(/^0+/, "")}`;

/** 先頭の 0 を落とした職員番号。DB と CSV で 0 埋めが揃っていないため */
export const normEmpNo = (v: string | number | null | undefined): string => String(v ?? "").trim().replace(/^0+/, "");
