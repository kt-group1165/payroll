/**
 * 事業所書式入力 (= /office-input) で扱う型定義。
 *
 * 既存 xlsm 「【中央】事業所書式完成（最新）.xlsm」の置換。
 * payroll_office_input_entries テーブル (= 20260619_payroll_office_input.sql) と対応。
 */

export type OfficeInputCategory =
  | "数値項目"
  | "時間項目"
  | "日付項目"
  | "日時項目"
  | "育児手当";

export const OFFICE_INPUT_CATEGORIES: OfficeInputCategory[] = [
  "数値項目",
  "時間項目",
  "日付項目",
  "日時項目",
  "育児手当",
];

/** DB row (= payroll_office_input_entries の 1 行) */
export type OfficeInputEntry = {
  id: string;
  tenant_id: string;
  employee_id: string;
  billing_month: string; // 'YYYY-MM'
  category: OfficeInputCategory;
  item_name: string;
  numeric_value: number | null;
  time_minutes: number | null;
  date_value: string | null;       // 'YYYY-MM-DD'
  start_time: string | null;       // 'HH:MM:SS'
  end_time: string | null;         // 'HH:MM:SS'
  break_minutes: number | null;
  child_name: string | null;
  reference_month: string | null;  // 'YYYY-MM'
  notes: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * upsert 時に POST する payload。
 * id があれば UPDATE、無ければ INSERT。
 */
export type OfficeInputEntryInput = {
  id?: string;
  employee_id: string;
  billing_month: string;
  category: OfficeInputCategory;
  item_name: string;
  numeric_value?: number | null;
  time_minutes?: number | null;
  date_value?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  break_minutes?: number | null;
  child_name?: string | null;
  reference_month?: string | null;
  notes?: string | null;
};

/**
 * カテゴリごとの選択可能な item_name の候補。
 * xlsm の項目一覧から抽出 (= 元 sheet と整合)。
 */
export const ITEM_OPTIONS: Record<OfficeInputCategory, string[]> = {
  数値項目: [
    "介護プラン",
    "予防プラン",
    "調査",
    "1000円加算",
    "2000円加算",
    "3000円加算",
    "会議1件数",
    "会議2件数",
    "会議3件数",
    "出勤日数",
    "訪問看護件数",
    "予定外訪看件数",
    "土日祝件数(訪看)",
    "夜朝訪看件数",
    "深夜訪看件数",
    "特日訪看件数",
    "担当者手当",
    "出張km",
    "通勤km",
  ],
  時間項目: [
    "訪看訪問時間",
    "研修時間(看護)",
    "会議時間(看護)",
    "訪看同行時間",
  ],
  日付項目: ["有給", "半有給", "特休", "半特休", "欠勤", "半欠勤"],
  日時項目: ["初任者研修", "HRD研修", "会議", "研修"],
  育児手当: ["保育料", "幼稚園料"],
};
