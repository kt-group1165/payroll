"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// ─── 実勤続月数の基準月 ─────────────────────────────────────
// effective_service_months の初期データが何月時点の値かを設定する
// 初期データを入れ直す場合はここを変更する
const TENURE_BASE_YEAR  = 2026;
const TENURE_BASE_MONTH = 3;

// ─── 型定義 ──────────────────────────────────────────────────

type ServiceRecord = {
  id: string;
  employee_number: string;
  employee_name: string;
  service_date: string;
  calc_duration: string;
  service_code: string;
  office_number: string;
  accompanied_visit: string;
};

type AttendanceRecord = {
  employee_number: string;
  day: number;
  work_note_1: string;
  work_note_2: string;
  work_note_3: string;
  work_note_4: string;
  work_note_5: string;
  start_time_1: string;
  work_hours: string;
};

type ServiceTypeMapping = { service_code: string; category_id: string };
type CategoryHourlyRate  = { category_id: string; office_id: string; hourly_rate: number };
type Office              = { id: string; office_number: string; name: string };
type ServiceCategory     = { id: string; name: string };

type Employee = {
  id: string;
  employee_number: string;
  name: string;
  role_type: string;
  salary_type: string;
  employment_status: string;
  has_care_qualification: boolean;
  job_type: string;
  effective_service_months: number;
};

type SalarySettings = {
  employee_id: string;
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
  travel_unit_price: number;
  care_overtime_threshold_hours: number;
  care_overtime_unit_price: number;
  yocho_unit_price: number;
};

// 勤怠サマリー（職員ごと）
type AttendanceSummary = {
  workDays: number;
  helperDays: number;
  paidLeave: number;
  specialLeave: number;
  workHoursMin: number;
  recordCount: number;
  accompaniedCount: number;
  visitMinutes: number;
  hrdCount: number;
};

// 時給者
type HourlyPayroll = {
  employee_number: string;
  employee_name: string;
  role_type: string;
  has_care_qualification: boolean;
  job_type: string;
  effective_service_months: number;
  care_plan_count: number;  // 居宅介護支援：担当要介護プラン相当件数（手動入力）
  records: HourlyDetailRow[];
  totalMinutes: number;
  totalPay: number;
  unmappedCount: number;
  summary: AttendanceSummary;
};

type HourlyDetailRow = {
  id: string;
  service_date: string;
  minutes: number;
  service_code: string;
  category_name: string;
  hourly_rate: number | null;
  pay: number | null;
};

// 月給者
type MonthlyPayroll = {
  employee_id: string;
  employee_number: string;
  employee_name: string;
  role_type: string;
  settings: SalarySettings | null;
  bonus_paid: boolean;
  travel_km: number;
  business_trip_fee: number;
  yocho_hours: number;   // 夜朝時間（月次手動入力）
  summary: AttendanceSummary;
};

// ─── ユーティリティ ──────────────────────────────────────────

function parseDurationMinutes(str: string): number {
  if (!str) return 0;
  str = str.trim();
  if (str.includes(":")) {
    const [h, m] = str.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  }
  return parseInt(str, 10) || 0;
}

function parseWorkHoursMinutes(s: string): number {
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
  if (min === 0) return "0分";
  const h = Math.floor(min / 60), m = min % 60;
  if (h === 0) return `${m}分`;
  if (m === 0) return `${h}時間`;
  return `${h}時間${m}分`;
}

