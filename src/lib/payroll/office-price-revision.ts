// 事業所の単価を画面・CSV から変えたときに 単価の履歴 (payroll_office_unit_prices) へ書く。2026-10-06
//
// 【なぜ要るか】
// 給与計算は 対象月に有効な履歴の行で 単価を上書きする (office-price-history.ts の applyOfficeUnitPrices)。
// ところが事業所の編集画面と CSV 取込は payroll_offices (今の値) しか書いていなかったので、
// ★ 画面で単価を変えても 履歴の値が勝って 給与計算の金額が変わらなかった。エラーも出ないので気づけない。
// → 単価を変えるときは「何月から」を決めて 履歴に 1 行足す (user 2026-10-06「その形で直して」)。
//
// 【書き方】
//   ・改定月の 1 日を effective_from にして 全部の単価を書く (その月の値の写し。null を混ぜない)
//   ・同じ改定月の行が既にあれば 上書き (同じ月の訂正)。UNIQUE (office_id, effective_from)
//   ・★ それより前の行で 変えた単価が null のもの は 変える前の値で埋める。
//     null は「今の値 (payroll_offices) を使う」意味なので、今の値を書き換えると 過去の月まで新しい単価になるため
//     (同行キャンセル単価は 列を足したときに 履歴を null のまま足したので 実際に当たる)
//   ・改定月より後の行があれば その月以降は そちらの単価のまま。呼出側に返して知らせる
import type { SupabaseClient } from "@supabase/supabase-js";
import { OFFICE_PRICE_KEYS, type OfficePriceKey } from "./office-price-history";

export type OfficePriceValues = Record<OfficePriceKey, number>;

/** 事業所の行から 単価だけを取り出す (無い列は 0。距離調整係数だけ 100) */
export function priceValuesOf(o: Partial<Record<OfficePriceKey, number | null>>): OfficePriceValues {
  const out = {} as OfficePriceValues;
  for (const k of OFFICE_PRICE_KEYS) out[k] = Number(o[k] ?? (k === "distance_adjustment_rate" ? 100 : 0));
  return out;
}

export function changedPriceKeys(before: OfficePriceValues, after: OfficePriceValues): OfficePriceKey[] {
  return OFFICE_PRICE_KEYS.filter((k) => Number(before[k]) !== Number(after[k]));
}

/** "YYYY-MM" → "YYYY-MM-01"。形が違えば null */
export function revisionMonthToDate(month: string): string | null {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? `${month}-01` : null;
}

/** 今月 (JST) を "YYYY-MM" で */
export function currentMonthJst(): string {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * 単価の改定を 履歴に書く。失敗したら throw (呼出側で表示する)。
 * @returns laterFrom 改定月より後に既にある改定の effective_from (その月以降は そちらの単価のまま)
 */
export async function recordOfficePriceRevision(
  sb: SupabaseClient,
  officeId: string,
  before: OfficePriceValues,
  after: OfficePriceValues,
  effectiveFrom: string,
  note: string,
): Promise<{ laterFrom: string[] }> {
  const changed = changedPriceKeys(before, after);
  if (changed.length === 0) return { laterFrom: [] };

  const { data: rows, error: readErr } = await sb
    .from("payroll_office_unit_prices")
    .select(`id, effective_from, ${OFFICE_PRICE_KEYS.join(", ")}`)
    .eq("office_id", officeId)
    .order("effective_from");
  if (readErr) throw new Error(`単価の履歴を読めませんでした: ${readErr.message}`);
  const hist = (rows ?? []) as unknown as ({ id: string; effective_from: string } & Partial<Record<OfficePriceKey, number | null>>)[];

  // 改定月より前の行で 変えた単価が null → 変える前の値で埋める
  for (const r of hist) {
    if (r.effective_from >= effectiveFrom) continue;
    const fill: Partial<OfficePriceValues> = {};
    for (const k of changed) if (r[k] == null) fill[k] = before[k];
    if (Object.keys(fill).length === 0) continue;
    const { error } = await sb.from("payroll_office_unit_prices").update(fill).eq("id", r.id);
    if (error) throw new Error(`単価の履歴 (${r.effective_from}) を埋められませんでした: ${error.message}`);
  }

  // 改定月の行 = 「その月に効いていた値」に 変えた単価だけを重ねたもの。
  // ★ after をそのまま書くと、もっと後の改定がある事業所で 過去の月から改定したとき
  //   変えていない単価まで 今の値 (後の改定の値) に変わってしまう (check:office-price-revision ④)
  const activeAtEff = [...hist].reverse().find((r) => r.effective_from <= effectiveFrom);
  const snapshot = {} as OfficePriceValues;
  for (const k of OFFICE_PRICE_KEYS) {
    snapshot[k] = changed.includes(k) ? after[k] : Number(activeAtEff?.[k] ?? before[k]);
  }

  const { error: upErr } = await sb
    .from("payroll_office_unit_prices")
    .upsert({ office_id: officeId, effective_from: effectiveFrom, ...snapshot, note, updated_at: new Date().toISOString() },
      { onConflict: "office_id,effective_from" });
  if (upErr) throw new Error(`単価の改定を保存できませんでした: ${upErr.message}`);

  return { laterFrom: hist.filter((r) => r.effective_from > effectiveFrom).map((r) => r.effective_from) };
}

/** 新しく作った事業所の 単価の初期値 (1970-01-01 起点。既存の初期投入と同じ規約) */
export async function insertInitialPriceRow(
  sb: SupabaseClient,
  officeId: string,
  values: OfficePriceValues,
  note: string,
): Promise<void> {
  const { error } = await sb
    .from("payroll_office_unit_prices")
    .upsert({ office_id: officeId, effective_from: "1970-01-01", ...values, note }, { onConflict: "office_id,effective_from" });
  if (error) throw new Error(`単価の初期値を保存できませんでした: ${error.message}`);
}
