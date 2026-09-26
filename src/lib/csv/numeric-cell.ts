/**
 * 表計算から来たセルを数値として読む (2026-09-27)。
 *
 * 【なぜ要るか】
 * ★ `parseFloat("1,302")` は **1** を返す。落ちも警告も出ず、もっともらしい値になるので気づけない。
 *   ★ 0 になるより危ない (0 なら「入っていない」と気づけるが、1 は本物の値に見える)。
 * ★ このリポジトリでは 請求・国保連・予防・総括表の 4 つのパーサが それぞれ
 *   `replace(/,/g, "")` を持っていたが、★ **出勤簿のパーサだけ持っていなかった**。
 *
 * 【実測 (2026-09-27)】
 * ```
 * payroll_attendance_records 21,160 行 / 691 人月
 *   月合計が 1,000km 以上の人月            270 件  ← CSV でカンマ書式になりうる
 *   ★ 1 日 1 行で 1,000km 以上              1 件   (星野寛之 2026-07 出張 1,238km。正しく入っている)
 *   ★ 「他の月は 4 桁なのに その月だけ 1 桁」  0 件   ← 切られた痕跡は **無い**
 * ```
 * ★ つまり 今のところ実害は 0。★ ただし 1 日 1,238km が既に出ているので、
 *   Excel の書式が変わった瞬間に 静かに 1km になる。潜在の穴として塞ぐ。
 */

/**
 * @returns 読めなければ null。★ 0 を返さない。
 *   「未設定」と「0」を混ぜないため (このリポジトリで繰り返し出ている型)。
 */
export function parseNumericCell(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  // 全角数字・全角記号を半角へ (`Number("１０")` は NaN)。そのうえで カンマ・空白・円/km の単位を落とす
  const s = String(v).normalize("NFKC").replace(/[,\s]/g, "").replace(/[円km㎞]/gi, "");
  if (s === "") return null;
  // 括弧の負数 "(1,000)" は 表計算の負の書式
  const m = /^\((.+)\)$/.exec(s);
  const body = m ? `-${m[1]}` : s;
  const n = Number(body);
  return Number.isFinite(n) ? n : null;
}

/** 読めなければ 0。★ 0 でよいと分かっている場所だけで使うこと */
export function parseNumericCellOrZero(v: string | number | null | undefined): number {
  return parseNumericCell(v) ?? 0;
}
