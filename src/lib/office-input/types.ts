/**
 * 事業所書式入力 (= /office-input) で扱う型定義。
 *
 * 既存 xlsm 「【中央】事業所書式完成（最新）.xlsm」の置換。
 * payroll_office_input_entries テーブル (= 20260619_payroll_office_input.sql) と対応。
 *
 * 画面は「データ型 (= category)」ではなく「項目 (= item_name)」で並べる。
 * category は DB の CHECK 制約に対応する内部的な区分で、画面には出さない。
 */

export type OfficeInputCategory =
  | "数値項目"
  | "時間項目"
  | "日付項目"
  | "日時項目"
  | "育児手当";

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
 * 画面が保持する行。
 *
 * `localKey` は React の key 専用の client 側 ID。
 * DB row の `id` を key にすると **INSERT で id が振り直された瞬間に remount** し、
 * 入力中の欄から focus が飛ぶ。localKey は保存前後で変えないので remount しない。
 */
export type OfficeInputRow = OfficeInputEntry & { localKey: string };

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

// ─── 項目カタログ ─────────────────────────────────────────

/**
 * 入力面の種類。category から機械的に決まる (= `inputModeOf`)。
 *
 *   scalar   … 1 人 1 値。全職員を 1 枚の表に並べて入力欄を出す
 *   dateList … 1 人が複数の「日」を持つ (有給など)。日付をまとめて 1 欄で入力
 *   rows     … 1 人が複数の明細行を持つ (研修・保育料)。明細表で入力
 */
export type OfficeInputMode = "scalar" | "dateList" | "rows";

export function inputModeOf(category: OfficeInputCategory): OfficeInputMode {
  switch (category) {
    case "数値項目":
    case "時間項目":
      return "scalar";
    case "日付項目":
      return "dateList";
    case "日時項目":
    case "育児手当":
      return "rows";
  }
}

/** 画面上のグループ (= 事業所の人が知っている括り) */
export type OfficeInputGroup =
  | "交通費・距離"
  | "手当・件数"
  | "休暇"
  | "研修・会議"
  | "育児手当"
  | "居宅 (ケアプラン)"
  | "訪問看護";

export const OFFICE_INPUT_GROUPS: OfficeInputGroup[] = [
  "交通費・距離",
  "手当・件数",
  "休暇",
  "研修・会議",
  "育児手当",
  "居宅 (ケアプラン)",
  "訪問看護",
];

export type OfficeInputItem = {
  /** DB に入る item_name。表示名も兼ねる */
  name: string;
  /** DB の category (CHECK 制約に対応) */
  category: OfficeInputCategory;
  group: OfficeInputGroup;
  /** 数値の単位表示 (scalar のみ)。時間項目は HH:MM 入力なので不要 */
  unit?: string;
  /** 整数のみ受け付ける (件数など) */
  integerOnly?: boolean;
  /**
   * この項目を既定で出す事業所種別 (payroll_offices.office_type)。
   * 省略 = 全事業所共通。
   * ⚠ 絞るのは既定の表示だけ。「すべての項目を表示」で必ず出せるようにする
   *    (= 事業所種別の登録漏れで入力できなくなるのを防ぐ)。
   */
  officeTypes?: string[];
  /** 入力欄の補足 */
  hint?: string;
};

/**
 * 項目の一覧。xlsm の項目一覧から抽出 (= 元 sheet と整合)。
 *
 * 並び順がそのまま画面の並び順になる。
 * 実データ (payroll_office_form_records / 2026-01〜2026-08 の 12,227 行) では
 * 出張km・通勤km が突出して多く (7,308 行)、次いで 有給 (2,847)・HRD研修 (468)。
 */
