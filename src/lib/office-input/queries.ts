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
import type { OfficeFormRecord } from "@/lib/payroll/payroll-calc";
import { isEmployedInMonth, monthBounds } from "@/lib/payroll/employment-in-month";

/**
 * `.in()` に渡す ID の chunk 上限。
 * 350 件を超えると Postgres が seq scan に落ちるので 150 に抑える
 * (= feedback_postgrest_in_query_plan_cliff)。
 */
const IN_CHUNK = 150;

/** PostgREST の 1 応答上限 (= 暗黙 1000 行で黙って切れるのを防ぐ) */
const PAGE_SIZE = 1000;

/**
 * 指定スタッフ群 × 月のエントリを全件取得。
 *
 * 画面は「項目ごとに全職員を一覧」で入力するので、事業所の全職員ぶんを
 * まとめて読む。⚠ order 無しの range は行が抜けるので必ず order を付ける
 * (= feedback_postgrest_paging_needs_order)。
 */
export async function getEntriesByEmployeesMonth(
  employeeIds: string[],
  billingMonth: string,
): Promise<OfficeInputEntry[]> {
  if (employeeIds.length === 0) return [];

  const chunks: string[][] = [];
  for (let i = 0; i < employeeIds.length; i += IN_CHUNK) {
    chunks.push(employeeIds.slice(i, i + IN_CHUNK));
  }

  const results = await Promise.all(
    chunks.map(async (ids) => {
      const rows: OfficeInputEntry[] = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await supabase
          .from("payroll_office_input_entries")
          .select("*")
          .in("employee_id", ids)
          .eq("billing_month", billingMonth)
          .order("id")
          .range(from, from + PAGE_SIZE - 1);

        if (error) {
          console.error("getEntriesByEmployeesMonth failed:", error.message);
          throw new Error(`エントリ取得失敗: ${error.message}`);
        }
        const page = (data ?? []) as OfficeInputEntry[];
        rows.push(...page);
        if (page.length < PAGE_SIZE) break;
      }
      return rows;
    }),
  );

  return results.flat();
}

