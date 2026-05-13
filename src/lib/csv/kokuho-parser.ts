/**
 * 国保連介護給付費請求 CSV (居宅介護支援事業所用) を読み込み、
 * payroll_kyotaku_records テーブルへの INSERT 用 row 配列に変換する。
 *
 * - エンコーディング: Shift-JIS (cp932) - 既存 decoder.ts を利用
 * - ヘッダ列名: CSV により揺れがあるためフォールバック対応
 *   (元 Python apps/居宅給与計算/集計.py の row.get(...) 互換性確保)
 *
 * 関連:
 *  - apps/居宅給与計算/SPEC.md §1, §6, §8
 *  - apps/payroll-app/migrations/payroll_kyotaku_v1.sql (テーブル定義)
 *  - apps/payroll-app/src/lib/csv/decoder.ts (Shift-JIS デコーダ)
 */

import { decodeCP932, parseCsvLines } from "./decoder";

// =====================================================================
// 型定義
// =====================================================================
export type KokuhoCsvRow = {
  service_month: string;           // YYYY-MM-01
  billing_month: string;           // YYYY-MM-01
  staff_name: string;
  detail_row_no: string | null;
  insured_number: string | null;
  insured_name: string | null;
  client_number: string | null;
  gender: string | null;
  birth_date: string | null;       // YYYY-MM-DD
  care_level: string | null;
  insurer_number: string | null;
  insurer_name: string | null;
  service_code: string | null;
  service_name: string | null;
  unit_total: number | null;
  unit_price: number | null;
  amount: number | null;
  cert_start_date: string | null;  // YYYY-MM-DD
  cert_end_date: string | null;    // YYYY-MM-DD
  staff_number: string | null;
  staff_identifier: string | null;
  kyotaku_office_number: string | null;
  kyotaku_office_name: string | null;
  kyotaku_support_number: string | null;
  receiver_number: string | null;
};

export type KokuhoParseError = {
  line: number;
  reason: string;
};

export type KokuhoParseResult = {
  rows: KokuhoCsvRow[];
  errors: KokuhoParseError[];
};

// =====================================================================
// ヘッダ名フォールバック表
// CSV の列名揺れを吸収する。Python: row.get("保険者", row.get("保険者名", "")) 相当
// =====================================================================
const HEADER_ALIASES: Record<keyof Omit<KokuhoCsvRow, never>, string[]> = {
  service_month: ["提供年月"],
  billing_month: ["請求年月", "決定年月", "請求年月日", "決定年月日"],
  staff_name: ["担当職員名", "担当者氏名", "担当者名", "ケアマネ名"],
  detail_row_no: ["明細行番号"],
  insured_number: ["被保険者番号"],
  insured_name: ["被保険者名", "氏名"],
  client_number: ["利用者番号"],
  gender: ["性別"],
  birth_date: ["生年月日"],
  care_level: ["要介護度"],
  insurer_number: ["保険者番号"],
  insurer_name: ["保険者名", "保険者"],
  service_code: ["サービスコード"],
  service_name: ["サービス名"],
  unit_total: ["単位数合計（点数）", "単位数合計", "単位数"],
  unit_price: ["単位数単価", "単価"],
  amount: ["請求額", "金額"],
  cert_start_date: ["認定期間（開始）", "認定期間開始", "認定開始日"],
  cert_end_date: ["認定期間（終了）", "認定期間終了", "認定終了日"],
  staff_number: ["担当職員番号", "担当者番号"],
  staff_identifier: ["担当者識別番号", "担当職員識別番号"],
  kyotaku_office_number: ["居宅介護支援事業所番号"],
  kyotaku_office_name: ["居宅介護支援事業者名", "居宅介護支援事業所名"],
  kyotaku_support_number: ["居宅介護支援専門員番号", "居宅介護支援番号"],
  receiver_number: ["公費受給者番号", "給付受給者番号"],
};

// =====================================================================
// ユーティリティ: 月正規化 (SPEC.md §6 多形式対応)
// 戻り値は YYYY-MM-01 形式 (DATE 互換)、変換不能なら null
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
// ユーティリティ: 日付正規化 (YYYY-MM-DD)
// 認定期間や生年月日用。月のみが来た場合は 01 を補う。
// =====================================================================
function normalizeDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  // YYYY年M月D日
  let m = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(s);
  if (m) {
    const yyyy = m[1];
    const mm = String(parseInt(m[2], 10)).padStart(2, "0");
    const dd = String(parseInt(m[3], 10)).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  // YYYY年M月 (日が欠落) → 1 日扱い
  m = /^(\d{4})年(\d{1,2})月$/.exec(s);
  if (m) {
    const yyyy = m[1];
    const mm = String(parseInt(m[2], 10)).padStart(2, "0");
    return `${yyyy}-${mm}-01`;
  }

  // YYYY/M/D
  m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (m) {
    const yyyy = m[1];
    const mm = String(parseInt(m[2], 10)).padStart(2, "0");
    const dd = String(parseInt(m[3], 10)).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  // YYYY-M-D / YYYY-MM-DD
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    const yyyy = m[1];
    const mm = String(parseInt(m[2], 10)).padStart(2, "0");
    const dd = String(parseInt(m[3], 10)).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  // YYYYMMDD
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) {
    return `${m[1]}-${m[2]}-${m[3]}`;
  }

  return null;
}