export const OFFICE_INPUT_ITEMS: OfficeInputItem[] = [
  // ── 交通費・距離 (全事業所。実データで最頻) ──
  { name: "出張km", category: "数値項目", group: "交通費・距離", unit: "km", hint: "月合計の出張距離" },
  { name: "通勤km", category: "数値項目", group: "交通費・距離", unit: "km", hint: "片道の通勤距離" },

  // ── 手当・件数 (全事業所) ──
  { name: "会議1件数", category: "数値項目", group: "手当・件数", unit: "件", integerOnly: true },
  { name: "会議2件数", category: "数値項目", group: "手当・件数", unit: "件", integerOnly: true },
  { name: "会議3件数", category: "数値項目", group: "手当・件数", unit: "件", integerOnly: true },
  { name: "担当者手当", category: "数値項目", group: "手当・件数", unit: "件", integerOnly: true },
  { name: "1000円加算", category: "数値項目", group: "手当・件数", unit: "件", integerOnly: true },
  { name: "2000円加算", category: "数値項目", group: "手当・件数", unit: "件", integerOnly: true },
  { name: "3000円加算", category: "数値項目", group: "手当・件数", unit: "件", integerOnly: true },
  { name: "出勤日数", category: "数値項目", group: "手当・件数", unit: "日", integerOnly: true },

  // ── 休暇 (全事業所。1 人が月に何日も持つ) ──
  { name: "有給", category: "日付項目", group: "休暇" },
  { name: "半有給", category: "日付項目", group: "休暇" },
  { name: "特休", category: "日付項目", group: "休暇" },
  { name: "半特休", category: "日付項目", group: "休暇" },
  { name: "欠勤", category: "日付項目", group: "休暇" },
  { name: "半欠勤", category: "日付項目", group: "休暇" },

  // ── 研修・会議 (全事業所。日付 + 開始/終了/休憩) ──
  { name: "研修", category: "日時項目", group: "研修・会議" },
  { name: "HRD研修", category: "日時項目", group: "研修・会議" },
  { name: "初任者研修", category: "日時項目", group: "研修・会議" },
  { name: "会議", category: "日時項目", group: "研修・会議" },

  // ── 育児手当 (全事業所) ──
  // ⚠ 「学童」は実データ (payroll_office_form_records) に実在するので候補に入れる
  { name: "保育料", category: "育児手当", group: "育児手当", unit: "円" },
  { name: "幼稚園料", category: "育児手当", group: "育児手当", unit: "円" },
  { name: "学童", category: "育児手当", group: "育児手当", unit: "円" },

  // ── 居宅 (ケアプラン) ──
  { name: "介護プラン", category: "数値項目", group: "居宅 (ケアプラン)", unit: "件", integerOnly: true, officeTypes: ["居宅介護支援"] },
  { name: "予防プラン", category: "数値項目", group: "居宅 (ケアプラン)", unit: "件", integerOnly: true, officeTypes: ["居宅介護支援"] },
  { name: "調査", category: "数値項目", group: "居宅 (ケアプラン)", unit: "件", integerOnly: true, officeTypes: ["居宅介護支援"] },

  // ── 訪問看護 ──
  { name: "訪問看護件数", category: "数値項目", group: "訪問看護", unit: "件", integerOnly: true, officeTypes: ["訪問看護"] },
  { name: "予定外訪看件数", category: "数値項目", group: "訪問看護", unit: "件", integerOnly: true, officeTypes: ["訪問看護"] },
  { name: "土日祝件数(訪看)", category: "数値項目", group: "訪問看護", unit: "件", integerOnly: true, officeTypes: ["訪問看護"] },
  { name: "夜朝訪看件数", category: "数値項目", group: "訪問看護", unit: "件", integerOnly: true, officeTypes: ["訪問看護"] },
  { name: "深夜訪看件数", category: "数値項目", group: "訪問看護", unit: "件", integerOnly: true, officeTypes: ["訪問看護"] },
  { name: "特日訪看件数", category: "数値項目", group: "訪問看護", unit: "件", integerOnly: true, officeTypes: ["訪問看護"] },
  { name: "訪看訪問時間", category: "時間項目", group: "訪問看護", officeTypes: ["訪問看護"] },
  { name: "研修時間(看護)", category: "時間項目", group: "訪問看護", officeTypes: ["訪問看護"] },
  { name: "会議時間(看護)", category: "時間項目", group: "訪問看護", officeTypes: ["訪問看護"] },
  { name: "訪看同行時間", category: "時間項目", group: "訪問看護", officeTypes: ["訪問看護"] },
];

/** item_name → 項目定義 の索引 */
export const OFFICE_INPUT_ITEM_BY_NAME: Map<string, OfficeInputItem> = new Map(
  OFFICE_INPUT_ITEMS.map((it) => [it.name, it]),
);

/**
 * その事業所種別で既定表示する項目。
 * officeTypes 未指定 = 全事業所共通。
 */
export function itemsForOfficeType(officeType: string | null | undefined): OfficeInputItem[] {
  return OFFICE_INPUT_ITEMS.filter(
    (it) => !it.officeTypes || (officeType ? it.officeTypes.includes(officeType) : false),
  );
}

