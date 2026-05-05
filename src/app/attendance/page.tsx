"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { OFFICE_MASTER_JOIN, flattenOfficeMaster } from "@/types/database";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { toast } from "sonner";

// ─── 型定義 ──────────────────────────────────────────────────

type AttendanceRecord = {
  id: string;
  employee_number: string;
  employee_name: string;
  office_number: string;
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

type Office = {
  office_number: string;
  name: string;
  work_week_start: number;  // 0=日, 1=月, ..., 6=土
};

type LaborStats = {
  totalWorkMin: number;
  workDays: number;
  dailyOvertimeMin: number;
  weeklyOvertimeMin: number;
  legalHolidayMin: number;
  paidLeave: number;
  specialLeave: number;
  absence: number;
  businessKm: number;
};

type EmployeeSummary = {
  employee_number: string;
  employee_name: string;
  role_type: string;
  salary_type: string;
  records: AttendanceRecord[];
  stats: LaborStats;
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
  return [rec.work_note_1, rec.work_note_2, rec.work_note_3, rec.work_note_4, rec.work_note_5]
    .filter((n) => n && n.trim()).join(" / ");
}

const DOW_COLOR: Record<string, string> = {
  土: "text-blue-600",
  日: "text-red-600",
  祝: "text-red-600",
};

const WEEK_DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

/**
 * 労働時間統計を計算する
 * @param records 該当月の日別出勤記録
 * @param year 年
 * @param month 月
 * @param weekStart 週起算曜日 0=日, 1=月, ..., 6=土
 */
function computeLaborStats(
  records: AttendanceRecord[],
  year: number,
  month: number,
  weekStart: number
): LaborStats {
  const daysInMonth = new Date(year, month, 0).getDate();

  // 総勤務時間・出勤日数
  const totalWorkMin = records.reduce((s, r) => s + parseTimeToMinutes(r.work_hours), 0);
  const workDays     = records.filter(r => parseTimeToMinutes(r.work_hours) > 0).length;

  // 日残業：1日8時間（480分）を超える部分
  let dailyOvertimeMin = 0;
  for (const r of records) {
    dailyOvertimeMin += Math.max(0, parseTimeToMinutes(r.work_hours) - 480);
  }

  // 週ごとにグループ化
  // 各日について「その週の起算日（月内最小日）」を週キーとする
  const weekMap = new Map<number, AttendanceRecord[]>();
  for (const r of records) {
    const dow = new Date(year, month - 1, r.day).getDay();  // 0=Sun
    const daysBack = (dow - weekStart + 7) % 7;
    const wStartDay = r.day - daysBack;  // 週の最初の日（前月になる場合もある）
    if (!weekMap.has(wStartDay)) weekMap.set(wStartDay, []);
    weekMap.get(wStartDay)!.push(r);
  }

  let weeklyOvertimeMin = 0;
  let legalHolidayMin   = 0;

  for (const [wStartDay, weekRecs] of weekMap) {
    const wEndDay = wStartDay + 6;

    // 週残業：min(日勤務時間, 8h)の週合計が40hを超える部分
    const cappedSum = weekRecs.reduce((s, r) => {
      return s + Math.min(parseTimeToMinutes(r.work_hours), 480);
    }, 0);
    if (cappedSum > 2400) {  // 2400 = 40h × 60
      weeklyOvertimeMin += cappedSum - 2400;
    }

    // 法定休日：週内7日すべてが当月内に存在し、全日勤務した場合、最終日が法定休日
    let daysInWeekInMonth = 0;
    for (let d = wStartDay; d <= wEndDay; d++) {
      if (d >= 1 && d <= daysInMonth) daysInWeekInMonth++;
    }
    if (daysInWeekInMonth === 7) {
      const workedAll = weekRecs.filter(r => parseTimeToMinutes(r.work_hours) > 0).length === 7;
      if (workedAll) {
        const lastRec = weekRecs.find(r => r.day === wEndDay);
        if (lastRec) legalHolidayMin += parseTimeToMinutes(lastRec.work_hours);
      }
    }
  }

  // 有給・特休・欠勤・出張km
  let paidLeave = 0, specialLeave = 0, absence = 0, businessKm = 0;
  for (const r of records) {
    if (hasNote(r, "有")) paidLeave++;
    if (hasNote(r, "特休")) specialLeave++;
    if (hasNote(r, "欠")) absence++;
    businessKm += r.business_km ?? 0;
  }

  return { totalWorkMin, workDays, dailyOvertimeMin, weeklyOvertimeMin, legalHolidayMin, paidLeave, specialLeave, absence, businessKm };
}

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
  const [selectedYear, setSelectedYear]   = useState(0);
  const [selectedMonth, setSelectedMonth] = useState(0);
  const [summaries, setSummaries]         = useState<EmployeeSummary[]>([]);
  const [expandedEmp, setExpandedEmp]     = useState<string | null>(null);
  const [loading, setLoading]             = useState(false);
  const [weekStart, setWeekStart]         = useState(0);  // 表示用（事業所設定から取得）

  // 利用可能な月一覧
  useEffect(() => {
    supabase
      .from("payroll_attendance_records")
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

    // employeesは1000件を超えるためページング取得
    const fetchAllEmployees = async () => {
      const all: Employee[] = [];
      let from = 0;
      while (true) {
        const { data } = await supabase
          .from("payroll_employees")
          .select("employee_number,name,role_type,salary_type")
          .range(from, from + 999);
        if (!data || data.length === 0) break;
        all.push(...(data as Employee[]));
        if (data.length < 1000) break;
        from += 1000;
      }
      return all;
    };

    const [attRes, emps, offRes] = await Promise.all([
      supabase
        .from("payroll_attendance_records")
        .select("*")
        .eq("year", selectedYear)
        .eq("month", selectedMonth)
        .order("employee_number")
        .order("day"),
      fetchAllEmployees(),
      supabase.from("payroll_offices").select(`office_number, work_week_start, ${OFFICE_MASTER_JOIN}`),
    ]);

    const records   = (attRes.data ?? []) as AttendanceRecord[];
    const empMap    = new Map(emps.map(e => [e.employee_number, e]));
    const officeRows = flattenOfficeMaster(offRes.data as never) as unknown as Office[];
    const officeMap = new Map(officeRows.map(o => [o.office_number, o]));

    // 週起算曜日（最初に見つかった事業所の設定を使用）
    const firstOfficeNum = records[0]?.office_number;
    const ws = officeMap.get(firstOfficeNum ?? "")?.work_week_start ?? 0;
    setWeekStart(ws);

    // 職員ごとにグループ化
    const grouped = new Map<string, AttendanceRecord[]>();
    for (const r of records) {
      if (!grouped.has(r.employee_number)) grouped.set(r.employee_number, []);
      grouped.get(r.employee_number)!.push(r);
    }

    const result: EmployeeSummary[] = [];
    for (const [empNum, recs] of grouped) {
      const emp = empMap.get(empNum);
      // 職員ごとの事業所の週起算曜日を取得
      const empOfficeNum = recs[0]?.office_number;
      const empWs = officeMap.get(empOfficeNum ?? "")?.work_week_start ?? 0;

      result.push({
        employee_number: empNum,
        employee_name: recs[0].employee_name,
        role_type: emp?.role_type ?? "",
        salary_type: emp?.salary_type ?? "",
        records: recs,
        stats: computeLaborStats(recs, selectedYear, selectedMonth, empWs),
      });
    }

    result.sort((a, b) => a.employee_number.localeCompare(b.employee_number));
    setSummaries(result);
    setLoading(false);
  }, [selectedYear, selectedMonth]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── データクリア ──────────────────────────────────────────

  async function handleClearMonth() {
    if (!confirm(`${selectedYear}年${selectedMonth}月の出勤簿データを全て削除しますか？\n対象: ${summaries.length}名、${summaries.reduce((s, e) => s + e.records.length, 0)}件`)) return;

    // import_batch_id を収集してバッチごと削除（cascade で attendance_records も削除）
    const batchIds = new Set(summaries.flatMap(s => s.records.map(r => r.id)));
    // 直接 attendance_records を year/month で削除
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
    setSummaries([]);
    // 月一覧を更新
    setMonthOptions(prev => prev.filter(o => !(o.year === selectedYear && o.month === selectedMonth)));
    void batchIds; // suppress unused warning
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
    setSummaries(prev => prev.filter(s => s.employee_number !== emp.employee_number));
  }

  // ── CSV出力 ──────────────────────────────────────────────

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

      {loading && <p className="text-center py-10 text-muted-foreground">読み込み中…</p>}

      {!loading && summaries.length > 0 && (
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
                    const t = s.stats;
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
                          <tr key={`${s.employee_number}-d`} className="bg-muted/10">
                            <td colSpan={13} className="px-6 py-3">
                              <div className="flex items-center justify-between mb-2">
                                <p className="text-xs font-semibold text-muted-foreground">
                                  日別明細（週起算: {WEEK_DAY_LABELS[weekStart]}曜）
                                </p>
                                <div className="flex gap-2">
                                  <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={(e) => { e.stopPropagation(); exportDetailCsv(s); }}>
                                    📥 詳細CSV
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 text-xs text-destructive hover:text-destructive"
                                    onClick={(e) => { e.stopPropagation(); handleClearEmployee(s); }}
                                  >
                                    🗑 削除
                                  </Button>
                                </div>
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
                                    <th className="text-right py-1 font-medium text-orange-700">日残業</th>
                                    <th className="text-right py-1 font-medium">出張km</th>
                                    <th className="text-left py-1 font-medium">備考</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {s.records.map((r) => {
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
                            </td>
                          </tr>
                        )}
                      </>
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
