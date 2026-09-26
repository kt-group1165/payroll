import { parseNumericCell } from "./numeric-cell";
import type {
  AttendanceRow,
  AttendanceMeta,
  ParsedAttendance,
  CsvParseResult,
} from "@/types/csv";
import { readCsvFile } from "./decoder";

/**
 * 出勤簿CSVをパースする
 *
 * 2つのフォーマットが存在:
 * - Format A (34列, クォート付き): 一般的な形式
 * - Format B (38列, クォートなし): パートヘルパー用、追加列あり
 *
 * 構造:
 * - 行0: 年, ..., "社員番号:", 番号, ...
 * - 行1: 月, ..., "名前:", 名前, ..., 事業所名
 * - 行2: カラムヘッダ
 * - 行3-33: 日別データ (1日〜31日)
 * - 行34: 合計行
 * - 行36: 残業時間
 * - 行37: 事業所番号
 * - 行38: 社員番号
 */
export async function parseAttendanceFile(
  file: File
): Promise<CsvParseResult<ParsedAttendance>> {
  const errors: string[] = [];

  try {
    const rows = await readCsvFile(file);
    if (rows.length < 35) {
      return {
        success: false,
        data: [],
        errors: ["出勤簿のフォーマットが正しくありません（行数不足）"],
        fileName: file.name,
      };
    }

    // メタデータ抽出
    const row0 = rows[0];
    const row1 = rows[1];

    const yearStr = (row0[0] ?? "").replace(/年$/, "").trim();
    const monthStr = (row1[0] ?? "").replace(/月$/, "").trim();
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);

    if (isNaN(year) || isNaN(month)) {
      return {
        success: false,
        data: [],
        errors: ["年月の解析に失敗しました"],
        fileName: file.name,
      };
    }

    // 社員番号と名前の取得
    const employeeNumber = (row0[4] ?? "").trim();
    const employeeName = (row1[4] ?? "").trim();

    // 事業所名 (行1の後半にある)
    let officeName = "";
    for (let i = 10; i < row1.length; i++) {
      const val = (row1[i] ?? "").trim();
      if (val && val.includes("リンクス")) {
        officeName = val;
        break;
      }
    }
    // fallback: 列17付近
    if (!officeName && row1.length > 17) {
      officeName = (row1[17] ?? "").trim();
    }

    // 事業所番号 (行37付近)
    let officeNumber = "";
    for (let i = 35; i < rows.length; i++) {
      const r = rows[i];
      if (r && (r[0] ?? "").trim().startsWith("事業所")) {
        officeNumber = (r[1] ?? "").trim();
        break;
      }
    }

    const meta: AttendanceMeta = {
      year,
      month,
      employeeNumber,
      employeeName,
      officeName,
      officeNumber,
    };

    // カラムヘッダ（行2）
    const headerRow = rows[2];
    const headerMap = new Map<string, number>();
    headerRow.forEach((h, i) => headerMap.set(h.trim(), i));

    // 日別データ（行3〜33）
    const attendanceRows: AttendanceRow[] = [];
    for (let i = 3; i <= 33 && i < rows.length; i++) {
      const row = rows[i];
      const dayStr = (row[0] ?? "").trim();

      // 空行（日付がないもの）はスキップ
      if (!dayStr || isNaN(parseInt(dayStr, 10))) continue;

      const get = (header: string): string => {
        const idx = headerMap.get(header);
        return idx !== undefined ? (row[idx] ?? "").trim() : "";
      };

      const attendanceRow: AttendanceRow = {
        日付: dayStr,
        曜日: get("曜日"),
        振替日: get("振替日"),
        勤務摘要: get("勤務摘要"),
        勤務摘要2: get("勤務摘要2"),
        勤務摘要3: get("勤務摘要3"),
        勤務摘要4: get("勤務摘要4"),
        勤務摘要5: get("勤務摘要5"),
        開始: get("開始"),
        終了: get("終了"),
        開始2: get("開始2"),
        終了2: get("終了2"),
        開始3: get("開始3"),
        終了3: get("終了3"),
        開始4: get("開始4"),
        終了4: get("終了4"),
        開始5: get("開始5"),
        終了5: get("終了5"),
        休憩: get("休憩"),
        勤務時間: get("勤務時間"),
        通勤km: get("通勤km") || get("出張km"),
        出張km: headerMap.has("出張km") ? get("出張km") : get("通勤km"),
      };

      // 通勤km/出張km の位置がフォーマットにより入れ替わるため修正
      if (headerMap.has("通勤km")) {
        attendanceRow.通勤km = get("通勤km");
      }
      if (headerMap.has("出張km")) {
        attendanceRow.出張km = get("出張km");
      }

      // オプションカラム（Format B）
      if (headerMap.has("週残業")) attendanceRow.週残業 = get("週残業");
      if (headerMap.has("日残業")) attendanceRow.日残業 = get("日残業");
      if (headerMap.has("休日")) attendanceRow.休日 = get("休日");
      if (headerMap.has("法内残業")) attendanceRow.法内残業 = get("法内残業");
      if (headerMap.has("控除")) attendanceRow.控除 = get("控除");
      if (headerMap.has("備考")) attendanceRow.備考 = get("備考");

      attendanceRows.push(attendanceRow);
    }

    fillMissingRows(attendanceRows);

    // 合計行（行34）
    const totalsRow = rows[34];
    const totals = {
      breakTime: (totalsRow?.[18] ?? "").trim(),
      workHours: (totalsRow?.[19] ?? "").trim(),
      // ★ parseFloat("1,302") は 1。カンマ・全角を外してから読む (numeric-cell.ts)
      commuteKm: parseNumericCell(totalsRow?.[21]) ?? 0,
      businessKm: parseNumericCell(totalsRow?.[20]) ?? 0,
      overtimeHours: "0:00",
    };

    // 残業時間（行36付近）
    for (let i = 35; i < rows.length; i++) {
      const r = rows[i];
      for (let j = 0; j < (r?.length ?? 0); j++) {
        if ((r[j] ?? "").trim() === "残業時間" && r[j + 1]) {
          totals.overtimeHours = (r[j + 1] ?? "").trim();
          break;
        }
      }
    }

    const parsed: ParsedAttendance = {
      meta,
      rows: attendanceRows,
      totals,
    };

    return {
      success: errors.length === 0,
      data: [parsed],
      errors,
      fileName: file.name,
    };
  } catch (e) {
    return {
      success: false,
      data: [],
      errors: [
        `ファイル読み込みエラー: ${e instanceof Error ? e.message : String(e)}`,
      ],
      fileName: file.name,
    };
  }
}

