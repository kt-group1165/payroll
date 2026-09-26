import type { AttendanceMeta, AttendanceRow } from "@/types/csv";
import { parseNumericCell } from "./numeric-cell";

/**
 * 出勤簿 1 日分 → payroll_attendance_records 1 行。
 *
 * 画面 (/csv-import の「出勤簿」) と scripts/import-attendance-xlsm.mts が同じ関数を使う
 * (逐語コピーだと片方だけ直したときに乖離するため)。
 */
export function attendanceRowToRecord(row: AttendanceRow, meta: AttendanceMeta, batchId: string) {
  return {
    import_batch_id: batchId,
    office_number: meta.officeNumber,
    employee_number: meta.employeeNumber,
    employee_name: meta.employeeName,
    year: meta.year,
    month: meta.month,
    day: parseInt(row.日付, 10),
    day_of_week: row.曜日,
    substitute_date: row.振替日,
    work_note_1: row.勤務摘要,
    work_note_2: row.勤務摘要2,
    work_note_3: row.勤務摘要3,
    work_note_4: row.勤務摘要4,
    work_note_5: row.勤務摘要5,
    start_time_1: row.開始,
    end_time_1: row.終了,
    start_time_2: row.開始2,
    end_time_2: row.終了2,
    start_time_3: row.開始3,
    end_time_3: row.終了3,
    start_time_4: row.開始4,
    end_time_4: row.終了4,
    start_time_5: row.開始5,
    end_time_5: row.終了5,
    break_time: row.休憩,
    work_hours: row.勤務時間,
    // ★ parseFloat("1,302") は 1 を返す。カンマ・全角を外してから読む (numeric-cell.ts)
    commute_km: parseNumericCell(row.通勤km) || null,
    business_km: parseNumericCell(row.出張km) || null,
    overtime_weekly: row.週残業 ?? "",
    overtime_daily: row.日残業 ?? "",
    holiday_work: row.休日 ?? "",
    legal_overtime: row.法内残業 ?? "",
    deduction: row.控除 ?? "",
    remarks: row.備考 ?? "",
  };
}
