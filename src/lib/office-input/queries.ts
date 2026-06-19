/**
 * 事業所書式入力 (= /office-input) の CRUD。
 *
 * 重要: silent failure を作らない。
 *   - supabase 呼出は必ず `{ error }` を check
 *   - error 時は throw して呼出元で toast 表示
 */

import { supabase } from "@/lib/supabase";
import type { Employee } from "@/types/database";
import type { OfficeInputEntry, OfficeInputEntryInput } from "./types";

/**
 * 指定スタッフ × 月のエントリを全件取得。
 */
export async function getEntriesByEmployeeMonth(
  employeeId: string,
  billingMonth: string,
): Promise<OfficeInputEntry[]> {
  const { data, error } = await supabase
    .from("payroll_office_input_entries")
    .select("*")
    .eq("employee_id", employeeId)
    .eq("billing_month", billingMonth)
    .order("category")
    .order("created_at");

  if (error) {
    console.error("getEntriesByEmployeeMonth failed:", error.message);
    throw new Error(`エントリ取得失敗: ${error.message}`);
  }

  return (data ?? []) as OfficeInputEntry[];
}

/**
 * エントリの upsert (id 有→UPDATE、無→INSERT)。
 * 返り値は保存後の最新 row。
 */
export async function upsertEntry(
  entry: OfficeInputEntryInput,
): Promise<OfficeInputEntry> {
  // 余計な undefined 値を落とす (= DB 側でデフォルト適用したい列)
  const payload: Record<string, unknown> = {
    employee_id: entry.employee_id,
    billing_month: entry.billing_month,
    category: entry.category,
    item_name: entry.item_name,
    numeric_value: entry.numeric_value ?? null,
    time_minutes: entry.time_minutes ?? null,
    date_value: entry.date_value ?? null,
    start_time: entry.start_time ?? null,
    end_time: entry.end_time ?? null,
    break_minutes: entry.break_minutes ?? null,
    child_name: entry.child_name ?? null,
    reference_month: entry.reference_month ?? null,
    notes: entry.notes ?? null,
  };
  if (entry.id) {
    payload.id = entry.id;
  }

  const { data, error } = await supabase
    .from("payroll_office_input_entries")
    .upsert(payload, { onConflict: "id" })
    .select()
    .single();

  if (error) {
    console.error("upsertEntry failed:", error.message, payload);
    throw new Error(`保存失敗: ${error.message}`);
  }

  if (!data) {
    throw new Error("保存失敗: data が空");
  }

  return data as OfficeInputEntry;
}

/**
 * エントリ削除。
 */
export async function deleteEntry(id: string): Promise<void> {
  const { error } = await supabase
    .from("payroll_office_input_entries")
    .delete()
    .eq("id", id);

  if (error) {
    console.error("deleteEntry failed:", error.message, id);
    throw new Error(`削除失敗: ${error.message}`);
  }
}

/**
 * 指定事業所所属のスタッフ一覧を取得 (在職者のみ)。
 * 既存 employees パターンを踏襲 (= payroll_employees.office_id 一致)。
 */
export async function listEmployeesByOffice(
  officeId: string,
): Promise<Employee[]> {
  const { data, error } = await supabase
    .from("payroll_employees")
    .select("*")
    .eq("office_id", officeId)
    .eq("employment_status", "在職者")
    .order("employee_number");

  if (error) {
    console.error("listEmployeesByOffice failed:", error.message);
    throw new Error(`スタッフ一覧取得失敗: ${error.message}`);
  }

  return (data ?? []) as Employee[];
}
