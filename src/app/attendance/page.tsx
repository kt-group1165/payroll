"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";

// ─── 型定義 ──────────────────────────────────────────────────

type AttendanceRecord = {
  employee_number: string;
  employee_name: string;
  day: number;
  day_of_week: string;
  work_note_1: string;
  work_note_2: string;
  work_note_3: string;
  work_note_4: string;
  work_note_5: string;
  start_time_1: string;
  end_time_1: string;
  start_time_2: string;
  end_time_2: string;
  break_time: string;
  work_hours: string;
  commute_km: number | null;
  business_km: number | null;
  overtime_weekly: string;
  overtime_daily: string;
  holiday_work: string;
  legal_overtime: string;
  deduction: string;
  remarks: string;
};

type Employee = {
  employee_number: string;
  name: string;
  role_type: string;
  salary_type: string;
};

// 職員ごとの月次サマリー
type EmployeeSummary = {
  employee_number: string;
  employee_name: string;
  role_type: string;
  salary_type: string;
  workDays: number;         // 出勤日数
  totalWorkMin: number;     // 合計勤務時間（分）
  overtimeMin: number;      // 残業時間（分）
  paidLeave: number;        // 有給
  specialLeave: number;     // 特休
  absence: number;          // 欠勤
  businessKm: number;       // 出張km
  records: AttendanceRecord[];
};

// ─── ユーティリティ ──────────────────────────────────────────

