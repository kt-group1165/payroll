"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { toast } from "sonner";
import {
  type AttendanceRecord,
  type EmployeeSummary,
  type MonthOption,
  parseTimeToMinutes,
  formatMinutes,
  noteLabel,
  DOW_COLOR,
  WEEK_DAY_LABELS,
} from "./attendance-helpers";

function downloadCsv(filename: string, rows: string[][]): void {
  const escape = (v: string) =>
    v.includes(",") || v.includes('"') || v.includes("\n")
      ? `"${v.replace(/"/g, '""')}"` : v;
  const csv = rows.map((r) => r.map(escape).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

const ROLE_COLORS: Record<string, string> = {
  管理者: "bg-purple-100 text-purple-800",
  提責:   "bg-blue-100 text-blue-800",
  社員:   "bg-green-100 text-green-800",
  パート: "bg-orange-100 text-orange-800",
  事務員: "bg-gray-100 text-gray-700",
};

export function AttendanceContent({
  monthOptions,
  selectedYear,
  selectedMonth,
  summaries,
  weekStart,
}: {
  monthOptions: MonthOption[];
  selectedYear: number;
  selectedMonth: number;
  summaries: EmployeeSummary[];
  weekStart: number;
}) {
  const router = useRouter();
  const [expandedEmp, setExpandedEmp] = useState<string | null>(null);

  // 月変更時は URL 移動 → server で再 fetch
  const handleMonthChange = (year: number, month: number) => {
    setExpandedEmp(null);
    router.push(`/attendance?year=${year}&month=${month}`);
  };

  async function handleClearMonth() {
    if (!confirm(`${selectedYear}年${selectedMonth}月の出勤簿データを全て削除しますか？\n対象: ${summaries.length}名、${summaries.reduce((s, e) => s + e.records.length, 0)}件`)) return;

    const { error } = await supabase
      .from("payroll_attendance_records")
      .delete()
      .eq("year", selectedYear)
      .eq("month", selectedMonth);

    if (error) {
      toast.error(`削除エラー: ${error.message}`);
      return;
    }
    toast.success(`${selectedYear}年${selectedMonth}月のデータを削除しました`);
    router.refresh();
  }

  async function handleClearEmployee(emp: EmployeeSummary) {
    if (!confirm(`${emp.employee_name}の${selectedYear}年${selectedMonth}月データを削除しますか？`)) return;

    const { error } = await supabase
      .from("payroll_attendance_records")
      .delete()
      .eq("year", selectedYear)
      .eq("month", selectedMonth)
      .eq("employee_number", emp.employee_number);

    if (error) {
      toast.error(`削除エラー: ${error.message}`);
      return;
    }
    toast.success(`${emp.employee_name}のデータを削除しました`);
    router.refresh();
  }

  function exportCsv() {
    const label = `${selectedYear}年${selectedMonth}月`;
    const rows: string[][] = [[
      "職員番号","職員名","役職","給与形態",
      "出勤日数","総労働時間","日残業","週残業","法定休日時間","残業合計",
      "有給","特休","欠勤","出張km",
    ]];
    for (const s of summaries) {
      const t = s.stats;
      const totalOT = t.dailyOvertimeMin + t.weeklyOvertimeMin;
      rows.push([
        s.employee_number, s.employee_name, s.role_type, s.salary_type,
        String(t.workDays), formatMinutes(t.totalWorkMin),
        formatMinutes(t.dailyOvertimeMin), formatMinutes(t.weeklyOvertimeMin),
        formatMinutes(t.legalHolidayMin), formatMinutes(totalOT),
        String(t.paidLeave), String(t.specialLeave), String(t.absence),
        t.businessKm.toFixed(1),
      ]);
    }
    downloadCsv(`労働時間管理_${label}.csv`, rows);
  }

  function exportDetailCsv(s: EmployeeSummary) {
    const label = `${selectedYear}年${selectedMonth}月`;
    const rows: string[][] = [["日","曜日","摘要","開始","終了","開始2","終了2","休憩","勤務時間","日残業","出張km","備考"]];
    for (const r of s.records) {
      const wh = parseTimeToMinutes(r.work_hours);
      const dailyOT = Math.max(0, wh - 480);
      rows.push([
        String(r.day), r.day_of_week, noteLabel(r),
        r.start_time_1, r.end_time_1, r.start_time_2, r.end_time_2,
        r.break_time, r.work_hours,
        dailyOT > 0 ? formatMinutes(dailyOT) : "",
        r.business_km != null && r.business_km > 0 ? String(r.business_km) : "",
        r.remarks,
      ]);
    }
    downloadCsv(`出勤簿_${s.employee_name}_${label}.csv`, rows);
  }

  // ─── 合計 ─────────────────────────────────────────────────
  const totalWorkMin    = summaries.reduce((s, e) => s + e.stats.totalWorkMin, 0);
  const totalDailyOT    = summaries.reduce((s, e) => s + e.stats.dailyOvertimeMin, 0);
  const totalWeeklyOT   = summaries.reduce((s, e) => s + e.stats.weeklyOvertimeMin, 0);
  const totalLegalHol   = summaries.reduce((s, e) => s + e.stats.legalHolidayMin, 0);
  const totalOT         = totalDailyOT + totalWeeklyOT;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">労働時間管理</h2>
        <Link href="/csv-import">
          <Button variant="outline" size="sm">📁 出勤簿を取り込む</Button>
        </Link>
      </div>

      {/* 月選択 */}
      <Card className="mb-6">
        <CardContent className="pt-5 pb-4">
          <div className="flex items-center gap-3 flex-wrap">
            <label className="text-sm font-medium">対象月</label>
            <select
              className="border rounded px-3 py-1.5 text-sm bg-background"
              value={`${selectedYear}-${selectedMonth}`}
              onChange={(e) => {
                const [y, m] = e.target.value.split("-").map(Number);
                handleMonthChange(y, m);
              }}
            >
              {monthOptions.length === 0 && <option value="">（データなし）</option>}
              {monthOptions.map((o) => (
                <option key={`${o.year}-${o.month}`} value={`${o.year}-${o.month}`}>
                  {o.year}年{o.month}月
                </option>
              ))}
            </select>
            {summaries.length > 0 && (
              <>
                <span className="text-sm text-muted-foreground">{summaries.length}名</span>
                <span className="text-xs text-muted-foreground">週起算: {WEEK_DAY_LABELS[weekStart]}曜</span>
              </>
            )}
            {summaries.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="ml-auto text-destructive hover:text-destructive"
                onClick={handleClearMonth}
              >
                🗑 この月のデータを削除
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {summaries.length > 0 && (
        <>
          {/* サマリーカード */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">対象職員数</CardTitle></CardHeader>
              <CardContent><p className="text-2xl font-bold">{summaries.length}名</p></CardContent></Card>
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">総労働時間</CardTitle></CardHeader>
              <CardContent><p className="text-2xl font-bold">{formatMinutes(totalWorkMin)}</p></CardContent></Card>
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">残業時間合計</CardTitle></CardHeader>
              <CardContent><p className={`text-2xl font-bold ${totalOT > 0 ? "text-orange-600" : ""}`}>{formatMinutes(totalOT)}</p></CardContent></Card>
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">法定休日労働</CardTitle></CardHeader>
              <CardContent><p className={`text-2xl font-bold ${totalLegalHol > 0 ? "text-red-600" : ""}`}>{formatMinutes(totalLegalHol)}</p></CardContent></Card>
          </div>

          {/* 一覧テーブル */}
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>{selectedYear}年{selectedMonth}月 出勤簿一覧</CardTitle>
              <Button variant="outline" size="sm" onClick={exportCsv}>📥 CSV出力</Button>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-3 py-3 font-medium">職員番号</th>
                    <th className="text-left px-3 py-3 font-medium">職員名</th>
                    <th className="text-left px-3 py-3 font-medium">役職</th>
                    <th className="text-right px-3 py-3 font-medium">出勤日数</th>
                    <th className="text-right px-3 py-3 font-medium">総労働時間</th>
                    <th className="text-right px-3 py-3 font-medium text-orange-700">日残業</th>
                    <th className="text-right px-3 py-3 font-medium text-orange-700">週残業</th>
                    <th className="text-right px-3 py-3 font-medium text-red-700">法定休日</th>
                    <th className="text-right px-3 py-3 font-medium text-green-700">有給</th>
                    <th className="text-right px-3 py-3 font-medium text-blue-700">特休</th>
                    <th className="text-right px-3 py-3 font-medium text-red-700">欠勤</th>
                    <th className="text-right px-3 py-3 font-medium">出張km</th>
                    <th className="px-3 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {summaries.map((s) => {
                    const isExpanded = expandedEmp === s.employee_number;
                    return (
                      <EmployeeRow
                        key={s.employee_number}
                        s={s}
                        isExpanded={isExpanded}
                        onToggle={() => setExpandedEmp(isExpanded ? null : s.employee_number)}
                        onExportDetail={() => exportDetailCsv(s)}
                        onClear={() => handleClearEmployee(s)}
                        weekStart={weekStart}
                      />
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-muted/30 font-bold">
                    <td colSpan={4} className="px-3 py-2">合計</td>
                    <td className="px-3 py-2 text-right">{formatMinutes(totalWorkMin)}</td>
                    <td className={`px-3 py-2 text-right ${totalDailyOT > 0 ? "text-orange-600" : ""}`}>{formatMinutes(totalDailyOT)}</td>
                    <td className={`px-3 py-2 text-right ${totalWeeklyOT > 0 ? "text-orange-600" : ""}`}>{formatMinutes(totalWeeklyOT)}</td>
                    <td className={`px-3 py-2 text-right ${totalLegalHol > 0 ? "text-red-600" : ""}`}>{formatMinutes(totalLegalHol)}</td>
                    <td colSpan={5}></td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </CardContent>
          </Card>
        </>
      )}

      {summaries.length === 0 && monthOptions.length === 0 && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground text-sm mb-3">出勤簿データがありません。</p>
            <Link href="/csv-import">
              <Button>📁 出勤簿を取り込む</Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {summaries.length === 0 && monthOptions.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground text-sm">選択した月のデータがありません。</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function EmployeeRow({
  s, isExpanded, onToggle, onExportDetail, onClear, weekStart,
}: {
  s: EmployeeSummary;
  isExpanded: boolean;
  onToggle: () => void;
  onExportDetail: () => void;
  onClear: () => void;
  weekStart: number;
}) {
  const t = s.stats;
  return (
    <>
      <tr
        className="border-b hover:bg-muted/30 cursor-pointer"
        onClick={onToggle}
      >
        <td className="px-3 py-2 font-mono text-xs">{s.employee_number}</td>
        <td className="px-3 py-2 font-medium">{s.employee_name}</td>
        <td className="px-3 py-2">
          {s.role_type && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${ROLE_COLORS[s.role_type] ?? "bg-gray-100 text-gray-700"}`}>
              {s.role_type}
            </span>
          )}
        </td>
        <td className="px-3 py-2 text-right">{t.workDays}日</td>
        <td className="px-3 py-2 text-right font-medium">{formatMinutes(t.totalWorkMin)}</td>
        <td className={`px-3 py-2 text-right font-medium ${t.dailyOvertimeMin > 0 ? "text-orange-600" : "text-muted-foreground"}`}>
          {formatMinutes(t.dailyOvertimeMin)}
        </td>
        <td className={`px-3 py-2 text-right font-medium ${t.weeklyOvertimeMin > 0 ? "text-orange-600" : "text-muted-foreground"}`}>
          {formatMinutes(t.weeklyOvertimeMin)}
        </td>
        <td className={`px-3 py-2 text-right font-medium ${t.legalHolidayMin > 0 ? "text-red-600" : "text-muted-foreground"}`}>
          {formatMinutes(t.legalHolidayMin)}
        </td>
        <td className="px-3 py-2 text-right">{t.paidLeave > 0 ? `${t.paidLeave}日` : "—"}</td>
        <td className="px-3 py-2 text-right">{t.specialLeave > 0 ? `${t.specialLeave}日` : "—"}</td>
        <td className={`px-3 py-2 text-right ${t.absence > 0 ? "text-red-600 font-medium" : "text-muted-foreground"}`}>
          {t.absence > 0 ? `${t.absence}日` : "—"}
        </td>
        <td className="px-3 py-2 text-right">{t.businessKm > 0 ? `${t.businessKm.toFixed(1)}km` : "—"}</td>
        <td className="px-3 py-2 text-center text-muted-foreground text-xs">
          {isExpanded ? "▲" : "▼"}
        </td>
      </tr>
      {isExpanded && (
        <tr className="bg-muted/10">
          <td colSpan={13} className="px-6 py-3">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-muted-foreground">
                日別明細（週起算: {WEEK_DAY_LABELS[weekStart]}曜）
              </p>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={(e) => { e.stopPropagation(); onExportDetail(); }}>
                  📥 詳細CSV
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs text-destructive hover:text-destructive"
                  onClick={(e) => { e.stopPropagation(); onClear(); }}
                >
                  🗑 削除
                </Button>
              </div>
            </div>
            <DetailTable s={s} />
          </td>
        </tr>
      )}
    </>
  );
}

function DetailTable({ s }: { s: EmployeeSummary }) {
  const t = s.stats;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b">
          <th className="text-left py-1 font-medium w-8">日</th>
          <th className="text-left py-1 font-medium w-8">曜</th>
          <th className="text-left py-1 font-medium">摘要</th>
          <th className="text-right py-1 font-medium">開始</th>
          <th className="text-right py-1 font-medium">終了</th>
          <th className="text-right py-1 font-medium">開始2</th>
          <th className="text-right py-1 font-medium">終了2</th>
          <th className="text-right py-1 font-medium">休憩</th>
          <th className="text-right py-1 font-medium">勤務時間</th>
          <th className="text-right py-1 font-medium text-orange-700">日残業</th>
          <th className="text-right py-1 font-medium">出張km</th>
          <th className="text-left py-1 font-medium">備考</th>
        </tr>
      </thead>
      <tbody>
        {s.records.map((r: AttendanceRecord) => {
          const wh = parseTimeToMinutes(r.work_hours);
          const dailyOT = Math.max(0, wh - 480);
          const dowColor = DOW_COLOR[r.day_of_week] ?? "";
          return (
            <tr key={r.day} className={`border-b border-border/30 ${wh === 0 && !noteLabel(r) ? "opacity-40" : ""}`}>
              <td className="py-0.5 font-medium">{r.day}</td>
              <td className={`py-0.5 ${dowColor}`}>{r.day_of_week}</td>
              <td className="py-0.5 text-muted-foreground">{noteLabel(r)}</td>
              <td className="py-0.5 text-right">{r.start_time_1}</td>
              <td className="py-0.5 text-right">{r.end_time_1}</td>
              <td className="py-0.5 text-right text-muted-foreground">{r.start_time_2}</td>
              <td className="py-0.5 text-right text-muted-foreground">{r.end_time_2}</td>
              <td className="py-0.5 text-right">{r.break_time}</td>
              <td className="py-0.5 text-right font-medium">{r.work_hours}</td>
              <td className={`py-0.5 text-right ${dailyOT > 0 ? "text-orange-600 font-medium" : "text-muted-foreground"}`}>
                {dailyOT > 0 ? formatMinutes(dailyOT) : "—"}
              </td>
              <td className="py-0.5 text-right">{r.business_km != null && r.business_km > 0 ? `${r.business_km}` : ""}</td>
              <td className="py-0.5 text-muted-foreground">{r.remarks}</td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr className="font-bold border-t">
          <td colSpan={3} className="py-1">合計</td>
          <td colSpan={4}></td>
          <td></td>
          <td className="py-1 text-right">{formatMinutes(t.totalWorkMin)}</td>
          <td className={`py-1 text-right ${t.dailyOvertimeMin > 0 ? "text-orange-600" : ""}`}>{formatMinutes(t.dailyOvertimeMin)}</td>
          <td className="py-1 text-right">{t.businessKm > 0 ? `${t.businessKm.toFixed(1)}` : ""}</td>
          <td></td>
        </tr>
      </tfoot>
    </table>
  );
}
