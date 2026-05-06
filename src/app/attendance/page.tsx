import { createClient } from "@/lib/supabase/server";
import { OFFICE_MASTER_JOIN, flattenOfficeMaster } from "@/types/database";
import {
  type AttendanceRecord,
  type Employee,
  type EmployeeSummary,
  type MonthOption,
  computeLaborStats,
} from "./attendance-helpers";
import { AttendanceContent } from "./attendance-content";

type OfficeRow = { office_number: string; name: string; work_week_start: number };

/**
 * /attendance
 * 労働時間管理 (年月選択 + 月別出勤簿サマリ + 詳細展開)。
 *
 * Server Component: ?year=YYYY&month=MM の URL params を受けて、その月の
 * 出勤データ + 全 employees + offices を server-side で取得し、computeLaborStats を
 * server で実行して summaries を作成。AttendanceContent (client) には computed
 * data を props で渡す。月変更は client から router.push(`?year=Y&month=M`) で。
 *
 * year/month 未指定の場合は monthOptions から最新月を自動選択。
 */
export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; month?: string }>;
}) {
  const supabase = await createClient();
  const params = await searchParams;

  // 利用可能な月一覧
  const { data: rawMonths } = await supabase
    .from("payroll_attendance_records")
    .select("year,month");
  const seen = new Set<string>();
  const monthOptions: MonthOption[] = [];
  for (const r of (rawMonths ?? []) as { year: number; month: number }[]) {
    const key = `${r.year}-${r.month}`;
    if (!seen.has(key)) {
      seen.add(key);
      monthOptions.push({ year: r.year, month: r.month });
    }
  }
  monthOptions.sort((a, b) => (b.year !== a.year ? b.year - a.year : b.month - a.month));

  // 対象 year/month: URL params 優先、なければ最新
  let selectedYear = params.year ? parseInt(params.year, 10) : 0;
  let selectedMonth = params.month ? parseInt(params.month, 10) : 0;
  if ((!selectedYear || !selectedMonth) && monthOptions.length > 0) {
    selectedYear = monthOptions[0].year;
    selectedMonth = monthOptions[0].month;
  }

  let summaries: EmployeeSummary[] = [];
  let weekStart = 0;

  if (selectedYear && selectedMonth) {
    // employees (paginate)
    const allEmployees: Employee[] = [];
    let from = 0;
    while (true) {
      const { data } = await supabase
        .from("payroll_employees")
        .select("employee_number,name,role_type,salary_type")
        .range(from, from + 999);
      if (!data || data.length === 0) break;
      allEmployees.push(...(data as Employee[]));
      if (data.length < 1000) break;
      from += 1000;
    }

    const [attRes, offRes] = await Promise.all([
      supabase
        .from("payroll_attendance_records")
        .select("*")
        .eq("year", selectedYear)
        .eq("month", selectedMonth)
        .order("employee_number")
        .order("day"),
      supabase
        .from("payroll_offices")
        .select(`office_number, work_week_start, ${OFFICE_MASTER_JOIN}`),
    ]);

    const records = (attRes.data ?? []) as AttendanceRecord[];
    const empMap = new Map(allEmployees.map((e) => [e.employee_number, e]));
    const officeRows = (flattenOfficeMaster(offRes.data as never) as unknown as OfficeRow[]);
    const officeMap = new Map(officeRows.map((o) => [o.office_number, o]));

    const firstOfficeNum = records[0]?.office_number;
    weekStart = officeMap.get(firstOfficeNum ?? "")?.work_week_start ?? 0;

    const grouped = new Map<string, AttendanceRecord[]>();
    for (const r of records) {
      if (!grouped.has(r.employee_number)) grouped.set(r.employee_number, []);
      grouped.get(r.employee_number)!.push(r);
    }

    const result: EmployeeSummary[] = [];
    for (const [empNum, recs] of grouped) {
      const emp = empMap.get(empNum);
      const empOfficeNum = recs[0]?.office_number;
      const empWs = officeMap.get(empOfficeNum ?? "")?.work_week_start ?? 0;
      result.push({
        employee_number: empNum,
        employee_name: recs[0].employee_name,
        role_type: emp?.role_type ?? "",
        salary_type: emp?.salary_type ?? "",
        records: recs,
        stats: computeLaborStats(recs, selectedYear, selectedMonth, empWs),
      });
    }
    result.sort((a, b) => a.employee_number.localeCompare(b.employee_number));
    summaries = result;
  }

  return (
    <AttendanceContent
      monthOptions={monthOptions}
      selectedYear={selectedYear}
      selectedMonth={selectedMonth}
      summaries={summaries}
      weekStart={weekStart}
    />
  );
}