/** "H:MM" → 分。読めなければ null */
function hhmmToMinutes(v: string | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((v ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function minutesToHhmm(min: number): string {
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
}

/**
 * 出勤簿の 1 日目だけ 勤務時間 が 0:00 のまま出てくる (出勤簿 xlsm の式の不具合。実測 63 ファイル)。
 * 開始・終了 があるのに 勤務時間 が 0 の日は 終了 − 開始 − 休憩 で埋める。
 * 休憩 も 0 のことがあるので、6 時間超のときは 1 時間を引く (事業所の出勤簿と同じ扱い)。
 *
 * 根拠: 総括表 2026-03〜07 の「出勤時間」と突合すると 494 人月中 411 → 459 一致に増える
 * (例 市原ムツミ 中村素子 2026-07: 130:30 → 138:30 = 総括表)。
 */
export function fillMissingWorkHours(row: AttendanceRow): void {
  if ((hhmmToMinutes(row.勤務時間) ?? 0) > 0) return;
  const pairs: [string | undefined, string | undefined][] = [
    [row.開始, row.終了], [row.開始2, row.終了2], [row.開始3, row.終了3],
    [row.開始4, row.終了4], [row.開始5, row.終了5],
  ];
  let gross = 0;
  for (const [st, en] of pairs) {
    const a = hhmmToMinutes(st), b = hhmmToMinutes(en);
    if (a === null || b === null || b <= a) continue;
    gross += b - a;
  }
  if (gross <= 0) return;
  const brk = hhmmToMinutes(row.休憩) ?? 0;
  const work = gross - (brk > 0 ? brk : gross > 360 ? 60 : 0);
  if (work > 0) row.勤務時間 = minutesToHhmm(work);
}

/**
 * ファイル 1 枚ぶんの穴埋め。
 *   1. 勤務時間 が 0 の日を 開始・終了 から埋める (fillMissingWorkHours)
 *   2. そこで埋めた日の 通勤km も空なので、その月の 通勤km が 1 種類しかないときだけ その値を入れる
 *
 * 出勤簿 xlsm は 1 日目だけ 勤務時間 も 通勤km も空で出てくる。総括表は両方入った値で計算している。
 * 通勤km は同じ人なら毎日同じ値のことが多い (実測 72 ファイル中 55 が 1 種類)。
 * 2 種類以上ある月は決められないので埋めない。
 *
 * 根拠: 総括表 2026-03〜07 の「距離(通)」と突合すると 61 人月中 7 → 45 一致に増える
 * (例 市原ムツミ 中村素子 2026-07: 172.8km → 182.4km = 総括表)。
 */
export function fillMissingRows(rows: AttendanceRow[]): void {
  const filled: AttendanceRow[] = [];
  for (const r of rows) {
    const before = r.勤務時間;
    fillMissingWorkHours(r);
    if (r.勤務時間 !== before) filled.push(r);
  }
  if (filled.length === 0) return;
  const kms = new Set(rows.map((r) => parseNumericCell(r.通勤km)).filter((v): v is number => v !== null && v > 0));
  if (kms.size !== 1) return;
  const km = [...kms][0];
  for (const r of filled) {
    if (!((parseNumericCell(r.通勤km) ?? 0) > 0)) r.通勤km = String(km);
  }
}

/**
 * 複数の出勤簿ファイルをパースする
 */
export async function parseAttendanceFiles(
  files: File[]
): Promise<{
  allData: ParsedAttendance[];
  results: CsvParseResult<ParsedAttendance>[];
}> {
  const results = await Promise.all(files.map(parseAttendanceFile));
  const allData = results.flatMap((r) => r.data);
  return { allData, results };
}
