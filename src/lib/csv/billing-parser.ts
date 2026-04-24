/**
 * 介護ソフトから出力される請求CSVのパーサ
 * 6ファイル対応: 01_金額 / 02_単位 / 03_利用日 × 介護 / 障害
 */

import { readCsvFile } from "./decoder";

export type BillingFileType =
  | "01_介護_金額" | "01_障害_金額"
  | "02_介護_単位" | "02_障害_単位"
  | "03_介護_利用日" | "03_障害_利用日";

export type BillingAmountItem = {
  segment: "介護" | "障害";
  office_number: string;
  office_name: string;
  client_number: string;
  client_name: string;
  billing_month: string; // YYYYMM
  service_item_code: string | null;
  service_item: string;
  unit_price: number | null;
  quantity: number | null;
  amount: number;
  tax_amount: number | null;
  reduction_amount: number | null;
  medical_deduction: number | null;
  period_start: string | null;
  period_end: string | null;
  status: string | null;
  raw: Record<string, string>;
};

export type BillingUnitItem = {
  segment: "介護" | "障害";
  office_number: string;
  client_number: string;
  client_name: string;
  billing_month: string;
  service_name: string;
  service_code: string | null;
  unit_count: number | null;
  unit_type: string | null;
  repetition: number | null;
  amount: number | null;
  raw: Record<string, string>;
};

export type BillingDailyItem = {
  segment: "介護" | "障害";
  office_number: string;
  client_number: string;
  client_name: string;
  billing_month: string;
  service_name: string;
  service_code: string | null;
  day: number;
  quantity: number;
};

// ─── 汎用ユーティリティ ──────────────────────────────

/**
 * ファイル名から種別を判別（副次的な手段）
 */
export function detectBillingFileTypeByFilename(filename: string): BillingFileType | null {
  const lower = filename.toLowerCase();
  if (!lower.endsWith(".csv")) return null;
  if (filename.includes("01_介護_金額")) return "01_介護_金額";
  if (filename.includes("01_障害_金額")) return "01_障害_金額";
  if (filename.includes("02_介護_単位")) return "02_介護_単位";
  if (filename.includes("02_障害_単位")) return "02_障害_単位";
  if (filename.includes("03_介護_利用日")) return "03_介護_利用日";
  if (filename.includes("03_障害_利用日")) return "03_障害_利用日";
  return null;
}

/**
 * CSVのヘッダ列名から種別を判別する（主判定手段）
 * 特徴的な列の組み合わせで一意に判別できる。
 */
export function detectBillingFileTypeByHeader(header: string[]): BillingFileType | null {
  const h = new Set(header.map((s) => s.replace(/^"|"$/g, "").trim()));
  const has = (...keys: string[]) => keys.every((k) => h.has(k));

  // 最も特徴的なものから先に判定
  // 03_障害: 1日〜31日 + "利用日数" + "入院日数"（介護の03にはこれらが揃わない）
  if (has("利用者番号", "1日", "31日", "利用日数", "入院日数")) return "03_障害_利用日";
  // 03_介護: 1日〜31日 + "合計・回数" + "事業所番号"
  if (has("事業所番号", "1日", "31日", "合計・回数")) return "03_介護_利用日";
  // 02_障害: サービス提供年月 + サービスコード + 受給者証番号
  if (has("利用者番号", "サービス提供年月", "サービスコード", "単位数")) return "02_障害_単位";
  // 02_介護: 介護サービス費内訳 + 単位/点/円 + 事業所番号
  if (has("事業所番号", "介護サービス費内訳", "単位数")) return "02_介護_単位";
  // 01_障害: 内部ID + 請求期間 + 事業者名 + 請求・入金
  if (has("内部ID", "請求期間", "事業者名", "利用料項目")) return "01_障害_金額";
  // 01_介護: 事業所番号 + 請求年月 + 利用料項目 + 金額
  if (has("事業所番号", "請求年月", "利用料項目", "金額")) return "01_介護_金額";
  return null;
}

/**
 * ファイル内容から種別を判別（ヘッダを読んで判定）。
 * 見つからなければファイル名から判定にフォールバック。
 */
