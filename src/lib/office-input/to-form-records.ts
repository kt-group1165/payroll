/**
 * 事業所書式入力 (Web /office-input) の行を、給与計算が読む形 (OfficeFormRecord) に射影する。
 *
 * ── なぜ 2 つの表があるのか (2026-09-23 に実測して決めた) ─────────────────
 *   payroll_office_form_records   xlsm → CSV 取込の受け皿。実データ 12,227 行
 *                                 (2026-01〜2026-08 / 22 事業所)。キーは
 *                                 (office_number, employee_number, processing_month)。
 *                                 総括表との突合・移行 script 8 本・取込件数の RPC が
 *                                 すべてこのキーに乗っている。
 *   payroll_office_input_entries  Web 入力の一次表。実データ 0 行。キーは
 *                                 (employee_id, billing_month)。1 日 = 1 行 / TIME 型 /
 *                                 break_minutes INT と、入力面としては素直な形。
 *
 *   給与計算が読む「形」は OfficeFormRecord 一本に保つ (= payroll-calc.ts は無改造)。
 *   Web 入力は この射影を通して同じ形で合流させる。
 *   CSV 取込が止まる (= xlsm 廃止) と、自然に Web 側だけが残る。
 *
 * ── 射影で守っていること (実データを見て決めた。推測しない) ────────────────
 *   ① category → record_type は 下流の分岐に合わせる。
 *      payroll-calc は record_type を「値のスロット」として使っている:
 *        "km"       numeric_value を読む (会議件数・担当者手当も km スロットに入る)
 *        "leave"    item_date の日付の数を数える (listedDateCount)
 *        "training" start_time/end_time/break_time から分を出す
 *        "childcare" year_month / child_name / amount
 *   ② item_date は **"M/D"** で出す。ISO ("2026-06-23") にすると
 *      - trainingMinutesByDay の正規表現 /(\d+)月(\d+)日|(\d+)\/(\d+)/ が外れて
 *        残業の日次判定から研修が落ちる
 *      - extractDay() が 8 桁として解釈でき、今は発火していない半日換算 (workDays 0.5) が
 *        Web 入力の行でだけ突然発火する
 *      どちらも「Web から入れたか CSV から入れたかで金額が変わる」ことになるので、
 *      実データで支配的な "M/D" に揃える。
 *   ③ year_month は **"YYYY/MM"** で出す。normalizeYM は "/" しか見ないので
 *      "2026-04" のまま渡すと正規化されず、保育手当の参照月がバラける。
 *   ④ 時刻は "HH:MM"。DB の TIME は "HH:MM:SS" で返るので 先頭 5 文字に揃える
 *      (秒付きのまま渡しても toMin は動くが、CSV 由来の行と見た目が食い違う)。
 *
 * ── この射影が「金額に届く」項目 (2026-09-23 実測) ────────────────────────
 *   届く   出張km / 通勤km / 会議1件数 / 会議2件数 / 会議3件数 /
 *          有給 / 半有給 / 特休 / 半欠勤 (半日換算の対象) /
 *          研修 / HRD研修 / 初任者研修 / 会議 / 保育料 / 学童 / 幼稚園料
 *   届かない 担当者手当 / 1000円加算 / 2000円加算 / 3000円加算 / 出勤日数 /
 *          半特休 / 欠勤 / 介護プラン / 予防プラン / 調査 / 訪問看護の全 10 項目
 *          (= 画面で入力できるが payroll-calc に読む側が無い。項目を消す前に
 *            「本当に要らないのか」を user に確認する。check:office-input-flow が一覧を出す)
 */

import type { OfficeFormRecord } from "@/lib/payroll/payroll-calc";
import { minutesToHHMM, type OfficeInputCategory, type OfficeInputEntry } from "./types";

/**
 * 職員番号の正規化 (先頭ゼロを落として "0048" と "48" を同一視)。
 * page.tsx の実績・出勤簿・事業所書式のグループ化と **同じ関数** を使う
 * (逐語コピーすると片方だけ直したときに黙って乖離する)。
 */
export function normEmp(n: string | number): string {
  return String(n).replace(/^0+/, "") || "0";
}

/** category → 下流 (payroll-calc) が期待する record_type */
export const RECORD_TYPE_BY_CATEGORY: Record<OfficeInputCategory, string> = {
  数値項目: "km",
  時間項目: "time", // ⚠ 下流に読む側が無い。読む側ができるまで意図的に別の値にしておく
  日付項目: "leave",
  日時項目: "training",
  育児手当: "childcare",
};

/** 'YYYY-MM' (billing_month) → 'YYYYMM' (processing_month) */
export function billingToProcessingMonth(billingMonth: string): string {
  return billingMonth.replace("-", "");
}

