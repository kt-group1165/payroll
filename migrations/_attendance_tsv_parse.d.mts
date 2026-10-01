/** `_attendance_tsv_parse.mjs` の型。★ .mts (検査) から import するために要る */
export type ScanAttendanceRow = {
  office_number: string; employee_number: string; year: number; month: number; day: number;
  day_of_week: string; start_time_1: string; end_time_1: string; break_time: string; work_hours: string;
  commute_km: number | null; remarks: string;
};
export type ScanAttendanceTotal = {
  office_number: string; employee_number: string; year: number; month: number;
  totalMinutes: number | null; workDays: number; file: string;
};
export declare const normEmpNo: (s: unknown) => string;
export declare const hmToMinutes: (s: unknown) => number | null;
export declare const groupKeyOf: (r: { office_number: string; employee_number: string; year: number; month: number }) => string;
export declare function parseAttendanceTsv(files: string[]): { rows: ScanAttendanceRow[]; totals: ScanAttendanceTotal[] };
export declare function groupByPersonMonth(rows: ScanAttendanceRow[]): Map<string, ScanAttendanceRow[]>;
