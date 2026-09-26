import { createClient } from "@/lib/supabase/server";
import { fetchAllPagesParallel } from "@/lib/fetch-all";
import { OFFICE_MASTER_JOIN, flattenOfficeMaster } from "@/types/database";
import {
  type AttendanceRecord,
  type Employee,
  type EmployeeSummary,
  type MonthOption,
  computeLaborStats,
} from "./attendance-helpers";
import { AttendanceContent } from "./attendance-content";

type OfficeRow = { id: string; office_number: string; name: string; work_week_start: number };

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
 *
 * Perf: monthOptions は payroll_import_batches (attendance タイプ) から導出。
 * 旧: payroll_attendance_records 全件 paginate で year/month 抽出 (10+ round trips)
 * 新: import_batches 1 ショット (sub-500行)。/payroll, /distance と同じパターン。
 * 並列化: monthOptions + employees(count+並列) + offices を Promise.all で同時発火。
 */
export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; month?: string }>;
}) {
  const supabase = await createClient();
  const params = await searchParams;

  // 利用可能な月一覧: import_batches から (高速)
  // 同時に employees / offices も並列発火 (どの月を選ぶかに依存しないため)
  const [batchRes, allEmployees, offRes] = await Promise.all([
    supabase
      .from("payroll_import_batches")
      .select("processing_month")
      .eq("import_type", "attendance")
      .eq("status", "completed")
      .gt("record_count", 0),
    fetchAllPagesParallel<Employee>(
      () => supabase.from("payroll_employees").select("*", { count: "exact", head: true }),
      (from, to) =>
        supabase
          .from("payroll_employees")
          // ★ office_id も取る。職員番号だけで引くと 別人に当たる (2026-09-27 実測 14/121 組)
          .select("office_id,employee_number,name,role_type,salary_type")
          .order("id").range(from, to) as unknown as PromiseLike<{ data: Employee[] | null }>,
    ),
    supabase
      .from("payroll_offices")
      .select(`id, office_number, work_week_start, ${OFFICE_MASTER_JOIN}`),
  ]);

  const seen = new Set<string>();
  const monthOptions: MonthOption[] = [];
  for (const r of (batchRes.data ?? []) as { processing_month: string }[]) {
    if (!r.processing_month || r.processing_month.length < 6) continue;
    const year = parseInt(r.processing_month.slice(0, 4), 10);
    const month = parseInt(r.processing_month.slice(4, 6), 10);
    if (!year || !month) continue;
    const key = `${year}-${month}`;
    if (!seen.has(key)) {
      seen.add(key);
      monthOptions.push({ year, month });
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
    // attendance_records は (employees × 1ヶ月の日数) で 1000 行を超え得るため
    // count + Promise.all で並列取得
    const records = await fetchAllPagesParallel<AttendanceRecord>(
      () =>
        supabase
          .from("payroll_attendance_records")
          .select("*", { count: "exact", head: true })
          .eq("year", selectedYear)
          .eq("month", selectedMonth),
      (from, to) =>
        supabase
          .from("payroll_attendance_records")
          .select("*")
          .eq("year", selectedYear)
          .eq("month", selectedMonth)
          .order("employee_number")
          .order("day")
          .range(from, to) as unknown as PromiseLike<{ data: AttendanceRecord[] | null }>,
    );

    // ★ 職員番号は事業所をまたぐと重複するので (事業所番号, 職員番号) の対で引く。
    //   番号だけで引いていたため 121 組中 14 組 (11.6%) が別人の役職・給与形態を出していた (2026-09-27 実測)
    const officeNumOfId = new Map(
      (flattenOfficeMaster(offRes.data as never) as unknown as OfficeRow[]).map((o) => [o.id, o.office_number]),
    );
    const empMap = new Map(
      allEmployees.map((e) => [`${officeNumOfId.get((e as { office_id?: string }).office_id ?? "") ?? ""}|${e.employee_number}`, e]),
    );
    const officeRows = (flattenOfficeMaster(offRes.data as never) as unknown as OfficeRow[]);
    const officeMap = new Map(officeRows.map((o) => [o.office_number, o]));

    const firstOfficeNum = records[0]?.office_number;
    weekStart = officeMap.get(firstOfficeNum ?? "")?.work_week_start ?? 0;

    // ★ 束ねるのも (事業所番号, 職員番号) の対。番号だけだと 別の事業所の同じ番号の人が 1 行に混ざる。
    //   2026-09-27 時点では 混ざる組は 0 件だが (出勤簿があるのは提責と事務員だけで衝突していない)、
    //   ★ 出勤簿の範囲が広がれば すぐ発火する
    const grouped = new Map<string, AttendanceRecord[]>();
    for (const r of records) {
      const k = `${r.office_number}|${r.employee_number}`;
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k)!.push(r);
    }

    const result: EmployeeSummary[] = [];
    for (const [key, recs] of grouped) {
      const emp = empMap.get(key);
      const empOfficeNum = recs[0]?.office_number ?? "";
      const empWs = officeMap.get(empOfficeNum)?.work_week_start ?? 0;
      result.push({
        office_number: empOfficeNum,
        employee_number: recs[0].employee_number,
        employee_name: recs[0].employee_name,
        role_type: emp?.role_type ?? "",
        salary_type: emp?.salary_type ?? "",
        records: recs,
        stats: computeLaborStats(recs, selectedYear, selectedMonth, empWs),
      });
    }
    result.sort((a, b) => (a.employee_number.localeCompare(b.employee_number) || a.office_number.localeCompare(b.office_number)));
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
