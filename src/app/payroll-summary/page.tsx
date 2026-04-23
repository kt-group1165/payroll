"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

type IndexEntry = {
  key: string;
  office_number: string;
  office_name: string;
  processing_month: string;
  calculated_at: string;
};

type HourlyRow = {
  employee_number: string;
  employee_name: string;
  role_type: string;
  totalPay: number;
  treatment_subsidy: number;
  paid_leave_allowance: number;
  cancel_allowance: number;
  travel_allowance: number;
  communication_fee: number;
  meeting_fee: number;
  childcare_allowance: number;
  commute_fee: number;
  business_trip_fee: number;
  unmappedCount: number;
  totalMinutes: number;
};

type MonthlyRow = {
  employee_id: string;
  employee_number: string;
  employee_name: string;
  role_type: string;
  settings: Record<string, number> | null;
  bonus_paid: boolean;
  childcare_allowance: number;
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

function fmtMonth(m: string) {
  return `${m.slice(0, 4)}年${parseInt(m.slice(4, 6), 10)}月`;
}

function yen(n: number) {
  return n.toLocaleString("ja-JP") + "円";
}

function sumHourlyPay(h: HourlyRow): number {
  return (
    h.totalPay +
    h.treatment_subsidy +
    h.paid_leave_allowance +
    h.cancel_allowance +
    h.travel_allowance +
    h.communication_fee +
    h.meeting_fee +
    h.childcare_allowance +
    h.commute_fee +
    h.business_trip_fee
  );
}

function sumMonthlyPay(m: MonthlyRow): number {
  const s = m.settings;
  if (!s) return 0;
  const fixedTotal =
    (s.base_personal_salary ?? 0) + (s.skill_salary ?? 0) +
    (s.position_allowance ?? 0) + (s.qualification_allowance ?? 0) + (s.tenure_allowance ?? 0) +
    (s.treatment_improvement ?? 0) + (s.specific_treatment_improvement ?? 0) + (s.treatment_subsidy ?? 0) +
    (s.fixed_overtime_pay ?? 0) + (s.special_bonus ?? 0);
  const bonus = m.bonus_paid ? (s.bonus_amount ?? 0) : 0;
  return fixedTotal + bonus + (m.childcare_allowance ?? 0);
}

export default function PayrollSummaryPage() {
  const [index, setIndex] = useState<IndexEntry[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    try {
      const idx = JSON.parse(localStorage.getItem("payroll-summary:index") ?? "[]") as IndexEntry[];
      // 新しい順
      idx.sort((a, b) => b.calculated_at.localeCompare(a.calculated_at));
      setIndex(idx);
      if (idx.length > 0) setSelectedKey(idx[0].key);
    } catch {
      setIndex([]);
    }
  }, []);

  useEffect(() => {
    if (!selectedKey) { setSummary(null); return; }
    try {
      const raw = localStorage.getItem(selectedKey);
      if (raw) setSummary(JSON.parse(raw) as Summary);
    } catch {
      setSummary(null);
    }
  }, [selectedKey]);

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
      <h2 className="text-2xl font-bold mb-2">総括表</h2>
      <p className="text-sm text-muted-foreground mb-4">
        直近の給与計算結果を事業所・月ごとに一覧できます。
        再計算する場合は <Link href="/payroll" className="underline">給与計算</Link> から実行してください。
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
              className="border rounded px-3 py-1.5 text-sm bg-background min-w-[320px]"
              value={selectedKey}
              onChange={(e) => setSelectedKey(e.target.value)}
            >
              {index.map((e) => (
                <option key={e.key} value={e.key}>
                  {e.office_name} / {fmtMonth(e.processing_month)} ({new Date(e.calculated_at).toLocaleString("ja-JP")} 計算)
                </option>
              ))}
            </select>
          </div>

          {summary && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
                <div className="border rounded-md p-4">
                  <p className="text-xs text-muted-foreground">時給者 合計</p>
                  <p className="text-2xl font-bold">{yen(hourlyTotal)}</p>
                  <p className="text-xs text-muted-foreground mt-1">{summary.hourly.length}名</p>
                </div>
                <div className="border rounded-md p-4">
                  <p className="text-xs text-muted-foreground">月給者 合計</p>
                  <p className="text-2xl font-bold">{yen(monthlyTotal)}</p>
                  <p className="text-xs text-muted-foreground mt-1">{summary.monthly.length}名</p>
                </div>
                <div className="border rounded-md p-4 bg-primary/5">
                  <p className="text-xs text-muted-foreground">総合計</p>
                  <p className="text-2xl font-bold text-primary">{yen(hourlyTotal + monthlyTotal)}</p>
                  <p className="text-xs text-muted-foreground mt-1">{summary.hourly.length + summary.monthly.length}名</p>
                </div>
              </div>

              {/* 時給者 */}
              <div className="border rounded-md overflow-hidden mb-6">
                <div className="bg-muted/40 px-3 py-2 text-sm font-medium">時給者（{summary.hourly.length}名）</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/20 border-b">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium">社員番号</th>
                        <th className="text-left px-3 py-2 font-medium">氏名</th>
                        <th className="text-left px-3 py-2 font-medium">役職</th>
                        <th className="text-right px-3 py-2 font-medium">支給合計</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.hourly.length === 0 ? (
                        <tr><td colSpan={4} className="text-center text-muted-foreground py-4">データなし</td></tr>
                      ) : (
                        summary.hourly.map((h) => (
                          <tr key={h.employee_number} className="border-b last:border-b-0">
                            <td className="px-3 py-1.5 font-mono text-xs">{h.employee_number}</td>
                            <td className="px-3 py-1.5">{h.employee_name}</td>
                            <td className="px-3 py-1.5 text-xs text-muted-foreground">{h.role_type}</td>
                            <td className="px-3 py-1.5 text-right font-medium">{yen(sumHourlyPay(h))}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* 月給者 */}
              <div className="border rounded-md overflow-hidden">
                <div className="bg-muted/40 px-3 py-2 text-sm font-medium">月給者（{summary.monthly.length}名）</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/20 border-b">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium">社員番号</th>
                        <th className="text-left px-3 py-2 font-medium">氏名</th>
                        <th className="text-left px-3 py-2 font-medium">役職</th>
                        <th className="text-right px-3 py-2 font-medium">支給合計</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.monthly.length === 0 ? (
                        <tr><td colSpan={4} className="text-center text-muted-foreground py-4">データなし</td></tr>
                      ) : (
                        summary.monthly.map((m) => (
                          <tr key={m.employee_id} className="border-b last:border-b-0">
                            <td className="px-3 py-1.5 font-mono text-xs">{m.employee_number}</td>
                            <td className="px-3 py-1.5">{m.employee_name}</td>
                            <td className="px-3 py-1.5 text-xs text-muted-foreground">{m.role_type}</td>
                            <td className="px-3 py-1.5 text-right font-medium">{yen(sumMonthlyPay(m))}</td>
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
