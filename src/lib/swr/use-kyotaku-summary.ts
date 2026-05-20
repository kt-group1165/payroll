"use client";

import useSWR from "swr";
import { supabase } from "@/lib/supabase";
import {
  calcDailyListWithWeekly,
  calcMonthlySummary,
  extendedMonthRange,
  type AttendanceRecord,
} from "@/lib/payroll/attendance-calc";
import {
  calcSalary,
  type CalcConfig,
  type EmployeeSetting,
  type KyotakuAttendanceRecord,
  type KyotakuRecord,
  type RegionalRate,
  type SalaryBreakdown,
  type ServiceUnit,
  type YobouRecord,
} from "@/lib/payroll/kyotaku-calc";
import {
  getActiveKyotakuSalary,
  type KyotakuSalary,
} from "@/lib/payroll/kyotaku-salary-history";

/**
 * 居宅介護支援 総括表 集計データ取得 hook (SWR ベース)。
 *
 * 撤去の容易さ:
 *   - 本ファイルが SWR を使う唯一の場所。
 *   - 撤去するときは本ファイル内部を `useState + useEffect` に書き換えるだけで
 *     呼び出し側 (KyotakuSummarySection) は変更不要。
 *
 * Cache key: `kyotaku-summary:${officeId}:${month}:${weekStart}`
 *   officeId / month / weekStart が変わると別 cache に。
 *   officeId が null の間は fetch 走らない。
 */

// =====================================================================
// 型 (component と共有するため export)
// =====================================================================

export type SummaryRow = {
  employee_id: string;
  employee_number: string;
  name: string;
  role_type: string;
  // 出勤簿集計
  workDays: number;
  workMin: number;
  dailyOvertimeMin: number;
  weeklyOvertimeMin: number;
  midnightMin: number;
  holidayWorkMin: number;
  absenceMin: number;
  paidLeaveDays: number;
  businessKmTotal: number;
  // 給与
  honnin: number;
  shokuno: number;
  kotei_zangyo: number;
  shikaku: number;
  kotei: number;
  tokutei: number;
  plan: number;
  kazan: number;
  chosei1: number;
  chosei2: number;
  business_trip_teate: number;
  total: number;
  breakdown: SalaryBreakdown;
};

type EmployeeRow = {
  id: string;
  employee_number: string | null;
  name: string;
  role_type: string | null;
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
  business_km: number | string | null;
  substitute_for_date: string | null;
};

// =====================================================================
// 内部 helper
// =====================================================================

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
// fetcher (SWR から呼ばれる)
// =====================================================================

