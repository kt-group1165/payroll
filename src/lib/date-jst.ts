/**
 * 日付を「暦の日付」として扱うためのヘルパ。
 *
 * ── なぜ要るか ──────────────────────────────────────────────────────────
 *   `toISOString()` は **UTC の日付**を返す。JST は UTC+9 なので、
 *   これで "YYYY-MM-DD" を作ると前日になることがある。
 *
 *     new Date(2026, 6, 0).toISOString().slice(0, 10)
 *       ローカル 0 時 = UTC では前日 15 時 → "2026-06-29"
 *       **時刻に関係なく 24 時間ずっとズレる**（6 月末のつもりが 29 日）
 *
 *     new Date().toISOString().slice(0, 10)
 *       JST の **0〜9 時だけ**前日になる（朝の操作でズレる）
 *
 *   ブラウザで動くコードなら **Vercel のサーバ TZ は無関係**。
 *   利用者の PC が JST である限り必ずズレる。
 *
 *   実害: 月末日ちょうどに始まる認定・公費が対象月から漏れる。
 *         朝に登録した日付（入金日・退職日・納品日）が前日になる。
 *
 * ── 使い方 ──────────────────────────────────────────────────────────────
 *     monthEndYmd("2026-06")        → "2026-06-30"
 *     monthEndYmd(2026, 6)          → "2026-06-30"
 *     todayYmd()                    → 実行した人の暦での今日
 *     addDaysYmd("2026-08-31", 30)  → "2026-09-30"
 *
 * ⚠ `toISOString()` を日付文字列を作る目的で使わないこと。
 *   ただし `new Date(Date.UTC(...))` や `new Date(ymd + "T00:00:00Z")` から
 *   組んだ Date なら正しい。**Date の作り方まで見て判定する**。
 */

/** 数値を 2 桁 0 埋め */
const p2 = (n: number): string => String(n).padStart(2, "0");

/**
 * 対象月の末日を "YYYY-MM-DD" で返す。
 *
 * ⚠ Date.UTC で組むので TZ に影響されない。month は 1〜12（0 始まりではない）。
 */
export function monthEndYmd(ym: string): string;
export function monthEndYmd(year: number, month: number): string;
export function monthEndYmd(a: string | number, b?: number): string {
  let year: number;
  let month: number;
  if (typeof a === "string") {
    const [y, m] = a.split("-").map(Number);
    year = y; month = m;
  } else {
    year = a; month = b as number;
  }
  // Date.UTC(y, month, 0) = その月の 0 日目 = 前月の末日。month は 0 始まりなので
  // 1〜12 をそのまま渡すと「対象月の末日」になる。
  const d = new Date(Date.UTC(year, month, 0));
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

/** 対象月の初日 "YYYY-MM-01"。対称性のために置く。 */
export function monthStartYmd(ym: string): string {
  return `${ym}-01`;
}

/**
 * 「今日」を暦の日付で返す。
 *
 * ⚠ `new Date().toISOString().slice(0,10)` は JST の 0〜9 時に前日を返す。
 *   朝に登録した入金日・退職日・納品日が 1 日前になる。
 */
export function todayYmd(): string {
  const now = new Date();
  return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
}

/**
 * "YYYY-MM-DD" に日数を足す（負数で引く）。
 *
 * ⚠ `new Date(t + n*86400000)` をローカル Date でやると夏時間のある地域でズレる。
 *   Date.UTC で組めば 1 日は必ず 86400000ms なので安全。
 */
export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`;
}