/** upsert payload を 1 か所で組み立てる (= 列の付け忘れを防ぐ) */
function toPayload(entry: OfficeInputEntryInput): Record<string, unknown> {
  return {
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
}

/**
 * エントリの upsert (id 有→UPDATE、無→INSERT)。
 * 返り値は保存後の最新 row。
 */
export async function upsertEntry(
  entry: OfficeInputEntryInput,
): Promise<OfficeInputEntry> {
  const payload = toPayload(entry);
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
 * 複数エントリをまとめて INSERT (= 休暇の日付をまとめて登録する用)。
 *
 * ⚠ `.insert([...])` は行ごとにキー集合が違うと未指定列に NULL を明示送信して
 *   DEFAULT が効かなくなる。`toPayload` で全行を同じキー集合に揃えてから渡す
 *   (= feedback_batch_insert_key_mismatch_null_fill)。
 */
export async function insertEntries(
  entries: OfficeInputEntryInput[],
): Promise<OfficeInputEntry[]> {
  if (entries.length === 0) return [];

  const { data, error } = await supabase
    .from("payroll_office_input_entries")
    .insert(entries.map(toPayload))
    .select();

  if (error) {
    console.error("insertEntries failed:", error.message, entries.length);
    throw new Error(`保存失敗: ${error.message}`);
  }

  return (data ?? []) as OfficeInputEntry[];
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
 * エントリをまとめて削除 (= 休暇の日付を外したとき)。
 */
export async function deleteEntries(ids: string[]): Promise<void> {
  if (ids.length === 0) return;

  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const { error } = await supabase
      .from("payroll_office_input_entries")
      .delete()
      .in("id", chunk);

    if (error) {
      console.error("deleteEntries failed:", error.message, chunk.length);
      throw new Error(`削除失敗: ${error.message}`);
    }
  }
}

/**
 * 指定事業所所属のスタッフ一覧を取得。
 * 既存 employees パターンを踏襲 (= payroll_employees.office_id 一致)。
 *
 * ★ その月に在籍していた人を出す (2026-10-06)。以前は在職者だけで、
 *   月の途中で辞めた人・休職者の書式が画面から入れられなかった (給与計算は 退職日が月初以降の人も含める)。
 *   判定は給与計算と同じ isEmployedInMonth。入社日がその月の末日より後の人は出さない。
 */
export async function listEmployeesByOffice(
  officeId: string,
  billingMonth?: string,
): Promise<Employee[]> {
  const { data, error } = await supabase
    .from("payroll_employees")
    .select("*")
    .eq("office_id", officeId)
    .order("employee_number");

  if (error) {
    console.error("listEmployeesByOffice failed:", error.message);
    throw new Error(`スタッフ一覧取得失敗: ${error.message}`);
  }

  const list = (data ?? []) as Employee[];
  // ★ 在籍の判定は 給与計算と同じ関数 (isEmployedInMonth。在職区分を直接比べない。
  //   check:employment-status-sites)。休職者も出る (書式を入れることがある)
  const ym = billingMonth && /^\d{4}-\d{2}$/.test(billingMonth) ? billingMonth.replace("-", "") : currentYM();
  const { end } = monthBounds(ym);
  return list.filter((e) => isEmployedInMonth(e, ym) && !(e.hire_date && e.hire_date > end));
}

/** 今月 "YYYYMM" */
function currentYM(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * ファイルで取り込んだ事業所書式 (payroll_office_form_records) を 事業所 × 処理月 で読む (2026-10-06)。
 * 画面にファイルの値を出し、「画面で直す」で画面の入力に写すために使う。
 */
export async function getFormRecordsByOfficeMonth(
  officeNumber: string,
  processingMonth: string,
): Promise<(OfficeFormRecord & { import_batch_id: string | null })[]> {
  const rows: (OfficeFormRecord & { import_batch_id: string | null })[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("payroll_office_form_records")
      .select("employee_number,record_type,item_name,item_date,numeric_value,start_time,end_time,break_time,year_month,child_name,amount,import_batch_id")
      .eq("office_number", officeNumber)
      .eq("processing_month", processingMonth)
      .order("id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      console.error("getFormRecordsByOfficeMonth failed:", error.message);
      throw new Error(`ファイル取込の事業所書式の取得に失敗: ${error.message}`);
    }
    const page = (data ?? []) as (OfficeFormRecord & { import_batch_id: string | null })[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

/**
 * 出勤簿 (payroll_attendance_records) の 出張km・通勤km の月合計 (職員ごと。キーは normEmp した社員番号)。
 * 給与計算は 出張km が 画面の入力にも事業所書式にも無い人に 出勤簿の出張km を使う (payroll/page.tsx tripKmOf)。
 * 事業所書式入力の画面で「この人は出勤簿の値で計算されている」を見せるため (2026-10-08)
 */
export async function getAttendanceKmByOfficeMonth(
  officeNumber: string,
  processingMonth: string,
): Promise<Map<string, { business_km: number; commute_km: number }>> {
  const out = new Map<string, { business_km: number; commute_km: number }>();
  const year = Number(processingMonth.slice(0, 4)), month = Number(processingMonth.slice(4, 6));
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("payroll_attendance_records")
      .select("employee_number,business_km,commute_km")
      .eq("office_number", officeNumber)
      .eq("year", year).eq("month", month)
      .order("id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      console.error("getAttendanceKmByOfficeMonth failed:", error.message);
      throw new Error(`出勤簿の取得に失敗: ${error.message}`);
    }
    const page = (data ?? []) as { employee_number: string; business_km: number | null; commute_km: number | null }[];
    for (const r of page) {
      const k = String(r.employee_number ?? "").trim().replace(/^0+/, "");
      const cur = out.get(k) ?? { business_km: 0, commute_km: 0 };
      cur.business_km += Number(r.business_km ?? 0);
      cur.commute_km += Number(r.commute_km ?? 0);
      out.set(k, cur);
    }
    if (page.length < PAGE_SIZE) break;
  }
  return out;
}

/** 取込バッチ (payroll_import_batches) の 種類とファイル名。ファイル取込の値が どこから来たかを出すため (2026-10-08) */
export async function getImportBatchesByIds(
  ids: string[],
): Promise<Map<string, { import_type: string; file_names: string[] }>> {
  const out = new Map<string, { import_type: string; file_names: string[] }>();
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await supabase
      .from("payroll_import_batches")
      .select("id,import_type,file_names")
      .in("id", ids.slice(i, i + 150));
    if (error) {
      console.error("getImportBatchesByIds failed:", error.message);
      throw new Error(`取込バッチの取得に失敗: ${error.message}`);
    }
    for (const b of (data ?? []) as { id: string; import_type: string; file_names: string[] | null }[]) {
      out.set(b.id, { import_type: b.import_type, file_names: b.file_names ?? [] });
    }
  }
  return out;
}

/**
 * 指定スタッフ群 × 月「範囲」のエントリを取得 (給与計算が読む用)。
 *
 * 給与計算は当月だけでなく「付与日〜当月」の有給も読む (= usedBefore の計算) ので、
 * 月を範囲で取れるようにしてある。範囲は両端を含む 'YYYY-MM'。
 */
export async function getEntriesByEmployeesMonthRange(
  employeeIds: string[],
  fromBillingMonth: string,
  toBillingMonth: string,
): Promise<OfficeInputEntry[]> {
  if (employeeIds.length === 0) return [];

  const chunks: string[][] = [];
  for (let i = 0; i < employeeIds.length; i += IN_CHUNK) {
    chunks.push(employeeIds.slice(i, i + IN_CHUNK));
  }

  const results = await Promise.all(
    chunks.map(async (ids) => {
      const rows: OfficeInputEntry[] = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await supabase
          .from("payroll_office_input_entries")
          .select("*")
          .in("employee_id", ids)
          .gte("billing_month", fromBillingMonth)
          .lte("billing_month", toBillingMonth)
          .order("id")
          .range(from, from + PAGE_SIZE - 1);

        if (error) {
          console.error("getEntriesByEmployeesMonthRange failed:", error.message);
          throw new Error(`事業所書式入力の取得に失敗: ${error.message}`);
        }
        const page = (data ?? []) as OfficeInputEntry[];
        rows.push(...page);
        if (page.length < PAGE_SIZE) break;
      }
      return rows;
    }),
  );

  return results.flat();
}
