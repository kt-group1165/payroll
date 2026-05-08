import { createClient } from "@/lib/supabase/server";
import { fetchAllPagesParallel } from "@/lib/fetch-all";
import {
  OFFICE_MASTER_JOIN,
  flattenOfficeMaster,
  type Employee,
  type Office,
} from "@/types/database";
import { EmployeesList } from "./employees-list";

/**
 * /employees
 * 職員一覧 + 編集 dialog + CSV import/export。
 *
 * Server Component: 全 employees + offices を server-side で取得し、
 * `<EmployeesList>` (client component) に initial props で渡す。
 * 保存・削除・取込後は client 側で `router.refresh()` を呼んで RSC 再評価。
 *
 * Perf: employees + offices を Promise.all で並列。employees は count + 並列 range で
 * page-loop の順次 wait を避ける (kt-group 1,200 行は 2 page だが将来の余裕分)。
 */
export default async function EmployeesPage() {
  const supabase = await createClient();

  const [employees, offRes] = await Promise.all([
    fetchAllPagesParallel<Employee>(
      () => supabase.from("payroll_employees").select("*", { count: "exact", head: true }),
      (from, to) =>
        supabase
          .from("payroll_employees")
          .select("*")
          .order("employee_number")
          .range(from, to) as unknown as PromiseLike<{ data: Employee[] | null }>,
    ),
    supabase.from("payroll_offices").select(`*, ${OFFICE_MASTER_JOIN}`),
  ]);

  let offices: Office[] = [];
  if (offRes.data) {
    offices = flattenOfficeMaster(offRes.data as never) as unknown as Office[];
    offices.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  }

  return <EmployeesList initialEmployees={employees} offices={offices} />;
}