function parseTimeToMinutes(s: string): number {
  if (!s || !s.trim()) return 0;
  s = s.trim();
  if (s.includes(":")) {
    const [h, m] = s.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : Math.round(n * 60);
}

function formatMinutes(min: number): string {
  if (min === 0) return "0:00";
  const h = Math.floor(min / 60), m = min % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

function hasNote(rec: AttendanceRecord, keyword: string): boolean {
  return [rec.work_note_1, rec.work_note_2, rec.work_note_3, rec.work_note_4, rec.work_note_5]
    .some((n) => n && n.includes(keyword));
}

function noteLabel(rec: AttendanceRecord): string {
  const notes = [rec.work_note_1, rec.work_note_2, rec.work_note_3, rec.work_note_4, rec.work_note_5]
    .filter((n) => n && n.trim());
  return notes.join(" / ");
}

const DOW_COLOR: Record<string, string> = {
  土: "text-blue-600",
  日: "text-red-600",
  祝: "text-red-600",
};

function downloadCsv(filename: string, rows: string[][]): void {
  const escape = (v: string) =>
    v.includes(",") || v.includes('"') || v.includes("\n")
      ? `"${v.replace(/"/g, '""')}"` : v;
  const csv = rows.map((r) => r.map(escape).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ─── メインコンポーネント ─────────────────────────────────────

export default function AttendancePage() {
  const [monthOptions, setMonthOptions] = useState<{ year: number; month: number }[]>([]);
  const [selectedYear, setSelectedYear] = useState(0);
  const [selectedMonth, setSelectedMonth] = useState(0);
  const [summaries, setSummaries] = useState<EmployeeSummary[]>([]);
  const [expandedEmp, setExpandedEmp] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 利用可能な月一覧を取得
  useEffect(() => {
    supabase
      .from("attendance_records")
      .select("year,month")
      .then(({ data }) => {
        if (!data) return;
        const seen = new Set<string>();
        const opts: { year: number; month: number }[] = [];
        for (const r of data as { year: number; month: number }[]) {
          const key = `${r.year}-${r.month}`;
          if (!seen.has(key)) { seen.add(key); opts.push({ year: r.year, month: r.month }); }
        }
        opts.sort((a, b) => b.year !== a.year ? b.year - a.year : b.month - a.month);
        setMonthOptions(opts);
        if (opts.length > 0) { setSelectedYear(opts[0].year); setSelectedMonth(opts[0].month); }
      });
  }, []);

  const loadData = useCallback(async () => {
    if (!selectedYear || !selectedMonth) return;
    setLoading(true);
    setExpandedEmp(null);

    const [attRes, empRes] = await Promise.all([
      supabase
        .from("attendance_records")
        .select("*")
        .eq("year", selectedYear)
        .eq("month", selectedMonth)
        .order("employee_number")
        .order("day"),
      supabase.from("employees").select("employee_number,name,role_type,salary_type"),
    ]);

    const records = (attRes.data ?? []) as AttendanceRecord[];
    const empMap = new Map(
      ((empRes.data ?? []) as Employee[]).map((e) => [e.employee_number, e])
    );

    // 職員ごとにグループ化してサマリー計算
    const grouped = new Map<string, AttendanceRecord[]>();
    for (const r of records) {
      if (!grouped.has(r.employee_number)) grouped.set(r.employee_number, []);
      grouped.get(r.employee_number)!.push(r);
    }

    const result: EmployeeSummary[] = [];
    for (const [empNum, recs] of grouped) {
      const emp = empMap.get(empNum);
      let workDays = 0, totalWorkMin = 0, overtimeMin = 0;
      let paidLeave = 0, specialLeave = 0, absence = 0, businessKm = 0;

      for (const r of recs) {
        const isWorked = r.start_time_1 && r.start_time_1.trim() !== "";
        if (isWorked) workDays++;
        totalWorkMin += parseTimeToMinutes(r.work_hours);
        overtimeMin  += parseTimeToMinutes(r.overtime_daily) + parseTimeToMinutes(r.overtime_weekly);
        if (hasNote(r, "有")) paidLeave++;
        if (hasNote(r, "特休")) specialLeave++;
        if (hasNote(r, "欠")) absence++;
        businessKm += r.business_km ?? 0;
      }

      result.push({
        employee_number: empNum,
        employee_name: recs[0].employee_name,
        role_type: emp?.role_type ?? "",
        salary_type: emp?.salary_type ?? "",
        workDays, totalWorkMin, overtimeMin,
        paidLeave, specialLeave, absence, businessKm,
        records: recs,
      });
    }

    result.sort((a, b) => a.employee_number.localeCompare(b.employee_number));
    setSummaries(result);
    setLoading(false);
  }, [selectedYear, selectedMonth]);

  useEffect(() => { loadData(); }, [loadData]);

  // CSV出力（サマリー）
  function exportCsv() {
    const label = `${selectedYear}年${selectedMonth}月`;
    const rows: string[][] = [[
      "職員番号","職員名","役職","給与形態",
      "出勤日数","勤務時間合計","残業時間","有給","特休","欠勤","出張km",
    ]];
    for (const s of summaries) {
      rows.push([
        s.employee_number, s.employee_name, s.role_type, s.salary_type,
        String(s.workDays), formatMinutes(s.totalWorkMin), formatMinutes(s.overtimeMin),
        String(s.paidLeave), String(s.specialLeave), String(s.absence),
        s.businessKm.toFixed(1),
      ]);
    }
    downloadCsv(`労働時間管理_${label}.csv`, rows);
  }

  // CSV出力（日別明細）
  function exportDetailCsv(s: EmployeeSummary) {
    const label = `${selectedYear}年${selectedMonth}月`;
    const rows: string[][] = [["日","曜日","摘要","開始","終了","開始2","終了2","休憩","勤務時間","残業","出張km","備考"]];
    for (const r of s.records) {
      rows.push([
        String(r.day), r.day_of_week, noteLabel(r),
        r.start_time_1, r.end_time_1, r.start_time_2, r.end_time_2,
        r.break_time, r.work_hours,
        r.overtime_daily || r.overtime_weekly,
        r.business_km != null ? String(r.business_km) : "",
        r.remarks,
      ]);
    }
    downloadCsv(`出勤簿_${s.employee_name}_${label}.csv`, rows);
  }

  const totalWorkMin = summaries.reduce((s, e) => s + e.totalWorkMin, 0);
  const totalOvertimeMin = summaries.reduce((s, e) => s + e.overtimeMin, 0);

  const ROLE_COLORS: Record<string, string> = {
    管理者: "bg-purple-100 text-purple-800",
    提責:   "bg-blue-100 text-blue-800",
    社員:   "bg-green-100 text-green-800",
    パート: "bg-orange-100 text-orange-800",
    事務員: "bg-gray-100 text-gray-700",
  };

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
                setSelectedYear(y); setSelectedMonth(m);
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
              <span className="text-sm text-muted-foreground">{summaries.length}名分</span>
            )}
          </div>
        </CardContent>
      </Card>

      {loading && <p className="text-center py-10 text-muted-foreground">読み込み中…</p>}

      {!loading && summaries.length > 0 && (
        <>
          {/* サマリーカード */}
          <div className="grid grid-cols-3 gap-4 mb-4">
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">対象職員数</CardTitle></CardHeader>
              <CardContent><p className="text-2xl font-bold">{summaries.length}名</p></CardContent></Card>
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">合計勤務時間</CardTitle></CardHeader>
              <CardContent><p className="text-2xl font-bold">{formatMinutes(totalWorkMin)}</p></CardContent></Card>
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">合計残業時間</CardTitle></CardHeader>
              <CardContent><p className={`text-2xl font-bold ${totalOvertimeMin > 0 ? "text-orange-600" : ""}`}>{formatMinutes(totalOvertimeMin)}</p></CardContent></Card>
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
                    <th className="text-right px-3 py-3 font-medium">勤務時間</th>
                    <th className="text-right px-3 py-3 font-medium text-orange-700">残業時間</th>
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
                      <>
                        <tr
                          key={s.employee_number}
                          className="border-b hover:bg-muted/30 cursor-pointer"
                          onClick={() => setExpandedEmp(isExpanded ? null : s.employee_number)}
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
                          <td className="px-3 py-2 text-right">{s.workDays}日</td>
                          <td className="px-3 py-2 text-right font-medium">{formatMinutes(s.totalWorkMin)}</td>
                          <td className={`px-3 py-2 text-right font-medium ${s.overtimeMin > 0 ? "text-orange-600" : "text-muted-foreground"}`}>
                            {formatMinutes(s.overtimeMin)}
                          </td>
                          <td className="px-3 py-2 text-right">{s.paidLeave > 0 ? `${s.paidLeave}日` : "—"}</td>
                          <td className="px-3 py-2 text-right">{s.specialLeave > 0 ? `${s.specialLeave}日` : "—"}</td>
                          <td className={`px-3 py-2 text-right ${s.absence > 0 ? "text-red-600 font-medium" : "text-muted-foreground"}`}>
                            {s.absence > 0 ? `${s.absence}日` : "—"}
                          </td>
                          <td className="px-3 py-2 text-right">{s.businessKm > 0 ? `${s.businessKm.toFixed(1)}km` : "—"}</td>
                          <td className="px-3 py-2 text-center text-muted-foreground text-xs">
                            {isExpanded ? "▲" : "▼"}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr key={`${s.employee_number}-detail`} className="bg-muted/10">
                            <td colSpan={11} className="px-6 py-3">
                              <div className="flex items-center justify-between mb-2">
                                <p className="text-xs font-semibold text-muted-foreground">日別明細</p>
                                <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => exportDetailCsv(s)}>
                                  📥 この職員の詳細CSV
                                </Button>
                              </div>
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
                                    <th className="text-right py-1 font-medium">残業</th>
                                    <th className="text-right py-1 font-medium">出張km</th>
                                    <th className="text-left py-1 font-medium">備考</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {s.records.map((r) => {
                                    const isWorked = r.start_time_1 && r.start_time_1.trim();
                                    const dowColor = DOW_COLOR[r.day_of_week] ?? "";
                                    const overtime = r.overtime_daily || r.overtime_weekly;
                                    return (
                                      <tr key={r.day} className={`border-b border-border/30 ${!isWorked && !noteLabel(r) ? "opacity-40" : ""}`}>
                                        <td className="py-0.5 font-medium">{r.day}</td>
                                        <td className={`py-0.5 ${dowColor}`}>{r.day_of_week}</td>
                                        <td className="py-0.5 text-muted-foreground">{noteLabel(r)}</td>
                                        <td className="py-0.5 text-right">{r.start_time_1}</td>
                                        <td className="py-0.5 text-right">{r.end_time_1}</td>
                                        <td className="py-0.5 text-right text-muted-foreground">{r.start_time_2}</td>
                                        <td className="py-0.5 text-right text-muted-foreground">{r.end_time_2}</td>
                                        <td className="py-0.5 text-right">{r.break_time}</td>
                                        <td className="py-0.5 text-right font-medium">{r.work_hours}</td>
                                        <td className={`py-0.5 text-right ${overtime ? "text-orange-600 font-medium" : ""}`}>{overtime}</td>
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
                                    <td className="py-1 text-right">{formatMinutes(s.totalWorkMin)}</td>
                                    <td className={`py-1 text-right ${s.overtimeMin > 0 ? "text-orange-600" : ""}`}>{formatMinutes(s.overtimeMin)}</td>
                                    <td className="py-1 text-right">{s.businessKm > 0 ? `${s.businessKm.toFixed(1)}` : ""}</td>
                                    <td></td>
                                  </tr>
                                </tfoot>
                              </table>
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}

      {!loading && summaries.length === 0 && monthOptions.length === 0 && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground text-sm mb-3">出勤簿データがありません。</p>
            <Link href="/csv-import">
              <Button>📁 出勤簿を取り込む</Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {!loading && summaries.length === 0 && monthOptions.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground text-sm">選択した月のデータがありません。</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
