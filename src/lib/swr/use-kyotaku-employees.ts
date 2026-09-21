"use client";

import useSWR from "swr";
import { supabase } from "@/lib/supabase";

/**
 * 選択 office に紐づく出勤簿対象職員 一覧 hook
 * (kaigo-app の出勤簿と同じ。2026-09-18 に給与計算システムにも入れた)。
 *
 * 訪問介護は「出勤簿を作る人と作らない人がいる」前提 (2026-07-29 user 確定) なので、
 * attendance_hidden = true (対象外) を除外する。対象/対象外の切替は出勤簿画面の
 * 「対象者設定」で行う。退職者も除外。
 *
 * Cache key: `attendance-employees:${officeId}` / officeId が空なら fetch しない。
 */

export type KyotakuEmployeeRow = {
  id: string;
  name: string;
  /** Excel 取込の出勤簿 (payroll_attendance_records) を引くのに要る (2026-09-21) */
  employee_number: string;
  office_id: string;
  role_type?: string | null;
  is_office_worker?: boolean | null;
};

/** 対象者設定 UI 用 (attendance_hidden 込み) */
export type AttendanceTargetRow = {
  id: string;
  name: string;
  attendance_hidden: boolean;
};

async function fetchEmployees(officeId: string): Promise<KyotakuEmployeeRow[]> {
  // attendance_hidden は後付け列 (migration 未適用でも動くよう select("*") + JS filter)
  const { data, error } = await supabase
    .from("payroll_employees")
    .select("*")
    .eq("office_id", officeId)
    .neq("employment_status", "退職者")
    .order("name");
  if (error) throw error;
  return ((data ?? []) as (KyotakuEmployeeRow & { attendance_hidden?: boolean })[])
    .filter((e) => e.attendance_hidden !== true)
    .map((e) => ({ id: e.id, name: e.name, employee_number: String(e.employee_number ?? ""), office_id: e.office_id, role_type: e.role_type ?? null, is_office_worker: e.is_office_worker ?? null }));
}

export type UseKyotakuEmployeesResult = {
  employees: KyotakuEmployeeRow[];
  isLoading: boolean;
  error: Error | null;
  mutate: () => void;
};

// 参照安定化用 (毎 render 新 [] を返すと consumer の effect/memo が毎回発火する)
const EMPTY_EMPLOYEES: KyotakuEmployeeRow[] = [];

export function useKyotakuEmployees(officeId: string): UseKyotakuEmployeesResult {
  const key = officeId ? `attendance-employees:${officeId}` : null;
  const { data, error, isLoading, mutate } = useSWR<KyotakuEmployeeRow[]>(
    key,
    () => fetchEmployees(officeId),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: true,
      keepPreviousData: true,
    },
  );
  return {
    employees: data ?? EMPTY_EMPLOYEES,
    isLoading,
    error: error ?? null,
    mutate: () => {
      void mutate();
    },
  };
}

/** 対象者設定 dialog 用: 退職者以外の全員 (対象外も含む) */
export async function fetchAttendanceTargets(officeId: string): Promise<AttendanceTargetRow[]> {
  const { data, error } = await supabase
    .from("payroll_employees")
    .select("*")
    .eq("office_id", officeId)
    .neq("employment_status", "退職者")
    .order("name");
  if (error) throw new Error(`職員の取得に失敗: ${error.message}`);
  return ((data ?? []) as (AttendanceTargetRow & { attendance_hidden?: boolean })[]).map(
    (e) => ({ id: e.id, name: e.name, attendance_hidden: e.attendance_hidden === true }),
  );
}

/** 対象/対象外の切替 (attendance_hidden 反転) */
export async function setAttendanceTarget(employeeId: string, hidden: boolean): Promise<void> {
  const { error } = await supabase
    .from("payroll_employees")
    .update({ attendance_hidden: hidden })
    .eq("id", employeeId);
  if (error) {
    if (error.code === "42703") {
      throw new Error(
        "非表示フラグの列が未適用です (payroll_employees_attendance_hidden.sql)。",
      );
    }
    throw new Error(`変更に失敗: ${error.message}`);
  }
}
