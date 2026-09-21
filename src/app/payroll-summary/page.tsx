"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useLocalStorage } from "@/lib/use-local-storage";
import { KyotakuSummarySection } from "@/components/payroll/kyotaku-summary-section";
import { MonthInputButton } from "@/components/ui/month-input-button";
import { usePayrollOffices } from "@/lib/swr/use-payroll-offices";
import { supabase } from "@/lib/supabase";

// ─── 型 ──────────────────────────────────────────────

type IndexEntry = {
  key: string;
  office_number: string;
  office_name: string;
  processing_month: string;
  calculated_at: string;
};

type AttendanceSummary = {
  workDays: number;
  helperDays: number;
  paidLeave: number;
  halfLeave: number;
  specialLeave: number;
  workHoursMin: number;
  overtimeMinutes: number;
  recordCount: number;
  accompaniedCount: number;
  visitMinutes: number;
  visitMinutesExcludingAccompanied: number;
  hrdCount: number;
  hrdMinutes: number;
  meetingCount: number;
  commuteKmTotal: number;
  businessKmTotal: number;
  weekendHolidayMinutes: number;
  weekendHolidayAccompaniedMinutes: number;
};

type HourlyRow = {
  employee_number: string;
  employee_name: string;
  role_type: string;
  totalPay: number;
  totalMinutes: number;
  unmappedCount: number;
  treatment_subsidy: number;
  paid_leave_allowance: number;
  cancel_allowance: number;
  travel_allowance: number;
  communication_fee: number;
  meeting_fee: number;
  childcare_allowance: number;
  commute_fee: number;
  business_trip_fee: number;
  summary: AttendanceSummary;
};

type SalarySettings = {
  base_personal_salary: number;
  skill_salary: number;
  position_allowance: number;
  qualification_allowance: number;
  tenure_allowance: number;
  treatment_improvement: number;
  specific_treatment_improvement: number;
  treatment_subsidy: number;
  fixed_overtime_pay: number;
  special_bonus: number;
  bonus_amount: number;
};

type MonthlyRow = {
  employee_id: string;
  employee_number: string;
  employee_name: string;
  role_type: string;
  settings: SalarySettings | null;
  bonus_paid: boolean;
  travel_km: number;
  travel_km_auto: number;
  office_travel_unit_price: number;
  business_trip_fee: number;
  childcare_allowance: number;
  summary: AttendanceSummary;
};

type Summary = {
  office_id: string;
  office_number: string;
  office_name: string;
  processing_month: string;
  calculated_at: string;
  hourly: HourlyRow[];
  monthly: MonthlyRow[];
};

// ─── カラム定義 ──────────────────────────────────────

type ColDef<T> = {
  key: string;
  label: string;
  align?: "left" | "right" | "center";
  always?: boolean;          // trueなら非表示不可（識別用）
  /** ⚠ 2026-09-21 以降 既定の表示/非表示には使っていない (値が入っていれば出す)。
   *  列の並び・分類の目印として残してある */
  defaultOff?: boolean;
  render: (row: T) => React.ReactNode;
};

