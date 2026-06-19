/**
 * 一括取込 (= /csv-import/batch) 向けの「種別・事業所番号・年月」自動判定。
 *
 * 既存 importer の検出ロジックを集約するのではなく、batch UI 専用の軽量判定を
 * 提供する (= 既存 parser を呼び出すと CSV を 2 回読み直すコストが大きく、
 * batch ではファイル数が多いので、ヘッダ + 数行サンプリングだけで decide する)。
 *
 * 判定の優先順位:
 *   1) ヘッダ行の特徴的な列名 (= 種別)
 *   2) サンプル行から「事業所番号 (10 桁数字) / 提供年月 / 処理月」を抽出
 *   3) ファイル名 (= 補助、fallback)
 *
 * confidence:
 *   - high   : 種別 + officeNumber + yearMonth が全て埋まった
 *   - medium : 種別は分かったが 1 つ以上欠落
 *   - low    : 種別不明 (ファイル名からも引けない)
 */

import { parseCsvLines } from "../csv/decoder";
import type { DetectResult, ImporterKind } from "./types";

const BILLING_TYPE_KEYWORDS = [
  "01_介護_金額",
  "01_障害_金額",
  "02_介護_単位",
  "02_障害_単位",
  "03_介護_利用日",
  "03_障害_利用日",
];

/** 種別をヘッダ行から判定。決まらなければ null。 */
function detectKindByHeader(header: string[]): ImporterKind | null {
  const h = new Set(header.map((s) => (s ?? "").replace(/^"|"$/g, "").trim()));
  const has = (...keys: string[]) => keys.every((k) => h.has(k));

  // 国保連 居宅 (kyotaku): 提供年月 + 担当職員名 (or aliases) + 被保険者番号
  if (
    has("提供年月") &&
    (h.has("担当職員名") || h.has("担当者氏名") || h.has("担当者名") || h.has("ケアマネ名")) &&
    h.has("被保険者番号")
  ) {
    return "kyotaku";
  }

  // 介護予防件数 (yobou): 提供年月 + 請求年月 + 担当ケアマネ + 要支援件数
  if (
    (h.has("提供年月") || h.has("提供月") || h.has("サービス提供月")) &&
    (h.has("請求年月") || h.has("請求月")) &&
    (h.has("担当ケアマネ") || h.has("担当者") || h.has("ケアマネ")) &&
    (h.has("要支援1件数") || h.has("要支援１件数") || h.has("要支援1") || h.has("要支援２件数"))
  ) {
    return "yobou";
  }

  // 介護ソフト 明細 (meisai): 事業者名 + 処理月 + 職員番号 + 派遣開始時間 + サービス
  if (has("事業者名", "処理月", "職員番号", "派遣開始時間", "サービス")) {
    return "meisai";
  }

  // 請求 CSV (billing): 既存の detectBillingFileTypeByHeader を簡略化したもの
  // 03_障害: 1日〜31日 + 利用日数 + 入院日数
  if (has("利用者番号", "1日", "31日", "利用日数", "入院日数")) return "billing";
  // 03_介護: 1日〜31日 + 合計・回数 + 事業所番号
  if (has("事業所番号", "1日", "31日", "合計・回数")) return "billing";
  // 02_障害: サービス提供年月 + サービスコード + 単位数
  if (has("利用者番号", "サービス提供年月", "サービスコード", "単位数")) return "billing";
  // 02_介護: 介護サービス費内訳 + 単位数 + 事業所番号
  if (has("事業所番号", "介護サービス費内訳", "単位数")) return "billing";
  // 01_障害: 内部ID + 請求期間 + 事業者名 + 利用料項目
  if (has("内部ID", "請求期間", "事業者名", "利用料項目")) return "billing";
  // 01_介護: 事業所番号 + 請求年月 + 利用料項目 + 金額
  if (has("事業所番号", "請求年月", "利用料項目", "金額")) return "billing";

  return null;
}