// =====================================================================
// ユーティリティ: 数値正規化 (空文字 / null → null)
// Excel から float 文字列が来ることがあるので Number で受ける
// =====================================================================
function normalizeNumber(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const s = raw.trim();
  if (!s) return null;
  // カンマ区切り対応
  const cleaned = s.replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// =====================================================================
// ユーティリティ: 文字列正規化 (空 → null)
// =====================================================================
function normalizeString(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = raw.trim();
  return s ? s : null;
}

// =====================================================================
// ヘッダマップ helper
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
  headerMap: Map<string, number>,
  aliases: readonly string[],
): string | null {
  const idx = findHeaderIndex(headerMap, aliases);
  if (idx === undefined) return null;
  const v = row[idx];
  if (v === undefined || v === null) return null;
  const trimmed = v.trim();
  return trimmed ? trimmed : null;
}

// =====================================================================
// メイン: parseKokuhoCsv
// =====================================================================
export async function parseKokuhoCsv(
  file: File | ArrayBuffer,
): Promise<KokuhoParseResult> {
  const errors: KokuhoParseError[] = [];
  const rows: KokuhoCsvRow[] = [];

  let buffer: ArrayBuffer;
  if (file instanceof ArrayBuffer) {
    buffer = file;
  } else {
    buffer = await file.arrayBuffer();
  }

  let csvRows: string[][];
  try {
    const text = decodeCP932(buffer);
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

  // 必須列の検証
  const serviceMonthIdx = findHeaderIndex(headerMap, HEADER_ALIASES.service_month);
  const staffNameIdx = findHeaderIndex(headerMap, HEADER_ALIASES.staff_name);
  if (serviceMonthIdx === undefined) {
    errors.push({ line: 1, reason: "必須列「提供年月」が見つかりません" });
  }
  if (staffNameIdx === undefined) {
    errors.push({
      line: 1,
      reason: "必須列「担当職員名」(または「担当者氏名」) が見つかりません",
    });
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
      const serviceMonthRaw = getCell(row, headerMap, HEADER_ALIASES.service_month);
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

      const staffName = getCell(row, headerMap, HEADER_ALIASES.staff_name);
      if (!staffName) {
        errors.push({ line: lineNo, reason: "担当職員名が空です" });
        continue;
      }

      // 請求年月 (フォールバック: 不明な場合は提供年月+1 ヶ月 = 翌月請求扱いを app 側で算出する想定)
      // ここでは raw が無い場合 service_month を流用する (1 件落とすより継続を優先)
      const billingMonthRaw = getCell(row, headerMap, HEADER_ALIASES.billing_month);
      const billingMonth = billingMonthRaw
        ? normalizeMonth(billingMonthRaw)
        : serviceMonth;
      if (!billingMonth) {
        errors.push({
          line: lineNo,
          reason: `請求年月の形式が不正: "${billingMonthRaw}"`,
        });
        continue;
      }

      const parsedRow: KokuhoCsvRow = {
        service_month: serviceMonth,
        billing_month: billingMonth,
        staff_name: staffName,
        detail_row_no: normalizeString(
          getCell(row, headerMap, HEADER_ALIASES.detail_row_no),
        ),
        insured_number: normalizeString(
          getCell(row, headerMap, HEADER_ALIASES.insured_number),
        ),
        insured_name: normalizeString(
          getCell(row, headerMap, HEADER_ALIASES.insured_name),
        ),
        client_number: normalizeString(
          getCell(row, headerMap, HEADER_ALIASES.client_number),
        ),
        gender: normalizeString(getCell(row, headerMap, HEADER_ALIASES.gender)),
        birth_date: normalizeDate(
          getCell(row, headerMap, HEADER_ALIASES.birth_date),
        ),
        care_level: normalizeString(
          getCell(row, headerMap, HEADER_ALIASES.care_level),
        ),
        insurer_number: normalizeString(
          getCell(row, headerMap, HEADER_ALIASES.insurer_number),
        ),
        insurer_name: normalizeString(
          getCell(row, headerMap, HEADER_ALIASES.insurer_name),
        ),
        service_code: normalizeString(
          getCell(row, headerMap, HEADER_ALIASES.service_code),
        ),
        service_name: normalizeString(
          getCell(row, headerMap, HEADER_ALIASES.service_name),
        ),
        unit_total: normalizeNumber(
          getCell(row, headerMap, HEADER_ALIASES.unit_total),
        ),
        unit_price: normalizeNumber(
          getCell(row, headerMap, HEADER_ALIASES.unit_price),
        ),
        amount: normalizeNumber(getCell(row, headerMap, HEADER_ALIASES.amount)),
        cert_start_date: normalizeDate(
          getCell(row, headerMap, HEADER_ALIASES.cert_start_date),
        ),
        cert_end_date: normalizeDate(
          getCell(row, headerMap, HEADER_ALIASES.cert_end_date),
        ),
        staff_number: normalizeString(
          getCell(row, headerMap, HEADER_ALIASES.staff_number),
        ),
        staff_identifier: normalizeString(
          getCell(row, headerMap, HEADER_ALIASES.staff_identifier),
        ),
        kyotaku_office_number: normalizeString(
          getCell(row, headerMap, HEADER_ALIASES.kyotaku_office_number),
        ),
        kyotaku_office_name: normalizeString(
          getCell(row, headerMap, HEADER_ALIASES.kyotaku_office_name),
        ),
        kyotaku_support_number: normalizeString(
          getCell(row, headerMap, HEADER_ALIASES.kyotaku_support_number),
        ),
        receiver_number: normalizeString(
          getCell(row, headerMap, HEADER_ALIASES.receiver_number),
        ),
      };

      rows.push(parsedRow);
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
