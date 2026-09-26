/**
 * 訪問 1 件ぶんの「時給の決まり方」と「本人給」。2026-09-26 に /payroll のページの中から切り出した。
 *
 * 【なぜ切り出したか】
 * ここは client component (`src/app/payroll/page.tsx`) の中の `recordPayOf` に埋まっていて、
 * ★ ハーネスからも他の画面からも呼べない = 永久に検証されない場所だった
 * (このリポジトリで 2026-09-05 に 4 箇所を同じ理由で外に出している)。
 * サービス記録一覧の画面が同じ金額を出す必要が生じたので、逐語コピーではなく共有 module にする
 * (逐語コピーは 片方だけ直したときに黙って乖離する。`billing-issue.ts` のヘッダにも同じ結論がある)。
 *
 * ⚠ **挙動は 1 ミリも変えていない。**時給の選び方の優先順位・端数・除外はすべて元のまま。
 */
import { parseDurationMinutes, payMinutesOf, visitPayAmount } from "./payroll-calc";

/** 訪問 1 件のうち 時給を決めるのに要る項目だけ */
export type VisitForPay = {
  calc_duration: string;
  service_code: string;
  office_number: string;
  time_period?: string | null;
};

/**
 * 時給を引くための対応表いろいろ。呼び出し側が DB から組み立てて渡す。
 *   mappingMap  サービスコード → 類型 id            (payroll_service_type_mappings)
 *   categoryMap 類型 id → 類型名                    (payroll_service_categories)
 *   officeMap   事業所番号 → 事業所 id              (payroll_offices)
 *   rateMap     "事業所id:類型id" → 時給            (payroll_category_hourly_rates。対象月で有効なもの)
 *   juhoShortRates   事業所番号 → 類型名 → 時給     重度訪問の 1.5 時間以下の時給
 *   sougouRates      事業所番号 → 時給              総合事業 (A…) で生活援助の時給
 *   doukouFlatRates  事業所番号 → 時給              同行援護 021008 を長さによらず固定で払う事業所
 *   lifeSupportCategoryId  「生活援助」の類型 id (1.5 時間を超えた分の時給に使う)
 */
export type VisitRateContext = {
  mappingMap: Map<string, string>;
  categoryMap: Map<string, string>;
  officeMap: Map<string, string>;
  rateMap: Map<string, number>;
  juhoShortRates: Record<string, Record<string, number>>;
  sougouRates: Record<string, number>;
  doukouFlatRates: Record<string, number>;
  lifeSupportCategoryId: string | null;
};

export type VisitPayResult = {
  minutes: number;
  categoryId: string | null;
  catName: string;
  officeId: string | null;
  hourlyRate: number | null;
  /** 本人給 (円)。時給が引けなければ null */
  pay: number | null;
  /** 0 円になった理由。null = 正常に引けた */
  cause: "類型なし" | "時給なし" | null;
};

/**
 * 訪問 1 件の 時給と本人給を決める。
 *
 * 時給の優先順位 (元の実装のまま):
 *   1. 同行援護 021008 を固定で払う事業所 → その時給 (★ 1.5 時間超の段階を付けない)
 *   2. 総合事業 (コードが A で始まる) かつ 生活援助 → その事業所の総合事業の時給
 *   3. 重度訪問で 90 分以下 → 短時間の時給
 *   4. それ以外 → 事業所 × 類型 の時給
 * ⚠ 1〜3 はいずれも **通常の時給が引けているとき (longRate !== null) だけ**効く。
 *   引けていない事業所に 短時間・総合事業の時給だけが入っていても 0 円のままにする。
 */
export function resolveVisitPay(rec: VisitForPay, ctx: VisitRateContext): VisitPayResult {
  const minutes = parseDurationMinutes(rec.calc_duration);
  const categoryId = ctx.mappingMap.get(rec.service_code) ?? null;
  const catName = categoryId ? (ctx.categoryMap.get(categoryId) ?? "不明") : "未マッピング";
  const officeId = ctx.officeMap.get(rec.office_number) ?? null;
  const longRate = categoryId && officeId ? (ctx.rateMap.get(`${officeId}:${categoryId}`) ?? null) : null;
  // 重度訪問は 1 回 1.5 時間以下なら短時間の時給 (事業所ごとの設定がある区分だけ)
  const shortRate = ctx.juhoShortRates[rec.office_number]?.[catName];
  // 総合事業 (A…) で生活援助に結び付いている訪問は 事業所ごとの総合事業の時給 (船橋 1,400)
  const sougouRate = /^A/.test(rec.service_code) && catName === "生活援助" ? ctx.sougouRates[rec.office_number] : undefined;
  // 同行援護 (021008) を固定の時給で払う事業所 (五井・やわた 1,750 / KT姉崎 2,100)。段階式にしない
  const doukouFlat = String(rec.service_code).padStart(6, "0") === "021008" ? ctx.doukouFlatRates[rec.office_number] : undefined;
  const hourlyRate = doukouFlat !== undefined && longRate !== null ? doukouFlat
    : sougouRate !== undefined && longRate !== null ? sougouRate
    : longRate !== null && shortRate !== undefined && minutes <= 90 ? shortRate : longRate;
  const overflowRate = officeId && ctx.lifeSupportCategoryId ? (ctx.rateMap.get(`${officeId}:${ctx.lifeSupportCategoryId}`) ?? null) : null;
  // 本人給は 1 回の訪問時間を 5 分単位に切り上げて払う (2026-09-19)。時間の集計 (介護超過・残業など) は切り上げない
  const pay = visitPayAmount(payMinutesOf(minutes), hourlyRate, catName, rec.time_period, doukouFlat !== undefined ? null : overflowRate);
  const cause = (pay === null || hourlyRate === null)
    ? (categoryId === null ? "類型なし" as const : "時給なし" as const)
    : null;
  return { minutes, categoryId, catName, officeId, hourlyRate, pay, cause };
}
