// 月ごと・職員ごとの手入力 (payroll_monthly_inputs)。2026-09-18
//
// 総括表で本社が手入力している数字のうち、実績・出勤簿・事業所書式に元が無いもの。
// 取込では消さない。給与計算 (page.tsx) は計算のたびに読む。

/**
 * 報奨金を その月に支給するか (payroll_monthly_inputs item_key。numeric_value 1 = 支給)。2026-09-22
 * 金額は 給与設定の 報奨金 (bonus_amount、変更しない限り続く)。支給する / しないは /bonus-payments で月ごとに決める。
 * 月ごとの手入力の画面 (MONTHLY_INPUT_ITEMS) には出さない。
 */
export const BONUS_PAID_KEY = "bonus_paid";

export const MONTHLY_INPUT_ITEMS = [
  {
    key: "bath_visit_count",
    label: "入浴件数",
    unit: "件",
    help: "社員の介護超過の時間に 件数 × 1.12 時間 を足す (おゆみ野の総括表の式)",
    allowNegative: false,
  },
  {
    key: "bath_minutes",
    label: "入浴時間",
    unit: "分",
    help: "社員の介護超過の時間にそのまま足す (リンクス茂原の総括表「入浴時間」)",
    allowNegative: false,
  },
  {
    key: "business_km",
    label: "出張km (精算書)",
    unit: "km",
    help: "交通費精算書の走行距離合計 (自宅からの移動を含む)。入れた月は 事業所書式・出勤簿の出張km より優先 (書式の入力漏れ用。八千代 社員など)",
    allowNegative: false,
  },
  {
    key: "adjustment",
    label: "調整手当・過誤",
    unit: "円",
    help: "総支給額にそのまま足す (マイナス可。前月分の過誤の精算など、総括表の「調整手当」「過誤(手入力)」)",
    allowNegative: true,
  },
] as const;

/**
 * 入浴 1 件あたりに介護時間として数える時間 (時間)。
 * おゆみ野の総括表 2026-03〜07 の 時間外h の式 = 訪問時間 … + 1.12 × 訪問件数 − 120 (全月 1.12)。
 * 7 月の社員で 1.1 だと 東條 2,500 円 (総括表 4,250 円) になり合わない。1.12 で合う
 */
export const BATH_VISIT_HOURS = 1.12;

/** 入浴件数 → 介護時間に足す分 (分) */
export function bathVisitCareMinutes(count: number): number {
  return count > 0 ? count * BATH_VISIT_HOURS * 60 : 0;
}
