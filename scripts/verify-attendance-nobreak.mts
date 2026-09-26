// 出勤簿の「休憩が空で欄が 1 時間引いている日」の扱い (2026-09-26)
//
// 出勤簿 xlsm は 1 日目だけ勤務時間が空で出るので、取込が「休憩 0 なら 6 時間超で 1 時間引く」で埋める。
// ★ 休憩欄は 0:00 のまま保存されるため、計算側が「終了−開始−休憩」を正にした結果 +60 分が残業に化けていた。
// ★ 一律に引くと 欄も時刻も一致している 392 行 (171 人月) まで減るので、
//   「欄が ちょうど 時刻 − 60」のときだけ 欄を採る。
import { attendanceWorkMinutes, type OfficeAttendanceRecord } from "../src/lib/payroll/payroll-calc";

const rec = (o: Partial<OfficeAttendanceRecord>): OfficeAttendanceRecord => ({
  employee_number: "1", day: 1, work_note_1: "", work_note_2: "", work_note_3: "", work_note_4: "", work_note_5: "",
  start_time_1: "", work_hours: "", overtime_daily: "", ...o,
} as OfficeAttendanceRecord);

let ng = 0;
const t = (name: string, got: number, want: number) => {
  const ok = got === want; if (!ok) ng++;
  console.log(`  ${ok ? "PASS" : "★FAIL"}  ${name}  got=${got} want=${want}`);
};
console.log("=== attendanceWorkMinutes ===");
// ★ 直した形: 9:00-18:00 (540分)・休憩空・欄 8:00 (480分) → 欄を採る
t("休憩空・欄が時刻-60 → 欄 (熊谷明日香 2026-05 の型)",
  attendanceWorkMinutes(rec({ start_time_1: "9:00", end_time_1: "18:00", break_time: "", work_hours: "8:00" })), 480);
t("休憩0:00・欄が時刻-60 → 欄 (1日目の型)",
  attendanceWorkMinutes(rec({ start_time_1: "9:00", end_time_1: "18:00", break_time: "0:00", work_hours: "8:00" })), 480);
// ⚠ 巻き込まないこと: 欄も時刻も一致している 392 行 (171 人月)
t("休憩空・欄が時刻と同じ → ★減らさない (392行を巻き込まない)",
  attendanceWorkMinutes(rec({ start_time_1: "9:00", end_time_1: "18:00", break_time: "", work_hours: "9:00" })), 540);
t("休憩空・欄が時刻-30 → 減らさない (60分ちょうどでない)",
  attendanceWorkMinutes(rec({ start_time_1: "9:00", end_time_1: "18:00", break_time: "", work_hours: "8:30" })), 540);
t("休憩空・欄も空 → 時刻のまま",
  attendanceWorkMinutes(rec({ start_time_1: "9:00", end_time_1: "18:00", break_time: "", work_hours: "" })), 540);
// これまで通り動くべきもの
t("休憩1:00 がある → 引く",
  attendanceWorkMinutes(rec({ start_time_1: "9:00", end_time_1: "18:00", break_time: "1:00", work_hours: "8:00" })), 480);
t("時間帯が2つ → 休憩を引かない (間が休憩)",
  attendanceWorkMinutes(rec({ start_time_1: "9:00", end_time_1: "12:00", start_time_2: "13:00", end_time_2: "16:00", break_time: "1:00", work_hours: "6:00" })), 360);
t("時刻が無い → 欄をそのまま",
  attendanceWorkMinutes(rec({ break_time: "1:00", work_hours: "7:30" })), 450);
t("日をまたぐ (22:00-1:00) ・休憩空・欄が時刻-60",
  attendanceWorkMinutes(rec({ start_time_1: "22:00", end_time_1: "1:00", break_time: "", work_hours: "2:00" })), 120);
t("短い日 (9:00-12:00)・休憩空・欄が時刻と同じ → 減らさない",
  attendanceWorkMinutes(rec({ start_time_1: "9:00", end_time_1: "12:00", break_time: "", work_hours: "3:00" })), 180);
console.log(ng === 0 ? "\n✓ 全部 PASS" : `\n★ ${ng} 件 FAIL`);
process.exit(ng === 0 ? 0 : 1);
