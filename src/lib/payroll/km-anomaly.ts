// km-anomaly.ts
// 通勤km・出張km が「その事業所で普段ありえる範囲」を大きく超えていないかを見る (user 2026-09-18)。
//
// 距離は稼働に合わせて増減するので、1 日あたり (km ÷ 出勤日数) で比べる。
// 事業所ごとにエリア特性があるので、線は事業所ごとに持つ (payroll_app_settings の km_anomaly_lines)。
// 線を超えたら 計算は止めず「確認してください」と出すだけ (本当に遠い人もいるため)。
//
// 実例: 船橋 金子百恵 2026-03〜07 通勤km 欄に 通勤費の金額 (22,816) が入っていた → ×12.4 で 282,918円 になっていた
//      高品 櫻井さとみ 2026-06 総括表の出張距離 13,974km (正しくは 1,397.4km。小数点の打ち漏れ)

export type KmLine = { commute_per_day: number; trip_per_day: number };

/** 事業所の線が無いときの既定 (km/日)。総括表 2026-03〜07 の全事業所で 通勤 最大 60 / 出張 最大 137 程度 */
export const DEFAULT_KM_LINE: KmLine = { commute_per_day: 80, trip_per_day: 180 };

export type KmAnomaly = {
  employee_number: string;
  employee_name: string;
  kind: "通勤" | "出張";
  km: number;
  days: number;
  per_day: number;
  line: number;
};

export function findKmAnomalies(
  rows: { employee_number: string; employee_name: string; commute_km: number; trip_km: number; work_days: number }[],
  line: KmLine,
): KmAnomaly[] {
  const out: KmAnomaly[] = [];
  for (const r of rows) {
    // 出勤日数が 0 の人は 1 日として見る (距離だけ入っている = それ自体が怪しい)
    const days = r.work_days > 0 ? r.work_days : 1;
    for (const [kind, km, lim] of [["通勤", r.commute_km, line.commute_per_day], ["出張", r.trip_km, line.trip_per_day]] as const) {
      if (!(km > 0)) continue;
      const perDay = km / days;
      if (perDay > lim) out.push({ employee_number: r.employee_number, employee_name: r.employee_name, kind, km, days: r.work_days, per_day: Math.round(perDay * 10) / 10, line: lim });
    }
  }
  return out.sort((a, b) => b.per_day / b.line - a.per_day / a.line);
}