export async function detectBillingFileType(file: File): Promise<BillingFileType | null> {
  try {
    const rows = await readCsvFile(file);
    if (rows.length > 0) {
      const byHeader = detectBillingFileTypeByHeader(rows[0]);
      if (byHeader) return byHeader;
    }
  } catch {
    // 読めなければファイル名判定
  }
  return detectBillingFileTypeByFilename(file.name);
}

/**
 * "24-Oct" や "2024/10" や "202410" を "202410" に正規化
 */
function normalizeBillingMonth(raw: string): string {
  if (!raw) return "";
  const s = raw.trim();
  // YYYYMM
  if (/^\d{6}$/.test(s)) return s;
  // YYYY/MM or YYYY-MM
  const m1 = s.match(/^(\d{4})[/-](\d{1,2})$/);
  if (m1) return `${m1[1]}${m1[2].padStart(2, "0")}`;
  // YY-Mon (Excel)  例: 24-Oct
  const monthMap: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  const m2 = s.match(/^(\d{2})-([A-Za-z]{3})$/);
  if (m2) {
    const yy = parseInt(m2[1], 10);
    const mm = monthMap[m2[2].toLowerCase()];
    if (mm) return `20${String(yy).padStart(2, "0")}${mm}`;
  }
  // YYYY年M月
  const m3 = s.match(/^(\d{4})年(\d{1,2})月$/);
  if (m3) return `${m3[1]}${m3[2].padStart(2, "0")}`;
  return s;
}

