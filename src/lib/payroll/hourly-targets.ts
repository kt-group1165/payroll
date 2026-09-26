/**
 * 時給者の給与計算の「対象にする職員番号」の集合 (2026-09-27 給与D が page.tsx から切り出し)。
 *
 * ⚠ ここに入らない職員は 手入力があっても **行ごと消える** (本人給 0 円・payload に居ない)。
 *   過去に 2 回 落ちた:
 *   - 事務時間の手入力しか無い事務員 (五井 根本カオリ 202603。2026-09-24)
 *   - 研修時間・出張km・有給 (管理簿の当月日数) の手入力しか無い人
 *     (岩田ゆきよ 202604 / 江波戸祐子 202607 / 杉尾加奈子 202606 / 木村江利・岩坪恵 202607。2026-09-27 726d07b)
 * client component の中に書いてあると 再計算するまで直ったか確かめられないので、純関数にして
 * scripts/check-hourly-targets.mts で fixture から検査する。
 * ★ 手入力の項目を増やしたら ここにも足すこと (足さないと その項目しか無い人が落ちる)。
 */
export type HourlyTargetSources = {
  /** サービス実績がある職員番号 */
  records: Iterable<string>;
  /** 出勤簿がある職員番号 */
  attendance: Iterable<string>;
  /** 事業所書式がある職員番号 */
  officeForms: Iterable<string>;
  /** 手入力 office_work_minutes > 0 */
  manualOfficeWork: Iterable<string>;
  /** 手入力 training_minutes > 0 */
  manualTraining: Iterable<string>;
  /** 手入力 business_km > 0 */
  manualTripKm: Iterable<string>;
  /** 有給管理簿: 職員番号 → (処理月 → 日数) */
  ledgerDaysByNum: Map<string, Map<string, number>>;
  /** 処理月 YYYYMM */
  month: string;
};

export function hourlyTargetEmployeeNumbers(s: HourlyTargetSources): Set<string> {
  const ledgerThisMonth = [...s.ledgerDaysByNum].filter(([, byM]) => (byM.get(s.month) ?? 0) > 0).map(([n]) => n);
  return new Set([...s.records, ...s.attendance, ...s.officeForms, ...s.manualOfficeWork,
    ...s.manualTraining, ...s.manualTripKm, ...ledgerThisMonth]);
}
