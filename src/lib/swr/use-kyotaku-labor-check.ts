"use client";

import useSWR from "swr";
import { supabase } from "@/lib/supabase";
import {
  calcMonthlySummary,
  extendedMonthRange,
  type AttendanceRecord,
} from "@/lib/payroll/attendance-calc";

/**
 * 居宅介護支援 労働時間チェック用データ取得 hook (SWR ベース)。
 *
 * 指定された 1 ヶ月について、全 居宅介護支援 office × 全職員 の出勤簿を集計し、
 * 「週40h 不足 (= 欠勤あり)」「日次残業あり」「週次残業あり」のいずれかが
 * 発生している職員だけを行として返す。
 *
 * Cache key: `kyotaku-labor-check:{month}`
 *   month は YYYY-MM。
 *
 * 撤去容易性: SWR を使うのは本ファイルだけ。撤去時は内部を useEffect+useState に
 * 書き換えるだけで、呼び出し側 component は無変更。
 */

// =====================================================================
// 型 (export して page で使う)
// =====================================================================

export type LaborCheckRow = {
  office_id: string;
  office_short_name: string;
  office_number: string;
  employee_id: string;
  employee_name: string;
  workMin: number;
  dailyOvertimeMin: number;
  weeklyOvertimeMin: number;
  absenceMin: number;
  /** 警告フラグ (少なくとも 1 つ true なら一覧に乗る) */
  hasDailyOvertime: boolean;
  hasWeeklyOvertime: boolean;
  hasAbsence: boolean;
};

type OfficeRow = {
  id: string;
  office_number: string;
  short_name: string | null;
  work_week_start: number | null;
};

type EmployeeRow = {
  id: string;
  name: string;
  office_id: string;
};

type AttendanceDbRow = {
  employee_id: string;
  work_date: string;
  start_time: string | null;
  end_time: string | null;
  break_minutes: number;
  is_legal_holiday: boolean;
  paid_leave_type: "full" | "half" | null;
  is_paid_leave?: boolean | null;
  substitute_for_date: string | null;
};

function toUiTime(s: string | null): string | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{1,2})/.exec(s);
  if (!m) return null;
  return `${String(parseInt(m[1], 10)).padStart(2, "0")}:${String(parseInt(m[2], 10)).padStart(2, "0")}`;
}

function dbToAttendanceRecord(r: AttendanceDbRow): AttendanceRecord {
  const paidLeaveType: "full" | "half" | null =
    r.paid_leave_type === "full" || r.paid_leave_type === "half"
      ? r.paid_leave_type
      : r.is_paid_leave
        ? "full"
        : null;
  return {
    work_date: r.work_date,
    start_time: toUiTime(r.start_time),
    end_time: toUiTime(r.end_time),
    break_minutes: r.break_minutes ?? 0,
    is_legal_holiday: !!r.is_legal_holiday,
    paid_leave_type: paidLeaveType,
    substitute_for_date: r.substitute_for_date ?? null,
  };
}

// =====================================================================
// fetcher
// =====================================================================

async function fetchLaborCheck(month: string): Promise<LaborCheckRow[]> {
  // 1) 居宅介護支援 offices 全件
  const { data: officeData, error: officeErr } = await supabase
    .from("payroll_offices")
    .select("id, office_number, short_name, office_type, work_week_start")
    .eq("office_type", "居宅介護支援");
  if (officeErr) throw officeErr;
  const offices = (officeData ?? []) as OfficeRow[];
  if (offices.length === 0) return [];
  const officeIds = offices.map((o) => o.id);
  const officeById = new Map(offices.map((o) => [o.id, o]));

  // 2) 居宅介護支援 office の全 employee
  const { data: empData, error: empErr } = await supabase
    .from("payroll_employees")
    .select("id, name, office_id")
    .in("office_id", officeIds);
  if (empErr) throw empErr;
  const employees = (empData ?? []) as EmployeeRow[];
  if (employees.length === 0) return [];
  const empIds = employees.map((e) => e.id);

  // 3) 当月 (extended range for 月跨ぎ週) の出勤簿 record を全 employee 分まとめて fetch
  //    各 office で work_week_start が異なる可能性があるので、最大 9 日前/後の余裕で fetch
  //    (週起算 0-6 のいずれでも余裕で含まれる範囲)
  const fallbackRange = extendedMonthRange(month, 0);
  const { data: attData, error: attErr } = await supabase
    .from("payroll_kyotaku_attendance_records")
    .select(
      "employee_id, work_date, start_time, end_time, break_minutes, is_legal_holiday, paid_leave_type, is_paid_leave, substitute_for_date",
    )
    .in("employee_id", empIds)
    .gte("work_date", fallbackRange.start)
    .lte("work_date", fallbackRange.end);
  if (attErr) throw attErr;
  const attRows = (attData ?? []) as AttendanceDbRow[];

  // 4) employee_id 単位で出勤 record をグルーピング
  const byEmp = new Map<string, AttendanceDbRow[]>();
  for (const r of attRows) {
    if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, []);
    byEmp.get(r.employee_id)!.push(r);
  }

  // 5) 各 employee で月集計 → 警告条件に合致するものだけ収集
  const result: LaborCheckRow[] = [];
  for (const emp of employees) {
    const empRows = byEmp.get(emp.id) ?? [];
    if (empRows.length === 0) continue; // 出勤記録 0 件はチェック対象外
    const office = officeById.get(emp.office_id);
    if (!office) continue;
    const weekStart = office.work_week_start ?? 0;
    const records = empRows.map(dbToAttendanceRecord);
    const sum = calcMonthlySummary(records, weekStart, month);

    const hasDailyOvertime = sum.total_daily_overtime > 0;
    const hasWeeklyOvertime = sum.total_weekly_overtime > 0;
    const hasAbsence = sum.total_absence > 0;

    if (!hasDailyOvertime && !hasWeeklyOvertime && !hasAbsence) continue;

    result.push({
      office_id: office.id,
      office_short_name: office.short_name ?? office.office_number,
      office_number: office.office_number,
      employee_id: emp.id,
      employee_name: emp.name,
      workMin: sum.total_work,
      dailyOvertimeMin: sum.total_daily_overtime,
      weeklyOvertimeMin: sum.total_weekly_overtime,
      absenceMin: sum.total_absence,
      hasDailyOvertime,
      hasWeeklyOvertime,
      hasAbsence,
    });
  }

  // 6) office_number ASC → employee_name ASC でソート
  result.sort((a, b) => {
    if (a.office_number !== b.office_number)
      return a.office_number.localeCompare(b.office_number);
    return a.employee_name.localeCompare(b.employee_name);
  });
  return result;
}

// =====================================================================
// 公開 hook
// =====================================================================

export type UseKyotakuLaborCheckResult = {
  rows: LaborCheckRow[];
  isLoading: boolean;
  error: Error | null;
  mutate: () => void;
};

export function useKyotakuLaborCheck(month: string): UseKyotakuLaborCheckResult {
  const key = `kyotaku-labor-check:${month}`;
  const { data, error, isLoading, mutate } = useSWR<LaborCheckRow[]>(
    key,
    () => fetchLaborCheck(month),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: true,
      keepPreviousData: true,
    },
  );
  return {
    rows: data ?? [],
    isLoading,
    error: error ?? null,
    mutate: () => {
      void mutate();
    },
  };
}
