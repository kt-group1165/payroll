// 事業所の単価の履歴 (payroll_office_unit_prices) を 対象月の値に解決する。2026-09-26
//
// 【なぜ履歴が要るか】
// payroll_offices は単価を「今の値」1 つしか持っていなかった。★ user 曰く「年 1 回は変わる」ので、
// 改定後に過去の月を再計算すると **新しい単価で計算されて過去が静かに変わる**。落ちないので気づけない。
//
// ⚠ 2026-09-26 に「2026-03〜08 の 6 ヶ月を測ったら単価は一定だったので月次化は不要」と一度結論したが誤り。
//   測定窓が 6 ヶ月しかなく、年 1 回の改定を見られるはずがなかった。★ 窓の長さを見ずに
//   「変わらない」と言わないこと ([[feedback_harness_two_layers_headline_number]] と同型)。
//
// 【方式】payroll_salary_settings と同じ effective_from 方式にそろえた。
//   ・append-only。改定は UPDATE せず 新しい effective_from の行を INSERT する
//   ・対象月で有効な行 = effective_from <= 対象月の 1 日 の中で最新 (salary-history.ts の getActiveSalary と同じ規約)
//   ・★ 過去の行を消さない。消すとその月が計算できなくなる
//   ・初期値は '1970-01-01' (payroll_salary_settings の慣習に合わせた)
//
// ⚠ 単価の改定が 全事業所いっせいか 事業所ごとにバラバラかは まだ分かっていない (調査中)。
//   この方式なら どちらでも表現できる (いっせいなら同じ日付の行が並び、バラバラなら日付が散るだけ)。

/** payroll_office_unit_prices の 1 行 (使う列だけ) */
export type OfficeUnitPriceRow = {
  office_id: string;
  effective_from: string; // 'YYYY-MM-DD'
  travel_unit_price?: number | null;
  commute_unit_price?: number | null;
  treatment_subsidy_amount?: number | null;
  cancel_unit_price?: number | null;
  travel_allowance_rate?: number | null;
  communication_fee_amount?: number | null;
  meeting_unit_price?: number | null;
  distance_adjustment_rate?: number | null;
};

/** 履歴が上書きする単価の列 */
export const OFFICE_PRICE_KEYS = [
  "travel_unit_price",
  "commute_unit_price",
  "treatment_subsidy_amount",
  "cancel_unit_price",
  "travel_allowance_rate",
  "communication_fee_amount",
  "meeting_unit_price",
  "distance_adjustment_rate",
] as const;

export type OfficePriceKey = (typeof OFFICE_PRICE_KEYS)[number];

/**
 * 対象月で有効な行を office_id ごとに 1 つ選ぶ。
 *
 * @param rows       payroll_office_unit_prices の全件 (小さい表なので全件 fetch でよい)
 * @param monthStart 'YYYY-MM-DD'。対象月の 1 日
 */
export function buildActiveOfficePriceMap(
  rows: OfficeUnitPriceRow[],
  monthStart: string,
): Map<string, OfficeUnitPriceRow> {
  const map = new Map<string, OfficeUnitPriceRow>();
  for (const r of rows) {
    if (r.effective_from > monthStart) continue;
    const cur = map.get(r.office_id);
    if (!cur || r.effective_from > cur.effective_from) map.set(r.office_id, r);
  }
  return map;
}

/**
 * 事業所の行に 対象月の単価を重ねる。
 *
 * ⚠ **履歴に行が無い事業所は そのままにする** (payroll_offices の現在値が残る)。
 *   0 で潰すと 単価が消えて金額が静かに変わる。★ 足りないときは「足りない」と分かる形で残す。
 *   呼出側は missing を見て 画面に出すこと。
 * ⚠ 履歴側の値が null の列も そのままにする (「未設定」と「0」は違う)。
 */
export function applyOfficeUnitPrices<T extends { id: string }>(
  offices: T[],
  rows: OfficeUnitPriceRow[],
  monthStart: string,
): { offices: T[]; missing: string[] } {
  const active = buildActiveOfficePriceMap(rows, monthStart);
  const missing: string[] = [];
  const out = offices.map((o) => {
    const h = active.get(o.id);
    if (!h) { missing.push(o.id); return o; }
    const next = { ...o } as T & Partial<Record<OfficePriceKey, number>>;
    for (const k of OFFICE_PRICE_KEYS) {
      const v = h[k];
      if (v == null) continue;
      next[k] = Number(v);
    }
    return next as T;
  });
  return { offices: out, missing };
}
