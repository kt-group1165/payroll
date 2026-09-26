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
    key: "training_minutes",
    label: "研修・会議の時間 (書式にない分)",
    unit: "分",
    help: "事業所書式に書かれていない研修・会議の時間。1,150円/時で支払う。本稼働後は書式に入れてもらう (2026-09-23 user)",
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
    key: "office_work_minutes",
    label: "事務時間 (出勤簿が取り込めない人)",
    unit: "分",
    help: "事務員の出勤簿が CSV で取り込めない人の勤務時間。事務時給 × この時間 を本人給にする (五井 根本カオリ のようにスキャンPDFしか無い人用。本稼働後は出勤簿から)",
    allowNegative: false,
  },
  {
    key: "shoninsha_training_minutes",
    label: "初任者研修の時間 (書式にない分)",
    unit: "分",
    help: "事業所書式に初任者研修が入力されていない月の受講時間。1,150円/時で 本人給 に入る。★ 実測 (2026-09-26): 総括表に初任者研修費がある 23 人月のうち 13 人月は事業所書式に記録が無く 当方 0 円だった (計 ¥533,025)。入れた月は 書式からの計算より優先する。本稼働後は書式に入れてもらう",
    allowNegative: false,
  },
  {
    key: "absence_days",
    label: "欠勤日数 (出勤簿・書式にない分)",
    unit: "日",
    help: "欠勤した日数。半欠勤は 0.5 で入れる。★ まるまる 1 か月休んだ月は 固定給を全額控除する。総括表の「欠勤控除」列と「有給・特休・欠勤」欄 (例 欠22) が元。⚠ 出勤簿にも事業所書式にも欠勤が入っていないと 当システムは満額で計算してしまう (金香蘭 2 人月・石毛博美 1 人月で 計 ¥904,500 の過大が実際に起きていた)",
    allowNegative: false,
  },
  {
    key: "legal_within_overtime_minutes",
    label: "法内残業 (出勤簿が取り込めない人)",
    unit: "分",
    help: "所定 (8h) は超えたが 法定 (8h/40h) は超えない残業。★ 割増が付かないので 残業とは単価が違う (法内残業手当 = 分 ÷ 60 × 残業単価 ÷ 1.25。総括表 17/17 で 1 円まで一致)。総括表には「法内残業」列が 全事業所に存在する。出勤簿が当システムに無い人だけ手で入れる",
    allowNegative: false,
  },
  {
    key: "overtime_minutes",
    label: "残業 (出勤簿が取り込めない人)",
    unit: "分",
    help: "事務員の残業。出勤簿が CSV で取り込めない人 (スキャンPDFしか無い人) 用。残業総額 = この分数 ÷ 60 × 残業単価 で払う (総括表 事務員 84/84 一致)。★ 残業 = 出勤時間 − 480分 × 出勤日数 は 42人月中 34 しか合わないので 計算しない。PDF の出勤簿 (赤字の手書き訂正が正) から人が入れる。本稼働後は出勤簿から",
    allowNegative: false,
  },
  {
    key: "commute_yen",
    label: "通勤費 (出勤簿が取り込めない人)",
    unit: "円",
    help: "出勤簿が当システムに無い職員の通勤費。入れた月は 出勤簿からの計算より優先する。★km ではなく円で持つ (事務員の通勤費は 日額の積み上げで、km × 単価では再現できない。三島由佳 花見川 310円/日 × 21日 = 6,510円)。本稼働後は出勤簿から",
    allowNegative: false,
  },
  {
    key: "overnight_allowance",
    label: "泊まり手当 (日をまたぐ訪問)",
    unit: "円",
    help: "日をまたぐ訪問に対して払う手当。★規則が決まっていないので 計算しない (user 2026-09-24「その時考える」)。画面が候補の回数を出すので 払う額を人が入れる。総括表 おゆみ野 峯島しおり = 1 回 10,000 円 × 4〜5 回/月",
    allowNegative: false,
  },
  {
    key: "childcare_allowance",
    label: "育児手当 (書式にない分)",
    unit: "円",
    help: "事業所書式に保育料が書かれていない月の育児手当。入れた月は 書式からの計算より優先する (書式の入力漏れ用)。本稼働後は書式に入れてもらう (2026-09-23 user)",
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
