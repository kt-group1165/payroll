/**
 * 総括表 (① 総括表データ / ② 支払用) の「時間の欄」を 分 にする (2026-09-27 給与D)。
 * ★ 時間の欄を読むところは 全部これを通す (逐語コピーを作らない)。scripts/check-soukatsu-time.mts が見張る。
 *
 * 【なぜ】 同じ「時間」でも 入り方が 4 通りあり、読み違いが 2 回出た (2026-09-27):
 *   - "H:MM" / "HHH:MM:SS" の文字列   ① のほぼ全部 (HRD研修時間 "04:00" / 出勤 "178:30:00")、② の 内初任者研修時間 "35:00"
 *       → ② の "35:00" を 0 と読み、①=② なのに「①≠②」と誤って出した
 *   - Excel の日付 (1904 年基準)       ① の一部 (大網 HRD研修時間 "1904-01-01T07:15:00.000Z" = 7:15 / 残業時間合計 145 セル)
 *       → 0 と読み、金額 ÷ 単価 で戻して辻褄を合わせていた
 *   - 数値                            ② のほぼ全部 (内研修時間 240 = 分)。① の「重度（×0.75）」は "114.1875" = 時間
 *       → ★ 数値の単位は欄ごとに違うので 呼ぶ側が unit で言う (決め打ちしない)
 *   - 空                              0 分
 * 【約束】 ★ 読めない値は 0 ではなく null を返す。0 にすると もっともらしい値になって気づけない (今日の 2 件がそれ)。
 *   例: "174..00" (② 出勤時間 の打ち間違い) / "6:75" / "abc"
 *   ★ "-36:-55" / "00:-55" (① 介護超過手当_120h以上_時。120h に足りない分) は 負の時間として読む (-2,215 分 / -55 分)
 */
export type SoukatsuNumberUnit = "minutes" | "hours";

/** Excel の日付の基準。exceljs は 1904 年基準のブックを 1904-01-01、1900 年基準を 1899-12-30 から数える */
const EXCEL_EPOCHS = ["1904-01-01T00:00:00.000Z", "1899-12-30T00:00:00.000Z"].map((s) => Date.parse(s));

export function soukatsuMinutes(v: unknown, numberUnit: SoukatsuNumberUnit): number | null {
  if (v === null || v === undefined) return 0;
  if (typeof v === "object" && v !== null && "result" in v) return soukatsuMinutes((v as { result: unknown }).result, numberUnit);
  if (v instanceof Date) return fromEpoch(v.getTime());
  if (typeof v === "number") return Number.isFinite(v) ? toMinutes(v, numberUnit) : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s === "") return 0;
  // ① の「介護超過手当_120h以上_時」は 120h に足りない分を 分を負にして出す (593 セル): "-36:-55" = -36 時間 55 分 / "00:-55" = -55 分
  const neg = /^-?(\d+):-(\d{1,2})$/.exec(s);
  if (neg) return Number(neg[2]) >= 60 ? null : -(Number(neg[1]) * 60 + Number(neg[2]));
  const hm = /^(-?)(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(s);
  if (hm) {
    const min = Number(hm[2]) * 60 + Number(hm[3]) + (hm[4] ? Number(hm[4]) / 60 : 0);
    if (Number(hm[3]) >= 60) return null;
    return hm[1] ? -min : min;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) { const t = Date.parse(s); return Number.isNaN(t) ? null : fromEpoch(t); }
  if (/^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/.test(s)) return toMinutes(Number(s.replace(/,/g, "")), numberUnit);
  return null;
}

function toMinutes(n: number, unit: SoukatsuNumberUnit): number {
  return unit === "hours" ? n * 60 : n;
}

/** Excel の日付を 基準日からの分にする。どちらの基準日からも 1 年以上離れていれば 時間ではない (本物の日付) ので null */
function fromEpoch(t: number): number | null {
  for (const e of EXCEL_EPOCHS) {
    const min = (t - e) / 60000;
    if (min >= 0 && min < 366 * 1440) return Math.round(min * 1000) / 1000;
  }
  return null;
}
