// visit-attendance-adapter.ts
// 画面入力の出勤簿 (kaigo-app「出勤簿」= payroll_kyotaku_attendance_records) を、
// 訪問介護の給与計算が読む形 (Excel 出勤簿 CSV を取り込んだ payroll_attendance_records と同じ形) に変える。
//
// 2026-09-18 user 方針: 訪問介護の出勤簿の入力は kaigo-app の画面で行う (部門別の配置どおり)。
// 移行中は Excel 取込も残し、事業所ごとに「画面入力を使う」を切り替える
// (payroll_app_settings の visit_attendance_screen_offices)。
//
// 変換の中身:
//   勤務時間     = 終了 − 開始 − 休憩 (calcDaily)
//   日残業/週残業 = 出さない (空)。給与計算は空なら「勤務時間 − 8h」の合計を残業にする。
//                  ★ Excel 出勤簿の大半 (107 人中 98 人) には 日残業/週残業 の列が無く、今の給与計算は
//                  1 日 8h 超だけを残業にしている。移行で金額が変わらないよう それに揃える (2026-09-18)。
//                  週 40h 超を入れると 107 人中 57 人しか Excel と合わない。総括表の「残業」はどちらとも
//                  合わない (105 人中 17 / 8 人) ので、週の扱いは総括表の規則が分かってから決める
//   勤務時間の計算で週 (法定休日の自動判定) を見るので、呼出側は extendedMonthRange の範囲で行を渡すこと
//   勤務摘要     = 有給 / 半日有給 / 振替休 (画面の 有給種別・振替元日付) → 無ければ備考
//   通勤km/出張km = commute_km / business_km
// ⚠ 有給・半有給の「日数」は今までどおり事業所書式から数える (給与計算は勤務摘要を日数に使っていない)
import { calcDailyListWithWeekly, formatHM, type AttendanceRecord as CalcRecord } from "./attendance-calc";

export type ScreenAttendanceRow = {
  employee_id: string;
  work_date: string;            // YYYY-MM-DD
  start_time: string | null;    // HH:mm(:ss)
  end_time: string | null;
  break_minutes: number | null;
  is_legal_holiday: boolean | null;
  paid_leave_type: "full" | "half" | null;
  substitute_for_date: string | null;
  note: string | null;
  commute_km?: number | null;
  business_km: number | null;
};

export type VisitAttendanceRecord = {
  employee_number: string;
  employee_name: string;
  day: number;
  work_note_1: string;
  work_note_2: string;
  work_note_3: string;
  work_note_4: string;
  work_note_5: string;
  start_time_1: string;
  work_hours: string;
  overtime_daily: string;
  overtime_weekly: string;
  commute_km: number | null;
  business_km: number | null;
};

const hm = (t: string | null) => (t ? t.slice(0, 5) : null);

/**
 * @param rows        画面入力の出勤簿 (週の計算のため 月をまたぐ週の前後の日も含めて渡す)
 * @param employees   employee_id → { employee_number, name }
 * @param yearMonth   "YYYY-MM"。この月の日だけを返す
 * @param weekStartDay 週の起算曜日 (0=日)
 */
export function screenAttendanceToVisitRecords(
  rows: ScreenAttendanceRow[],
  employees: Map<string, { employee_number: string; name: string }>,
  yearMonth: string,
  weekStartDay = 0,
): VisitAttendanceRecord[] {
  const byEmp = new Map<string, ScreenAttendanceRow[]>();
  for (const r of rows) (byEmp.get(r.employee_id) ?? byEmp.set(r.employee_id, []).get(r.employee_id)!).push(r);
  const out: VisitAttendanceRecord[] = [];
  for (const [empId, list] of byEmp) {
    const emp = employees.get(empId);
    if (!emp) continue;
    list.sort((a, b) => a.work_date.localeCompare(b.work_date));
    const calcRows: CalcRecord[] = list.map((r) => ({
      work_date: r.work_date,
      start_time: hm(r.start_time),
      end_time: hm(r.end_time),
      break_minutes: r.break_minutes ?? 0,
      is_legal_holiday: !!r.is_legal_holiday,
      paid_leave_type: r.paid_leave_type,
      substitute_for_date: r.substitute_for_date,
    }));
    const daily = calcDailyListWithWeekly(calcRows, weekStartDay);
    list.forEach((r, i) => {
      if (!r.work_date.startsWith(yearMonth)) return;
      const d = daily[i];
      const note = r.paid_leave_type === "full" ? "有給"
        : r.paid_leave_type === "half" ? "半日有給"
        : r.substitute_for_date ? "振替休"
        : (r.note ?? "").trim();
      out.push({
        employee_number: emp.employee_number,
        employee_name: emp.name,
        day: Number(r.work_date.slice(8, 10)),
        work_note_1: note, work_note_2: "", work_note_3: "", work_note_4: "", work_note_5: "",
        start_time_1: d.work_minutes > 0 ? (hm(r.start_time) ?? "") : "",
        work_hours: formatHM(d.work_minutes),
        overtime_daily: "",
        overtime_weekly: "",
        commute_km: r.commute_km ?? null,
        business_km: r.business_km ?? null,
      });
    });
  }
  return out;
}
