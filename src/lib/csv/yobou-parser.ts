/**
 * 介護予防支援 件数 CSV パーサ (独自フォーマット)
 *
 * 想定ヘッダ (列名揺れは HEADER_ALIASES で吸収):
 *   提供年月, 請求年月, 担当ケアマネ, 要支援1件数, 要支援2件数
 *
 * - 文字コード: UTF-8 (BOM 可) または Shift-JIS の両対応
 *   (国保連 CSV と違い、Excel 手出力で UTF-8 が混ざることを想定)
 * - 1 row = 1 staff × 1 提供月 × 1 請求月 の集約形式
 *   (= 国保連系の明細行ベース parser とは別系統)
 *
 * 関連:
 *   - apps/payroll-app/migrations/payroll_kyotaku_yobou_records.sql (テーブル定義)
 *   - apps/payroll-app/src/lib/csv/kokuho-parser.ts (姉妹 parser、API スタイル合わせ)
 *   - apps/payroll-app/src/lib/csv/decoder.ts (Shift-JIS デコーダ + CSV 行分割)
 */

import { decodeCP932, parseCsvLines } from "./decoder";

// =====================================================================
// 型定義
// =====================================================================
export type YobouCsvRow = {
  service_month: string;  // YYYY-MM-01
  billing_month: string;  // YYYY-MM-01
  staff_name: string;
  yobou1_count: number;
  yobou2_count: number;
};

export type YobouParseError = {
  line: number;
  reason: string;
};

export type YobouParseResult = {
  rows: YobouCsvRow[];
  errors: YobouParseError[];
};

// =====================================================================
// ヘッダ名フォールバック表
// 全角数字 / 「件数」省略 / 「担当者」表記揺れ等を吸収
// =====================================================================
const HEADER_ALIASES = {
  service_month: ["提供年月", "提供月", "サービス提供月"],
  billing_month: ["請求年月", "請求月"],
  staff_name: ["担当ケアマネ", "担当者", "ケアマネ"],
  yobou1: ["要支援1件数", "要支援１件数", "要支援1", "要支援１"],
  yobou2: ["要支援2件数", "要支援２件数", "要支援2", "要支援２"],
} as const;

// =====================================================================
// ユーティリティ: 月正規化 (YYYY-MM-01 形式に統一、不能なら null)
// kokuho-parser.ts の normalizeMonth と同一ロジック。
// (重複は許容: yobou は独自フォーマットなので将来別個に拡張する余地を残す)
// =====================================================================
export function normalizeMonth(raw: string): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  // YYYY年M月D日 / YYYY年M月
  let m = /^(\d{4})年(\d{1,2})月(?:\d{1,2}日)?$/.exec(s);
  if (m) {
    const yyyy = m[1];
    const mm = String(parseInt(m[2], 10)).padStart(2, "0");
    return `${yyyy}-${mm}-01`;
  }

  // YYYY/M/D
  m = /^(\d{4})\/(\d{1,2})\/\d{1,2}$/.exec(s);
  if (m) {
    const yyyy = m[1];
    const mm = String(parseInt(m[2], 10)).padStart(2, "0");
    return `${yyyy}-${mm}-01`;
  }

  // YYYY/M または YYYY/MM
  m = /^(\d{4})\/(\d{1,2})$/.exec(s);
  if (m) {
    const yyyy = m[1];
    const mm = String(parseInt(m[2], 10)).padStart(2, "0");
    return `${yyyy}-${mm}-01`;
  }

  // YYYY-M-D / YYYY-MM-DD
  m = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(s);
  if (m) {
    const yyyy = m[1];
    const mm = String(parseInt(m[2], 10)).padStart(2, "0");
    return `${yyyy}-${mm}-01`;
  }

  // YYYYMM
  m = /^(\d{4})(\d{2})$/.exec(s);
  if (m) {
    return `${m[1]}-${m[2]}-01`;
  }

  return null;
}

// =====================================================================
// ユーティリティ: 整数件数正規化
// 空文字 / null → 0、負数や非整数は null (= 「不正」を呼び出し側で扱う)
// =====================================================================
export function normalizeCount(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return 0;
  const s = raw.trim();
  if (!s) return 0;
  // カンマ区切り対応 ("1,000" 等)
  const cleaned = s.replace(/,/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return null;
  if (!Number.isInteger(n)) return null;
  return n;
}

// =====================================================================
// ユーティリティ: UTF-8 / Shift-JIS 自動判定 + デコード
//   - 先頭 3 byte が EF BB BF (UTF-8 BOM) → UTF-8、BOM 除去
//   - UTF-8 として fatal: true でデコードできれば UTF-8
//   - だめなら Shift-JIS (CP932) として decodeCP932 にフォールバック
// =====================================================================
function decodeCsvBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);

  // UTF-8 BOM 検出
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }

  // UTF-8 strict デコード試行 (不正シーケンスがあれば throw)
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Shift-JIS にフォールバック
    return decodeCP932(buffer);
  }
}

// =====================================================================
// ヘッダ map helper
// =====================================================================
function findHeaderIndex(
  headerMap: Map<string, number>,
  aliases: readonly string[],
): number | undefined {
  for (const name of aliases) {
    const idx = headerMap.get(name);
    if (idx !== undefined) return idx;
  }
  return undefined;
}

