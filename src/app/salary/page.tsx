import { createClient } from "@/lib/supabase/server";
import { fetchAllPagesParallel } from "@/lib/fetch-all";
import {
  OFFICE_MASTER_JOIN,
  flattenOfficeMaster,
  type Employee,
  type Office,
} from "@/types/database";
import { SalaryList } from "./salary-list";

type SalarySettings = {
  id?: string;
  employee_id: string;
  base_personal_salary: number;
  skill_salary: number;
  position_allowance: number;
  qualification_allowance: number;
  tenure_allowance: number;
  treatment_improvement: number;
  specific_treatment_improvement: number;
  treatment_subsidy: number;
  fixed_overtime_pay: number;
  special_bonus: number;
  bonus_amount: number;
  travel_unit_price: number;
  care_overtime_threshold_hours: number;
  care_overtime_unit_price: number;
  yocho_unit_price: number;
  note: string;
};

type OvertimeSetting = {
  id?: string;
  job_type: string;
  scheduled_hours_per_month: number;
  include_base_personal_salary: boolean;
  include_skill_salary: boolean;
  include_position_allowance: boolean;
  include_qualification_allowance: boolean;
  include_tenure_allowance: boolean;
  include_treatment_improvement: boolean;
  include_specific_treatment: boolean;
  include_treatment_subsidy: boolean;
  include_fixed_overtime_pay: boolean;
  include_special_bonus: boolean;
};

/**
 * /salary
 * 職員給与設定 + 残業設定。
 *
 * Server Component: employees / offices / salary_settings / overtime_settings の
 * 4 dataset を server-side で取得し、`<SalaryList>` (client component) に initial
 * props で渡す。selectedId 変化時の個別 settings fetch は client 側で実行。
 *
 * Perf: 4 fetch を Promise.all で並列。employees / salary_settings は count + 並列
 * range で page-loop の順次 wait を避ける。
 */
export default async function SalaryPage() {
  const supabase = await createClient();

  const [emps, offRes, sals, otRes] = await Promise.all([
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
    fetchAllPagesParallel<SalarySettings>(
      () => supabase.from("payroll_salary_settings").select("*", { count: "exact", head: true }),
      (from, to) =>
        supabase
          .from("payroll_salary_settings")
          .select("*")
          .range(from, to) as unknown as PromiseLike<{ data: SalarySettings[] | null }>,
    ),
    supabase.from("payroll_overtime_settings").select("*"),
  ]);

  const offices: Office[] = offRes.data
    ? (flattenOfficeMaster(offRes.data as never) as unknown as Office[])
    : [];
  const overtimeSettings: OvertimeSetting[] = (otRes.data as OvertimeSetting[] | null) ?? [];

  return (
    <SalaryList
      initialEmployees={emps}
      initialOffices={offices}
      initialAllSettings={sals}
      initialOvertimeSettings={overtimeSettings}
    />
  );
}
