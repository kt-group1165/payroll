import type { OfficeFormRecord } from "@/types/csv";

/**
 * 事業所書式 1 項目 → payroll_office_form_records 1 行。
 * 画面 (/csv-import の「事業所書式」) と scripts/import-office-form.mts が同じ関数を使う。
 */
export function officeFormRecordToRow(r: OfficeFormRecord, ctx: { batchId: string; processingMonth: string }) {
  return {
    import_batch_id: ctx.batchId,
    office_number: r.office_number,
    employee_number: r.employee_number,
    processing_month: ctx.processingMonth,
    record_type: r.record_type,
    item_name: r.item_name,
    item_date: r.item_date ?? null,
    start_time: r.start_time ?? null,
    end_time: r.end_time ?? null,
    break_time: r.break_time ?? null,
    numeric_value: r.numeric_value ?? null,
    year_month: r.year_month ?? null,
    child_name: r.child_name ?? null,
    amount: r.amount ?? null,
  };
}
