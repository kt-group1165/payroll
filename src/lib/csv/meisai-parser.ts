import type { MeisaiRow, CsvParseResult } from "@/types/csv";
import { readCsvFile } from "./decoder";

/**
 * 既知のヘッダ名マッピング
 * CSVファイルによってカラム数が異なるため、ヘッダ名ベースでパースする
 */
const CORE_HEADERS = [
  "事業者名",
  "処理月",
  "職員番号",
  "職員名",
  "開始日",
  "終了日",
  "日付",
  "派遣開始時間",
  "派遣終了時間",
  "利用者名",
  "サービス",
  "実時刻開始時間",
  "実時刻終了時間",
  "実時間",
  "算定開始時刻",
  "算定終了時刻",
  "算定時間",
  "休日区分",
  "時間帯",
  "サービス型",
  "金額",
] as const;

// CSVによって有無が異なるヘッダ（欠損時は空文字として扱う）
const OPTIONAL_HEADERS = [
  "交通費",
  "電話代",
  "調整費",
  "会議費",
  "研修",
  "その他手当",
  "合計",
  "同行訪問",
] as const;

export async function parseMeisaiFile(
  file: File
): Promise<CsvParseResult<MeisaiRow>> {
  const errors: string[] = [];
  const data: MeisaiRow[] = [];

  try {
    const rows = await readCsvFile(file);
    if (rows.length < 2) {
      return { success: false, data: [], errors: ["データ行がありません"], fileName: file.name };
    }

    const headers = rows[0];
    const headerMap = new Map<string, number>();
    headers.forEach((h, i) => headerMap.set(h.trim(), i));

    // コアヘッダの検証
    for (const h of CORE_HEADERS) {
      if (!headerMap.has(h)) {
        errors.push(`必須カラム「${h}」が見つかりません`);
      }
    }

    if (errors.length > 0) {
      return { success: false, data: [], errors, fileName: file.name };
    }

    // 末尾3カラムのインデックスを特定
    const colCount = headers.length;
    const tailStartIdx = colCount - 3;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.length < 10 || row.every((cell) => cell.trim() === "")) continue;

      try {
        const getValue = (header: string): string => {
          const idx = headerMap.get(header);
          return idx !== undefined ? (row[idx] ?? "").trim() : "";
        };

        const meisaiRow: MeisaiRow = {
          事業者名: getValue("事業者名"),
          処理月: getValue("処理月"),
          職員番号: getValue("職員番号"),
          職員名: getValue("職員名"),
          開始日: getValue("開始日"),
          終了日: getValue("終了日"),
          日付: getValue("日付"),
          派遣開始時間: getValue("派遣開始時間"),
          派遣終了時間: getValue("派遣終了時間"),
          利用者名: getValue("利用者名"),
          サービス: getValue("サービス"),
          実時刻開始時間: getValue("実時刻開始時間"),
          実時刻終了時間: getValue("実時刻終了時間"),
          実時間: getValue("実時間"),
          算定開始時刻: getValue("算定開始時刻"),
          算定終了時刻: getValue("算定終了時刻"),
          算定時間: getValue("算定時間"),
          休日区分: getValue("休日区分"),
          時間帯: getValue("時間帯"),
          サービス型: getValue("サービス型"),
          金額: getValue("金額"),
          交通費: getValue("交通費"),
          事業所番号: (row[tailStartIdx] ?? "").trim(),
          利用者番号: (row[tailStartIdx + 1] ?? "").trim(),
          サービスコード: (row[tailStartIdx + 2] ?? "").trim(),
        };

        // オプションカラム
        for (const h of OPTIONAL_HEADERS) {
          if (headerMap.has(h)) {
            (meisaiRow as unknown as Record<string, string>)[h] = getValue(h);
          }
        }

        data.push(meisaiRow);
      } catch {
        errors.push(`行${i + 1}: パースエラー`);
      }
    }

    return {
      success: errors.length === 0,
      data,
      errors,
      fileName: file.name,
    };
  } catch (e) {
    return {
      success: false,
      data: [],
      errors: [`ファイル読み込みエラー: ${e instanceof Error ? e.message : String(e)}`],
      fileName: file.name,
    };
  }
}

/**
 * 複数のMEISAIファイルをパースして結合する
 */
export async function parseMeisaiFiles(
  files: File[]
): Promise<{ allData: MeisaiRow[]; results: CsvParseResult<MeisaiRow>[] }> {
  const results = await Promise.all(files.map(parseMeisaiFile));
  const allData = results.flatMap((r) => r.data);
  return { allData, results };
}