/** ファイル名から種別を判定 (fallback)。 */
function detectKindByFilename(filename: string): ImporterKind | null {
  const lower = filename.toLowerCase();
  if (!lower.endsWith(".csv")) return null;
  for (const k of BILLING_TYPE_KEYWORDS) {
    if (filename.includes(k)) return "billing";
  }
  // 緩いマッチ (担当者の運用上の命名規則を当て込む)
  if (filename.includes("meisai") || filename.includes("MEISAI") || filename.includes("明細")) return "meisai";
  if (filename.includes("kyotaku") || filename.includes("居宅")) return "kyotaku";
  if (filename.includes("yobou") || filename.includes("予防")) return "yobou";
  return null;
}

/**
 * 年月文字列を "YYYY-MM" に正規化。
 * (kokuho-parser.ts の normalizeMonth と互換だが、batch 用に YYYY-MM だけ返す簡略版)
 */
export function normalizeYearMonth(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  // YYYY-MM(-DD?) / YYYY/M(/D?)
  let m = /^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}`;
  // YYYY年M月(D日?)
  m = /^(\d{4})年(\d{1,2})月(?:\d{1,2}日)?$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}`;
  // YYYYMM
  m = /^(\d{4})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}`;
  // YYYYMMDD
  m = /^(\d{4})(\d{2})\d{2}$/.exec(s);
  if (m) return `${m[1]}-${m[2]}`;
  return null;
}

/** ファイル名から年月を抽出 (例: "2026_05_kyotaku.csv" / "中央_2026年5月.csv" / "20260501.csv")。 */
function extractYearMonthFromFilename(filename: string): string | null {
  // YYYY[-_]MM
  let m = /(\d{4})[-_/年](\d{1,2})/.exec(filename);
  if (m) {
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    if (y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12) {
      return `${y}-${String(mo).padStart(2, "0")}`;
    }
  }
  // YYYYMM 連続 6 桁 (誤検出を避けるため YYYYMMDD は YYYY-MM のみ取り出す)
  m = /(?<!\d)(\d{4})(\d{2})(?!\d)/.exec(filename);
  if (m) {
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    if (y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12) {
      return `${y}-${String(mo).padStart(2, "0")}`;
    }
  }
  return null;
}

/** ファイル名から事業所番号 (10 桁) を抽出。 */
function extractOfficeNumberFromFilename(filename: string): string | null {
  const m = /(?<!\d)(\d{10})(?!\d)/.exec(filename);
  return m ? m[1] : null;
}

/** ヘッダの列名から index を引く helper (alias 群を順に試す)。 */
function headerIndex(header: string[], names: readonly string[]): number {
  for (const n of names) {
    const i = header.findIndex((h) => (h ?? "").trim() === n);
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * メイン: テキスト全文 + ファイル名から判定。
 * UTF-8 / Shift-JIS どちらの text でも構わない (呼び出し側で decode 済みを渡す)。
 */
export function detectFromText(text: string, filename: string): DetectResult {
  let rows: string[][];
  try {
    rows = parseCsvLines(text);
  } catch (e) {
    return {
      kind: detectKindByFilename(filename) ?? "unknown",
      officeNumber: extractOfficeNumberFromFilename(filename),
      yearMonth: extractYearMonthFromFilename(filename),
      rowCount: 0,
      confidence: "low",
      notes: `CSV パース失敗: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (rows.length < 1) {
    return {
      kind: detectKindByFilename(filename) ?? "unknown",
      officeNumber: extractOfficeNumberFromFilename(filename),
      yearMonth: extractYearMonthFromFilename(filename),
      rowCount: 0,
      confidence: "low",
      notes: "空ファイル",
    };
  }

  const header = (rows[0] ?? []).map((h) => (h ?? "").trim());
  const rowCount = Math.max(0, rows.length - 1);

  const headerKind = detectKindByHeader(header);
  const fnameKind = detectKindByFilename(filename);
  const kind: ImporterKind | "unknown" = headerKind ?? fnameKind ?? "unknown";

  // 事業所番号・年月の自動抽出 (種別ごとに列の位置/名前が違う)
  let officeNumber: string | null = null;
  let yearMonth: string | null = null;
  const notes: string[] = [];

  // サンプル行を 5 行まで見る (空行はスキップ)
  const sampleRows: string[][] = [];
  for (let i = 1; i < rows.length && sampleRows.length < 5; i++) {
    const r = rows[i];
    if (!r || r.every((c) => (c ?? "").trim() === "")) continue;
    sampleRows.push(r);
  }

  if (kind === "kyotaku") {
    // 国保連: 提供年月 列 + 事業所番号は CSV に無いことが多いのでファイル名 fallback
    const idxMonth = headerIndex(header, ["提供年月"]);
    if (idxMonth >= 0) {
      for (const r of sampleRows) {
        const ym = normalizeYearMonth(r[idxMonth]);
        if (ym) { yearMonth = ym; break; }
      }
    }
    officeNumber = extractOfficeNumberFromFilename(filename);
    if (!officeNumber) notes.push("事業所番号がファイル名から取れません");
  } else if (kind === "yobou") {
    const idxMonth = headerIndex(header, ["提供年月", "提供月", "サービス提供月"]);
    if (idxMonth >= 0) {
      for (const r of sampleRows) {
        const ym = normalizeYearMonth(r[idxMonth]);
        if (ym) { yearMonth = ym; break; }
      }
    }
    officeNumber = extractOfficeNumberFromFilename(filename);
    if (!officeNumber) notes.push("事業所番号がファイル名から取れません");
  } else if (kind === "meisai") {
    // meisai CSV: 事業所番号は各行末尾近く、処理月は列名 "処理月"
    const idxMonth = headerIndex(header, ["処理月"]);
    if (idxMonth >= 0) {
      for (const r of sampleRows) {
        const ym = normalizeYearMonth(r[idxMonth]);
        if (ym) { yearMonth = ym; break; }
      }
    }
    // 事業所番号: meisai-parser の解釈 (末尾 3 列のうち先頭 = 事業所番号)
    const colCount = header.length;
    const tailStartIdx = colCount - 3;
    if (tailStartIdx >= 0) {
      for (const r of sampleRows) {
        const v = (r[tailStartIdx] ?? "").trim();
        if (/^\d{10}$/.test(v)) { officeNumber = v; break; }
      }
    }
    if (!officeNumber) officeNumber = extractOfficeNumberFromFilename(filename);
  } else if (kind === "billing") {
    // billing は alias 解決が必要なので batch では auto 取込しない
    // 表示用に年月だけ拾えればよい
    yearMonth = extractYearMonthFromFilename(filename);
    officeNumber = null;
    notes.push("請求 CSV は alias 解決が必要なため、専用画面 (/billing/import) で取込んでください");
  } else {
    // unknown
    officeNumber = extractOfficeNumberFromFilename(filename);
    yearMonth = extractYearMonthFromFilename(filename);
  }

  let confidence: "high" | "medium" | "low";
  if (kind === "unknown") {
    confidence = "low";
  } else if (kind === "billing") {
    // 種別だけ分かれば medium (どのみち batch では実行しない)
    confidence = yearMonth ? "medium" : "low";
  } else {
    const haveAll = !!officeNumber && !!yearMonth;
    confidence = haveAll ? "high" : "medium";
  }

  return {
    kind,
    officeNumber,
    yearMonth,
    rowCount,
    confidence,
    notes: notes.length > 0 ? notes.join(" / ") : undefined,
  };
}

/**
 * テキストを decode してから detect する helper (UTF-8 / Shift-JIS 自動判定)。
 * batch UI は file を 1 回読んでから detect & process の両方に流す。
 */
export function decodeCsv(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  // UTF-8 BOM
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  // UTF-8 strict
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Shift-JIS fallback
    return new TextDecoder("shift_jis").decode(bytes);
  }
}
