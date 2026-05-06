import { createClient } from "@/lib/supabase/server";
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
 * Server Component: 全 employees (ページング) + offices を server-side で取得し、
 * `<EmployeesList>` (client component) に initial props で渡す。
 * 保存・削除・取込後は client 側で `router.refresh()` を呼んで RSC 再評価。
 */
export default async function EmployeesPage() {
  const supabase = await createClient();
  const pageSize = 1000;

  const employees: Employee[] = [];
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from("payroll_employees")
      .select("*")
      .order("employee_number")
      .range(from, from + pageSize - 1);
    if (!data || data.length === 0) break;
    employees.push(...(data as Employee[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }

  const { data: offData } = await supabase
    .from("payroll_offices")
    .select(`*, ${OFFICE_MASTER_JOIN}`);

  let offices: Office[] = [];
  if (offData) {
    offices = flattenOfficeMaster(offData as never) as unknown as Office[];
    offices.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  }

  return <EmployeesList initialEmployees={employees} offices={offices} />;
}
