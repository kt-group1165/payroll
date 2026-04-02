import { readCsvFile } from "./decoder";

export type ParsedClient = {
  client_number: string;
  name: string;
  address: string;
  office_name: string; // 担当事業所名称（office_id の解決に使用）
  start_date: string;
  end_date: string;
};

export type ClientParseResult = {
  success: boolean;
  data: ParsedClient[];
  errors: string[];
  fileName: string;
};

export async function parseClientFile(file: File): Promise<ClientParseResult> {
  const errors: string[] = [];
  const data: ParsedClient[] = [];

  try {
    const rows = await readCsvFile(file);
    if (rows.length < 2) {
      return { success: false, data: [], errors: ["データ行がありません"], fileName: file.name };
    }

    const header = rows[0].map((h) => h.trim());
    const idxOf = (name: string) => header.indexOf(name);

    // ヘッダー名でインデックス解決、見つからなければ位置で代替
    const colClientNum  = idxOf("利用者番号")  >= 0 ? idxOf("利用者番号")  : 0;
    const colName       = idxOf("利用者氏名")  >= 0 ? idxOf("利用者氏名")  : 1;
    const colAddress    = idxOf("住所")        >= 0 ? idxOf("住所")        : 14;
    const colOfficeName = idxOf("担当事業所名称") >= 0 ? idxOf("担当事業所名称") : 26;
    const colStartDate  = idxOf("利用開始日")  >= 0 ? idxOf("利用開始日")  : 27;
    const colEndDate    = idxOf("利用終了日")  >= 0 ? idxOf("利用終了日")  : 28;

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.every((c) => !c.trim())) continue;

      const clientNum = r[colClientNum]?.trim() ?? "";
      const name      = r[colName]?.trim() ?? "";
      if (!clientNum || !name) continue;

      data.push({
        client_number: clientNum,
        name,
        address:     r[colAddress]?.trim() ?? "",
        office_name: r[colOfficeName]?.trim() ?? "",
        start_date:  r[colStartDate]?.trim() ?? "",
        end_date:    r[colEndDate]?.trim() ?? "",
      });
    }

    return { success: errors.length === 0, data, errors, fileName: file.name };
  } catch (e) {
    return {
      success: false, data: [],
      errors: [`読み込みエラー: ${e instanceof Error ? e.message : String(e)}`],
      fileName: file.name,
    };
  }
}