async function fetchKyotakuSummary(
  officeId: string,
  month: string,
  weekStart: number,
): Promise<SummaryRow[]> {
  // 1a) office_number + travel_unit_price
  const officeRes = await supabase
    .from("payroll_offices")
    .select("office_number, travel_unit_price")
    .eq("id", officeId)
    .single();
  if (officeRes.error) throw officeRes.error;
  const officeNumber =
    (officeRes.data as { office_number?: string | null } | null)?.office_number ?? "";
  const travelRate = (() => {
    const v = (officeRes.data as { travel_unit_price?: number | string | null } | null)
      ?.travel_unit_price;
    if (v === null || v === undefined) return 0;
    const n = typeof v === "string" ? parseFloat(v) : v;
    return Number.isFinite(n) ? n : 0;
  })();

  // 1b) 並列 fetch
  //   居宅ケアマネ給与設定は payroll_employees.kyotaku_* (旧) から
  //   payroll_kyotaku_salary (履歴 table) に移行済。対象月の active row を
  //   getActiveKyotakuSalary(rows, employee_id, monthStart) で解決する。
  const [empRes, recRes, unitRes, rateRes, yobouRes, salaryRes] =
    await Promise.all([
      supabase
        .from("payroll_employees")
        .select("id, employee_number, name, role_type")
        .eq("office_id", officeId)
        .order("name"),
      supabase
        .from("payroll_kyotaku_records")
        .select("*")
        .eq("office_number", officeNumber)
        .limit(10000),
      supabase.from("payroll_kyotaku_service_units").select("*"),
      supabase.from("payroll_kyotaku_regional_rates").select("*"),
      supabase
        .from("payroll_kyotaku_yobou_records")
        .select("*")
        .eq("office_number", officeNumber),
      // 対象 office の employee の給与履歴を fetch。employee_id 絞り込みは employees
      // 取得後でないとできないので、ここでは全件取得 (件数 ~数千、limit(10000) で十分)。
      // DB 未 apply 段階は error 握り潰し → 空配列 fallback。
      supabase
        .from("payroll_kyotaku_salary")
        .select(
          "id, tenant_id, employee_id, effective_from, honnin_kyu, shokuno_kyu, kotei_zangyo, shikaku_teate, kotei, tokutei_shogu, kaigo_rate, shien_rate",
        )
        .limit(10000),
    ]);
  if (empRes.error) throw empRes.error;
  const employees = (empRes.data ?? []) as EmployeeRow[];
  if (employees.length === 0) return [];
  const empIds = employees.map((e) => e.id);
  const kyotakuSalaryRows: KyotakuSalary[] = salaryRes.error
    ? []
    : ((salaryRes.data ?? []) as unknown as KyotakuSalary[]);

  // 2) 出勤簿 (extended range)
  const { start: extStart, end: extEnd } = extendedMonthRange(month, weekStart);
  const { data: attData, error: attErr } = await supabase
    .from("payroll_kyotaku_attendance_records")
    .select(
      "employee_id, work_date, start_time, end_time, break_minutes, is_legal_holiday, paid_leave_type, is_paid_leave, business_km, substitute_for_date",
    )
    .in("employee_id", empIds)
    .gte("work_date", extStart)
    .lte("work_date", extEnd);
  if (attErr) throw attErr;
  const attRows = (attData ?? []) as AttendanceDbRow[];

  // 3) employee_id → 出勤 record list
  const byEmp = new Map<string, AttendanceDbRow[]>();
  for (const r of attRows) {
    if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, []);
    byEmp.get(r.employee_id)!.push(r);
  }

  // 4) calcSalary 用 config
  //    対象月 (`${month}-01`) で active な salary row を解決して EmployeeSetting に
  //    焼き込む (履歴 table 対応)。active row なし → null fallback (resolveSetting の
  //    DEFAULT_BASE_SALARY=250000 へ)。
  const serviceMonth = `${month}-01`;
  const settings: EmployeeSetting[] = employees.map((e) => {
    const active = getActiveKyotakuSalary(kyotakuSalaryRows, e.id, serviceMonth);
    return {
      staff_name: e.name,
      honnin_kyu: active ? active.honnin_kyu : null,
      shokuno_kyu: active ? active.shokuno_kyu : null,
      kotei_zangyo: active ? active.kotei_zangyo : null,
      shikaku_teate: active ? active.shikaku_teate : null,
      kotei: active ? active.kotei : null,
      tokutei_shogu: active ? active.tokutei_shogu : null,
      kaigo_rate: active ? active.kaigo_rate : null,
      shien_rate: active ? active.shien_rate : null,
    };
  });
  const allKyotakuRecords = (recRes.data ?? []) as KyotakuRecord[];
  const allYobou = (yobouRes.error ? [] : (yobouRes.data ?? [])) as YobouRecord[];
  const attendanceForCalc: KyotakuAttendanceRecord[] = [];
  for (const ar of attRows) {
    const emp = employees.find((e) => e.id === ar.employee_id);
    if (!emp) continue;
    const km = typeof ar.business_km === "string" ? parseFloat(ar.business_km) : ar.business_km;
    if (km === null || km === undefined || !Number.isFinite(km) || km <= 0) continue;
    attendanceForCalc.push({
      staff_name: emp.name,
      work_date: ar.work_date,
      business_km: km,
    });
  }
  const calcConfig: CalcConfig = {
    settings,
    units: (unitRes.data ?? []) as ServiceUnit[],
    rates: (rateRes.data ?? []) as RegionalRate[],
    yobouRecords: allYobou,
    attendanceRecords: attendanceForCalc,
    officeTravelUnitPrice: travelRate,
  };

  // 5) 各 employee で集計
  return employees.map((emp) => {
    const empAttRows = byEmp.get(emp.id) ?? [];
    const records = empAttRows.map(dbToAttendanceRecord);
    const dailies = calcDailyListWithWeekly(records, weekStart);
    const summary = calcMonthlySummary(records, weekStart, month);
    const workDays = dailies.filter(
      (d) => d.work_minutes > 0 && d.work_date.startsWith(month),
    ).length;
    let businessKmTotal = 0;
    for (const r of empAttRows) {
      if (!r.work_date.startsWith(month)) continue;
      const km = r.business_km;
      if (km === null || km === undefined || km === "") continue;
      const n = typeof km === "string" ? parseFloat(km) : km;
      if (Number.isFinite(n) && n > 0) businessKmTotal += n;
    }
    businessKmTotal = Math.round(businessKmTotal * 10) / 10;

    const breakdown = calcSalary(allKyotakuRecords, emp.name, serviceMonth, calcConfig);

    return {
      employee_id: emp.id,
      employee_number: emp.employee_number ?? "",
      name: emp.name,
      role_type: emp.role_type ?? "",
      workDays,
      workMin: summary.total_work,
      dailyOvertimeMin: summary.total_daily_overtime,
      weeklyOvertimeMin: summary.total_weekly_overtime,
      midnightMin: summary.total_midnight,
      holidayWorkMin: summary.total_holiday,
      absenceMin: summary.total_absence,
      paidLeaveDays: summary.total_paid_leave_days,
      businessKmTotal,
      honnin: breakdown.honnin,
      shokuno: breakdown.shokuno,
      kotei_zangyo: breakdown.kotei_zangyo,
      shikaku: breakdown.shikaku,
      kotei: breakdown.kotei,
      tokutei: breakdown.tokutei,
      plan: breakdown.plan,
      kazan: breakdown.kazan,
      chosei1: breakdown.chosei1,
      chosei2: breakdown.chosei2,
      business_trip_teate: breakdown.business_trip_teate,
      total: breakdown.total,
      breakdown,
    };
  });
}

// =====================================================================
// 公開 hook
// =====================================================================

export type UseKyotakuSummaryResult = {
  rows: SummaryRow[];
  isLoading: boolean;
  error: Error | null;
  /** 強制再 fetch (保存後など) */
  mutate: () => void;
};

export function useKyotakuSummary(
  officeId: string,
  month: string,
  weekStart: number,
): UseKyotakuSummaryResult {
  const key = officeId ? `kyotaku-summary:${officeId}:${month}:${weekStart}` : null;
  const { data, error, isLoading, mutate } = useSWR<SummaryRow[]>(
    key,
    () => fetchKyotakuSummary(officeId, month, weekStart),
    {
      // 一度取得した cache を維持しつつ、focus/再 mount で background revalidate
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
