"use client";

import useSWR from "swr";
import { supabase } from "@/lib/supabase";
import {
  extendedMonthRange,
  type AttendanceRecord,
} from "@/lib/payroll/attendance-calc";

/**
 * 居宅介護支援 出勤簿 row 取得 hook (SWR ベース)。
 *
 * 撤去の容易さ:
 *   - SWR は本ファイル内部のみ。撤去時は内部書換のみで呼び出し側不変。
 *
 * Cache key: `kyotaku-attendance:${employeeId}:${month}:${weekStart}`
 *   employeeId / month / weekStart のいずれかが変わると別 cache に。
 *   employeeId が空文字 or null の間は fetch 走らない。
 *
 * 月跨ぎ週の正しい週次残業計算のため、当月の前後の週に該当する隣接月の record も
 * 含めて取得する (= extendedMonthRange)。
 *   - currentMonthRows: 当月分の DB row (UI 入力欄に展開)
 *   - neighborRecords:  前月末 / 翌月頭 の隣接月分 (calc 用、UI 表示しない)
 *
 * Table 未 apply 時は error 握り潰し → 空 array fallback (旧挙動と互換)。
 */

// =====================================================================
// 型
// =====================================================================

/** DB row (payroll_kyotaku_attendance_records) */
export type AttendanceDbRow = {
  id?: string;
  tenant_id: string;
  office_id: string;
  employee_id: string;
  work_date: string;
  start_time: string | null;
  end_time: string | null;
  break_minutes: number;
  is_legal_holiday: boolean;
  is_paid_leave: boolean;
  paid_leave_type: "full" | "half" | null;
  note: string | null;
  business_km: number | string | null;
  substitute_for_date: string | null;
};

export type KyotakuAttendanceFetchResult = {
  /** 当月分の DB row (work_date 引きで使う) */
  currentMonthRows: AttendanceDbRow[];
  /** 前後隣接月分。calc lib にそのまま渡す形式に変換済 (UI 表示しない) */
  neighborRecords: AttendanceRecord[];
  /**
   * どこから読んだか。
   *   screen = この画面の table (payroll_kyotaku_attendance_records)
   *   excel  = Excel 出勤簿の CSV 取込 (payroll_attendance_records) ← ★ この画面からは編集できない
   */
  source: "screen" | "excel";
};

// =====================================================================
// 内部 helper
// =====================================================================

function toUiTime(s: string | null): string {
  if (!s) return "";
  const m = /^(\d{1,2}):(\d{1,2})/.exec(s);
  if (!m) return "";
  return `${String(parseInt(m[1], 10)).padStart(2, "0")}:${String(parseInt(m[2], 10)).padStart(2, "0")}`;
}

// =====================================================================
// fetcher
// =====================================================================

/** "1:30" / "01:30" → 90 分。空や不正は 0 */
function breakToMinutes(s: string | null): number {
  const m = /^(\d{1,2}):(\d{1,2})/.exec(String(s ?? "").trim());
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 0;
}

/**
 * Excel 出勤簿の取込 (payroll_attendance_records) を この画面の row 形に直す。
 * ⚠ 読み取り専用。給与計算は事業所ごとに どちらの table を見るかが決まっており
 *   (payroll_app_settings visit_attendance_screen_offices)、ここに書き戻すと食い違う。
 * ⚠ 出退勤は 1 組目だけを使う。2 組目以降がある行は全 17,566 行中 1 行だけ (2026-09-21 実測)。
 */
async function fetchExcelAttendanceRows(
  employeeId: string,
  officeNumber: string,
  employeeNumber: string,
  y: number,
  m: number,
): Promise<AttendanceDbRow[]> {
  const { data, error } = await supabase
    .from("payroll_attendance_records")
    .select("year,month,day,start_time_1,end_time_1,break_time,holiday_work,business_km,substitute_date")
    .eq("office_number", officeNumber)
    .eq("employee_number", employeeNumber)
    .eq("year", y)
    .eq("month", m);
  if (error || !data) return [];
  return data.map((r) => ({
    tenant_id: "",
    office_id: "",
    employee_id: employeeId,
    work_date: `${r.year}-${String(r.month).padStart(2, "0")}-${String(r.day).padStart(2, "0")}`,
    start_time: toUiTime(r.start_time_1 as string | null) || null,
    end_time: toUiTime(r.end_time_1 as string | null) || null,
    break_minutes: breakToMinutes(r.break_time as string | null),
    is_legal_holiday: !!r.holiday_work,
    is_paid_leave: false,
    paid_leave_type: null,
    note: null,
    business_km: (r.business_km as number | null) ?? null,
    substitute_for_date: (r.substitute_date as string | null) || null,
  }));
}

