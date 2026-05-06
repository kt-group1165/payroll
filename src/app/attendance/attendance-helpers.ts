// 共有 types + 純粋関数 (server / client どちらからも import 可)。
// "use client" を持たないので server から呼んでも bundle は client に含まれない。

export type AttendanceRecord = {
  id: string;
  employee_number: string;
  employee_name: string;
  office_number: string;
  day: number;
  day_of_week: string;
  work_note_1: string;
  work_note_2: string;
  work_note_3: string;
  work_note_4: string;
  work_note_5: string;
  start_time_1: string;
  end_time_1: string;
  start_time_2: string;
  end_time_2: string;
  break_time: string;
  work_hours: string;
  commute_km: number | null;
  business_km: number | null;
  overtime_weekly: string;
  overtime_daily: string;
  holiday_work: string;
  legal_overtime: string;
  deduction: string;
  remarks: string;
};

export type Employee = {
  employee_number: string;
  name: string;
  role_type: string;
  salary_type: string;
};

export type Office = {
  office_number: string;
  name: string;
  work_week_start: number;  // 0=日, 1=月, ..., 6=土
};

export type LaborStats = {
  totalWorkMin: number;
  workDays: number;
  dailyOvertimeMin: number;
  weeklyOvertimeMin: number;
  legalHolidayMin: number;
  paidLeave: number;
  specialLeave: number;
  absence: number;
  businessKm: number;
};

export type EmployeeSummary = {
  employee_number: string;
  employee_name: string;
  role_type: string;
  salary_type: string;
  records: AttendanceRecord[];
  stats: LaborStats;
};

export type MonthOption = { year: number; month: number };

export function parseTimeToMinutes(s: string): number {
  if (!s || !s.trim()) return 0;
  s = s.trim();
  if (s.includes(":")) {
    const [h, m] = s.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : Math.round(n * 60);
}

export function formatMinutes(min: number): string {
  if (min === 0) return "0:00";
  const h = Math.floor(min / 60), m = min % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

export function hasNote(rec: AttendanceRecord, keyword: string): boolean {
  return [rec.work_note_1, rec.work_note_2, rec.work_note_3, rec.work_note_4, rec.work_note_5]
    .some((n) => n && n.includes(keyword));
}

export function noteLabel(rec: AttendanceRecord): string {
  return [rec.work_note_1, rec.work_note_2, rec.work_note_3, rec.work_note_4, rec.work_note_5]
    .filter((n) => n && n.trim()).join(" / ");
}

export const DOW_COLOR: Record<string, string> = {
  土: "text-blue-600",
  日: "text-red-600",
  祝: "text-red-600",
};

export const WEEK_DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

/**
 * 労働時間統計を計算する
 */
export function computeLaborStats(
  records: AttendanceRecord[],
  year: number,
  month: number,
  weekStart: number
): LaborStats {
  const daysInMonth = new Date(year, month, 0).getDate();

  const totalWorkMin = records.reduce((s, r) => s + parseTimeToMinutes(r.work_hours), 0);
  const workDays     = records.filter(r => parseTimeToMinutes(r.work_hours) > 0).length;

  let dailyOvertimeMin = 0;
  for (const r of records) {
    dailyOvertimeMin += Math.max(0, parseTimeToMinutes(r.work_hours) - 480);
  }

  const weekMap = new Map<number, AttendanceRecord[]>();
  for (const r of records) {
    const dow = new Date(year, month - 1, r.day).getDay();
    const daysBack = (dow - weekStart + 7) % 7;
    const wStartDay = r.day - daysBack;
    if (!weekMap.has(wStartDay)) weekMap.set(wStartDay, []);
    weekMap.get(wStartDay)!.push(r);
  }

  let weeklyOvertimeMin = 0;
  let legalHolidayMin   = 0;

  for (const [wStartDay, weekRecs] of weekMap) {
    const wEndDay = wStartDay + 6;

    const cappedSum = weekRecs.reduce((s, r) => {
      return s + Math.min(parseTimeToMinutes(r.work_hours), 480);
    }, 0);
    if (cappedSum > 2400) {
      weeklyOvertimeMin += cappedSum - 2400;
    }

    let daysInWeekInMonth = 0;
    for (let d = wStartDay; d <= wEndDay; d++) {
      if (d >= 1 && d <= daysInMonth) daysInWeekInMonth++;
    }
    if (daysInWeekInMonth === 7) {
      const workedAll = weekRecs.filter(r => parseTimeToMinutes(r.work_hours) > 0).length === 7;
      if (workedAll) {
        const lastRec = weekRecs.find(r => r.day === wEndDay);
        if (lastRec) legalHolidayMin += parseTimeToMinutes(lastRec.work_hours);
      }
    }
  }

  let paidLeave = 0, specialLeave = 0, absence = 0, businessKm = 0;
  for (const r of records) {
    if (hasNote(r, "有")) paidLeave++;
    if (hasNote(r, "特休")) specialLeave++;
    if (hasNote(r, "欠")) absence++;
    businessKm += r.business_km ?? 0;
  }

  return { totalWorkMin, workDays, dailyOvertimeMin, weeklyOvertimeMin, legalHolidayMin, paidLeave, specialLeave, absence, businessKm };
}