function fmtMinutes(m: number) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}:${String(mm).padStart(2, "0")}`;
}

function yen(n: number) {
  return n > 0 ? n.toLocaleString("ja-JP") + "円" : "—";
}

function num(n: number) {
  return n > 0 ? n.toLocaleString("ja-JP") : "—";
}

/** 保存時に給与計算画面と同じ関数で出した grand_total があればそれを使う。古い保存データだけ下の概算 */
function sumHourlyPay(h: HourlyRow): number {
  const saved = (h as HourlyRow & { grand_total?: number }).grand_total;
  if (typeof saved === "number") return saved;
  return (
    h.totalPay + h.treatment_subsidy + h.paid_leave_allowance + h.cancel_allowance +
    h.travel_allowance + h.communication_fee + h.meeting_fee + h.childcare_allowance +
    h.commute_fee + h.business_trip_fee
  );
}

function fixedMonthlyTotal(s: SalarySettings | null): number {
  if (!s) return 0;
  return s.base_personal_salary + s.skill_salary + s.position_allowance +
    s.qualification_allowance + s.tenure_allowance + s.treatment_improvement +
    s.specific_treatment_improvement + s.treatment_subsidy + s.fixed_overtime_pay +
    s.special_bonus;
}

function sumMonthlyPay(m: MonthlyRow): number {
  const saved = (m as MonthlyRow & { grand_total?: number }).grand_total;
  if (typeof saved === "number") return saved;
  const fixed = fixedMonthlyTotal(m.settings);
  const bonus = m.bonus_paid ? (m.settings?.bonus_amount ?? 0) : 0;
  const travelKm = m.travel_km > 0 ? m.travel_km : m.travel_km_auto;
  const travelFee = Math.round(travelKm * m.office_travel_unit_price);
  return fixed + bonus + (m.childcare_allowance ?? 0) + travelFee;
}

const HOURLY_COLS: ColDef<HourlyRow>[] = [
  { key: "employee_number", label: "社員番号", always: true, render: (r) => <span className="font-mono text-xs">{r.employee_number}</span> },
  { key: "employee_name",   label: "氏名",      always: true, render: (r) => r.employee_name },
  { key: "role_type",       label: "役職",      render: (r) => r.role_type },
  { key: "workDays",        label: "出勤日数",  align: "right", render: (r) => num(r.summary.workDays) },
  { key: "helperDays",      label: "ヘルパー日数", align: "right", render: (r) => num(r.summary.helperDays) },
  { key: "paidLeave",       label: "有給",      align: "right", defaultOff: true, render: (r) => num(r.summary.paidLeave) },
  { key: "halfLeave",       label: "半有給",    align: "right", defaultOff: true, render: (r) => num(r.summary.halfLeave) },
  { key: "specialLeave",    label: "特休",      align: "right", defaultOff: true, render: (r) => num(r.summary.specialLeave) },
  { key: "workHoursMin",    label: "出勤時間",  align: "right", render: (r) => r.summary.workHoursMin > 0 ? fmtMinutes(r.summary.workHoursMin) : "—" },
  { key: "overtimeMinutes", label: "残業時間",  align: "right", defaultOff: true, render: (r) => r.summary.overtimeMinutes > 0 ? fmtMinutes(r.summary.overtimeMinutes) : "—" },
  { key: "visitMinutes",    label: "訪問時間",  align: "right", render: (r) => r.summary.visitMinutes > 0 ? fmtMinutes(r.summary.visitMinutes) : "—" },
  { key: "accompaniedMin",  label: "同行時間",  align: "right", defaultOff: true, render: (r) => {
      const acc = r.summary.visitMinutes - r.summary.visitMinutesExcludingAccompanied;
      return acc > 0 ? fmtMinutes(acc) : "—";
    } },
  { key: "hrdCount",        label: "HRD回数",   align: "right", defaultOff: true, render: (r) => num(r.summary.hrdCount) },
  { key: "meetingCount",    label: "会議回数",  align: "right", defaultOff: true, render: (r) => num(r.summary.meetingCount) },
  { key: "commuteKm",       label: "通勤km",    align: "right", defaultOff: true, render: (r) => r.summary.commuteKmTotal > 0 ? `${r.summary.commuteKmTotal.toFixed(1)}km` : "—" },
  { key: "businessKm",      label: "出張km",    align: "right", defaultOff: true, render: (r) => r.summary.businessKmTotal > 0 ? `${r.summary.businessKmTotal.toFixed(1)}km` : "—" },
  { key: "totalPay",        label: "時給額",    align: "right", render: (r) => yen(r.totalPay) },
  { key: "treatment_subsidy",     label: "処遇補助金手当", align: "right", defaultOff: true, render: (r) => yen(r.treatment_subsidy) },
  { key: "paid_leave_allowance",  label: "有給手当",  align: "right", defaultOff: true, render: (r) => yen(r.paid_leave_allowance) },
  { key: "cancel_allowance",      label: "キャンセル手当", align: "right", defaultOff: true, render: (r) => yen(r.cancel_allowance) },
  { key: "travel_allowance",      label: "移動手当",  align: "right", render: (r) => yen(r.travel_allowance) },
  { key: "communication_fee",     label: "通信費",    align: "right", defaultOff: true, render: (r) => yen(r.communication_fee) },
  { key: "meeting_fee",           label: "会議費",    align: "right", defaultOff: true, render: (r) => yen(r.meeting_fee) },
  { key: "childcare_allowance",   label: "保育手当",  align: "right", defaultOff: true, render: (r) => yen(r.childcare_allowance) },
  { key: "commute_fee",           label: "通勤手当",  align: "right", render: (r) => yen(r.commute_fee) },
  { key: "business_trip_fee",     label: "出張手当",  align: "right", render: (r) => yen(r.business_trip_fee) },
  { key: "grand_total",           label: "支給合計",  align: "right", always: true, render: (r) => <span className="font-bold">{sumHourlyPay(r).toLocaleString("ja-JP")}円</span> },
];

const MONTHLY_COLS: ColDef<MonthlyRow>[] = [
  { key: "employee_number", label: "社員番号", always: true, render: (r) => <span className="font-mono text-xs">{r.employee_number}</span> },
  { key: "employee_name",   label: "氏名",      always: true, render: (r) => r.employee_name },
  { key: "role_type",       label: "役職",      render: (r) => r.role_type },
  { key: "workDays",        label: "出勤日数",  align: "right", render: (r) => num(r.summary.workDays) },
  { key: "paidLeave",       label: "有給",      align: "right", defaultOff: true, render: (r) => num(r.summary.paidLeave) },
  { key: "specialLeave",    label: "特休",      align: "right", defaultOff: true, render: (r) => num(r.summary.specialLeave) },
  { key: "workHoursMin",    label: "出勤時間",  align: "right", render: (r) => r.summary.workHoursMin > 0 ? fmtMinutes(r.summary.workHoursMin) : "—" },
  { key: "visitMinutes",    label: "訪問時間",  align: "right", defaultOff: true, render: (r) => r.summary.visitMinutes > 0 ? fmtMinutes(r.summary.visitMinutes) : "—" },
  { key: "base_personal",   label: "本人給",    align: "right", render: (r) => yen(r.settings?.base_personal_salary ?? 0) },
  { key: "skill",           label: "職能給",    align: "right", render: (r) => yen(r.settings?.skill_salary ?? 0) },
  { key: "position",        label: "役職手当",  align: "right", defaultOff: true, render: (r) => yen(r.settings?.position_allowance ?? 0) },
  { key: "qualification",   label: "資格手当",  align: "right", defaultOff: true, render: (r) => yen(r.settings?.qualification_allowance ?? 0) },
  { key: "tenure",          label: "勤続手当",  align: "right", render: (r) => yen(r.settings?.tenure_allowance ?? 0) },
  { key: "treatment_improvement", label: "処遇改善手当", align: "right", render: (r) => yen(r.settings?.treatment_improvement ?? 0) },
  { key: "specific_treatment",    label: "特定処遇改善手当", align: "right", defaultOff: true, render: (r) => yen(r.settings?.specific_treatment_improvement ?? 0) },
  { key: "treatment_subsidy",     label: "処遇改善補助金手当", align: "right", defaultOff: true, render: (r) => yen(r.settings?.treatment_subsidy ?? 0) },
  { key: "fixed_overtime",  label: "固定残業代", align: "right", defaultOff: true, render: (r) => yen(r.settings?.fixed_overtime_pay ?? 0) },
  { key: "special_bonus",   label: "特別報奨金", align: "right", defaultOff: true, render: (r) => yen(r.settings?.special_bonus ?? 0) },
  { key: "bonus",           label: "報奨金",     align: "right", defaultOff: true, render: (r) => yen(r.bonus_paid ? (r.settings?.bonus_amount ?? 0) : 0) },
  { key: "childcare_allowance", label: "保育手当", align: "right", defaultOff: true, render: (r) => yen(r.childcare_allowance) },
  { key: "business_trip",   label: "出張手当",   align: "right", defaultOff: true, render: (r) => {
      const km = r.travel_km > 0 ? r.travel_km : r.travel_km_auto;
      return yen(Math.round(km * r.office_travel_unit_price));
    } },
  { key: "grand_total",     label: "支給合計",   align: "right", always: true, render: (r) => <span className="font-bold">{sumMonthlyPay(r).toLocaleString("ja-JP")}円</span> },
];

// ─── 列表示設定の localStorage 管理 ───────────────────

const HOURLY_COL_STORAGE = "payroll-summary:cols:hourly:v2";
const MONTHLY_COL_STORAGE = "payroll-summary:cols:monthly:v2";

/**
 * 「自動」= その月のデータで 値が入っている列だけを出す。
 * 既定はこれ。⚠ 金額や値が入っている列は 既定で隠さない (2026-09-21 user)。
 * 横に長くなるぶんは 左右スクロールで見る。
 */
const AUTO_COLS = "__auto__";

/** render() の結果から文字を取り出す。"—" と空は「値が無い」とみなす */
function nodeText(n: React.ReactNode): string {
  if (n == null || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(nodeText).join("");
  if (typeof n === "object" && "props" in n) {
    return nodeText((n as React.ReactElement<{ children?: React.ReactNode }>).props.children);
  }
  return "";
}

/** 1 行でも値が入っている列の key。always の列は呼ぶ側で足す */
function keysWithValue<T>(cols: ColDef<T>[], rows: T[]): string[] {
  return cols
    .filter((c) => rows.some((r) => {
      const t = nodeText(c.render(r)).trim();
      return t !== "" && t !== "—";
    }))
    .map((c) => c.key);
}

function fmtMonth(m: string) {
  // YYYYMM and YYYY-MM 両対応
  const compact = m.replace("-", "");
  if (compact.length < 6) return m;
  return `${compact.slice(0, 4)}年${parseInt(compact.slice(4, 6), 10)}月`;
}

/** YYYY-MM の前月/次月 */
function shiftYM(ym: string, delta: number): string {
  const [yStr, mStr] = ym.split("-");
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return ym;
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** 当月 YYYY-MM */
function currentYM(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** YYYY-MM → YYYYMM */
function ymToCompact(ym: string): string {
  return ym.replace("-", "");
}

// ─── 業種定義 ──────────────────────────────────────────

/** UI 上の業種 → DB 上の payroll_offices.office_type 値 */
const BUSINESS_TYPE_OPTIONS: { value: string; label: string; types: string[] }[] = [
  // 訪問介護系: 訪問介護 / 居宅 (= 自社内では 訪問介護 / 居宅介護 のいずれか) / 重度訪問介護等
  // 既存の payroll_offices.office_type は "訪問介護" "居宅介護支援" "福祉用具" 等
  { value: "houmon_kaigo", label: "訪問介護", types: ["訪問介護"] },
  { value: "kyotaku", label: "居宅介護支援", types: ["居宅介護支援"] },
];

// ─── 本体 ────────────────────────────────────────────

export default function PayrollSummaryPage() {
  // useLocalStorage で SSR-safe に hydrate (setState-in-effect 不要)
  const [index] = useLocalStorage<IndexEntry[]>(
    "payroll-summary:index",
    [],
    (raw) => {
      const arr = JSON.parse(raw) as IndexEntry[];
      arr.sort((a, b) => b.calculated_at.localeCompare(a.calculated_at));
      return arr;
    },
    JSON.stringify,
  );

  // ─── 業種・事業所・月 selector (出勤簿と同じレイアウト) ───
  const [businessType, setBusinessType] = useState<string>("kyotaku");
  const [selectedOfficeId, setSelectedOfficeId] = useState<string>("");
  const [month, setMonth] = useState<string>(() => currentYM());

  // 全 office (業種選択肢に応じて filter) — SWR cache でページ再訪時の fetch を skip
  const { offices: allOffices, isLoading: officesLoading } = usePayrollOffices();

  const businessTypeMatchTypes = useMemo(
    () => BUSINESS_TYPE_OPTIONS.find((o) => o.value === businessType)?.types ?? [],
    [businessType],
  );
  const filteredOffices = useMemo(
    () => allOffices.filter((o) => businessTypeMatchTypes.includes(o.office_type)),
    [allOffices, businessTypeMatchTypes],
  );
  const selectedOffice = useMemo(
    () => filteredOffices.find((o) => o.id === selectedOfficeId) ?? null,
    [filteredOffices, selectedOfficeId],
  );

  // 業種が切り替わったら、現在 office が新業種に居なければクリア
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- 業種切替時の整合性確保 */
    if (selectedOfficeId && !filteredOffices.some((o) => o.id === selectedOfficeId)) {
      setSelectedOfficeId("");
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [filteredOffices, selectedOfficeId]);

  // 訪問介護モード: 選択中 office + 月 に対応する index entry を検索 (= 計算済 snapshot)
  // 同一 office+月 の calc が複数あれば最新を選ぶ
  const matchingIndexEntry = useMemo<IndexEntry | null>(() => {
    if (businessType !== "houmon_kaigo") return null;
    if (!selectedOffice) return null;
    const target = ymToCompact(month);
    const candidates = index.filter(
      (e) => e.office_number === selectedOffice.office_number && e.processing_month === target,
    );
    if (candidates.length === 0) return null;
    // index は計算時刻 desc でソート済 (useLocalStorage parse 内)
    return candidates[0];
  }, [businessType, selectedOffice, month, index]);

  const selectedKey = matchingIndexEntry?.key ?? "";

  const [visibleHourly, setVisibleHourly] = useLocalStorage<string[]>(
    HOURLY_COL_STORAGE,
    [AUTO_COLS],
    (raw) => {
      const arr = JSON.parse(raw) as string[];
      if (arr.includes(AUTO_COLS)) return [AUTO_COLS];
      const allKeys = HOURLY_COLS.map((c) => c.key);
      return arr.filter((k) => allKeys.includes(k));
    },
    JSON.stringify,
  );
  const [visibleMonthly, setVisibleMonthly] = useLocalStorage<string[]>(
    MONTHLY_COL_STORAGE,
    [AUTO_COLS],
    (raw) => {
      const arr = JSON.parse(raw) as string[];
      if (arr.includes(AUTO_COLS)) return [AUTO_COLS];
      const allKeys = MONTHLY_COLS.map((c) => c.key);
      return arr.filter((k) => allKeys.includes(k));
    },
    JSON.stringify,
  );
  const [colDialogOpen, setColDialogOpen] = useState(false);

  // DB の計算結果 (2026-09-17〜)。あればこちらを優先し、無ければブラウザ保存分
  const [dbSummary, setDbSummary] = useState<{ key: string; summary: Summary | null; error: string | null } | null>(null);
  const dbKey = businessType === "houmon_kaigo" && selectedOffice ? `${selectedOffice.office_number}:${ymToCompact(month)}` : "";
  useEffect(() => {
    if (!dbKey) return;
    const [officeNumber, ym] = dbKey.split(":");
    let cancelled = false;
    supabase
      .from("payroll_calc_results")
      .select("payload, calculated_at")
      .eq("office_number", officeNumber)
      .eq("processing_month", ym)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) console.warn("[payroll-summary] DB の計算結果取得に失敗:", error.message);
        const s = data ? ({ ...(data.payload as Summary), calculated_at: data.calculated_at as string }) : null;
        setDbSummary({ key: dbKey, summary: s, error: error?.message ?? null });
      });
    return () => { cancelled = true; };
  }, [dbKey]);
  const dbResult = dbSummary && dbSummary.key === dbKey ? dbSummary : null;

  // selectedKey から summary を導出 (useEffect+setState ではなく純粋な derived)
  const localSummary = useMemo<Summary | null>(() => {
    if (!selectedKey || typeof window === "undefined") return null;
    try {
      const raw = localStorage.getItem(selectedKey);
      if (raw) return JSON.parse(raw) as Summary;
    } catch (e) {
      console.warn(`[payroll-summary] summary JSON parse 失敗 (key=${selectedKey}):`, e);
    }
    return null;
  }, [selectedKey]);
  const summary: Summary | null = dbResult?.summary ?? localSummary;
  const calculatedAt = dbResult?.summary?.calculated_at ?? matchingIndexEntry?.calculated_at ?? null;

  // 「自動」のときは その月のデータで 値が入っている列を出す
  const autoHourly = useMemo(() => keysWithValue(HOURLY_COLS, summary?.hourly ?? []), [summary]);
  const autoMonthly = useMemo(() => keysWithValue(MONTHLY_COLS, summary?.monthly ?? []), [summary]);
  const isAutoHourly = visibleHourly.includes(AUTO_COLS);
  const isAutoMonthly = visibleMonthly.includes(AUTO_COLS);
  const effHourly = isAutoHourly ? autoHourly : visibleHourly;
  const effMonthly = isAutoMonthly ? autoMonthly : visibleMonthly;

  // 列選択 (useLocalStorage の setter が localStorage 書込まで担当)
  //   ⚠ 自動の状態で 1 つでも触ったら その時点の列を実体化して 手動に切り替える
  const toggleHourly = (key: string, on: boolean) => {
    const base = effHourly;
    setVisibleHourly(on ? [...new Set([...base, key])] : base.filter((k) => k !== key));
  };
  const toggleMonthly = (key: string, on: boolean) => {
    const base = effMonthly;
    setVisibleMonthly(on ? [...new Set([...base, key])] : base.filter((k) => k !== key));
  };

  // 表示する列の順序は COLS の定義順を維持
  const hourlyVisibleCols = useMemo(
    () => HOURLY_COLS.filter((c) => c.always || effHourly.includes(c.key)),
    [effHourly]
  );
  const monthlyVisibleCols = useMemo(
    () => MONTHLY_COLS.filter((c) => c.always || effMonthly.includes(c.key)),
    [effMonthly]
  );

  const hourlyTotal = useMemo(
    () => summary?.hourly.reduce((s, h) => s + sumHourlyPay(h), 0) ?? 0,
    [summary]
  );
  const monthlyTotal = useMemo(
    () => summary?.monthly.reduce((s, m) => s + sumMonthlyPay(m), 0) ?? 0,
    [summary]
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h2 className="text-2xl font-bold">総括表</h2>
        <div className="flex items-center gap-2">
          <Dialog open={colDialogOpen} onOpenChange={setColDialogOpen}>
            <DialogTrigger render={<Button variant="outline" size="sm" />}>⚙ 表示項目を設定</DialogTrigger>
            <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>表示項目の設定</DialogTitle>
              </DialogHeader>
              <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                <span>
                  既定は<strong className="text-foreground">自動</strong>
                  （その月に値が入っている列を全部出す。横は左右スクロール）。
                  チェックを触ると手動に切り替わります。
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto shrink-0"
                  disabled={isAutoHourly && isAutoMonthly}
                  onClick={() => { setVisibleHourly([AUTO_COLS]); setVisibleMonthly([AUTO_COLS]); }}
                >
                  自動に戻す
                </Button>
              </div>
              <div className="space-y-6 mt-2">
                <section>
                  <h3 className="font-semibold mb-2 text-sm">時給者の列</h3>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                    {HOURLY_COLS.map((c) => (
                      <label key={c.key} className={`flex items-center gap-2 text-sm ${c.always ? "opacity-60" : ""}`}>
                        <input
                          type="checkbox"
                          checked={c.always || effHourly.includes(c.key)}
                          disabled={c.always}
                          onChange={(e) => toggleHourly(c.key, e.target.checked)}
                        />
                        {c.label}
                        {c.always && <span className="text-xs text-muted-foreground">（常時）</span>}
                      </label>
                    ))}
                  </div>
                </section>
                <section>
                  <h3 className="font-semibold mb-2 text-sm">月給者の列</h3>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                    {MONTHLY_COLS.map((c) => (
                      <label key={c.key} className={`flex items-center gap-2 text-sm ${c.always ? "opacity-60" : ""}`}>
                        <input
                          type="checkbox"
                          checked={c.always || effMonthly.includes(c.key)}
                          disabled={c.always}
                          onChange={(e) => toggleMonthly(c.key, e.target.checked)}
                        />
                        {c.label}
                        {c.always && <span className="text-xs text-muted-foreground">（常時）</span>}
                      </label>
                    ))}
                  </div>
                </section>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        業種・事業所・月を選んで集計を表示します。訪問介護の再計算は <Link href="/payroll" className="underline">給与計算</Link> から。
      </p>

      {/* ─── 業種 / 事業所 / 月 selector (出勤簿と同じレイアウト) ─── */}
      <div className="border rounded-md p-3 mb-4 bg-muted/10">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">業種</label>
            <select
              className="rounded-md border bg-background px-3 py-2 text-sm min-w-[180px]"
              value={businessType}
              onChange={(e) => setBusinessType(e.target.value)}
            >
              {BUSINESS_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">事業所</label>
            <select
              className="rounded-md border bg-background px-3 py-2 text-sm min-w-[240px]"
              value={selectedOfficeId}
              onChange={(e) => setSelectedOfficeId(e.target.value)}
              disabled={officesLoading || filteredOffices.length === 0}
            >
              <option value="">
                {officesLoading
                  ? "読み込み中..."
                  : filteredOffices.length === 0
                    ? "対象事業所なし"
                    : "事業所を選択"}
              </option>
              {filteredOffices.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.short_name || o.name || o.office_number}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">対象月</label>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setMonth((m) => shiftYM(m, -1))}>
                ← 前月
              </Button>
              <MonthInputButton
                value={month}
                onChange={(next) => setMonth(next)}
                formatLabel={fmtMonth}
              />
              <Button variant="outline" size="sm" onClick={() => setMonth((m) => shiftYM(m, 1))}>
                次月 →
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setMonth(currentYM())}>
                今月
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* ─── 業種に応じた表示 ─── */}
      {businessType === "houmon_kaigo" && (
        <>
          {!selectedOfficeId ? (
            <div className="border rounded-md p-6 text-center text-muted-foreground">
              事業所を選択してください
            </div>
          ) : !summary ? (
            <div className="border rounded-md p-6 text-center text-muted-foreground">
              {selectedOffice?.short_name ?? ""} の {fmtMonth(month)} の計算結果はありません。
              <Link href="/payroll" className="underline ml-1">給与計算</Link> を実行してください。
            </div>
          ) : (
            summary && (
              <>
                <div className="text-xs text-muted-foreground mb-3">
                  {calculatedAt ? new Date(calculatedAt).toLocaleString("ja-JP") : ""} 計算{dbResult?.summary ? "" : "（このブラウザに保存された結果）"}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
                  <div className="border rounded-md p-4">
                    <p className="text-xs text-muted-foreground">時給者 合計</p>
                    <p className="text-2xl font-bold">{hourlyTotal.toLocaleString("ja-JP")}円</p>
                    <p className="text-xs text-muted-foreground mt-1">{summary.hourly.length}名</p>
                  </div>
                  <div className="border rounded-md p-4">
                    <p className="text-xs text-muted-foreground">月給者 合計</p>
                    <p className="text-2xl font-bold">{monthlyTotal.toLocaleString("ja-JP")}円</p>
                    <p className="text-xs text-muted-foreground mt-1">{summary.monthly.length}名</p>
                  </div>
                  <div className="border rounded-md p-4 bg-primary/5">
                    <p className="text-xs text-muted-foreground">総合計</p>
                    <p className="text-2xl font-bold text-primary">{(hourlyTotal + monthlyTotal).toLocaleString("ja-JP")}円</p>
                    <p className="text-xs text-muted-foreground mt-1">{summary.hourly.length + summary.monthly.length}名</p>
                  </div>
                </div>

                {/* 時給者テーブル */}
                <div className="border rounded-md overflow-hidden mb-6">
                  <div className="bg-muted/40 px-3 py-2 text-sm font-medium">時給者（{summary.hourly.length}名）</div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs whitespace-nowrap">
                      <thead className="bg-muted/20 border-b">
                        <tr>
                          {hourlyVisibleCols.map((c) => (
                            <th key={c.key} className={`px-3 py-2 font-medium ${c.align === "right" ? "text-right" : "text-left"}`}>
                              {c.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {summary.hourly.length === 0 ? (
                          <tr><td colSpan={hourlyVisibleCols.length} className="text-center text-muted-foreground py-4">データなし</td></tr>
                        ) : (
                          summary.hourly.map((h) => (
                            <tr key={h.employee_number} className="border-b last:border-b-0">
                              {hourlyVisibleCols.map((c) => (
                                <td key={c.key} className={`px-3 py-1.5 ${c.align === "right" ? "text-right" : ""}`}>
                                  {c.render(h)}
                                </td>
                              ))}
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* 月給者テーブル */}
                <div className="border rounded-md overflow-hidden">
                  <div className="bg-muted/40 px-3 py-2 text-sm font-medium">月給者（{summary.monthly.length}名）</div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs whitespace-nowrap">
                      <thead className="bg-muted/20 border-b">
                        <tr>
                          {monthlyVisibleCols.map((c) => (
                            <th key={c.key} className={`px-3 py-2 font-medium ${c.align === "right" ? "text-right" : "text-left"}`}>
                              {c.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {summary.monthly.length === 0 ? (
                          <tr><td colSpan={monthlyVisibleCols.length} className="text-center text-muted-foreground py-4">データなし</td></tr>
                        ) : (
                          summary.monthly.map((m) => (
                            <tr key={m.employee_id} className="border-b last:border-b-0">
                              {monthlyVisibleCols.map((c) => (
                                <td key={c.key} className={`px-3 py-1.5 ${c.align === "right" ? "text-right" : ""}`}>
                                  {c.render(m)}
                                </td>
                              ))}
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )
          )}
        </>
      )}

      {businessType === "kyotaku" && (
        <KyotakuSummarySection
          officeId={selectedOfficeId}
          month={month}
          weekStart={selectedOffice?.work_week_start ?? 0}
        />
      )}
    </div>
  );
}
