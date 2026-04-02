import type { OfficeFormRecord, CsvParseResult } from "@/types/csv";
import { readCsvFile } from "./decoder";

/**
 * ファイル名から処理月（YYYYMM）を抽出する
 * 例: xxx_20260203.csv → "202602"（先頭6桁）
 */
function extractProcessingMonthFromFilename(filename: string): string | null {
  const m = filename.match(/(\d{6})\d{2}\.csv$/i);
  if (m) return m[1]; // YYYYMM
  const m2 = filename.match(/(\d{4})(\d{2})/);
  if (m2) return m2[1] + m2[2]; // YYYYMM
  return null;
}


/**
 * 事業所書式CSVをパースしてOfficeFormRecord配列を返す
 *
 * カラム構造:
 *   0: 事業所番号, 1: 事業所名, 2: 社員番号, 3: 名前（取り込みません）
 *   4- : 数値×20セット(サービスコード,項目名,数値)
 *   64- : 時間×10セット(サービスコード,項目名,時間)
 *   94- : 日付×6セット(サービスコード,項目名,対象日)
 *   112- : 日時×15セット(サービスコード,項目名,日付,開始,終了,休憩)
 *   202- : 育児手当×6セット(サービスコード,項目名,年月,お子さん名,金額)
 */
export async function parseOfficeFormFile(
  file: File
): Promise<CsvParseResult<OfficeFormRecord>> {
  const errors: string[] = [];
  const data: OfficeFormRecord[] = [];

  try {
    const rows = await readCsvFile(file);
    if (rows.length < 2) {
      return { success: false, data: [], errors: ["データ行がありません"], fileName: file.name };
    }

    const header = rows[0];

    // カラムインデックスをヘッダ名で解決
    const idxOf = (name: string) => header.indexOf(name);

    const officeNumberIdx = idxOf("事業所番号");
    const empNumberIdx    = idxOf("社員番号");

    // 数値スロット (最大20)
    const numSlots: { nameIdx: number; valIdx: number }[] = [];
    for (let n = 1; n <= 20; n++) {
      const nameIdx = idxOf(`数値項目名${n}`);
      const valIdx  = idxOf(`数値${n}`);
      if (nameIdx >= 0 && valIdx >= 0) numSlots.push({ nameIdx, valIdx });
    }

    // 日付スロット (最大6)
    const dateSlots: { nameIdx: number; dateIdx: number }[] = [];
    for (let n = 1; n <= 6; n++) {
      const nameIdx = idxOf(`日付項目名${n}`);
      const dateIdx = idxOf(`対象日${n}`);
      if (nameIdx >= 0 && dateIdx >= 0) dateSlots.push({ nameIdx, dateIdx });
    }

    // 日時スロット (最大15)
    const dtSlots: { nameIdx: number; dateIdx: number; startIdx: number; endIdx: number; breakIdx: number }[] = [];
    for (let n = 1; n <= 15; n++) {
      const nameIdx  = idxOf(`日時項目名${n}`);
      const dateIdx  = idxOf(`日付${n}`);
      const startIdx = idxOf(`開始時間${n}`);
      const endIdx   = idxOf(`終了時間${n}`);
      const breakIdx = idxOf(`休憩時間${n}`);
      if (nameIdx >= 0) dtSlots.push({ nameIdx, dateIdx, startIdx, endIdx, breakIdx });
    }

    // 育児手当スロット (最大6)
    const childSlots: { nameIdx: number; ymIdx: number; kidIdx: number; amtIdx: number }[] = [];
    for (let n = 1; n <= 6; n++) {
      const nameIdx = idxOf(`育児手当項目名${n}`);
      const ymIdx   = idxOf(`年月${n}`);
      const kidIdx  = idxOf(`お子さん名${n}`);
      const amtIdx  = idxOf(`金額${n}`);
      if (nameIdx >= 0) childSlots.push({ nameIdx, ymIdx, kidIdx, amtIdx });
    }

    // 処理月: ファイル名の年月（YYYYMM）を優先使用
    // 例: xxx_20260203.csv → "202602"
    const processingMonth = extractProcessingMonthFromFilename(file.name)
      ?? `${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, "0")}`;

    for (let i = 1; i < rows.length; i++) {
      const cols = rows[i];
      if (!cols || cols.every((c) => !c.trim())) continue;

      const officeNumber  = cols[officeNumberIdx]?.trim() ?? "";
      const employeeNumber = cols[empNumberIdx]?.trim() ?? "";
      if (!employeeNumber) continue;

      const base = { office_number: officeNumber, employee_number: employeeNumber, processing_month: processingMonth };

      // 数値 (km等)
      for (const { nameIdx, valIdx } of numSlots) {
        const name = cols[nameIdx]?.trim();
        const val  = cols[valIdx]?.trim();
        if (!name) continue;
        data.push({
          ...base,
          record_type: "km",
          item_name: name,
          numeric_value: val ? parseFloat(val) || undefined : undefined,
        });
      }

      // 日付 (有給/半有給/特休)
      for (const { nameIdx, dateIdx } of dateSlots) {
        const name = cols[nameIdx]?.trim();
        const date = cols[dateIdx]?.trim();
        if (!name) continue;
        data.push({
          ...base,
          record_type: "leave",
          item_name: name,
          item_date: date || undefined,
        });
      }

      // 日時 (HRD研修等)
      for (const { nameIdx, dateIdx, startIdx, endIdx, breakIdx } of dtSlots) {
        const name = cols[nameIdx]?.trim();
        if (!name) continue;
        data.push({
          ...base,
          record_type: "training",
          item_name: name,
          item_date: cols[dateIdx]?.trim() || undefined,
          start_time: cols[startIdx]?.trim() || undefined,
          end_time: cols[endIdx]?.trim() || undefined,
          break_time: cols[breakIdx]?.trim() || undefined,
        });
      }

      // 育児手当
      for (const { nameIdx, ymIdx, kidIdx, amtIdx } of childSlots) {
        const name = cols[nameIdx]?.trim();
        if (!name) continue;
        data.push({
          ...base,
          record_type: "childcare",
          item_name: name,
          year_month: cols[ymIdx]?.trim() || undefined,
          child_name: cols[kidIdx]?.trim() || undefined,
          amount: cols[amtIdx]?.trim() ? parseInt(cols[amtIdx].trim(), 10) || undefined : undefined,
        });
      }
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  return {
    success: errors.length === 0,
    data,
    errors,
    fileName: file.name,
  };
}
