"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

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
  defaultOff?: boolean;      // 既定で非表示
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

function sumHourlyPay(h: HourlyRow): number {
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

const HOURLY_COL_STORAGE = "payroll-summary:cols:hourly";
const MONTHLY_COL_STORAGE = "payroll-summary:cols:monthly";

function defaultVisibleKeys<T>(cols: ColDef<T>[]): string[] {
  return cols.filter((c) => !c.defaultOff).map((c) => c.key);
}

function loadVisible(storageKey: string, allKeys: string[], defaults: string[]): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return defaults;
    const arr = JSON.parse(raw) as string[];
    return arr.filter((k) => allKeys.includes(k));
  } catch {
    return defaults;
  }
}

function fmtMonth(m: string) {
  return `${m.slice(0, 4)}年${parseInt(m.slice(4, 6), 10)}月`;
}

// ─── 本体 ────────────────────────────────────────────

export default function PayrollSummaryPage() {
  const [index, setIndex] = useState<IndexEntry[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [visibleHourly, setVisibleHourly] = useState<string[]>(() => defaultVisibleKeys(HOURLY_COLS));
  const [visibleMonthly, setVisibleMonthly] = useState<string[]>(() => defaultVisibleKeys(MONTHLY_COLS));
  const [colDialogOpen, setColDialogOpen] = useState(false);

  // 初期化: index と 列選択
  useEffect(() => {
    try {
      const idx = JSON.parse(localStorage.getItem("payroll-summary:index") ?? "[]") as IndexEntry[];
      idx.sort((a, b) => b.calculated_at.localeCompare(a.calculated_at));
      setIndex(idx);
      if (idx.length > 0) setSelectedKey(idx[0].key);
    } catch { setIndex([]); }
    setVisibleHourly(loadVisible(HOURLY_COL_STORAGE, HOURLY_COLS.map((c) => c.key), defaultVisibleKeys(HOURLY_COLS)));
    setVisibleMonthly(loadVisible(MONTHLY_COL_STORAGE, MONTHLY_COLS.map((c) => c.key), defaultVisibleKeys(MONTHLY_COLS)));
  }, []);

  useEffect(() => {
    if (!selectedKey) { setSummary(null); return; }
    try {
      const raw = localStorage.getItem(selectedKey);
      if (raw) setSummary(JSON.parse(raw) as Summary);
    } catch { setSummary(null); }
  }, [selectedKey]);

  // 列選択の保存
  const toggleHourly = (key: string, on: boolean) => {
    setVisibleHourly((prev) => {
      const next = on ? [...new Set([...prev, key])] : prev.filter((k) => k !== key);
      localStorage.setItem(HOURLY_COL_STORAGE, JSON.stringify(next));
      return next;
    });
  };
  const toggleMonthly = (key: string, on: boolean) => {
    setVisibleMonthly((prev) => {
      const next = on ? [...new Set([...prev, key])] : prev.filter((k) => k !== key);
      localStorage.setItem(MONTHLY_COL_STORAGE, JSON.stringify(next));
      return next;
    });
  };

  // 表示する列の順序は COLS の定義順を維持
  const hourlyVisibleCols = useMemo(
    () => HOURLY_COLS.filter((c) => c.always || visibleHourly.includes(c.key)),
    [visibleHourly]
  );
  const monthlyVisibleCols = useMemo(
    () => MONTHLY_COLS.filter((c) => c.always || visibleMonthly.includes(c.key)),
    [visibleMonthly]
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
              <div className="space-y-6 mt-2">
                <section>
                  <h3 className="font-semibold mb-2 text-sm">時給者の列</h3>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                    {HOURLY_COLS.map((c) => (
                      <label key={c.key} className={`flex items-center gap-2 text-sm ${c.always ? "opacity-60" : ""}`}>
                        <input
                          type="checkbox"
                          checked={c.always || visibleHourly.includes(c.key)}
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
                          checked={c.always || visibleMonthly.includes(c.key)}
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
        直近の給与計算結果を事業所・月ごとに一覧できます。再計算は <Link href="/payroll" className="underline">給与計算</Link> から。
      </p>

      {index.length === 0 ? (
        <div className="border rounded-md p-6 text-center text-muted-foreground">
          まだ計算結果がありません。<Link href="/payroll" className="underline ml-1">給与計算</Link> を実行してください。
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <label className="text-sm font-medium">計算履歴</label>
            <select
              className="border rounded px-3 py-1.5 text-sm bg-background min-w-[360px]"
              value={selectedKey}
              onChange={(e) => setSelectedKey(e.target.value)}
            >
              {index.map((e) => (
                <option key={e.key} value={e.key}>
                  {e.office_name} / {fmtMonth(e.processing_month)} （{new Date(e.calculated_at).toLocaleString("ja-JP")} 計算）
                </option>
              ))}
            </select>
          </div>

          {summary && (
            <>
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
          )}
        </>
      )}
    </div>
  );
}