// ─── 値のフォーマット / パース ────────────────────────────
// 画面 (office-input-content / category-section) の両方から使うのでここに置く。

/** 分 → "HH:MM" */
export function minutesToHHMM(m: number | null | undefined): string {
  if (m === null || m === undefined || Number.isNaN(m)) return "";
  const sign = m < 0 ? "-" : "";
  const abs = Math.abs(m);
  const h = Math.floor(abs / 60);
  const mm = abs % 60;
  return `${sign}${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * "H:MM" / "HH:MM" を分に。解釈できなければ undefined。
 * (= 入力途中の文字列で値を壊さないため null ではなく undefined を返す)
 */
export function parseHHMM(s: string): number | undefined {
  const trimmed = s.trim();
  if (trimmed === "") return undefined;
  const m = /^(-?)(\d{1,3}):([0-5]?\d)$/.exec(trimmed);
  if (!m) return undefined;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

/** 日時項目の実働分 (= 終了 − 開始 − 休憩)。算出できなければ null */
export function workedMinutesOf(row: OfficeInputEntry): number | null {
  const start = parseHHMM((row.start_time ?? "").slice(0, 5));
  const end = parseHHMM((row.end_time ?? "").slice(0, 5));
  if (start === undefined || end === undefined) return null;
  // 日跨ぎ (= 終了が開始より小さい) は +24h して扱う
  const span = end >= start ? end - start : end + 24 * 60 - start;
  return Math.max(0, span - (row.break_minutes ?? 0));
}

/** 1000 区切り。小数は最大 2 桁まで */
export function formatNumber(n: number): string {
  return n.toLocaleString("ja-JP", { maximumFractionDigits: 2 });
}

/** "YYYY-MM" の日数。⚠ Date.toISOString() は JST で前日になるので使わない */
export function daysInMonth(billingMonth: string): number {
  const m = /^(\d{4})-(\d{2})$/.exec(billingMonth);
  if (!m) return 31;
  // 月 index に「その月」を渡し day=0 で前月末日 = その月の日数
  return new Date(parseInt(m[1], 10), parseInt(m[2], 10), 0).getDate();
}

/**
 * 休暇の日付をまとめて入力する欄のパース。
 *
 * 受け付ける書き方 (xlsm の書き方をそのまま打てるようにする):
 *   "3 7 18"         日だけ
 *   "3,7,18"         カンマ区切り
 *   "6/3, 6/7"       月/日 (月は対象月と一致するものだけ採用)
 *   "2026-06-03"     ISO
 *
 * @returns 'YYYY-MM-DD' の昇順・重複なし配列。解釈できない字が混ざれば null
 */
export function parseDayList(text: string, billingMonth: string): string[] | null {
  const m = /^(\d{4})-(\d{2})$/.exec(billingMonth);
  if (!m) return null;
  const [, yyyy, mm] = m;
  const last = daysInMonth(billingMonth);

  const trimmed = text.trim();
  if (trimmed === "") return [];

  const tokens = trimmed.split(/[\s,、･・]+/).filter((t) => t !== "");
  const days = new Set<number>();
  for (const t of tokens) {
    let day: number | null = null;
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
    const slash = /^(\d{1,2})\/(\d{1,2})$/.exec(t);
    if (iso) {
      // 対象月と違う年月は受け付けない (= 打ち間違いを黙って通さない)
      if (iso[1] !== yyyy || parseInt(iso[2], 10) !== parseInt(mm, 10)) return null;
      day = parseInt(iso[3], 10);
    } else if (slash) {
      if (parseInt(slash[1], 10) !== parseInt(mm, 10)) return null;
      day = parseInt(slash[2], 10);
    } else if (/^\d{1,2}$/.test(t)) {
      day = parseInt(t, 10);
    } else {
      return null;
    }
    if (day < 1 || day > last) return null;
    days.add(day);
  }

  return [...days]
    .sort((a, b) => a - b)
    .map((d) => `${yyyy}-${mm}-${String(d).padStart(2, "0")}`);
}

/** 'YYYY-MM-DD'[] → "3, 7, 18" (対象月の日だけを取り出す) */
export function formatDayList(dates: (string | null)[]): string {
  return dates
    .filter((d): d is string => !!d)
    .map((d) => parseInt(d.slice(8, 10), 10))
    .sort((a, b) => a - b)
    .join(", ");
}