function toNum(v: string | undefined): number | null {
  if (!v) return null;
  const s = v.replace(/,/g, "").trim();
  if (s === "") return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function toInt(v: string | undefined): number | null {
  const n = toNum(v);
  return n == null ? null : Math.round(n);
}

function toDate(v: string | undefined): string | null {
  if (!v) return null;
  const s = v.trim();
  if (!s) return null;
  // YYYY/M/D or YYYY-M-D
  const m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return null;
}

// ─── 01_介護_金額 パーサ ─────────────────────────────
// カラムに「支払方法」が2回出てくる（12列目と62列目）ので、最初の出現を使う

export async function parse01KaigoAmount(file: File): Promise<{ data: BillingAmountItem[]; errors: string[] }> {
  const errors: string[] = [];
  const rows = await readCsvFile(file);
  if (rows.length < 2) return { data: [], errors: ["データ行がありません"] };

  // ヘッダは重複列があるので独自処理
  const header = rows[0];
  const idxOnce: Record<string, number> = {};
  for (let i = 0; i < header.length; i++) {
    const h = header[i].trim();
    if (h && idxOnce[h] === undefined) idxOnce[h] = i;
  }

  const data: BillingAmountItem[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (key: string) => (idxOnce[key] != null ? (r[idxOnce[key]] ?? "").trim() : "");
    const clientNumber = get("利用者番号");
    if (!clientNumber) continue;
    const rawObj: Record<string, string> = {};
    for (const k of Object.keys(idxOnce)) rawObj[k] = get(k);

    data.push({
      segment: "介護",
      office_number: get("事業所番号"),
      office_name: get("事業所名"),
      client_number: clientNumber,
      client_name: get("利用者名"),
      billing_month: normalizeBillingMonth(get("請求年月") || get("提供年月")),
      service_item_code: get("利用料項目コード") || null,
      service_item: get("利用料項目"),
      unit_price: toNum(get("単価")),
      quantity: toNum(get("数量")),
      amount: toInt(get("金額")) ?? 0,
      tax_amount: toInt(get("消費税額")),
      reduction_amount: toInt(get("軽減額")),
      medical_deduction: toInt(get("医療費控除対象額")),
      period_start: toDate(get("集計開始日")),
      period_end: toDate(get("集計終了日")),
      status: get("状態") || null,
      raw: rawObj,
    });
  }
  return { data, errors };
}

// ─── 01_障害_金額 パーサ ─────────────────────────────

export async function parse01ShogaiAmount(file: File): Promise<{ data: BillingAmountItem[]; errors: string[] }> {
  const errors: string[] = [];
  const rows = await readCsvFile(file);
  if (rows.length < 2) return { data: [], errors: ["データ行がありません"] };

  const header = rows[0].map((h) => h.trim());
  const idx: Record<string, number> = {};
  header.forEach((h, i) => { if (h && idx[h] === undefined) idx[h] = i; });

  const data: BillingAmountItem[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (k: string) => (idx[k] != null ? (r[idx[k]] ?? "").trim() : "");
    const clientNumber = get("利用者番号");
    if (!clientNumber) continue;
    const rawObj: Record<string, string> = {};
    for (const k of Object.keys(idx)) rawObj[k] = get(k);

    // 障害は「請求期間」が "YYYY/MM/DD〜YYYY/MM/DD" 形式の可能性
    const period = get("請求期間");
    const mPeriod = period.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
    const billingMonth = mPeriod ? `${mPeriod[1]}${mPeriod[2].padStart(2, "0")}` : "";

    // 障害番号（事業所番号）は複数の列名の可能性があるのでフォールバック
    const shogaiNum =
      get("請求事業者指定事業所番号") ||
      get("指定事業所番号") ||
      get("事業所番号") ||
      get("事業者番号") ||
      "";

    data.push({
      segment: "障害",
      office_number: shogaiNum,
      office_name: get("事業者名") || get("事業所名"),
      client_number: clientNumber,
      client_name: get("利用者名"),
      billing_month: billingMonth,
      service_item_code: null,
      service_item: get("利用料項目"),
      unit_price: toNum(get("単価")),
      quantity: toNum(get("数量")),
      amount: toInt(get("金額")) ?? 0,
      tax_amount: toInt(get("消費税額")),
      reduction_amount: toInt(get("減免額")),
      medical_deduction: null,
      period_start: null,
      period_end: null,
      status: get("請求・入金") || null,
      raw: rawObj,
    });
  }
  return { data, errors };
}

// ─── 02_介護_単位 パーサ ─────────────────────────────

export async function parse02KaigoUnit(file: File): Promise<{ data: BillingUnitItem[]; errors: string[] }> {
  const errors: string[] = [];
  const rows = await readCsvFile(file);
  if (rows.length < 2) return { data: [], errors: ["データ行がありません"] };
  const header = rows[0].map((h) => h.replace(/^"|"$/g, "").trim());
  const idxOnce: Record<string, number> = {};
  header.forEach((h, i) => { if (h && idxOnce[h] === undefined) idxOnce[h] = i; });

  const data: BillingUnitItem[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (k: string) => (idxOnce[k] != null ? (r[idxOnce[k]] ?? "").replace(/^"|"$/g, "").trim() : "");
    const clientNumber = get("利用者番号");
    if (!clientNumber) continue;
    const rawObj: Record<string, string> = {};
    for (const k of Object.keys(idxOnce)) rawObj[k] = get(k);

    data.push({
      segment: "介護",
      office_number: get("事業所番号"),
      client_number: clientNumber,
      client_name: get("利用者名"),
      billing_month: normalizeBillingMonth(get("請求年月") || get("処理年月")),
      service_name: get("介護サービス費内訳") || "",
      service_code: null,
      unit_count: toNum(get("単位数")),
      unit_type: get("単位/点/円") || null,
      repetition: toNum(get("回数")),
      amount: null,
      raw: rawObj,
    });
  }
  return { data, errors };
}

// ─── 02_障害_単位 パーサ ─────────────────────────────

export async function parse02ShogaiUnit(file: File): Promise<{ data: BillingUnitItem[]; errors: string[] }> {
  const errors: string[] = [];
  const rows = await readCsvFile(file);
  if (rows.length < 2) return { data: [], errors: ["データ行がありません"] };
  const header = rows[0].map((h) => h.trim());
  const idx: Record<string, number> = {};
  header.forEach((h, i) => { if (h && idx[h] === undefined) idx[h] = i; });

  const data: BillingUnitItem[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (k: string) => (idx[k] != null ? (r[idx[k]] ?? "").trim() : "");
    const clientNumber = get("利用者番号");
    if (!clientNumber) continue;
    const rawObj: Record<string, string> = {};
    for (const k of Object.keys(idx)) rawObj[k] = get(k);

    const shogaiNum =
      get("請求事業者指定事業所番号") ||
      get("指定事業所番号") ||
      get("事業所番号") ||
      get("事業者番号") ||
      "";
    data.push({
      segment: "障害",
      office_number: shogaiNum,
      client_number: clientNumber,
      client_name: get("利用者名"),
      billing_month: normalizeBillingMonth(get("サービス提供年月") || get("提供年月") || get("請求年月")),
      service_name: get("サービス内容") || "",
      service_code: get("サービスコード") || null,
      unit_count: toNum(get("単位数")),
      unit_type: "単位",
      repetition: toNum(get("回数")),
      amount: toInt(get("サービス単位数")),
      raw: rawObj,
    });
  }
  return { data, errors };
}

// ─── 03_介護_利用日 パーサ ──────────────────────────
// カレンダー形式: 1日〜31日の各セルにサービス数量

export async function parse03KaigoDaily(file: File): Promise<{ data: BillingDailyItem[]; errors: string[] }> {
  const errors: string[] = [];
  const rows = await readCsvFile(file);
  if (rows.length < 2) return { data: [], errors: ["データ行がありません"] };
  const header = rows[0].map((h) => h.replace(/^"|"$/g, "").trim());
  const idx: Record<string, number> = {};
  header.forEach((h, i) => { if (h && idx[h] === undefined) idx[h] = i; });

  const data: BillingDailyItem[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (k: string) => (idx[k] != null ? (r[idx[k]] ?? "").replace(/^"|"$/g, "").trim() : "");
    const clientNumber = get("利用者番号");
    if (!clientNumber) continue;
    const billingMonth = normalizeBillingMonth(get("提供年月") || get("処理年月"));
    const serviceName = get("サービス内容");
    for (let d = 1; d <= 31; d++) {
      const qStr = get(`${d}日`);
      if (!qStr) continue;
      const q = toNum(qStr);
      if (q == null || q === 0) continue;
      data.push({
        segment: "介護",
        office_number: get("事業所番号"),
        client_number: clientNumber,
        client_name: get("利用者名"),
        billing_month: billingMonth,
        service_name: serviceName,
        service_code: get("サービスコード") || null,
        day: d,
        quantity: q,
      });
    }
  }
  return { data, errors };
}

// ─── 03_障害_利用日 パーサ ──────────────────────────
// 障害版はサービス内容列がない → 利用日のみ記録

export async function parse03ShogaiDaily(file: File): Promise<{ data: BillingDailyItem[]; errors: string[] }> {
  const errors: string[] = [];
  const rows = await readCsvFile(file);
  if (rows.length < 2) return { data: [], errors: ["データ行がありません"] };
  const header = rows[0].map((h) => h.trim());
  const idx: Record<string, number> = {};
  header.forEach((h, i) => { if (h && idx[h] === undefined) idx[h] = i; });

  const data: BillingDailyItem[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (k: string) => (idx[k] != null ? (r[idx[k]] ?? "").trim() : "");
    const clientNumber = get("利用者番号");
    if (!clientNumber) continue;

    // 障害番号（列名のゆらぎをフォールバックで吸収）
    const shogaiNum =
      get("請求事業者指定事業所番号") ||
      get("指定事業所番号") ||
      get("事業所番号") ||
      get("事業者番号") ||
      "";
    // 提供年月（複数の列名候補）
    const billingMonth = normalizeBillingMonth(
      get("サービス提供年月") ||
      get("提供年月") ||
      get("請求年月") ||
      get("処理年月") ||
      ""
    );
    const serviceName = get("サービス内容") || get("サービス名称") || "";
    const serviceCode = get("サービスコード") || null;

    for (let d = 1; d <= 31; d++) {
      const qStr = get(`${d}日`);
      if (!qStr) continue;
      const q = toNum(qStr);
      if (q == null || q === 0) continue;
      data.push({
        segment: "障害",
        office_number: shogaiNum,
        client_number: clientNumber,
        client_name: get("利用者名"),
        billing_month: billingMonth,
        service_name: serviceName,
        service_code: serviceCode,
        day: d,
        quantity: q,
      });
    }
  }
  return { data, errors };
}