async function fetchKyotakuAttendanceRows(
  employeeId: string,
  month: string,
  weekStart: number,
  officeNumber?: string,
  employeeNumber?: string,
): Promise<KyotakuAttendanceFetchResult> {
  const { start: extStart, end: extEnd } = extendedMonthRange(month, weekStart);
  // 月の範囲も計算 (extendedMonthRange が空文字を返した場合の保険)
  const [yStr, mStr] = month.split("-");
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  if (!Number.isFinite(y) || !Number.isFinite(m)) {
    return { currentMonthRows: [], neighborRecords: [], source: "screen" };
  }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthStart = `${y}-${String(m).padStart(2, "0")}-01`;
  const monthEnd = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  const { data, error } = await supabase
    .from("payroll_kyotaku_attendance_records")
    .select("*")
    .eq("employee_id", employeeId)
    .gte("work_date", extStart || monthStart)
    .lte("work_date", extEnd || monthEnd);
  // 旧挙動と互換: table 未 apply 時は空 fallback (throw しない)
  if (error) {
    return { currentMonthRows: [], neighborRecords: [], source: "screen" };
  }
  const allRows = (data ?? []) as AttendanceDbRow[];

  const currentMonthRows: AttendanceDbRow[] = [];
  const neighborRecords: AttendanceRecord[] = [];
  for (const r of allRows) {
    if (r.work_date >= monthStart && r.work_date <= monthEnd) {
      currentMonthRows.push(r);
    } else {
      const paidLeaveType: "full" | "half" | null =
        r.paid_leave_type === "full" || r.paid_leave_type === "half"
          ? r.paid_leave_type
          : r.is_paid_leave
            ? "full"
            : null;
      neighborRecords.push({
        work_date: r.work_date,
        start_time: toUiTime(r.start_time) || null,
        end_time: toUiTime(r.end_time) || null,
        break_minutes: r.break_minutes ?? 0,
        is_legal_holiday: !!r.is_legal_holiday,
        paid_leave_type: paidLeaveType,
        substitute_for_date: r.substitute_for_date ?? null,
      });
    }
  }
  // この画面の table に 1 行も無いときだけ、Excel 取込のほうを読んで表示する。
  //   ⚠ 「データが無い」のではなく「別の table に入っている」ことが 画面から分からなかった
  //     (2026-09-21 user 指摘。中央 斉藤悠希弥 2026-07 は 31 日ぶん入っているのに空に見えた)
  if (currentMonthRows.length === 0 && officeNumber && employeeNumber) {
    const excel = await fetchExcelAttendanceRows(employeeId, officeNumber, employeeNumber, y, m);
    if (excel.length > 0) return { currentMonthRows: excel, neighborRecords, source: "excel" };
  }
  return { currentMonthRows, neighborRecords, source: "screen" };
}

// =====================================================================
// 公開 hook
// =====================================================================

export type UseKyotakuAttendanceRowsResult = {
  data: KyotakuAttendanceFetchResult | null;
  isLoading: boolean;
  error: Error | null;
  /** 強制再 fetch (保存・削除・CSV 取込後など) */
  mutate: () => void;
};

export function useKyotakuAttendanceRows(
  employeeId: string,
  month: string,
  weekStart: number,
  officeNumber?: string,
  employeeNumber?: string,
): UseKyotakuAttendanceRowsResult {
  const key = employeeId
    ? `kyotaku-attendance:${employeeId}:${month}:${weekStart}:${officeNumber ?? ""}:${employeeNumber ?? ""}`
    : null;
  const { data, error, isLoading, mutate } = useSWR<KyotakuAttendanceFetchResult>(
    key,
    () => fetchKyotakuAttendanceRows(employeeId, month, weekStart, officeNumber, employeeNumber),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: true,
      keepPreviousData: true,
    },
  );
  return {
    data: data ?? null,
    isLoading,
    error: error ?? null,
    mutate: () => {
      void mutate();
    },
  };
}