function getCell(
  row: readonly string[],
  idx: number | undefined,
): string | null {
  if (idx === undefined) return null;
  const v = row[idx];
  if (v === undefined || v === null) return null;
  const trimmed = v.trim();
  return trimmed ? trimmed : null;
}

// =====================================================================
// メイン: parseYobouCsv
// =====================================================================
export async function parseYobouCsv(
  file: File | ArrayBuffer,
): Promise<YobouParseResult> {
  const errors: YobouParseError[] = [];
  const rows: YobouCsvRow[] = [];

  let buffer: ArrayBuffer;
  if (file instanceof ArrayBuffer) {
    buffer = file;
  } else {
    buffer = await file.arrayBuffer();
  }

  let csvRows: string[][];
  try {
    const text = decodeCsvBuffer(buffer);
    csvRows = parseCsvLines(text);
  } catch (e) {
    return {
      rows: [],
      errors: [
        {
          line: 0,
          reason: `CSV デコードエラー: ${
            e instanceof Error ? e.message : String(e)
          }`,
        },
      ],
    };
  }

  if (csvRows.length < 2) {
    return {
      rows: [],
      errors: [{ line: 0, reason: "データ行がありません" }],
    };
  }

  const headers = csvRows[0];
  const headerMap = new Map<string, number>();
  headers.forEach((h, i) => {
    if (h !== undefined && h !== null) {
      headerMap.set(h.trim(), i);
    }
  });

  // 必須列の検証 (全 5 列が揃わなければ errors に追加して即 return)
  const serviceMonthIdx = findHeaderIndex(headerMap, HEADER_ALIASES.service_month);
  const billingMonthIdx = findHeaderIndex(headerMap, HEADER_ALIASES.billing_month);
  const staffNameIdx = findHeaderIndex(headerMap, HEADER_ALIASES.staff_name);
  const yobou1Idx = findHeaderIndex(headerMap, HEADER_ALIASES.yobou1);
  const yobou2Idx = findHeaderIndex(headerMap, HEADER_ALIASES.yobou2);

  if (serviceMonthIdx === undefined) {
    errors.push({ line: 1, reason: "必須列「提供年月」が見つかりません" });
  }
  if (billingMonthIdx === undefined) {
    errors.push({ line: 1, reason: "必須列「請求年月」が見つかりません" });
  }
  if (staffNameIdx === undefined) {
    errors.push({
      line: 1,
      reason: "必須列「担当ケアマネ」(または「担当者」「ケアマネ」) が見つかりません",
    });
  }
  if (yobou1Idx === undefined) {
    errors.push({ line: 1, reason: "必須列「要支援1件数」が見つかりません" });
  }
  if (yobou2Idx === undefined) {
    errors.push({ line: 1, reason: "必須列「要支援2件数」が見つかりません" });
  }
  if (errors.length > 0) {
    return { rows: [], errors };
  }

  // データ行ループ
  for (let i = 1; i < csvRows.length; i++) {
    const row = csvRows[i];
    if (!row || row.length === 0) continue;
    if (row.every((c) => (c ?? "").trim() === "")) continue;

    const lineNo = i + 1; // 1-based、ヘッダが 1 行目

    try {
      const serviceMonthRaw = getCell(row, serviceMonthIdx);
      if (!serviceMonthRaw) {
        errors.push({ line: lineNo, reason: "提供年月が空です" });
        continue;
      }
      const serviceMonth = normalizeMonth(serviceMonthRaw);
      if (!serviceMonth) {
        errors.push({
          line: lineNo,
          reason: `提供年月の形式が不正: "${serviceMonthRaw}"`,
        });
        continue;
      }

      const billingMonthRaw = getCell(row, billingMonthIdx);
      if (!billingMonthRaw) {
        errors.push({ line: lineNo, reason: "請求年月が空です" });
        continue;
      }
      const billingMonth = normalizeMonth(billingMonthRaw);
      if (!billingMonth) {
        errors.push({
          line: lineNo,
          reason: `請求年月の形式が不正: "${billingMonthRaw}"`,
        });
        continue;
      }

      const staffName = getCell(row, staffNameIdx);
      if (!staffName) {
        errors.push({ line: lineNo, reason: "担当ケアマネが空です" });
        continue;
      }

      const yobou1Raw = getCell(row, yobou1Idx);
      const yobou1Count = normalizeCount(yobou1Raw);
      if (yobou1Count === null) {
        errors.push({
          line: lineNo,
          reason: `要支援1件数の値が不正: "${yobou1Raw}"`,
        });
        continue;
      }

      const yobou2Raw = getCell(row, yobou2Idx);
      const yobou2Count = normalizeCount(yobou2Raw);
      if (yobou2Count === null) {
        errors.push({
          line: lineNo,
          reason: `要支援2件数の値が不正: "${yobou2Raw}"`,
        });
        continue;
      }

      rows.push({
        service_month: serviceMonth,
        billing_month: billingMonth,
        staff_name: staffName,
        yobou1_count: yobou1Count,
        yobou2_count: yobou2Count,
      });
    } catch (e) {
      errors.push({
        line: lineNo,
        reason: `行パースエラー: ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
    }
  }

  return { rows, errors };
}
