"use client";

import useSWR from "swr";
import { supabase } from "@/lib/supabase";
import {
  calcMonthlySummary,
  extendedMonthRange,
  type AttendanceRecord,
} from "@/lib/payroll/attendance-calc";
import {
  calcOvertimePayBreakdown,
  type OvertimeSettingForCalc,
  type SalarySettingsForOvertime,
} from "@/lib/payroll/overtime-pay-calc";
import {
  getActiveKyotakuSalary,
  type KyotakuSalary,
} from "@/lib/payroll/kyotaku-salary-history";

/**
 * 居宅介護支援 労働時間チェック用データ取得 hook (SWR ベース)。
 *
 * 全 居宅介護支援 office × 全職員 × 全月 の出勤簿を集計し、
 * 「欠勤あり (週40h 確保できず) 」「固定残業代 超過」 のいずれかが
 * 発生している (employee × month) 行だけを返す。
 *
 * Cache key: `kyotaku-labor-check:all`
 *
 * 撤去容易性: SWR を使うのは本ファイルだけ。撤去時は内部を useEffect+useState に
 * 書き換えるだけで、呼び出し側 component は無変更。
 */

// =====================================================================
// 型 (export して page で使う)
// =====================================================================

export type LaborCheckRow = {
  /** 対象月 YYYY-MM */
  month: string;
  office_id: string;
  office_short_name: string;
  office_number: string;
  employee_id: string;
  employee_name: string;
  workMin: number;
  absenceMin: number;
  /** 残業 (日次 + 週次) 分 */
  overtimeMin: number;
  /** 残業代 (1.25 倍、円) */
  overtimePay: number;
  /** 深夜分 */
  midnightMin: number;
  /** 深夜割増 (0.25 倍のみ、円) */
  midnightPay: number;
  /** 法休分 */
  holidayMin: number;
  /** 法休割増 (0.35 倍のみ、円) */
  holidayPay: number;
  /** 実残業代の合計 (= overtimePay + midnightPay + holidayPay) */
  totalOvertimePay: number;
  /** 固定残業代 (kyotaku_kotei_zangyo) */
  fixedOvertimePay: number;
  /** 超過支給額 (= max(0, totalOvertimePay - fixedOvertimePay)) */
  exceedAmount: number;
  hasAbsence: boolean;
  /** 実残業代 > 固定残業代 (固定 0 のときは false) */
  hasFixedOvertimeExceeded: boolean;
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

async function fetchLaborCheck(): Promise<LaborCheckRow[]> {
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

  // 2) 居宅介護支援 office の全 employee (identity のみ)。
  //    固定残業代の判定は payroll_salary_settings ではなく
  //    payroll_kyotaku_salary (= 居宅ケアマネ給与設定の履歴 table) を使う。
  //    対象月の active row を getActiveKyotakuSalary(rows, employee_id, month) で解決。
  const { data: empData, error: empErr } = await supabase
    .from("payroll_employees")
    .select("id, name, office_id")
    .in("office_id", officeIds);
  if (empErr) throw empErr;
  const employees = (empData ?? []) as EmployeeRow[];
  if (employees.length === 0) return [];
  const empIds = employees.map((e) => e.id);

  // 2b) 居宅ケアマネ給与履歴 (= 月別 active row 解決用)。
  //     DB 未 apply 段階は error 握り潰し → 空配列 fallback (= 旧 NULL 互換挙動)。
  const { data: salaryData, error: salaryErr } = await supabase
    .from("payroll_kyotaku_salary")
    .select(
      "id, tenant_id, employee_id, effective_from, honnin_kyu, shokuno_kyu, kotei_zangyo, shikaku_teate, kotei, tokutei_shogu, kaigo_rate, shien_rate",
    )
    .in("employee_id", empIds)
    .limit(10000);
  const kyotakuSalaryRows: KyotakuSalary[] = salaryErr
    ? []
    : ((salaryData ?? []) as unknown as KyotakuSalary[]);

  // 3) 全期間の出勤簿 record を fetch (1000 行制限を回避するため pagination)
  //    select() の default limit 1000 を超える可能性があるので明示的に大きく取る。
  const { data: attData, error: attErr } = await supabase
    .from("payroll_kyotaku_attendance_records")
    .select(
      "employee_id, work_date, start_time, end_time, break_minutes, is_legal_holiday, paid_leave_type, is_paid_leave, substitute_for_date",
    )
    .in("employee_id", empIds)
    .limit(100000);
  if (attErr) throw attErr;
  const attRows = (attData ?? []) as AttendanceDbRow[];

  // 4) employee_id + 月 でグルーピング (YYYY-MM)
  const byEmpMonth = new Map<string, Map<string, AttendanceDbRow[]>>();
  // 出現する全 month 集合
  const monthsByEmp = new Map<string, Set<string>>();
  for (const r of attRows) {
    const ym = r.work_date.slice(0, 7); // YYYY-MM
    if (!byEmpMonth.has(r.employee_id)) byEmpMonth.set(r.employee_id, new Map());
    const monthMap = byEmpMonth.get(r.employee_id)!;
    if (!monthMap.has(ym)) monthMap.set(ym, []);
    monthMap.get(ym)!.push(r);
    if (!monthsByEmp.has(r.employee_id)) monthsByEmp.set(r.employee_id, new Set());
    monthsByEmp.get(r.employee_id)!.add(ym);
  }

  // 月跨ぎ週の正確計算のため、各月集計時には隣接月分も必要。
  // ここでは extendedMonthRange で当月 ± 9 日の record を抽出して計算に渡す。
  function recordsForMonth(empId: string, ym: string): AttendanceDbRow[] {
    const range = extendedMonthRange(ym, 0);
    const empAll = byEmpMonth.get(empId);
    if (!empAll) return [];
    const out: AttendanceDbRow[] = [];
    // empAll は month 単位で持っているので、隣接 3 ヶ月分 (前/当/後) を結合
    for (const [, list] of empAll) {
      for (const r of list) {
        if (r.work_date >= range.start && r.work_date <= range.end) out.push(r);
      }
    }
    return out;
  }

  // 4b) 居宅ケアマネ用 salary を payroll_kyotaku_salary (履歴) から月別に解決し
  //     SalarySettingsForOvertime 形に mapping。
  //     overtime_settings.include_base_personal_salary / include_skill_salary だけ true なので、
  //     base = honnin_kyu + shokuno_kyu になる。固定残業代は kotei_zangyo。
  //     他の手当 (qualification/tenure/specific) は include 設定次第。
  //
  //     対象月 ym (YYYY-MM) → ${ym}-01 で getActiveKyotakuSalary に渡す。
  //     active row なし (履歴 0 件 or 未来 effective_from) は全 0 fallback。
  function kyotakuToSalarySettings(
    employeeId: string,
    ym: string,
  ): SalarySettingsForOvertime {
    const active = getActiveKyotakuSalary(
      kyotakuSalaryRows,
      employeeId,
      `${ym}-01`,
    );
    return {
      base_personal_salary: active?.honnin_kyu ?? 0,
      skill_salary: active?.shokuno_kyu ?? 0,
      position_allowance: 0,
      qualification_allowance: active?.shikaku_teate ?? 0,
      tenure_allowance: active?.kotei ?? 0,
      treatment_improvement: 0,
      specific_treatment_improvement: active?.tokutei_shogu ?? 0,
      treatment_subsidy: 0,
      fixed_overtime_pay: active?.kotei_zangyo ?? 0,
      special_bonus: 0,
    };
  }

  // 4c) overtime_settings (job_type='居宅介護支援') を 1 件取得
  const { data: otData } = await supabase
    .from("payroll_overtime_settings")
    .select(
      "job_type, scheduled_hours_per_month, include_base_personal_salary, include_skill_salary, include_position_allowance, include_qualification_allowance, include_tenure_allowance, include_treatment_improvement, include_specific_treatment, include_treatment_subsidy, include_fixed_overtime_pay, include_special_bonus",
    )
    .eq("job_type", "居宅介護支援")
    .maybeSingle();
  const otSetting = (otData ?? null) as OvertimeSettingForCalc | null;

  // 4d) 会社休日 (お盆 / 年末年始) を fetch
  //     祝日と同様に「所定労働日でない日」として absence 判定から除外する。
  //     渡さないと お盆出勤しなかった日が「欠勤」 として誤検知される。
  const { data: holidayData } = await supabase
    .from("payroll_company_holidays")
    .select("holiday_date")
    .eq("tenant_id", "kt-group");
  const companyHolidayDates = new Set<string>(
    (holidayData ?? []).map((r) => (r as { holiday_date: string }).holiday_date),
  );

  // 5) 各 employee × 各月 で集計 → 警告条件に合致するものだけ収集
  const result: LaborCheckRow[] = [];
  for (const emp of employees) {
    const monthSet = monthsByEmp.get(emp.id);
    if (!monthSet || monthSet.size === 0) continue;
    const office = officeById.get(emp.office_id);
    if (!office) continue;
    const weekStart = office.work_week_start ?? 0;

    for (const ym of monthSet) {
      const empRecords = recordsForMonth(emp.id, ym);
      if (empRecords.length === 0) continue;
      // 当月分が実際に存在するか (空 month は除く)
      const hasCurrentMonth = empRecords.some((r) => r.work_date.slice(0, 7) === ym);
      if (!hasCurrentMonth) continue;
      const records = empRecords.map(dbToAttendanceRecord);
      const sum = calcMonthlySummary(records, weekStart, ym, companyHolidayDates);

      // 対象月の active salary 履歴 row で固定残業代 等を解決
      const salary = kyotakuToSalarySettings(emp.id, ym);

      const hasAbsence = sum.total_absence > 0;
      const ot = calcOvertimePayBreakdown(sum, salary, otSetting);
      const hasFixedOvertimeExceeded = ot.isExceeding;

      if (!hasAbsence && !hasFixedOvertimeExceeded) continue;

      result.push({
        month: ym,
        office_id: office.id,
        office_short_name: office.short_name ?? office.office_number,
        office_number: office.office_number,
        employee_id: emp.id,
        employee_name: emp.name,
        workMin: sum.total_work,
        absenceMin: sum.total_absence,
        overtimeMin: sum.total_daily_overtime + sum.total_weekly_overtime,
        overtimePay: ot.regularOvertimePay,
        midnightMin: sum.total_midnight,
        midnightPay: ot.midnightExtraPay,
        holidayMin: sum.total_holiday,
        holidayPay: ot.holidayExtraPay,
        totalOvertimePay: ot.totalOvertimePay,
        fixedOvertimePay: ot.fixedOvertimePay,
        exceedAmount: ot.exceedAmount,
        hasAbsence,
        hasFixedOvertimeExceeded,
      });
    }
  }

  // 6) month DESC (新しい月先頭) → office_number ASC → employee_name ASC でソート
  result.sort((a, b) => {
    if (a.month !== b.month) return b.month.localeCompare(a.month);
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

export function useKyotakuLaborCheck(): UseKyotakuLaborCheckResult {
  const key = `kyotaku-labor-check:all`;
  const { data, error, isLoading, mutate } = useSWR<LaborCheckRow[]>(
    key,
    () => fetchLaborCheck(),
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
