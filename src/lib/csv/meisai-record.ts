import type { MeisaiRow } from "@/types/csv";

/**
 * MEISAI (ほのぼの 賃金集計【明細】) 1 行 → payroll_service_records 1 行。
 *
 * 画面の単発取込・一括取込・scripts/import-meisai-folder.mts が同じ関数を使う
 * (逐語コピーだと片方だけ直したときに乖離するため)。
 */
export function meisaiRowToRecord(
  row: MeisaiRow,
  ctx: { batchId: string; officeNumber: string; processingMonth: string },
) {
  const int = (v: string | undefined) => (v ? parseInt(v, 10) || null : null);
  return {
    import_batch_id: ctx.batchId,
    office_number: ctx.officeNumber,
    office_name: row.事業者名,
    processing_month: ctx.processingMonth,
    employee_number: row.職員番号,
    employee_name: row.職員名.replace(/　様$/, "").replace(/　$/, ""),
    period_start: row.開始日,
    period_end: row.終了日,
    service_date: row.日付,
    dispatch_start_time: row.派遣開始時間,
    dispatch_end_time: row.派遣終了時間,
    client_name: row.利用者名,
    service_type: row.サービス,
    actual_start_time: row.実時刻開始時間,
    actual_end_time: row.実時刻終了時間,
    actual_duration: row.実時間,
    calc_start_time: row.算定開始時刻,
    calc_end_time: row.算定終了時刻,
    calc_duration: row.算定時間,
    holiday_type: row.休日区分,
    time_period: row.時間帯,
    service_category: row.サービス型,
    amount: int(row.金額),
    transport_fee: int(row.交通費),
    phone_fee: int(row.電話代),
    adjustment_fee: int(row.調整費),
    meeting_fee: int(row.会議費),
    training_fee: int(row.研修),
    other_allowance: int(row.その他手当),
    total: int(row.合計),
    accompanied_visit: row.同行訪問 ?? "",
    client_number: row.利用者番号,
    service_code: row.サービスコード,
  };
}