/** 'YYYYMM' (processing_month) → 'YYYY-MM' (billing_month) */
export function processingToBillingMonth(processingMonth: string): string {
  return `${processingMonth.slice(0, 4)}-${processingMonth.slice(4, 6)}`;
}

/** 'YYYY-MM-DD' → "M/D" (実データで支配的な書式。上記 ② 参照)。解釈できなければ null */
export function dateValueToItemDate(dateValue: string | null): string | null {
  if (!dateValue) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  if (!m) return null;
  return `${Number(m[2])}/${Number(m[3])}`;
}

/** TIME ("HH:MM:SS" / "HH:MM") → "HH:MM"。空は null */
function toHHMM(t: string | null): string | null {
  if (!t) return null;
  return t.slice(0, 5);
}

/**
 * Web 入力 1 行 → OfficeFormRecord 1 行。
 * @param employeeNumber employee_id から引いた職員番号 (呼出元で解決する)
 */
export function officeInputEntryToFormRecord(
  entry: OfficeInputEntry,
  employeeNumber: string,
): OfficeFormRecord {
  const recordType = RECORD_TYPE_BY_CATEGORY[entry.category];
  return {
    employee_number: employeeNumber,
    record_type: recordType,
    item_name: entry.item_name,
    item_date: dateValueToItemDate(entry.date_value),
    // 数値スロット。時間項目だけは「分」をそのまま置く (読む側ができたときに単位を決める)
    numeric_value: entry.category === "時間項目" ? entry.time_minutes : entry.numeric_value,
    start_time: toHHMM(entry.start_time),
    end_time: toHHMM(entry.end_time),
    break_time: entry.break_minutes == null ? null : minutesToHHMM(entry.break_minutes),
    // 育児手当: 参照月は "YYYY/MM" (上記 ③)。未入力なら null にして呼出元の処理月に倒す
    year_month: entry.category === "育児手当"
      ? (entry.reference_month ? entry.reference_month.replace("-", "/") : null)
      : null,
    child_name: entry.category === "育児手当" ? entry.child_name : null,
    amount: entry.category === "育児手当" ? entry.numeric_value : null,
  };
}

/** 合流のキー。職員 × 項目 (= 事業所が書式を埋める単位) */
export function mergeKeyOf(r: { employee_number: string; item_name: string }): string {
  return `${normEmp(r.employee_number)}|${r.item_name}`;
}

export type MergeResult = {
  /** 給与計算に渡す行 */
  records: OfficeFormRecord[];
  /** Web 入力が採用された (職員 × 項目) のキー */
  webWonKeys: string[];
  /** Web 入力に負けて落とした CSV 行の数 */
  csvDropped: number;
};

/**
 * CSV 取込の行と Web 入力の行を合流させる。
 *
 * 優先は **(職員 × 項目) 単位で Web 入力が勝つ**。
 *   - 事業所は「この人の有給」「この人の出張km」という単位で書式を埋めるので、
 *     その単位で丸ごと差し替えるのが実際の入力の仕方に合う。
 *   - 行単位で混ぜると「Web で 1 日消したのに CSV の行が残って日数が減らない」
 *     という消せない状態ができる。
 *   - 職員単位で切ると「出張km だけ Web に直したら有給が消える」ことになる。
 *
 * Web 入力が 1 行も無ければ 出力は CSV そのまま (= 現行と完全に同じ)。
 */
export function mergeOfficeFormSources(
  csvRecords: OfficeFormRecord[],
  webRecords: OfficeFormRecord[],
): MergeResult {
  if (webRecords.length === 0) {
    return { records: csvRecords, webWonKeys: [], csvDropped: 0 };
  }
  const webKeys = new Set(webRecords.map(mergeKeyOf));
  const kept = csvRecords.filter((r) => !webKeys.has(mergeKeyOf(r)));
  return {
    records: [...kept, ...webRecords],
    webWonKeys: [...webKeys].sort(),
    csvDropped: csvRecords.length - kept.length,
  };
}

/**
 * Web 入力エントリ群を OfficeFormRecord に射影する。
 * employee_id → employee_number が引けない行は **黙って捨てず** unresolved に入れる。
 */
export function officeInputEntriesToFormRecords(
  entries: OfficeInputEntry[],
  employeeNumberById: Map<string, string>,
): { records: OfficeFormRecord[]; unresolved: OfficeInputEntry[] } {
  const records: OfficeFormRecord[] = [];
  const unresolved: OfficeInputEntry[] = [];
  for (const e of entries) {
    const num = employeeNumberById.get(e.employee_id);
    if (num === undefined) { unresolved.push(e); continue; }
    records.push(officeInputEntryToFormRecord(e, num));
  }
  return { records, unresolved };
}
