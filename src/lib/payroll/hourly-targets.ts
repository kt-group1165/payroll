/**
 * 時給者の給与計算の「対象にする職員番号」の集合 (2026-09-27 給与D が page.tsx から切り出し)。
 *
 * ⚠ ここに入らない職員は 手入力があっても **行ごと消える** (本人給 0 円・payload に居ない)。
 *   過去に 2 回 落ちた:
 *   - 事務時間の手入力しか無い事務員 (五井 根本カオリ 202603。2026-09-24)
 *   - 研修時間・出張km・有給 (管理簿の当月日数) の手入力しか無い人
 *     (岩田ゆきよ 202604 / 江波戸祐子 202607 / 杉尾加奈子 202606 / 木村江利・岩坪恵 202607。2026-09-27 726d07b)
 *   どちらも「手入力の項目を列挙していて 足し忘れた」型。★ なので 手入力は項目を列挙せず、
 *   **値>0 の手入力は全部入れる**。入れないのは HOURLY_TARGET_EXCLUDED_ITEMS に理由付きで書いたものだけ
 *   (★ 新しい項目は 何もしなくても入る側に倒れる)。
 * client component の中に書いてあると 再計算するまで直ったか確かめられないので、純関数にして
 * scripts/check-hourly-targets.mts で fixture から検査する。
 */

/** 手入力があっても それだけでは時給者の集合に入れない項目 (★ 理由の無いものを足さないこと) */
export const HOURLY_TARGET_EXCLUDED_ITEMS: Readonly<Record<string, string>> = {
  social_insurance: "社会保険の有無の旗。払う額ではない",
  bonus_paid: "報奨金を払う月の旗。月給者の計算だけが読む",
  overtime_minutes: "月給者 (事務員) の残業。時給者の計算は読まない → 入れると 固定分だけの行ができる",
  legal_within_overtime_minutes: "月給者の法内残業。時給者の計算は読まない",
  absence_days: "月給者の欠勤控除。時給者の計算は読まない",
  overnight_allowance: "泊まり手当。月給者の計算だけが読む",
};

export type HourlyTargetSources = {
  /** サービス実績がある職員番号 */
  records: Iterable<string>;
  /** 出勤簿がある職員番号 */
  attendance: Iterable<string>;
  /** 事業所書式がある職員番号 */
  officeForms: Iterable<string>;
  /** 月ごとの手入力 (payroll_monthly_inputs): 項目 → 値>0 の職員番号 */
  manualByItem: Map<string, Iterable<string>>;
  /** 有給管理簿: 職員番号 → (処理月 → 日数) */
  ledgerDaysByNum: Map<string, Map<string, number>>;
  /** 処理月 YYYYMM */
  month: string;
};

export function hourlyTargetEmployeeNumbers(s: HourlyTargetSources): Set<string> {
  const ledgerThisMonth = [...s.ledgerDaysByNum].filter(([, byM]) => (byM.get(s.month) ?? 0) > 0).map(([n]) => n);
  const manual = [...s.manualByItem].filter(([k]) => !(k in HOURLY_TARGET_EXCLUDED_ITEMS)).flatMap(([, nums]) => [...nums]);
  return new Set([...s.records, ...s.attendance, ...s.officeForms, ...manual, ...ledgerThisMonth]);
}