function formatWorkHours(min: number): string {
  if (min === 0) return "0:00";
  const h = Math.floor(min / 60), m = min % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

const yen = (n: number) => n.toLocaleString("ja-JP") + "円";

function formatProcessingMonth(m: string): string {
  if (!m || m.length < 6) return m;
  return `${m.slice(0, 4)}年${parseInt(m.slice(4, 6), 10)}月`;
}

function formatDate(d: string): string {
  if (!d || d.length < 8) return d;
  return `${parseInt(d.slice(4, 6), 10)}/${parseInt(d.slice(6, 8), 10)}`;
}

/** service_date 文字列から「日」の数値を抽出（YYYYMMDD / YYYY/MM/DD 等に対応） */
function extractDay(serviceDate: string): number {
  const digits = serviceDate.replace(/\D/g, ""); // 数字のみ
  if (digits.length >= 8) return parseInt(digits.slice(6, 8), 10);
  return 0;
}

/**
 * 勤続手当計算（資格・経験による定期昇給）
 * 対象: 介護福祉士または実務者研修修了者
 *   社員(月給)    : 1年=1,000円、以降1年ごと+500円
 *   パートヘルパー: 1年=10円/h、5年=20円/h、以降5年ごと+10円/h
 *   パート訪問入浴: 1年=10円/件、5年=20円/件、以降5年ごと+10円/件
 *   非常勤居宅介護支援: 1年=50円/件、5年=100円/件、以降5年ごと+50円/件
 */
function computeTenureAllowance(
  hasQualification: boolean,
  effectiveServiceMonths: number,
  salaryType: string,
  jobType: string,
  workHoursMin: number,   // パートヘルパー用（出勤簿の総労働時間）
  recordCount: number,    // パート訪問入浴用（実績件数）
  carePlanCount: number,  // 非常勤居宅介護支援用（要介護プラン相当件数）
): number {
  if (!hasQualification) return 0;
  const years = Math.floor(effectiveServiceMonths / 12);
  if (years < 1) return 0;

  if (salaryType === "月給") {
    return 1000 + (years - 1) * 500;
  }

  if (salaryType === "時給") {
    if (jobType === "訪問介護" || jobType === "訪問看護") {
      const rate = (Math.floor(years / 5) + 1) * 10;
      return Math.round((workHoursMin / 60) * rate);
    }
    if (jobType === "訪問入浴") {
      const rate = (Math.floor(years / 5) + 1) * 10;
      return rate * recordCount;
    }
    if (jobType === "居宅介護支援") {
      const rate = (Math.floor(years / 5) + 1) * 50;
      return rate * carePlanCount;
    }
  }

  return 0;
}

function fixedTotal(s: SalarySettings): number {
  return (
    s.base_personal_salary + s.skill_salary +
    s.position_allowance + s.qualification_allowance + s.tenure_allowance +
    s.treatment_improvement + s.specific_treatment_improvement + s.treatment_subsidy +
    s.fixed_overtime_pay + s.special_bonus
  );
}

function careOvertimePay(p: MonthlyPayroll): number {
  if (p.role_type !== "社員") return 0;
  const s = p.settings;
  if (!s || s.care_overtime_threshold_hours <= 0 || s.care_overtime_unit_price <= 0) return 0;
  const thresholdMin = s.care_overtime_threshold_hours * 60;
  const overMin = Math.max(0, p.summary.visitMinutes - thresholdMin);
  return Math.round((overMin / 60) * s.care_overtime_unit_price);
}

function yochoAllowance(p: MonthlyPayroll): number {
  const s = p.settings;
  if (!s || s.yocho_unit_price <= 0 || p.yocho_hours <= 0) return 0;
  return Math.round(p.yocho_hours * s.yocho_unit_price);
}

function monthlyGrandTotal(p: MonthlyPayroll): number {
  if (!p.settings) return 0;
  return (
    fixedTotal(p.settings) +
    (p.bonus_paid ? p.settings.bonus_amount : 0) +
    Math.round(p.travel_km * (p.settings.travel_unit_price || 0)) +
    p.business_trip_fee +
    careOvertimePay(p) +
    yochoAllowance(p)
  );
}

function downloadCsv(filename: string, rows: string[][]): void {
  const escape = (v: string) =>
    v.includes(",") || v.includes('"') || v.includes("\n")
      ? `"${v.replace(/"/g, '""')}"`
      : v;
  const csv = rows.map((r) => r.map(escape).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function countNoteKeyword(attDays: AttendanceRecord[], keyword: string): number {
  return attDays.filter((r) =>
    [r.work_note_1, r.work_note_2, r.work_note_3, r.work_note_4, r.work_note_5]
      .some((n) => n && n.includes(keyword))
  ).length;
}

// ─── メインコンポーネント ─────────────────────────────────────

export default function PayrollPage() {
  const [months, setMonths] = useState<string[]>([]);
  const [selectedMonth, setSelectedMonth] = useState("");
  const [tab, setTab] = useState<"hourly" | "monthly">("hourly");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [hourlyResults, setHourlyResults] = useState<HourlyPayroll[]>([]);
  const [expandedEmp, setExpandedEmp] = useState<string | null>(null);

  const [monthlyResults, setMonthlyResults] = useState<MonthlyPayroll[]>([]);
  const [expandedMonthly, setExpandedMonthly] = useState<string | null>(null);

  useEffect(() => {
    supabase.from("service_records").select("processing_month").then(({ data }) => {
      if (!data) return;
      const unique = [...new Set(data.map((r: { processing_month: string }) => r.processing_month))].sort().reverse();
      setMonths(unique);
      if (unique.length > 0) setSelectedMonth(unique[0]);
    });
  }, []);

  // ─── 給与計算実行 ─────────────────────────────────────────────

  async function calculate() {
    if (!selectedMonth) return;
    setLoading(true); setError("");
    setHourlyResults([]); setMonthlyResults([]);
    setExpandedEmp(null); setExpandedMonthly(null);

    try {
      const year  = parseInt(selectedMonth.slice(0, 4), 10);
      const month = parseInt(selectedMonth.slice(4, 6), 10);

      // 実勤続月数の基準月（初期データ投入時点）
      // 処理月に応じてoffsetを加算し動的に調整する
      const monthOffset = (year * 12 + month) - (TENURE_BASE_YEAR * 12 + TENURE_BASE_MONTH);
      const adjustedMonths = (m: number) => Math.max(0, m + monthOffset);

      const [recRes, mappingRes, catRes, officeRes, rateRes, empRes, salRes, attRes] = await Promise.all([
        supabase.from("service_records")
          .select("id,employee_number,employee_name,service_date,calc_duration,service_code,office_number,accompanied_visit")
          .eq("processing_month", selectedMonth),
        supabase.from("service_type_mappings").select("service_code,category_id"),
        supabase.from("service_categories").select("id,name"),
        supabase.from("offices").select("id,office_number,name"),
        supabase.from("category_hourly_rates").select("category_id,office_id,hourly_rate"),
        supabase.from("employees").select("id,employee_number,name,role_type,salary_type,employment_status,has_care_qualification,job_type,effective_service_months").neq("employment_status", "退職者"),
        supabase.from("salary_settings").select("*"),
        supabase.from("attendance_records")
          .select("employee_number,day,work_note_1,work_note_2,work_note_3,work_note_4,work_note_5,start_time_1,work_hours")
          .eq("year", year).eq("month", month),
      ]);

      const records    = (recRes.data ?? []) as ServiceRecord[];
      const mappingMap = new Map((mappingRes.data ?? []).map((m: ServiceTypeMapping) => [m.service_code, m.category_id]));
      const categoryMap= new Map((catRes.data ?? []).map((c: ServiceCategory) => [c.id, c.name]));
      const officeMap  = new Map((officeRes.data ?? []).map((o: Office) => [o.office_number, o.id]));
      const rateMap    = new Map((rateRes.data ?? []).map((r: CategoryHourlyRate) => [`${r.office_id}:${r.category_id}`, r.hourly_rate]));
      const employees  = (empRes.data ?? []) as Employee[];
      const salMap     = new Map((salRes.data ?? []).map((s: SalarySettings) => [s.employee_id, s]));
      const attRecords = (attRes.data ?? []) as AttendanceRecord[];

      // 出勤簿・実績を職員番号でグループ化
      const attByEmp = new Map<string, AttendanceRecord[]>();
      for (const ar of attRecords) {
        if (!attByEmp.has(ar.employee_number)) attByEmp.set(ar.employee_number, []);
        attByEmp.get(ar.employee_number)!.push(ar);
      }
      const recsByEmp = new Map<string, ServiceRecord[]>();
      for (const r of records) {
        if (!recsByEmp.has(r.employee_number)) recsByEmp.set(r.employee_number, []);
        recsByEmp.get(r.employee_number)!.push(r);
      }

      // 勤怠サマリー計算
      function computeSummary(empNum: string, empRecs: ServiceRecord[]): AttendanceSummary {
        const attDays = attByEmp.get(empNum) ?? [];

        // ヘルパー日数：service_date をそのまま Set のキーにして重複排除
        const helperDateSet = new Set(empRecs.map((r) => r.service_date));
        const helperDays    = helperDateSet.size;

        // 出勤日数：実績の「日」+ 出勤簿の実勤務日の和集合
        const helperDayNums = new Set(empRecs.map((r) => extractDay(r.service_date)).filter((d) => d > 0));
        const attWorkDayNums = new Set(
          attDays.filter((r) => r.start_time_1 && r.start_time_1.trim() !== "").map((r) => r.day)
        );
        const workDays = new Set([...helperDayNums, ...attWorkDayNums]).size;

        const paidLeave    = countNoteKeyword(attDays, "有");
        const specialLeave = countNoteKeyword(attDays, "特休");
        const hrdCount     = countNoteKeyword(attDays, "HRD");
        const workHoursMin = attDays.reduce((s, r) => s + parseWorkHoursMinutes(r.work_hours), 0);
        const recordCount  = empRecs.length;
        const accompaniedCount = empRecs.filter((r) => r.accompanied_visit && r.accompanied_visit.trim() !== "").length;
        const visitMinutes = empRecs.reduce((s, r) => s + parseDurationMinutes(r.calc_duration), 0);

        return { workDays, helperDays, paidLeave, specialLeave, workHoursMin, recordCount, accompaniedCount, visitMinutes, hrdCount };
      }

      // 時給者
      const roleMap = new Map(employees.map((e) => [e.employee_number, {
        role: e.role_type,
        salary: e.salary_type,
        hasQual: e.has_care_qualification ?? false,
        jobType: e.job_type ?? "",
        serviceMonths: adjustedMonths(e.effective_service_months ?? 0),
      }]));
      const hourlyEmpMap = new Map<string, HourlyPayroll>();

      for (const empNum of new Set([...recsByEmp.keys(), ...attByEmp.keys()])) {
        const info    = roleMap.get(empNum);
        if (info && info.salary === "月給") continue;
        const empRecs = recsByEmp.get(empNum) ?? [];
        const firstRec = empRecs[0];
        hourlyEmpMap.set(empNum, {
          employee_number: empNum,
          employee_name: firstRec?.employee_name ?? empNum,
          role_type: info?.role ?? "",
          has_care_qualification: info?.hasQual ?? false,
          job_type: info?.jobType ?? "",
          effective_service_months: info?.serviceMonths ?? 0,
          care_plan_count: 0,
          records: [],
          totalMinutes: 0,
          totalPay: 0,
          unmappedCount: 0,
          summary: computeSummary(empNum, empRecs),
        });
      }

      for (const rec of records) {
        const emp = hourlyEmpMap.get(rec.employee_number);
        if (!emp) continue;
        const minutes    = parseDurationMinutes(rec.calc_duration);
        const categoryId = mappingMap.get(rec.service_code) ?? null;
        const catName    = categoryId ? (categoryMap.get(categoryId) ?? "不明") : "未マッピング";
        const officeId   = officeMap.get(rec.office_number) ?? null;
        const hourlyRate = categoryId && officeId ? (rateMap.get(`${officeId}:${categoryId}`) ?? null) : null;
        const pay        = hourlyRate !== null ? Math.round((minutes / 60) * hourlyRate) : null;
        emp.records.push({ id: rec.id, service_date: rec.service_date, minutes, service_code: rec.service_code, category_name: catName, hourly_rate: hourlyRate, pay });
        emp.totalMinutes += minutes;
        if (pay !== null) emp.totalPay += pay; else emp.unmappedCount++;
      }

      setHourlyResults(
        [...hourlyEmpMap.values()].sort((a, b) => a.employee_name.localeCompare(b.employee_name, "ja"))
      );

      // 月給者
      const monthlyEmps = employees.filter(
        (e) => e.salary_type === "月給" && (!e.employment_status || e.employment_status === "在職者")
      );
      setMonthlyResults(
        monthlyEmps.sort((a, b) => a.name.localeCompare(b.name, "ja")).map((e) => {
          const sal = salMap.get(e.id) ?? null;
          // 勤続手当を自動計算してsettingsをオーバーライド
          const computedTenure = computeTenureAllowance(
            e.has_care_qualification ?? false,
            adjustedMonths(e.effective_service_months ?? 0),
            "月給",
            e.job_type ?? "",
            0, 0, 0
          );
          const settingsWithTenure = sal ? { ...sal, tenure_allowance: computedTenure } : null;
          return {
            employee_id: e.id,
            employee_number: e.employee_number,
            employee_name: e.name,
            role_type: e.role_type,
            settings: settingsWithTenure,
            bonus_paid: false,
            travel_km: 0,
            business_trip_fee: 0,
            yocho_hours: 0,
            summary: computeSummary(e.employee_number, recsByEmp.get(e.employee_number) ?? []),
          };
        })
      );
    } catch (e) {
      setError(`計算エラー: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  function updateMonthly(empId: string, patch: Partial<MonthlyPayroll>) {
    setMonthlyResults((prev) => prev.map((p) => p.employee_id === empId ? { ...p, ...patch } : p));
  }

  function updateHourly(empNum: string, patch: Partial<HourlyPayroll>) {
    setHourlyResults((prev) => prev.map((p) => p.employee_number === empNum ? { ...p, ...patch } : p));
  }

  // ── CSV出力 ─────────────────────────────────────────────────

  function exportHourlyCsv() {
    const label = formatProcessingMonth(selectedMonth).replace(/\s/g, "");
    const rows: string[][] = [[
      "職員番号","職員名","役職",
      "出勤日数","ヘルパー日数","有給","特休欠勤","出勤時間",
      "実績","同行","訪問時間","HRD",
      "合計算定時間(分)","合計算定時間","実績給与(円)","勤続手当(円)","合計(円)",
    ]];
    for (const e of hourlyResults) {
      const s = e.summary;
      const tenure = computeTenureAllowance(
        e.has_care_qualification, e.effective_service_months, "時給", e.job_type,
        s.workHoursMin, s.recordCount, e.care_plan_count
      );
      rows.push([
        e.employee_number, e.employee_name, e.role_type,
        String(s.workDays), String(s.helperDays), String(s.paidLeave), String(s.specialLeave),
        formatWorkHours(s.workHoursMin),
        String(s.recordCount), String(s.accompaniedCount), formatMinutes(s.visitMinutes), String(s.hrdCount),
        String(e.totalMinutes), formatMinutes(e.totalMinutes), String(e.totalPay), String(tenure), String(e.totalPay + tenure),
      ]);
    }
    downloadCsv(`給与計算_${label}_時給者サマリー.csv`, rows);
  }

  function exportMonthlyCsv() {
    const label = formatProcessingMonth(selectedMonth).replace(/\s/g, "");
    const rows: string[][] = [[
      "職員番号","職員名","役職",
      "出勤日数","ヘルパー日数","有給","特休欠勤","出勤時間",
      "実績","同行","訪問時間","HRD",
      "本人給","職能給","役職手当","資格手当","勤続手当",
      "処遇改善手当","特定処遇改善手当","処遇改善補助金手当",
      "固定残業代","特別報奨金","報奨金","移動費","出張費",
      "夜朝時間","夜朝手当","介護超過手当","合計(円)",
    ]];
    for (const p of monthlyResults) {
      const s = p.settings;
      const sm = p.summary;
      const travelFee = Math.round(p.travel_km * (s?.travel_unit_price ?? 0));
      rows.push([
        p.employee_number, p.employee_name, p.role_type,
        String(sm.workDays), String(sm.helperDays), String(sm.paidLeave), String(sm.specialLeave),
        formatWorkHours(sm.workHoursMin),
        String(sm.recordCount), String(sm.accompaniedCount), formatMinutes(sm.visitMinutes), String(sm.hrdCount),
        String(s?.base_personal_salary ?? 0),
        String(s?.skill_salary ?? 0),
        String(s?.position_allowance ?? 0),
        String(s?.qualification_allowance ?? 0),
        String(s?.tenure_allowance ?? 0),
        String(s?.treatment_improvement ?? 0),
        String(s?.specific_treatment_improvement ?? 0),
        String(s?.treatment_subsidy ?? 0),
        String(s?.fixed_overtime_pay ?? 0),
        String(s?.special_bonus ?? 0),
        String(p.bonus_paid ? (s?.bonus_amount ?? 0) : 0),
        String(travelFee),
        String(p.business_trip_fee),
        String(p.yocho_hours),
        String(yochoAllowance(p)),
        String(careOvertimePay(p)),
        String(monthlyGrandTotal(p)),
      ]);
    }
    downloadCsv(`給与計算_${label}_月給者.csv`, rows);
  }

  const hourlyGrandTotal   = hourlyResults.reduce((s, e) => {
    const tenure = computeTenureAllowance(
      e.has_care_qualification, e.effective_service_months, "時給", e.job_type,
      e.summary.workHoursMin, e.summary.recordCount, e.care_plan_count
    );
    return s + e.totalPay + tenure;
  }, 0);
  const hourlyGrandMinutes = hourlyResults.reduce((s, e) => s + e.totalMinutes, 0);
  const monthlyGrandSum    = monthlyResults.reduce((s, p) => s + monthlyGrandTotal(p), 0);

  // ─── 描画 ─────────────────────────────────────────────────────

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">給与計算</h2>

      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium whitespace-nowrap">処理月</label>
              <select
                className="border rounded px-3 py-1.5 text-sm bg-background"
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value)}
              >
                {months.length === 0 && <option value="">（データなし）</option>}
                {months.map((m) => (
                  <option key={m} value={m}>{formatProcessingMonth(m)}</option>
                ))}
              </select>
            </div>
            <Button onClick={calculate} disabled={!selectedMonth || loading}>
              {loading ? "計算中…" : "給与計算を実行"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="mb-4 p-3 bg-destructive/10 text-destructive rounded text-sm">{error}</div>
      )}

      {(hourlyResults.length > 0 || monthlyResults.length > 0) && (
        <>
          <div className="flex gap-1 mb-4 border-b">
            {(["hourly", "monthly"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                  tab === t ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {t === "hourly"
                  ? `⏱ 時給者（${hourlyResults.length}名）`
                  : `📅 月給者（${monthlyResults.length}名）`}
              </button>
            ))}
          </div>

          {/* ── 時給者タブ ───────────────────────────────────── */}
          {tab === "hourly" && (
            <>
              <div className="grid grid-cols-3 gap-4 mb-4">
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">対象職員数</CardTitle></CardHeader>
                  <CardContent><p className="text-2xl font-bold">{hourlyResults.length}名</p></CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">合計算定時間</CardTitle></CardHeader>
                  <CardContent><p className="text-2xl font-bold">{formatMinutes(hourlyGrandMinutes)}</p></CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">給与合計</CardTitle></CardHeader>
                  <CardContent><p className="text-2xl font-bold">{yen(hourlyGrandTotal)}</p></CardContent></Card>
              </div>

              <Card>
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle>{formatProcessingMonth(selectedMonth)} 時給者 給与計算結果</CardTitle>
                  <Button variant="outline" size="sm" onClick={exportHourlyCsv}>📥 CSV出力</Button>
                </CardHeader>
                <CardContent className="p-0 overflow-x-auto">
                  <table className="w-full text-sm whitespace-nowrap">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="text-left px-3 py-3 font-medium">職員番号</th>
                        <th className="text-left px-3 py-3 font-medium">職員名</th>
                        <th className="text-left px-3 py-3 font-medium">役職</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">出勤日数</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">ヘルパー日数</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">有給</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">特休欠勤</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">出勤時間</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">実績</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">同行</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">訪問時間</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">HRD</th>
                        <th className="text-right px-3 py-3 font-medium">算定時間</th>
                        <th className="text-right px-3 py-3 font-medium">実績給与</th>
                        <th className="text-right px-3 py-3 font-medium text-green-700">勤続手当</th>
                        <th className="text-right px-3 py-3 font-medium font-bold">合計</th>
                        <th className="text-center px-3 py-3 font-medium">注記</th>
                        <th className="px-3 py-3"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {hourlyResults.map((emp) => {
                        const sm = emp.summary;
                        const tenure = computeTenureAllowance(
                          emp.has_care_qualification, emp.effective_service_months, "時給", emp.job_type,
                          sm.workHoursMin, sm.recordCount, emp.care_plan_count
                        );
                        const grandTotal = emp.totalPay + tenure;
                        return (
                          <>
                            <tr
                              key={emp.employee_number}
                              className="border-b hover:bg-muted/30 cursor-pointer"
                              onClick={() => setExpandedEmp(expandedEmp === emp.employee_number ? null : emp.employee_number)}
                            >
                              <td className="px-3 py-2 font-mono text-xs">{emp.employee_number}</td>
                              <td className="px-3 py-2 font-medium">{emp.employee_name}</td>
                              <td className="px-3 py-2"><RoleBadge role={emp.role_type} /></td>
                              <td className="px-3 py-2 text-right">{sm.workDays}</td>
                              <td className="px-3 py-2 text-right">{sm.helperDays}</td>
                              <td className="px-3 py-2 text-right">{sm.paidLeave || "—"}</td>
                              <td className="px-3 py-2 text-right">{sm.specialLeave || "—"}</td>
                              <td className="px-3 py-2 text-right">{formatWorkHours(sm.workHoursMin)}</td>
                              <td className="px-3 py-2 text-right">{sm.recordCount}</td>
                              <td className="px-3 py-2 text-right">{sm.accompaniedCount || "—"}</td>
                              <td className="px-3 py-2 text-right">{formatMinutes(sm.visitMinutes)}</td>
                              <td className="px-3 py-2 text-right">{sm.hrdCount || "—"}</td>
                              <td className="px-3 py-2 text-right">{formatMinutes(emp.totalMinutes)}</td>
                              <td className="px-3 py-2 text-right">{yen(emp.totalPay)}</td>
                              <td className="px-3 py-2 text-right">
                                {tenure > 0
                                  ? <span className="font-medium text-green-700">{yen(tenure)}</span>
                                  : <span className="text-muted-foreground text-xs">—</span>}
                              </td>
                              <td className="px-3 py-2 text-right font-bold">{yen(grandTotal)}</td>
                              <td className="px-3 py-2 text-center">
                                {emp.unmappedCount > 0 && (
                                  <span className="text-xs px-2 py-0.5 bg-yellow-100 text-yellow-800 rounded-full">未設定{emp.unmappedCount}件</span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-center text-muted-foreground text-xs">
                                {expandedEmp === emp.employee_number ? "▲" : "▼"}
                              </td>
                            </tr>
                            {expandedEmp === emp.employee_number && (
                              <tr key={`${emp.employee_number}-d`} className="bg-muted/10">
                                <td colSpan={19} className="px-8 py-3">
                                  {/* 居宅介護支援：プラン件数入力 */}
                                  {emp.job_type === "居宅介護支援" && emp.has_care_qualification && (
                                    <div className="flex items-center gap-2 mb-3 text-xs" onClick={(e) => e.stopPropagation()}>
                                      <span className="text-muted-foreground">担当要介護プラン相当件数</span>
                                      <Input
                                        type="number" min={0}
                                        value={emp.care_plan_count || ""}
                                        placeholder="0"
                                        onChange={(e) => updateHourly(emp.employee_number, { care_plan_count: parseInt(e.target.value) || 0 })}
                                        className="w-20 text-right h-6 px-2 text-xs"
                                      />
                                      <span className="text-muted-foreground">件</span>
                                      {tenure > 0 && <span className="text-green-700 font-medium">勤続手当: {yen(tenure)}</span>}
                                    </div>
                                  )}
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="border-b">
                                        <th className="text-left py-1 font-medium">日付</th>
                                        <th className="text-left py-1 font-medium">サービスコード</th>
                                        <th className="text-left py-1 font-medium">類型</th>
                                        <th className="text-right py-1 font-medium">算定時間</th>
                                        <th className="text-right py-1 font-medium">時給</th>
                                        <th className="text-right py-1 font-medium">金額</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {emp.records.slice().sort((a, b) => a.service_date.localeCompare(b.service_date)).map((d) => (
                                        <tr key={d.id} className="border-b border-border/30">
                                          <td className="py-1">{formatDate(d.service_date)}</td>
                                          <td className="py-1 font-mono">{d.service_code}</td>
                                          <td className="py-1">
                                            <span className={d.category_name === "未マッピング" ? "text-yellow-600" : ""}>{d.category_name}</span>
                                          </td>
                                          <td className="py-1 text-right">{formatMinutes(d.minutes)}</td>
                                          <td className="py-1 text-right">{d.hourly_rate !== null ? d.hourly_rate.toLocaleString() + "円" : "—"}</td>
                                          <td className="py-1 text-right font-medium">{d.pay !== null ? yen(d.pay) : "—"}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                    <tfoot>
                                      <tr className="font-bold">
                                        <td colSpan={3} className="py-2">合計</td>
                                        <td className="py-2 text-right">{formatMinutes(emp.totalMinutes)}</td>
                                        <td></td>
                                        <td className="py-2 text-right">{yen(emp.totalPay)}{tenure > 0 ? ` + 勤続 ${yen(tenure)} = ${yen(grandTotal)}` : ""}</td>
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

          {/* ── 月給者タブ ───────────────────────────────────── */}
          {tab === "monthly" && (
            <>
              <div className="grid grid-cols-2 gap-4 mb-4">
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">対象職員数</CardTitle></CardHeader>
                  <CardContent><p className="text-2xl font-bold">{monthlyResults.length}名</p></CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">給与合計</CardTitle></CardHeader>
                  <CardContent><p className="text-2xl font-bold">{yen(monthlyGrandSum)}</p></CardContent></Card>
              </div>

              <Card>
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle>{formatProcessingMonth(selectedMonth)} 月給者 給与計算</CardTitle>
                  <Button variant="outline" size="sm" onClick={exportMonthlyCsv}>📥 CSV出力</Button>
                </CardHeader>
                <CardContent className="p-0 overflow-x-auto">
                  <table className="w-full text-sm whitespace-nowrap">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="text-left px-3 py-3 font-medium">職員番号</th>
                        <th className="text-left px-3 py-3 font-medium">職員名</th>
                        <th className="text-left px-3 py-3 font-medium">役職</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">出勤日数</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">ヘルパー日数</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">有給</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">特休欠勤</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">出勤時間</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">実績</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">同行</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">訪問時間</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">HRD</th>
                        <th className="text-right px-3 py-3 font-medium">固定支給計</th>
                        <th className="text-right px-3 py-3 font-medium text-orange-700">介護超過手当</th>
                        <th className="text-right px-3 py-3 font-medium font-bold">合計</th>
                        <th className="px-3 py-3"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthlyResults.map((p) => {
                        const s  = p.settings;
                        const sm = p.summary;
                        const fixed = s ? fixedTotal(s) : 0;
                        const total = monthlyGrandTotal(p);
                        const cop   = careOvertimePay(p);
                        const yocho = yochoAllowance(p);
                        const travelFee = Math.round(p.travel_km * (s?.travel_unit_price ?? 0));
                        const isExpanded = expandedMonthly === p.employee_id;
                        return (
                          <>
                            <tr
                              key={p.employee_id}
                              className="border-b hover:bg-muted/30 cursor-pointer"
                              onClick={() => setExpandedMonthly(isExpanded ? null : p.employee_id)}
                            >
                              <td className="px-3 py-2 font-mono text-xs">{p.employee_number}</td>
                              <td className="px-3 py-2 font-medium">{p.employee_name}</td>
                              <td className="px-3 py-2"><RoleBadge role={p.role_type} /></td>
                              <td className="px-3 py-2 text-right">{sm.workDays}</td>
                              <td className="px-3 py-2 text-right">{sm.helperDays || "—"}</td>
                              <td className="px-3 py-2 text-right">{sm.paidLeave || "—"}</td>
                              <td className="px-3 py-2 text-right">{sm.specialLeave || "—"}</td>
                              <td className="px-3 py-2 text-right">{formatWorkHours(sm.workHoursMin)}</td>
                              <td className="px-3 py-2 text-right">{sm.recordCount || "—"}</td>
                              <td className="px-3 py-2 text-right">{sm.accompaniedCount || "—"}</td>
                              <td className="px-3 py-2 text-right">{sm.visitMinutes ? formatMinutes(sm.visitMinutes) : "—"}</td>
                              <td className="px-3 py-2 text-right">{sm.hrdCount || "—"}</td>
                              <td className="px-3 py-2 text-right">
                                {s ? yen(fixed) : <span className="text-xs text-yellow-600">⚠ 設定なし</span>}
                              </td>
                              <td className="px-3 py-2 text-right">
                                {p.role_type !== "社員"
                                  ? <span className="text-xs text-muted-foreground">—</span>
                                  : !s || s.care_overtime_threshold_hours <= 0
                                    ? <span className="text-xs text-muted-foreground">未設定</span>
                                    : cop > 0
                                      ? <span className="font-medium text-orange-700">{yen(cop)}</span>
                                      : <span className="text-xs text-muted-foreground">0円</span>}
                              </td>
                              <td className="px-3 py-2 text-right font-bold">{yen(total)}</td>
                              <td className="px-3 py-2 text-center text-muted-foreground text-xs">
                                {isExpanded ? "▲" : "▼"}
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr key={`${p.employee_id}-d`} className="bg-muted/10">
                                <td colSpan={15} className="px-8 py-4">
                                  <div className="grid md:grid-cols-2 gap-6 text-xs">
                                    {/* 左：支給内訳 */}
                                    <div>
                                      <p className="font-semibold text-sm mb-2 text-muted-foreground">支給内訳</p>
                                      {s ? (
                                        <div className="space-y-0.5">
                                          <DetailLine label="本人給" v={s.base_personal_salary} />
                                          <DetailLine label="職能給" v={s.skill_salary} />
                                          <DetailLine label="役職手当" v={s.position_allowance} />
                                          <DetailLine label="資格手当" v={s.qualification_allowance} />
                                          <DetailLine label="勤続手当" v={s.tenure_allowance} />
                                          <DetailLine label="処遇改善手当" v={s.treatment_improvement} />
                                          <DetailLine label="特定処遇改善手当" v={s.specific_treatment_improvement} />
                                          <DetailLine label="処遇改善補助金手当" v={s.treatment_subsidy} />
                                          <DetailLine label="固定残業代" v={s.fixed_overtime_pay} />
                                          <DetailLine label="特別報奨金" v={s.special_bonus} />
                                          {p.bonus_paid && s.bonus_amount > 0 && <DetailLine label="報奨金" v={s.bonus_amount} />}
                                          {travelFee > 0 && <DetailLine label={`移動費(${p.travel_km}km)`} v={travelFee} />}
                                          {p.business_trip_fee > 0 && <DetailLine label="出張費" v={p.business_trip_fee} />}
                                          {yocho > 0 && <DetailLine label={`夜朝手当(${p.yocho_hours}h)`} v={yocho} />}
                                          {cop > 0 && <DetailLine label={`介護超過手当`} v={cop} />}
                                          <div className="flex justify-between pt-2 border-t font-bold text-sm mt-1">
                                            <span>合計</span>
                                            <span>{yen(total)}</span>
                                          </div>
                                        </div>
                                      ) : (
                                        <p className="text-yellow-600">⚠ 給与設定がありません。<a href="/salary" className="underline text-primary">設定画面へ</a></p>
                                      )}
                                    </div>
                                    {/* 右：変動入力 */}
                                    <div>
                                      <p className="font-semibold text-sm mb-2 text-muted-foreground">変動入力</p>
                                      <div className="space-y-3">
                                        {/* 報奨金 */}
                                        {s && s.bonus_amount > 0 && (
                                          <label className="flex items-center gap-3 cursor-pointer">
                                            <input
                                              type="checkbox"
                                              checked={p.bonus_paid}
                                              onChange={(e) => updateMonthly(p.employee_id, { bonus_paid: e.target.checked })}
                                              onClick={(e) => e.stopPropagation()}
                                            />
                                            <span>報奨金を支給　<span className="font-medium">{yen(s.bonus_amount)}</span></span>
                                          </label>
                                        )}
                                        {/* 夜朝時間 */}
                                        {s && s.yocho_unit_price > 0 && (
                                          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                                            <span className="w-28">夜朝時間</span>
                                            <Input
                                              type="number" min={0} step={0.5}
                                              value={p.yocho_hours || ""}
                                              placeholder="0"
                                              onChange={(e) => updateMonthly(p.employee_id, { yocho_hours: parseFloat(e.target.value) || 0 })}
                                              className="w-24 text-right h-7 px-2"
                                            />
                                            <span className="text-muted-foreground">時間</span>
                                            {p.yocho_hours > 0 && <span className="text-muted-foreground">= {yen(yocho)}</span>}
                                          </div>
                                        )}
                                        {/* 移動距離 */}
                                        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                                          <span className="w-28">移動距離</span>
                                          <Input
                                            type="number" min={0} step={0.1}
                                            value={p.travel_km || ""}
                                            placeholder="0"
                                            onChange={(e) => updateMonthly(p.employee_id, { travel_km: parseFloat(e.target.value) || 0 })}
                                            className="w-24 text-right h-7 px-2"
                                          />
                                          <span className="text-muted-foreground">km</span>
                                          {travelFee > 0 && <span className="text-muted-foreground">= {yen(travelFee)}</span>}
                                        </div>
                                        {/* 出張費 */}
                                        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                                          <span className="w-28">出張費</span>
                                          <Input
                                            type="number" min={0}
                                            value={p.business_trip_fee || ""}
                                            placeholder="0"
                                            onChange={(e) => updateMonthly(p.employee_id, { business_trip_fee: parseInt(e.target.value) || 0 })}
                                            className="w-24 text-right h-7 px-2"
                                          />
                                          <span className="text-muted-foreground">円</span>
                                        </div>
                                        {/* 介護超過（参考表示） */}
                                        {p.role_type === "社員" && s && s.care_overtime_threshold_hours > 0 && (
                                          <div className="flex items-center gap-2 text-muted-foreground">
                                            <span className="w-28">介護超過手当</span>
                                            <span className={cop > 0 ? "font-medium text-orange-700" : ""}>
                                              {cop > 0 ? yen(cop) : `閾値${s.care_overtime_threshold_hours}h 未超過`}
                                            </span>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="bg-muted/30 font-bold">
                        <td colSpan={14} className="px-3 py-2">合計</td>
                        <td className="px-3 py-2 text-right text-base">{yen(monthlyGrandSum)}</td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                </CardContent>
              </Card>
            </>
          )}
        </>
      )}

      {hourlyResults.length === 0 && monthlyResults.length === 0 && !loading && !error && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground text-sm">処理月を選択して「給与計算を実行」をクリックしてください。</p>
            <ul className="mt-3 text-sm text-muted-foreground space-y-1 list-disc list-inside">
              <li>時給者：サービス実績CSV（MEISAI）の取り込みが必要です</li>
              <li>月給者：給与設定ページで各職員の給与設定が必要です</li>
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── バッジ・明細コンポーネント ───────────────────────────────

const ROLE_COLORS: Record<string, string> = {
  管理者: "bg-purple-100 text-purple-800",
  提責:   "bg-blue-100 text-blue-800",
  社員:   "bg-green-100 text-green-800",
  パート: "bg-orange-100 text-orange-800",
  事務員: "bg-gray-100 text-gray-700",
};
function RoleBadge({ role }: { role: string }) {
  const c = ROLE_COLORS[role] ?? "bg-gray-100 text-gray-700";
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${c}`}>{role}</span>;
}

function DetailLine({ label, v }: { label: string; v: number }) {
  if (!v) return null;
  return (
    <div className="flex justify-between py-0.5 border-b border-border/30">
      <span className="text-muted-foreground">{label}</span>
      <span>{v.toLocaleString("ja-JP")}円</span>
    </div>
  );
}
