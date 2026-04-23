"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { calcDayRoute, collectAddressPairs, secToHm } from "@/lib/distance-calculator";
import type { VisitForRoute } from "@/lib/distance-calculator";

// ─── 実勤続月数の基準月 ─────────────────────────────────────
// effective_service_months の初期データが何月時点の値かを設定する
// 初期データを入れ直す場合はここを変更する
const TENURE_BASE_YEAR  = 2026;
const TENURE_BASE_MONTH = 3;

// ─── 日本の祝日一覧（YYYYMMDD） ──────────────────────────────
const JAPAN_HOLIDAYS = new Set([
  // 2024
  "20240101","20240108","20240211","20240212","20240223","20240320",
  "20240429","20240503","20240504","20240505","20240506",
  "20240715","20240811","20240812","20240916","20240923","20241014",
  "20241103","20241104","20241123",
  // 2025
  "20250101","20250113","20250211","20250224","20250320",
  "20250429","20250503","20250504","20250505","20250506",
  "20250721","20250811","20250915","20250923","20251013",
  "20251103","20251123","20251124",
  // 2026
  "20260101","20260112","20260211","20260223","20260320",
  "20260429","20260503","20260504","20260505","20260506",
  "20260720","20260811","20260921","20260923","20261012",
  "20261103","20261123",
  // 2027
  "20270101","20270111","20270211","20270223","20270321",
  "20270429","20270503","20270504","20270505",
  "20270719","20270811","20270920","20270923","20271011",
  "20271103","20271123",
]);

/** YYYYMMDD 形式の日付が土日または祝日かどうかを判定 */
function isWeekendOrHoliday(dateStr: string): boolean {
  const d = dateStr.replace(/\D/g, "");
  if (d.length < 8) return false;
  const date = new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
  const dow = date.getDay();
  return dow === 0 || dow === 6 || JAPAN_HOLIDAYS.has(d.slice(0, 8));
}

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
  client_number: string;
  dispatch_start_time: string;
  dispatch_end_time: string;
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
  overtime_daily: string;
};

type OvertimeSetting = {
  job_type: string;
  scheduled_hours_per_month: number;
  include_base_personal_salary: boolean;
  include_skill_salary: boolean;
  include_position_allowance: boolean;
  include_qualification_allowance: boolean;
  include_tenure_allowance: boolean;
  include_treatment_improvement: boolean;
  include_specific_treatment: boolean;
  include_treatment_subsidy: boolean;
  include_fixed_overtime_pay: boolean;
  include_special_bonus: boolean;
};

type OfficeFormRecord = {
  employee_number: string;
  record_type: string;
  item_name: string;
  item_date: string | null;
  numeric_value: number | null;
  start_time: string | null;
  end_time: string | null;
  year_month: string | null;  // childcare: 何月分か (YYYYMM)
  child_name: string | null;  // childcare: 子供の名前
  amount: number | null;      // childcare: 支払い金額
};

type ServiceTypeMapping = { service_code: string; category_id: string };
type CategoryHourlyRate  = { category_id: string; office_id: string; hourly_rate: number };
type Office              = { id: string; office_number: string; name: string; short_name: string; office_type: string; travel_unit_price: number; commute_unit_price: number; treatment_subsidy_amount: number; cancel_unit_price: number; travel_allowance_rate: number; communication_fee_amount: number; meeting_unit_price: number; distance_adjustment_rate: number };
type ServiceCategory     = { id: string; name: string };

type Employee = {
  id: string;
  employee_number: string;
  name: string;
  address: string;
  role_type: string;
  salary_type: string;
  employment_status: string;
  has_care_qualification: boolean;
  job_type: string;
  effective_service_months: number;
  office_id: string;
  social_insurance: boolean;
  paid_leave_unit_price: number;
  communication_fee_type: string;
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
  halfLeave: number;
  specialLeave: number;
  workHoursMin: number;
  overtimeMinutes: number;
  recordCount: number;
  accompaniedCount: number;
  visitMinutes: number;
  hrdCount: number;
  hrdMinutes: number;
  meetingCount: number;
  commuteKmTotal: number;
  businessKmTotal: number;
  weekendHolidayMinutes: number;
  weekendHolidayAccompaniedMinutes: number;
  visitMinutesExcludingAccompanied: number;
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
  error_adjustment: number; // 過誤（手入力）：総支給額に加減算
  treatment_subsidy: number;
  paid_leave_allowance: number;
  cancel_count: number;
  cancel_allowance: number;
  travel_time_sec: number;
  travel_allowance: number;
  communication_fee: number;
  meeting_fee: number;
  childcare_allowance: number;
  commute_fee: number;
  commute_distance_m: number;
  business_trip_fee: number;
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
  job_type: string;
  settings: SalarySettings | null;
  bonus_paid: boolean;
  travel_km: number;        // 手動オーバーライド（0=自動値を使用）
  travel_km_auto: number;   // 事業所書式/出勤簿から自動取得した出張km
  office_travel_unit_price: number;  // 事業所の出張単価
  office_commute_unit_price: number; // 事業所の通勤単価
  business_trip_fee: number;
  childcare_allowance: number;
  yocho_hours: number;   // 夜朝時間（月次手動入力）
  summary: AttendanceSummary;
};

// ─── ユーティリティ ──────────────────────────────────────────

/** year_month を YYYYMM 形式に正規化
 *  対応フォーマット:
 *    "2025/12" → "202512"
 *    "2026/1"  → "202601"
 *    "Dec-25"  → "202512"
 *    "Jan-26"  → "202601"
 */
const MONTH_ABBR: Record<string, string> = {
  Jan:"01", Feb:"02", Mar:"03", Apr:"04", May:"05", Jun:"06",
  Jul:"07", Aug:"08", Sep:"09", Oct:"10", Nov:"11", Dec:"12",
};
function normalizeYM(ym: string): string {
  if (!ym) return ym;
  // "YYYY/M" or "YYYY/MM"
  const slashIdx = ym.indexOf("/");
  if (slashIdx !== -1) {
    const y = ym.slice(0, slashIdx);
    const m = ym.slice(slashIdx + 1).padStart(2, "0");
    return y + m;
  }
  // "MMM-YY" or "YY-MMM" (e.g. "Dec-25" or "25-Dec" → "202512")
  const dashIdx = ym.indexOf("-");
  if (dashIdx !== -1) {
    const left  = ym.slice(0, dashIdx);
    const right = ym.slice(dashIdx + 1);
    // Dec-25 形式
    if (MONTH_ABBR[left]) {
      const fullYear = "20" + right.padStart(2, "0");
      return fullYear + MONTH_ABBR[left];
    }
    // 25-Dec 形式
    if (MONTH_ABBR[right]) {
      const fullYear = "20" + left.padStart(2, "0");
      return fullYear + MONTH_ABBR[right];
    }
  }
  return ym;
}

function parseDurationMinutes(str: string): number {
  if (!str) return 0;
  str = str.trim();
  let result: number;
  if (str.includes(":")) {
    const [h, m] = str.split(":").map(Number);
    result = (h || 0) * 60 + (m || 0);
  } else {
    result = parseInt(str, 10) || 0;
  }
  // 開始時刻＝終了時刻のとき24時間になる場合は0として扱う
  return result >= 1440 ? 0 : result;
}

function parseWorkHoursMinutes(s: string): number {
  if (!s || !s.trim()) return 0;
  s = s.trim();
  let result: number;
  if (s.includes(":")) {
    const [h, m] = s.split(":").map(Number);
    result = (h || 0) * 60 + (m || 0);
  } else {
    const n = parseFloat(s);
    result = isNaN(n) ? 0 : Math.round(n * 60);
  }
  // 開始時刻＝終了時刻のとき24時間になる場合は0として扱う
  return result >= 1440 ? 0 : result;
}

function formatMinutes(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

function formatWorkHours(min: number): string {
  if (min === 0) return "0:00";
  const h = Math.floor(min / 60), m = min % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

const yen = (n: number) => n.toLocaleString("ja-JP") + "円";

/** km値を小数点2位まで切り上げ表示。浮動小数点誤差を先に除去する */
function formatKm(km: number): string {
  const clean = Math.round(km * 1e8) / 1e8;
  return (Math.ceil(clean * 100) / 100).toFixed(2);
}

function formatProcessingMonth(m: string): string {
  if (!m || m.length < 6) return m;
  return `${m.slice(0, 4)}年${parseInt(m.slice(4, 6), 10)}月`;
}

function formatDate(d: string): string {
  if (!d) return d;
  const digits = d.replace(/\D/g, "");
  if (digits.length < 8) return d;
  return `${parseInt(digits.slice(4, 6), 10)}/${parseInt(digits.slice(6, 8), 10)}`;
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
  workHoursMin: number,   // パートヘルパー用（実績の訪問時間合計）
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

/** 勤続手当の単価（率）を返す */
function computeTenureRate(
  hasQualification: boolean,
  effectiveServiceMonths: number,
  jobType: string,
): number {
  if (!hasQualification) return 0;
  const years = Math.floor(effectiveServiceMonths / 12);
  if (years < 1) return 0;
  if (jobType === "訪問介護" || jobType === "訪問看護") return (Math.floor(years / 5) + 1) * 10;
  if (jobType === "訪問入浴") return (Math.floor(years / 5) + 1) * 10;
  if (jobType === "居宅介護支援") return (Math.floor(years / 5) + 1) * 50;
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

function computeOvertimePay(
  p: MonthlyPayroll,
  otSettings: Map<string, OvertimeSetting>,
): number {
  const ot = otSettings.get(p.job_type);
  if (!ot || ot.scheduled_hours_per_month <= 0) return 0;
  const overtimeMin = p.summary.overtimeMinutes;
  if (overtimeMin <= 0) return 0;
  const s = p.settings;
  if (!s) return 0;

  let base = 0;
  if (ot.include_base_personal_salary)    base += s.base_personal_salary;
  if (ot.include_skill_salary)            base += s.skill_salary;
  if (ot.include_position_allowance)      base += s.position_allowance;
  if (ot.include_qualification_allowance) base += s.qualification_allowance;
  if (ot.include_tenure_allowance)        base += s.tenure_allowance;
  if (ot.include_treatment_improvement)   base += s.treatment_improvement;
  if (ot.include_specific_treatment)      base += s.specific_treatment_improvement;
  if (ot.include_treatment_subsidy)       base += s.treatment_subsidy;
  if (ot.include_fixed_overtime_pay)      base += s.fixed_overtime_pay;
  if (ot.include_special_bonus)           base += s.special_bonus;

  const hourlyRate = base / ot.scheduled_hours_per_month;
  return Math.round((overtimeMin / 60) * hourlyRate * 1.25);
}

function effectiveTravelKm(p: MonthlyPayroll): number {
  return p.travel_km > 0 ? p.travel_km : p.travel_km_auto;
}

function travelFeeAmount(p: MonthlyPayroll): number {
  return Math.round(effectiveTravelKm(p) * p.office_travel_unit_price);
}

function commuteFeeAmount(p: MonthlyPayroll): number {
  return Math.round(p.summary.commuteKmTotal * p.office_commute_unit_price);
}

function overtimeExcessPay(p: MonthlyPayroll, otSettings: Map<string, OvertimeSetting>): number {
  return Math.max(0, computeOvertimePay(p, otSettings) - (p.settings?.fixed_overtime_pay ?? 0));
}

function monthlyGrandTotal(p: MonthlyPayroll, otSettings: Map<string, OvertimeSetting>): number {
  if (!p.settings) return 0;
  return (
    fixedTotal(p.settings) +
    (p.bonus_paid ? p.settings.bonus_amount : 0) +
    travelFeeAmount(p) +
    commuteFeeAmount(p) +
    p.business_trip_fee +
    p.childcare_allowance +
    careOvertimePay(p) +
    yochoAllowance(p) +
    overtimeExcessPay(p, otSettings)
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
  const [offices, setOffices] = useState<Office[]>([]);
  const [selectedOfficeId, setSelectedOfficeId] = useState("");
  const [selectedOfficeType, setSelectedOfficeType] = useState<string>("訪問介護");
  const [tab, setTab] = useState<"hourly" | "monthly">("monthly");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [hourlyResults, setHourlyResults] = useState<HourlyPayroll[]>([]);
  const [expandedEmp, setExpandedEmp] = useState<string | null>(null);

  const [monthlyResults, setMonthlyResults] = useState<MonthlyPayroll[]>([]);
  const [expandedMonthly, setExpandedMonthly] = useState<string | null>(null);
  const [otSettings, setOtSettings] = useState<Map<string, OvertimeSetting>>(new Map());

  useEffect(() => {
    // service_records実データのある月を import_batches 経由で取得（高速）
    supabase
      .from("import_batches")
      .select("processing_month,record_count,import_type,status")
      .eq("import_type", "meisai")
      .eq("status", "completed")
      .gt("record_count", 0)
      .order("processing_month", { ascending: false })
      .then(({ data }) => {
        if (!data) return;
        const unique = [...new Set((data as { processing_month: string }[]).map((r) => r.processing_month))];
        setMonths(unique);
        if (unique.length > 0) setSelectedMonth(unique[0]);
      });
    supabase.from("offices").select("id,office_number,name,short_name,office_type,travel_unit_price,commute_unit_price,treatment_subsidy_amount,cancel_unit_price,travel_allowance_rate,meeting_unit_price").order("name").then(({ data }) => {
      if (!data) return;
      setOffices(data as unknown as Office[]);
      // 訪問介護の最初の事業所を初期選択
      const firstVisitCare = (data as unknown as Office[]).find((o) => o.office_type === "訪問介護");
      if (firstVisitCare) setSelectedOfficeId(firstVisitCare.id);
      else if (data.length > 0) setSelectedOfficeId((data as unknown as Office[])[0].id);
    });
  }, []);

  // ─── 給与計算実行 ─────────────────────────────────────────────

  async function calculate() {
    if (!selectedMonth || !selectedOfficeId) return;
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

      // service_records はサーバー側上限(1000件)を回避するため range でページング取得
      const selectedOffice = offices.find((o) => o.id === selectedOfficeId)!;
      const allServiceRecords: ServiceRecord[] = [];
      {
        const pageSize = 1000;
        let from = 0;
        while (true) {
          const { data } = await supabase
            .from("service_records")
            .select("id,employee_number,employee_name,service_date,calc_duration,service_code,office_number,accompanied_visit,client_number,dispatch_start_time,dispatch_end_time")
            .eq("processing_month", selectedMonth)
            .eq("office_number", selectedOffice.office_number)
            .order("id")
            .range(from, from + pageSize - 1);
          if (!data || data.length === 0) break;
          allServiceRecords.push(...(data as ServiceRecord[]));
          if (data.length < pageSize) break;
          from += pageSize;
        }
      }

      // salary_settingsは将来1000件を超え得るためページング取得
      const fetchAllSalarySettings = async (): Promise<{ data: SalarySettings[] }> => {
        const all: SalarySettings[] = [];
        let sFrom = 0;
        while (true) {
          const { data } = await supabase
            .from("salary_settings").select("*").range(sFrom, sFrom + 999);
          if (!data || data.length === 0) break;
          all.push(...(data as SalarySettings[]));
          if (data.length < 1000) break;
          sFrom += 1000;
        }
        return { data: all };
      };

      const [mappingRes, catRes, officeRes, rateRes, empRes, salRes, attRes, otRes] = await Promise.all([
        supabase.from("service_type_mappings").select("service_code,category_id"),
        supabase.from("service_categories").select("id,name"),
        supabase.from("offices").select("id,office_number,name,short_name,office_type,travel_unit_price,commute_unit_price,treatment_subsidy_amount,cancel_unit_price,travel_allowance_rate,communication_fee_amount,meeting_unit_price,distance_adjustment_rate"),
        supabase.from("category_hourly_rates").select("category_id,office_id,hourly_rate"),
        supabase.from("employees").select("id,employee_number,name,address,role_type,salary_type,employment_status,has_care_qualification,job_type,effective_service_months,office_id,social_insurance,paid_leave_unit_price,communication_fee_type").eq("office_id", selectedOfficeId).neq("employment_status", "退職者"),
        fetchAllSalarySettings(),
        supabase.from("attendance_records")
          .select("employee_number,employee_name,day,work_note_1,work_note_2,work_note_3,work_note_4,work_note_5,start_time_1,work_hours,overtime_daily,commute_km,business_km")
          .eq("year", year).eq("month", month)
          .eq("office_number", selectedOffice.office_number),
        supabase.from("overtime_settings").select("*"),
      ]);

      // office_form_records は1000件上限を回避するためページネーション
      const allOfRecords: OfficeFormRecord[] = [];
      {
        const pageSize = 1000;
        let from = 0;
        while (true) {
          const { data } = await supabase
            .from("office_form_records")
            .select("id,employee_number,record_type,item_name,item_date,numeric_value,start_time,end_time,year_month,child_name,amount")
            .eq("processing_month", selectedMonth)
            .eq("office_number", selectedOffice.office_number)
            .order("id")
            .range(from, from + pageSize - 1);
          if (!data || data.length === 0) break;
          allOfRecords.push(...(data as OfficeFormRecord[]));
          if (data.length < pageSize) break;
          from += pageSize;
        }
      }

      const records    = allServiceRecords;
      const mappingMap = new Map((mappingRes.data ?? []).map((m: ServiceTypeMapping) => [m.service_code, m.category_id]));
      const categoryMap= new Map((catRes.data ?? []).map((c: ServiceCategory) => [c.id, c.name]));
      const officeMap         = new Map((officeRes.data ?? []).map((o: Office) => [o.office_number, o.id]));
      const officeByIdMap     = new Map((officeRes.data ?? []).map((o: Office) => [o.id, o]));
      const rateMap    = new Map((rateRes.data ?? []).map((r: CategoryHourlyRate) => [`${r.office_id}:${r.category_id}`, r.hourly_rate]));
      const employees  = (empRes.data ?? []) as Employee[];
      const salMap     = new Map((salRes.data ?? []).map((s: SalarySettings) => [s.employee_id, s]));
      const attRecords = (attRes.data ?? []) as AttendanceRecord[];
      const ofRecords  = allOfRecords;
      const otMap = new Map((otRes.data ?? []).map((r: OvertimeSetting) => [r.job_type, r]));
      setOtSettings(otMap);

      // 出勤簿・実績・事業所書式を職員番号でグループ化
      // 先頭ゼロを除去して正規化（"0048" と "48" を同一視）
      const normEmp = (n: string | number) => String(n).replace(/^0+/, "") || "0";

      const attByEmp = new Map<string, AttendanceRecord[]>();
      for (const ar of attRecords) {
        const key = normEmp(ar.employee_number);
        if (!attByEmp.has(key)) attByEmp.set(key, []);
        attByEmp.get(key)!.push(ar);
      }
      const recsByEmp = new Map<string, ServiceRecord[]>();
      for (const r of records) {
        const key = normEmp(r.employee_number);
        if (!recsByEmp.has(key)) recsByEmp.set(key, []);
        recsByEmp.get(key)!.push(r);
      }
      const ofByEmp = new Map<string, OfficeFormRecord[]>();
      for (const r of ofRecords) {
        const key = normEmp(r.employee_number);
        if (!ofByEmp.has(key)) ofByEmp.set(key, []);
        ofByEmp.get(key)!.push(r);
      }

      // 勤怠サマリー計算
      function computeSummary(empNum: string, empRecs: ServiceRecord[]): AttendanceSummary {
        const attDays = attByEmp.get(normEmp(empNum)) ?? [];
        const ofRecs  = ofByEmp.get(normEmp(empNum)) ?? [];

        // ヘルパー日数：service_date をそのまま Set のキーにして重複排除
        const helperDateSet = new Set(empRecs.map((r) => r.service_date));
        const helperDays    = helperDateSet.size;

        // 出勤日数：実績の「日」+ 出勤簿の実勤務日の和集合
        // 半有給・半欠勤等の半日事象がある日は 0.5 として計算
        const helperDayNums = new Set(empRecs.map((r) => extractDay(r.service_date)).filter((d) => d > 0));
        const attWorkDayNums = new Set(
          attDays.filter((r) => r.start_time_1 && r.start_time_1.trim() !== "").map((r) => r.day)
        );
        const halfDayNums = new Set(
          ofRecs
            .filter((r) => r.item_name.startsWith("半"))
            .map((r) => extractDay(r.item_date ?? ""))
            .filter((d) => d > 0)
        );
        const allWorkedDays = new Set([...helperDayNums, ...attWorkDayNums]);
        const workDays = [...allWorkedDays].reduce((s, d) => s + (halfDayNums.has(d) ? 0.5 : 1.0), 0);

        // 有給・半有給・特休・HRDは事業所書式から取得
        // record_type を問わず item_name で判定（数値スロット＝"km"で保存されるケースを吸収）
        // 数値スロットの場合は numeric_value が件数、日付スロットの場合は1件として計算
        const paidLeaveRecs = ofRecs.filter((r) => r.item_name.includes("有給") && !r.item_name.includes("半"));
        const paidLeaveFromOf = paidLeaveRecs.reduce((s, r) =>
          s + (r.record_type === "km" ? Math.round((r.numeric_value as number) ?? 1) : 1), 0);
        const paidLeave    = paidLeaveFromOf;
        const halfLeave    = ofRecs.filter((r) => r.item_name.includes("半有給")).reduce((s, r) =>
          s + (r.record_type === "km" ? Math.round((r.numeric_value as number) ?? 1) : 1), 0);
        const specialLeave = ofRecs.filter((r) => r.item_name.includes("特休")).reduce((s, r) =>
          s + (r.record_type === "km" ? Math.round((r.numeric_value as number) ?? 1) : 1), 0);
        const hrdCount     = ofRecs.filter((r) => r.item_name.includes("HRD")).reduce((s, r) =>
          s + (r.record_type === "km" ? Math.round((r.numeric_value as number) ?? 1) : 1), 0);
        const hrdMinutes   = ofRecs.filter((r) => r.item_name.includes("HRD")).reduce((s, r) => {
          if (r.start_time && r.end_time) {
            const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
            return s + Math.max(0, toMin(r.end_time) - toMin(r.start_time));
          }
          return s + Math.round((r.numeric_value ?? 0) * 60);
        }, 0);
        const meetingCount = ofRecs.filter((r) => r.item_name.includes("会議1")).reduce((s, r) =>
          s + (r.record_type === "km" ? Math.round((r.numeric_value as number) ?? 1) : 1), 0);

        const workHoursMin    = attDays.reduce((s, r) => s + parseWorkHoursMinutes(r.work_hours), 0);
        // overtime_daily があれば使用（Format B）、なければ work_hours - 8h で計算（Format A）
        const overtimeMinutes = attDays.reduce((s, r) => {
          const od = parseWorkHoursMinutes(r.overtime_daily ?? "");
          if (od > 0) return s + od;
          return s + Math.max(0, parseWorkHoursMinutes(r.work_hours) - 480);
        }, 0);
        const recordCount      = empRecs.length;
        const accompaniedCount = empRecs.filter((r) => r.accompanied_visit && r.accompanied_visit.trim() !== "").length;
        const visitMinutes     = empRecs.reduce((s, r) => s + parseDurationMinutes(r.calc_duration), 0);
        const visitMinutesExcludingAccompanied = empRecs
          .filter((r) => !r.accompanied_visit || r.accompanied_visit.trim() === "")
          .reduce((s, r) => s + parseDurationMinutes(r.calc_duration), 0);
        const commuteKmTotal   = attDays.reduce((s, r) => s + ((r as unknown as { commute_km?: number }).commute_km ?? 0), 0);
        const businessKmTotal  = attDays.reduce((s, r) => s + ((r as unknown as { business_km?: number }).business_km ?? 0), 0);
        const weekendHolidayMinutes = empRecs
          .filter((r) => isWeekendOrHoliday(r.service_date) && (!r.accompanied_visit || r.accompanied_visit.trim() === ""))
          .reduce((s, r) => s + parseDurationMinutes(r.calc_duration), 0);
        const weekendHolidayAccompaniedMinutes = empRecs
          .filter((r) => isWeekendOrHoliday(r.service_date) && r.accompanied_visit && r.accompanied_visit.trim() !== "")
          .reduce((s, r) => s + parseDurationMinutes(r.calc_duration), 0);

        return { workDays, helperDays, paidLeave, halfLeave, specialLeave, workHoursMin, overtimeMinutes, recordCount, accompaniedCount, visitMinutes, visitMinutesExcludingAccompanied, hrdCount, hrdMinutes, meetingCount, commuteKmTotal, businessKmTotal, weekendHolidayMinutes, weekendHolidayAccompaniedMinutes };
      }

      // ── 保育手当：参照月ごとの実績時間を事前取得 ──────────────
      // childcareレコードの year_month が処理月と異なる場合、その月のサービス実績を取得する
      const childcareRecs = ofRecords.filter((r) => r.record_type === "childcare");
      // visitMinutesByEmpMonth: key = "empNum:YYYYMM", value = visitMinutesExcludingAccompanied
      const visitMinutesByEmpMonth = new Map<string, number>();
      // まず現在の処理月のデータをセット
      for (const emp of employees) {
        const normNum = normEmp(emp.employee_number);
        const empRecs = recsByEmp.get(normNum) ?? [];
        const visitMin = empRecs
          .filter((r) => !r.accompanied_visit || r.accompanied_visit.trim() === "")
          .reduce((s, r) => s + parseDurationMinutes(r.calc_duration), 0);
        visitMinutesByEmpMonth.set(`${normNum}:${selectedMonth}`, visitMin);
      }
      // 参照月が処理月と異なる場合は追加取得（year_month を YYYYMM に正規化）
      const otherMonths = new Set(
        childcareRecs
          .map((r) => r.year_month ? normalizeYM(r.year_month) : null)
          .filter((ym): ym is string => !!ym && ym !== selectedMonth)
      );
      for (const ym of otherMonths) {
        const byEmpYm = new Map<string, number>();
        let ymFrom = 0;
        while (true) {
          const { data: ymData } = await supabase
            .from("service_records")
            .select("employee_number,calc_duration,accompanied_visit")
            .eq("processing_month", ym)
            .eq("office_number", selectedOffice.office_number)
            .order("id")
            .range(ymFrom, ymFrom + 999);
          if (!ymData || ymData.length === 0) break;
          for (const r of ymData as { employee_number: string; calc_duration: string; accompanied_visit: string }[]) {
            const k = normEmp(r.employee_number);
            if (!byEmpYm.has(k)) byEmpYm.set(k, 0);
            if (!r.accompanied_visit || r.accompanied_visit.trim() === "") {
              byEmpYm.set(k, (byEmpYm.get(k) ?? 0) + parseDurationMinutes(r.calc_duration));
            }
          }
          if (ymData.length < 1000) break;
          ymFrom += 1000;
        }
        for (const [en, min] of byEmpYm) {
          visitMinutesByEmpMonth.set(`${en}:${ym}`, min);
        }
      }

      /** 保育手当を計算する */
      function computeChildcareAllowance(empNum: string, salaryType: string): number {
        const recs = childcareRecs.filter((r) => normEmp(r.employee_number) === empNum);
        if (recs.length === 0) return 0;
        const uniqueChildren = new Set(recs.map((r) => r.child_name ?? "不明")).size;
        const ceiling = uniqueChildren >= 2 ? 30000 : 20000;
        let total = 0;
        for (const rec of recs) {
          const amount = rec.amount ?? 0;
          if (amount <= 0) continue;
          const isKindergarten = rec.item_name.includes("幼稚園");
          const baseRate = isKindergarten ? 0.2 : 0.4;
          if (salaryType === "月給") {
            total += Math.round(amount * baseRate);
          } else {
            // year_month を YYYYMM に正規化してからルックアップ
            const rawYm = rec.year_month ?? selectedMonth;
            const ym = normalizeYM(rawYm);
            const visitMin = visitMinutesByEmpMonth.get(`${empNum}:${ym}`) ?? 0;
            const ratio = Math.min(visitMin / (120 * 60), 1.0);
            total += Math.round(amount * baseRate * ratio);
          }
        }
        return Math.min(total, ceiling);
      }

      /** 会議費を計算する（月給・時給共通） */
      function computeMeetingFee(empNum: string, officeId: string): number {
        const ofRecs = ofByEmp.get(empNum) ?? [];
        const meetingCount = ofRecs.filter((r) => r.item_name.includes("会議1")).reduce((s, r) =>
          s + (r.record_type === "km" ? Math.round((r.numeric_value as number) ?? 1) : 1), 0);
        const empOffice = officeByIdMap.get(officeId);
        return Math.round(meetingCount * (empOffice?.meeting_unit_price ?? 0));
      }

      // 時給者
      const roleMap = new Map(employees.map((e) => [normEmp(e.employee_number), {
        role: e.role_type,
        salary: e.salary_type,
        hasQual: e.has_care_qualification ?? false,
        jobType: e.job_type ?? "",
        serviceMonths: adjustedMonths(e.effective_service_months ?? 0),
        empId: e.id,
        officeId: e.office_id,
        socialInsurance: e.social_insurance ?? false,
        paidLeaveUnitPrice: e.paid_leave_unit_price ?? 0,
        communicationFeeType: e.communication_fee_type ?? "none",
      }]));
      const hourlyEmpMap = new Map<string, HourlyPayroll>();

      for (const empNum of new Set([...recsByEmp.keys(), ...attByEmp.keys()])) {
        const info    = roleMap.get(empNum);
        // 選択事業所の職員マスタに存在しない番号はスキップ（他事業所の番号衝突対策）
        if (!info) continue;
        if (info.salary === "月給") continue;
        const empRecs = recsByEmp.get(empNum) ?? [];
        const firstRec = empRecs[0];
        const sal = info ? salMap.get(info.empId) : null;
        const empSummary = computeSummary(empNum, empRecs);
        const empOffice = officeByIdMap.get(info?.officeId ?? "");
        const isVisitCare = info?.jobType === "訪問介護";
        const hasSocialInsurance = info?.socialInsurance ?? false;
        const treatmentSubsidy = (isVisitCare && hasSocialInsurance && empSummary.visitMinutes > 0)
          ? (empOffice?.treatment_subsidy_amount ?? 0)
          : (sal?.treatment_subsidy ?? 0);
        const cancelCount = empRecs.filter((r) => {
          const catId = mappingMap.get(r.service_code) ?? null;
          return catId ? categoryMap.get(catId) === "キャンセル" : false;
        }).length;
        const cancelAllowance = Math.round(cancelCount * (empOffice?.cancel_unit_price ?? 0));
        const paidLeaveAllowance = Math.round(empSummary.paidLeave * (info?.paidLeaveUnitPrice ?? 0));
        // 通信手当：社保未加入者のみ変動支給（50時間超:1000円、0〜50時間:500円）
        let communicationFee = 0;
        if (!(info?.socialInsurance ?? false)) {
          const visitHours = empSummary.visitMinutes / 60;
          if (visitHours > 50) communicationFee = 1000;
          else if (visitHours > 0) communicationFee = 500;
        }
        const commuteFee = Math.round(empSummary.commuteKmTotal * (empOffice?.commute_unit_price ?? 0));
        const businessTripFee = Math.round(empSummary.businessKmTotal * (empOffice?.travel_unit_price ?? 0));
        const meetingFee = computeMeetingFee(empNum, info?.officeId ?? "");
        hourlyEmpMap.set(empNum, {
          employee_number: empNum,
          employee_name: firstRec?.employee_name || (attByEmp.get(empNum)?.[0] as {employee_name?: string})?.employee_name || empNum,
          role_type: info?.role ?? "",
          has_care_qualification: info?.hasQual ?? false,
          job_type: info?.jobType ?? "",
          effective_service_months: info?.serviceMonths ?? 0,
          care_plan_count: 0,
          error_adjustment: 0,
          treatment_subsidy: treatmentSubsidy,
          paid_leave_allowance: paidLeaveAllowance,
          cancel_count: cancelCount,
          cancel_allowance: cancelAllowance,
          travel_time_sec: 0,
          travel_allowance: 0,
          communication_fee: communicationFee,
          meeting_fee: meetingFee,
          childcare_allowance: computeChildcareAllowance(empNum, "時給"),
          commute_fee: commuteFee,
          commute_distance_m: 0,
          business_trip_fee: businessTripFee,
          records: [],
          totalMinutes: 0,
          totalPay: 0,
          unmappedCount: 0,
          summary: empSummary,
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

      // ── 移動手当計算（訪問介護・時給者） ──
      {
        const visitCareEmps = employees.filter(
          (e) => e.salary_type === "時給" && e.job_type === "訪問介護" && e.address?.trim()
        );
        if (visitCareEmps.length > 0) {
          const { data: clientData } = await supabase
            .from("clients")
            .select("client_number,address,map_latitude,map_longitude")
            .eq("office_id", selectedOfficeId);
          // マップ用座標が設定されていればそちらを優先（"lat,lng" 文字列としてDistance Matrix APIに渡せる）
          const clientMap = new Map(
            (clientData ?? []).map((c: { client_number: string; address: string; map_latitude: number | null; map_longitude: number | null }) => {
              const addr = (c.map_latitude != null && c.map_longitude != null)
                ? `${c.map_latitude},${c.map_longitude}`
                : c.address;
              return [c.client_number, addr];
            })
          );

          const byEmpNum = new Map<string, { address: string; dayMap: Map<string, VisitForRoute[]> }>();
          for (const emp of visitCareEmps) {
            const normNum = normEmp(emp.employee_number);
            const empRecs = recsByEmp.get(normNum) ?? [];
            const dayMap = new Map<string, VisitForRoute[]>();
            for (const rec of empRecs) {
              const clientAddr = clientMap.get(rec.client_number);
              if (!clientAddr?.trim()) continue;
              if (!dayMap.has(rec.service_date)) dayMap.set(rec.service_date, []);
              dayMap.get(rec.service_date)!.push({
                client_number: rec.client_number,
                client_address: clientAddr,
                dispatch_start_time: rec.dispatch_start_time,
                dispatch_end_time: rec.dispatch_end_time,
              });
            }
            if (dayMap.size > 0) byEmpNum.set(normNum, { address: emp.address, dayMap });
          }

          const allPairs: { origin: string; destination: string }[] = [];
          for (const { address, dayMap } of byEmpNum.values()) {
            allPairs.push(...collectAddressPairs(address, dayMap));
          }

          if (allPairs.length > 0) {
            const BATCH_SIZE = 50;
            const distResultsArr: { origin: string; destination: string; distance_meters: number; duration_seconds: number }[] = [];
            for (let i = 0; i < allPairs.length; i += BATCH_SIZE) {
              const batch = allPairs.slice(i, i + BATCH_SIZE);
              const res = await fetch("/api/distance", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pairs: batch }),
              });
              if (res.ok) {
                const json = await res.json();
                distResultsArr.push(...(json.results ?? []));
              }
            }
            const distMap = new Map<string, { distance_meters: number; duration_seconds: number }>(
              distResultsArr.map((r) => [`${r.origin}|||${r.destination}`, { distance_meters: r.distance_meters, duration_seconds: r.duration_seconds }])
            );

            for (const [normNum, { address, dayMap }] of byEmpNum) {
              const entry = hourlyEmpMap.get(normNum);
              if (!entry) continue;
              const empObj = employees.find((e) => normEmp(e.employee_number) === normNum);
              const empOffice = officeByIdMap.get(empObj?.office_id ?? "");
              const rate = empOffice?.travel_allowance_rate ?? 0;
              let totalSec = 0;
              let totalCommuteM = 0;
              for (const [date, visits] of dayMap) {
                const day = calcDayRoute(date, address, visits, distMap);
                if (day) {
                  totalSec += day.travel_time_sec;
                  totalCommuteM += day.commute_distance_m;
                }
              }
              const distRate = (empOffice?.distance_adjustment_rate ?? 100) / 100;
              const adjustedDistanceM = Math.round(totalCommuteM * distRate);
              entry.travel_time_sec = totalSec;
              entry.travel_allowance = rate > 0 ? Math.round(totalSec / 3600 * rate) : 0;
              entry.commute_distance_m = adjustedDistanceM;
              entry.business_trip_fee = Math.round((adjustedDistanceM / 1000) * (empOffice?.travel_unit_price ?? 0));
            }
          }
        }
      }

      const hourlySorted = [...hourlyEmpMap.values()].sort((a, b) => a.employee_name.localeCompare(b.employee_name, "ja"));
      setHourlyResults(hourlySorted);

      // 月給者
      const monthlyEmps = employees.filter(
        (e) => e.salary_type === "月給" && (!e.employment_status || e.employment_status === "在職者")
      );
      const monthlySorted = monthlyEmps.sort((a, b) => a.name.localeCompare(b.name, "ja")).map((e) => {
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
          const summary = computeSummary(String(e.employee_number), recsByEmp.get(String(e.employee_number)) ?? []);
          // 出張km: 事業所書式 > 出勤簿
          const empOfRecs = ofByEmp.get(normEmp(e.employee_number)) ?? [];
          const ofTravelKm = empOfRecs
            .filter((r) => r.record_type === "km" && r.item_name === "出張km")
            .reduce((s, r) => s + (r.numeric_value ?? 0), 0);
          const travelKmAuto = ofTravelKm > 0 ? ofTravelKm : summary.businessKmTotal;
          const office = officeByIdMap.get(e.office_id);

          return {
            employee_id: e.id,
            employee_number: e.employee_number,
            employee_name: e.name,
            role_type: e.role_type,
            job_type: e.job_type ?? "",
            settings: settingsWithTenure,
            bonus_paid: false,
            travel_km: 0,
            travel_km_auto: travelKmAuto,
            office_travel_unit_price: office?.travel_unit_price ?? 0,
            office_commute_unit_price: office?.commute_unit_price ?? 0,
            business_trip_fee: 0,
            childcare_allowance: computeChildcareAllowance(normEmp(e.employee_number), "月給"),
            yocho_hours: 0,
            summary,
          };
        });
      setMonthlyResults(monthlySorted);

      // 総括表用に計算結果を localStorage へ保存（直近の結果を読み返せるように）
      try {
        const key = `payroll-summary:${selectedOffice.office_number}:${selectedMonth}`;
        const payload = {
          office_id: selectedOfficeId,
          office_number: selectedOffice.office_number,
          office_name: selectedOffice.short_name || selectedOffice.name,
          processing_month: selectedMonth,
          calculated_at: new Date().toISOString(),
          hourly: hourlySorted,
          monthly: monthlySorted,
          overtime_settings: [...otMap.values()],
        };
        localStorage.setItem(key, JSON.stringify(payload));
        // インデックス（どの組み合わせが保存されているか）
        const indexKey = "payroll-summary:index";
        const existingIndex = JSON.parse(localStorage.getItem(indexKey) ?? "[]") as { key: string; office_number: string; office_name: string; processing_month: string; calculated_at: string }[];
        const filtered = existingIndex.filter((x) => x.key !== key);
        filtered.push({ key, office_number: selectedOffice.office_number, office_name: selectedOffice.short_name || selectedOffice.name, processing_month: selectedMonth, calculated_at: payload.calculated_at });
        localStorage.setItem(indexKey, JSON.stringify(filtered));
      } catch {
        // localStorage 書き込みは失敗しても給与計算自体は続行
      }
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
      "出勤日数","ヘルパー日数","有給","半有給","特休欠勤","出勤時間",
      "実績時間","同行時間","訪問時間","HRD",
      "合計算定時間(分)","合計算定時間","本人給（パート）(円)","勤続手当単価","勤続手当(円)","資格手当(円)","処遇改善補助金手当(円)","報奨金(円)","移動時間","移動手当(円)","有給休暇手当(円)","調整手当(円)","育児手当(円)","HRD研修(円)","会議費(円)","保育手当(円)","その他手当(円)","通信手当(円)","土日祝手当(円)","キャンセル手当(円)","残業(円)","休日(円)","残業総額(円)","通勤費(円)","出張距離(km)","出張費(円)","総支給額(円)",
    ]];
    for (const e of hourlyResults) {
      const s = e.summary;
      const tenure = computeTenureAllowance(
        e.has_care_qualification, e.effective_service_months, "時給", e.job_type,
        s.visitMinutesExcludingAccompanied, s.recordCount, e.care_plan_count
      );
      const total = e.totalPay + tenure + e.treatment_subsidy + e.paid_leave_allowance + e.cancel_allowance + e.travel_allowance + e.communication_fee + e.meeting_fee + e.commute_fee + e.business_trip_fee;
      rows.push([
        e.employee_number, e.employee_name, e.role_type,
        String(s.workDays), String(s.helperDays), String(s.paidLeave), String(s.halfLeave), String(s.specialLeave),
        formatWorkHours(s.workHoursMin),
        formatMinutes(s.visitMinutesExcludingAccompanied), formatMinutes(s.visitMinutes - s.visitMinutesExcludingAccompanied), formatMinutes(s.visitMinutes), formatMinutes(s.hrdMinutes),
        String(e.totalMinutes), formatMinutes(e.totalMinutes), String(e.totalPay),
        String(computeTenureRate(e.has_care_qualification, e.effective_service_months, e.job_type)),
        String(tenure), "0", String(e.treatment_subsidy), "0",
        e.travel_time_sec > 0 ? secToHm(e.travel_time_sec) : "0:00", String(e.travel_allowance),
        String(e.paid_leave_allowance), "0", "0", "0", String(e.meeting_fee), String(e.childcare_allowance), "0",
        String(e.communication_fee),
        String(Math.round(e.summary.weekendHolidayMinutes / 60 * 100)),
        String(e.cancel_allowance), "0", "0", "0",
        String(e.commute_fee), `${(e.commute_distance_m / 1000).toFixed(1)}`, String(e.business_trip_fee), String(total),
      ]);
    }
    downloadCsv(`給与計算_${label}_時給者サマリー.csv`, rows);
  }

  function exportMonthlyCsv() {
    const label = formatProcessingMonth(selectedMonth).replace(/\s/g, "");
    const rows: string[][] = [[
      "職員番号","職員名","役職",
      "出勤日数","ヘルパー日数","有給","半有給","特休欠勤","出勤時間",
      "実績時間","同行時間","訪問時間","HRD","出張距離(km)","出張手当","通勤距離(km)","通勤手当",
      "本人給","職能給","役職手当","資格手当","勤続手当",
      "処遇改善手当","特定処遇改善手当","処遇改善補助金手当",
      "固定残業代","残業代","残業代(超過額)","特別報奨金","報奨金","移動費","出張費",
      "育児手当","夜朝時間","夜朝手当","介護超過手当","合計(円)",
    ]];
    for (const p of monthlyResults) {
      const s = p.settings;
      const sm = p.summary;
      rows.push([
        p.employee_number, p.employee_name, p.role_type,
        String(sm.workDays), String(sm.helperDays), String(sm.paidLeave), String(sm.halfLeave), String(sm.specialLeave),
        formatWorkHours(sm.workHoursMin),
        formatMinutes(sm.visitMinutesExcludingAccompanied), formatMinutes(sm.visitMinutes - sm.visitMinutesExcludingAccompanied), formatMinutes(sm.visitMinutes), String(sm.hrdCount),
        String(effectiveTravelKm(p)), String(travelFeeAmount(p)), String(sm.commuteKmTotal), String(commuteFeeAmount(p)),
        String(s?.base_personal_salary ?? 0),
        String(s?.skill_salary ?? 0),
        String(s?.position_allowance ?? 0),
        String(s?.qualification_allowance ?? 0),
        String(s?.tenure_allowance ?? 0),
        String(s?.treatment_improvement ?? 0),
        String(s?.specific_treatment_improvement ?? 0),
        String(s?.treatment_subsidy ?? 0),
        String(s?.fixed_overtime_pay ?? 0),
        String(computeOvertimePay(p, otSettings)),
        String(overtimeExcessPay(p, otSettings)),
        String(s?.special_bonus ?? 0),
        String(p.bonus_paid ? (s?.bonus_amount ?? 0) : 0),
        String(travelFeeAmount(p)),
        String(p.business_trip_fee),
        String(p.childcare_allowance),
        String(p.yocho_hours),
        String(yochoAllowance(p)),
        String(careOvertimePay(p)),
        String(monthlyGrandTotal(p, otSettings)),
      ]);
    }
    downloadCsv(`給与計算_${label}_月給者.csv`, rows);
  }

  const hourlyTenureTotal  = hourlyResults.reduce((s, e) => {
    return s + computeTenureAllowance(
      e.has_care_qualification, e.effective_service_months, "時給", e.job_type,
      e.summary.visitMinutesExcludingAccompanied, e.summary.recordCount, e.care_plan_count
    );
  }, 0);
  const hourlyGrandTotal   = hourlyResults.reduce((s, e) => {
    const tenure = computeTenureAllowance(
      e.has_care_qualification, e.effective_service_months, "時給", e.job_type,
      e.summary.workHoursMin, e.summary.recordCount, e.care_plan_count
    );
    return s + e.totalPay + tenure + e.treatment_subsidy + e.paid_leave_allowance + e.cancel_allowance + e.travel_allowance + e.communication_fee + e.meeting_fee + e.childcare_allowance + e.commute_fee + e.business_trip_fee;
  }, 0);
  const hourlyGrandMinutes = hourlyResults.reduce((s, e) => s + e.totalMinutes, 0);
  const monthlyGrandSum    = monthlyResults.reduce((s, p) => s + monthlyGrandTotal(p, otSettings), 0);

  // ─── 描画 ─────────────────────────────────────────────────────

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">給与計算</h2>

      <Card className="mb-6">
        <CardContent className="pt-6 space-y-3">
          {/* 種別タブ: 事業所をoffice_typeで絞り込む */}
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-sm font-medium whitespace-nowrap">種別</label>
            {(() => {
              // 実際に登録されている office_type だけ表示
              const availableTypes = [...new Set(offices.map((o) => o.office_type).filter(Boolean))]
                .sort((a, b) => a.localeCompare(b, "ja"));
              if (availableTypes.length === 0) return <span className="text-xs text-muted-foreground">（事業所なし）</span>;
              return availableTypes.map((t) => {
                const count = offices.filter((o) => o.office_type === t).length;
                const active = selectedOfficeType === t;
                return (
                  <button
                    key={t}
                    onClick={() => {
                      setSelectedOfficeType(t);
                      // 種別に該当する最初の事業所を選択
                      const first = offices.find((o) => o.office_type === t);
                      if (first) setSelectedOfficeId(first.id);
                    }}
                    className={`px-3 py-1 rounded-full text-sm transition-colors ${
                      active ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-muted/80"
                    }`}
                  >
                    {t}
                    <span className="ml-1 text-xs opacity-70">{count}</span>
                  </button>
                );
              });
            })()}
          </div>

          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium whitespace-nowrap">事業所</label>
              <select
                className="border rounded px-3 py-1.5 text-sm bg-background"
                value={selectedOfficeId}
                onChange={(e) => setSelectedOfficeId(e.target.value)}
              >
                {(() => {
                  const filtered = offices.filter((o) => o.office_type === selectedOfficeType);
                  if (filtered.length === 0) return <option value="">（該当事業所なし）</option>;
                  return filtered.map((o) => (
                    <option key={o.id} value={o.id}>{o.short_name || o.name}</option>
                  ));
                })()}
              </select>
            </div>
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
            <Button onClick={calculate} disabled={!selectedMonth || !selectedOfficeId || loading}>
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

              {/* 時給未設定により0円になっている実績の集計 */}
              {(() => {
                type Agg = { count: number; minutes: number; reason: "未マッピング" | "時給未設定" };
                const agg = new Map<string, Agg>();
                for (const emp of hourlyResults) {
                  for (const d of emp.records) {
                    if (d.hourly_rate !== null) continue;
                    const reason = d.category_name === "未マッピング" ? "未マッピング" : "時給未設定";
                    const key = `${d.service_code}|${d.category_name}|${reason}`;
                    const cur = agg.get(key) ?? { count: 0, minutes: 0, reason };
                    cur.count += 1;
                    cur.minutes += d.minutes;
                    agg.set(key, cur);
                  }
                }
                if (agg.size === 0) return null;
                const rows = [...agg.entries()]
                  .map(([k, v]) => {
                    const [service_code, category_name] = k.split("|");
                    return { service_code, category_name, ...v };
                  })
                  .sort((a, b) => b.minutes - a.minutes);
                const totalCount = rows.reduce((s, r) => s + r.count, 0);
                const totalMinutes = rows.reduce((s, r) => s + r.minutes, 0);
                return (
                  <Card className="mb-4 border-yellow-300 bg-yellow-50/50">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm text-yellow-900">
                        ⚠ 時給未設定により0円になっている実績: {totalCount}件 / {formatMinutes(totalMinutes)}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-yellow-200 bg-yellow-100/50">
                            <th className="text-left px-3 py-1.5 font-medium">サービスコード</th>
                            <th className="text-left px-3 py-1.5 font-medium">類型</th>
                            <th className="text-left px-3 py-1.5 font-medium">原因</th>
                            <th className="text-right px-3 py-1.5 font-medium">件数</th>
                            <th className="text-right px-3 py-1.5 font-medium">時間合計</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r, i) => (
                            <tr key={i} className="border-b border-yellow-100">
                              <td className="px-3 py-1 font-mono">{r.service_code}</td>
                              <td className="px-3 py-1">{r.category_name}</td>
                              <td className="px-3 py-1">
                                <span className={r.reason === "未マッピング" ? "text-orange-700" : "text-red-700"}>
                                  {r.reason === "未マッピング" ? "サービスコード→類型のマッピング未登録" : "事業所×類型の時給未設定"}
                                </span>
                              </td>
                              <td className="px-3 py-1 text-right">{r.count}件</td>
                              <td className="px-3 py-1 text-right">{formatMinutes(r.minutes)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </CardContent>
                  </Card>
                );
              })()}

              <Card>
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle>{formatProcessingMonth(selectedMonth)} 時給者 給与計算結果</CardTitle>
                  <Button variant="outline" size="sm" onClick={exportHourlyCsv}>📥 CSV出力</Button>
                </CardHeader>
                <CardContent className="p-0 overflow-x-auto">
                  <table className="w-full text-sm whitespace-nowrap">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="text-left px-3 py-3 font-medium sticky left-0 z-20 bg-muted">職員番号 / 職員名</th>
                        <th className="text-left px-3 py-3 font-medium">役職</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">出勤日数</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">ヘルパー日数</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">有給</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">特休</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">欠勤</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">出勤時間</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">内事務入浴</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">内初任者研修時間</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">内研修時間</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">実績時間</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">同行時間</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">訪問時間</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">内残業</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">内休日時間</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">入浴残業</th>
                        <th className="text-right px-3 py-3 font-medium">集計項目小計</th>
                        <th className="text-right px-3 py-3 font-medium">ドタキャン</th>
                        <th className="text-right px-3 py-3 font-medium">特日</th>
                        <th className="text-right px-3 py-3 font-medium">土日祝</th>
                        <th className="text-right px-3 py-3 font-medium">初任者研修調整費</th>
                        <th className="text-right px-3 py-3 font-medium">過誤(手入力)</th>
                        <th className="text-right px-3 py-3 font-medium">初任者研修費</th>
                        <th className="text-right px-3 py-3 font-medium text-green-700">勤続手当単価</th>
                        <th className="text-right px-3 py-3 font-medium text-green-700">勤続手当</th>
                        <th className="text-right px-3 py-3 font-medium">資格手当</th>
                        <th className="text-right px-3 py-3 font-medium">処遇改善補助金手当</th>
                        <th className="text-right px-3 py-3 font-medium">報奨金</th>
                        <th className="text-right px-3 py-3 font-medium">移動手当</th>
                        <th className="text-right px-3 py-3 font-medium">訪問入浴</th>
                        <th className="text-right px-3 py-3 font-medium">有給休暇手当</th>
                        <th className="text-right px-3 py-3 font-medium">調整手当</th>
                        <th className="text-right px-3 py-3 font-medium">育児手当</th>
                        <th className="text-right px-3 py-3 font-medium">HRD研修</th>
                        <th className="text-right px-3 py-3 font-medium">会議費</th>
                        <th className="text-right px-3 py-3 font-medium">その他手当</th>
                        <th className="text-right px-3 py-3 font-medium">通信手当</th>
                        <th className="text-right px-3 py-3 font-medium">残業</th>
                        <th className="text-right px-3 py-3 font-medium">休日</th>
                        <th className="text-right px-3 py-3 font-medium">残業総額</th>
                        <th className="text-right px-3 py-3 font-medium">通勤距離</th>
                        <th className="text-right px-3 py-3 font-medium">通勤費</th>
                        <th className="text-right px-3 py-3 font-medium">出張距離</th>
                        <th className="text-right px-3 py-3 font-medium">出張費</th>
                        <th className="text-right px-3 py-3 font-medium font-bold">総支給額</th>
                        <th className="text-center px-3 py-3 font-medium">注記</th>
                        <th className="px-3 py-3"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {hourlyResults.map((emp) => {
                        const sm = emp.summary;
                        const tenure = computeTenureAllowance(
                          emp.has_care_qualification, emp.effective_service_months, "時給", emp.job_type,
                          sm.visitMinutesExcludingAccompanied, sm.recordCount, emp.care_plan_count
                        );
                        const grandTotal = emp.totalPay + tenure + emp.treatment_subsidy + emp.paid_leave_allowance + emp.cancel_allowance + emp.travel_allowance + emp.communication_fee + emp.meeting_fee + emp.childcare_allowance + emp.commute_fee + emp.business_trip_fee + emp.error_adjustment;
                        return (
                          <>
                            <tr
                              key={emp.employee_number}
                              className="border-b hover:bg-muted/30 cursor-pointer"
                              onClick={() => setExpandedEmp(expandedEmp === emp.employee_number ? null : emp.employee_number)}
                            >
                              <td className="px-3 py-2 sticky left-0 z-10 bg-background">
                                <div className="flex flex-col">
                                  <span className="font-mono text-xs text-muted-foreground">{emp.employee_number}</span>
                                  <span className="font-medium">{emp.employee_name}</span>
                                </div>
                              </td>
                              <td className="px-3 py-2"><RoleBadge role={emp.role_type} /></td>
                              <td className="px-3 py-2 text-right">{sm.workDays}</td>
                              <td className="px-3 py-2 text-right">{sm.helperDays}</td>
                              <td className="px-3 py-2 text-right">{sm.paidLeave || "—"}</td>
                              <td className="px-3 py-2 text-right">{sm.specialLeave || "—"}</td>
                              <td className="px-3 py-2 text-right text-muted-foreground text-xs">—</td>
                              <td className="px-3 py-2 text-right">{formatWorkHours(sm.workHoursMin)}</td>
                              <td className="px-3 py-2 text-right text-muted-foreground text-xs">—</td>
                              <td className="px-3 py-2 text-right text-muted-foreground text-xs">—</td>
                              <td className="px-3 py-2 text-right text-muted-foreground text-xs">—</td>
                              <td className="px-3 py-2 text-right">{sm.visitMinutesExcludingAccompanied ? formatMinutes(sm.visitMinutesExcludingAccompanied) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right">{(sm.visitMinutes - sm.visitMinutesExcludingAccompanied) > 0 ? formatMinutes(sm.visitMinutes - sm.visitMinutesExcludingAccompanied) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right">{sm.visitMinutes ? formatMinutes(sm.visitMinutes) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right text-muted-foreground text-xs">—</td>
                              <td className="px-3 py-2 text-right text-muted-foreground text-xs">—</td>
                              <td className="px-3 py-2 text-right text-muted-foreground text-xs">—</td>
                              <td className="px-3 py-2 text-right">{emp.totalPay > 0 ? yen(emp.totalPay) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right">{emp.cancel_allowance > 0 ? yen(emp.cancel_allowance) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right text-muted-foreground text-xs">—</td>
                              <td className="px-3 py-2 text-right">{sm.weekendHolidayMinutes > 0 ? yen(Math.round(sm.weekendHolidayMinutes / 60 * 100)) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right text-muted-foreground text-xs">—</td>
                              <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                                <Input
                                  type="number"
                                  value={emp.error_adjustment || ""}
                                  placeholder="0"
                                  onChange={(e) => updateHourly(emp.employee_number, { error_adjustment: parseFloat(e.target.value) || 0 })}
                                  className="w-24 text-right h-6 px-2 text-xs"
                                />
                              </td>
                              <td className="px-3 py-2 text-right text-muted-foreground text-xs">—</td>
                              <td className="px-3 py-2 text-right text-green-700 text-xs">
                                {computeTenureRate(emp.has_care_qualification, emp.effective_service_months, emp.job_type) > 0
                                  ? `${computeTenureRate(emp.has_care_qualification, emp.effective_service_months, emp.job_type)}円`
                                  : <span className="text-muted-foreground">—</span>}
                              </td>
                              <td className="px-3 py-2 text-right">
                                {tenure > 0 ? <span className="font-medium text-green-700">{yen(tenure)}</span> : <span className="text-muted-foreground text-xs">—</span>}
                              </td>
                              <td className="px-3 py-2 text-right text-muted-foreground text-xs">—</td>
                              <td className="px-3 py-2 text-right">{emp.treatment_subsidy > 0 ? yen(emp.treatment_subsidy) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right text-muted-foreground text-xs">—</td>
                              <td className="px-3 py-2 text-right">{emp.travel_allowance > 0 ? yen(emp.travel_allowance) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right text-muted-foreground text-xs">—</td>
                              <td className="px-3 py-2 text-right">{emp.paid_leave_allowance > 0 ? yen(emp.paid_leave_allowance) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right text-muted-foreground text-xs">—</td>
                              <td className="px-3 py-2 text-right">{emp.childcare_allowance > 0 ? yen(emp.childcare_allowance) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right text-muted-foreground text-xs">—</td>
                              <td className="px-3 py-2 text-right">{emp.meeting_fee > 0 ? yen(emp.meeting_fee) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right text-muted-foreground text-xs">—</td>
                              <td className="px-3 py-2 text-right">{emp.communication_fee > 0 ? yen(emp.communication_fee) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right text-muted-foreground text-xs">—</td>
                              <td className="px-3 py-2 text-right text-muted-foreground text-xs">—</td>
                              <td className="px-3 py-2 text-right text-muted-foreground text-xs">—</td>
                              <td className="px-3 py-2 text-right font-mono text-xs">{sm.commuteKmTotal > 0 ? `${formatKm(sm.commuteKmTotal)} km` : <span className="text-muted-foreground">—</span>}</td>
                              <td className="px-3 py-2 text-right">{emp.commute_fee > 0 ? yen(emp.commute_fee) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right font-mono text-xs">{emp.commute_distance_m > 0 ? `${formatKm(emp.commute_distance_m / 1000)} km` : <span className="text-muted-foreground">—</span>}</td>
                              <td className="px-3 py-2 text-right">{emp.business_trip_fee > 0 ? yen(emp.business_trip_fee) : <span className="text-muted-foreground text-xs">—</span>}</td>
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
                                <td colSpan={48} className="px-8 py-3">
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
                    <tfoot>
                      <tr className="bg-muted/30 font-bold border-t-2">
                        {/* sticky: 合計 */}
                        <td className="px-3 py-2 sticky left-0 z-10 bg-muted/30">合計</td>
                        {/* 役職 */}
                        <td></td>
                        {/* 出勤日数 */}
                        <td className="px-3 py-2 text-right">{hourlyResults.reduce((s, e) => s + e.summary.workDays, 0)}</td>
                        {/* ヘルパー日数 */}
                        <td className="px-3 py-2 text-right">{hourlyResults.reduce((s, e) => s + e.summary.helperDays, 0) || "—"}</td>
                        {/* 有給 */}
                        <td className="px-3 py-2 text-right">{hourlyResults.reduce((s, e) => s + e.summary.paidLeave, 0) || "—"}</td>
                        {/* 特休 */}
                        <td className="px-3 py-2 text-right">{hourlyResults.reduce((s, e) => s + e.summary.specialLeave, 0) || "—"}</td>
                        {/* 欠勤 */}
                        <td></td>
                        {/* 出勤時間 */}
                        <td className="px-3 py-2 text-right">{formatWorkHours(hourlyResults.reduce((s, e) => s + e.summary.workHoursMin, 0))}</td>
                        {/* 内事務入浴・内初任者研修時間・内研修時間 */}
                        <td></td><td></td><td></td>
                        {/* 実績時間 */}
                        <td className="px-3 py-2 text-right">{formatMinutes(hourlyResults.reduce((s, e) => s + e.summary.visitMinutesExcludingAccompanied, 0))}</td>
                        {/* 同行時間 */}
                        <td className="px-3 py-2 text-right">{formatMinutes(hourlyResults.reduce((s, e) => s + (e.summary.visitMinutes - e.summary.visitMinutesExcludingAccompanied), 0))}</td>
                        {/* 訪問時間 */}
                        <td className="px-3 py-2 text-right">{formatMinutes(hourlyResults.reduce((s, e) => s + e.summary.visitMinutes, 0))}</td>
                        {/* 内残業・内休日時間・入浴残業 */}
                        <td></td><td></td><td></td>
                        {/* 集計項目小計 */}
                        <td className="px-3 py-2 text-right">{yen(hourlyResults.reduce((s, e) => s + e.totalPay, 0))}</td>
                        {/* ドタキャン */}
                        <td className="px-3 py-2 text-right">{yen(hourlyResults.reduce((s, e) => s + e.cancel_allowance, 0))}</td>
                        {/* 特日 */}
                        <td></td>
                        {/* 土日祝 */}
                        <td className="px-3 py-2 text-right">{yen(hourlyResults.reduce((s, e) => s + Math.round(e.summary.weekendHolidayMinutes / 60 * 100), 0))}</td>
                        {/* 初任者研修調整費 */}
                        <td></td>
                        {/* 過誤 */}
                        <td className="px-3 py-2 text-right">{hourlyResults.reduce((s, e) => s + (e.error_adjustment || 0), 0) !== 0 ? yen(hourlyResults.reduce((s, e) => s + (e.error_adjustment || 0), 0)) : ""}</td>
                        {/* 初任者研修費 */}
                        <td></td>
                        {/* 勤続手当単価 */}
                        <td></td>
                        {/* 勤続手当 */}
                        <td className="px-3 py-2 text-right">{hourlyTenureTotal > 0 ? yen(hourlyTenureTotal) : "—"}</td>
                        {/* 資格手当 */}
                        <td></td>
                        {/* 処遇改善補助金手当 */}
                        <td className="px-3 py-2 text-right">{yen(hourlyResults.reduce((s, e) => s + e.treatment_subsidy, 0))}</td>
                        {/* 報奨金 */}
                        <td></td>
                        {/* 移動手当 */}
                        <td className="px-3 py-2 text-right">{yen(hourlyResults.reduce((s, e) => s + e.travel_allowance, 0))}</td>
                        {/* 訪問入浴 */}
                        <td></td>
                        {/* 有給休暇手当 */}
                        <td className="px-3 py-2 text-right">{yen(hourlyResults.reduce((s, e) => s + e.paid_leave_allowance, 0))}</td>
                        {/* 調整手当 */}
                        <td></td>
                        {/* 育児手当 */}
                        <td className="px-3 py-2 text-right">{yen(hourlyResults.reduce((s, e) => s + e.childcare_allowance, 0))}</td>
                        {/* HRD研修 */}
                        <td></td>
                        {/* 会議費 */}
                        <td className="px-3 py-2 text-right">{yen(hourlyResults.reduce((s, e) => s + e.meeting_fee, 0))}</td>
                        {/* その他手当 */}
                        <td></td>
                        {/* 通信手当 */}
                        <td className="px-3 py-2 text-right">{yen(hourlyResults.reduce((s, e) => s + e.communication_fee, 0))}</td>
                        {/* 残業・休日・残業総額 */}
                        <td></td><td></td><td></td>
                        {/* 通勤距離 */}
                        <td className="px-3 py-2 text-right font-mono text-xs">{`${formatKm(hourlyResults.reduce((s, e) => s + e.summary.commuteKmTotal, 0))} km`}</td>
                        {/* 通勤費 */}
                        <td className="px-3 py-2 text-right">{yen(hourlyResults.reduce((s, e) => s + e.commute_fee, 0))}</td>
                        {/* 出張距離 */}
                        <td className="px-3 py-2 text-right font-mono text-xs">{`${formatKm(hourlyResults.reduce((s, e) => s + e.commute_distance_m, 0) / 1000)} km`}</td>
                        {/* 出張費 */}
                        <td className="px-3 py-2 text-right">{yen(hourlyResults.reduce((s, e) => s + e.business_trip_fee, 0))}</td>
                        {/* 総支給額 */}
                        <td className="px-3 py-2 text-right text-base">{yen(hourlyGrandTotal)}</td>
                        {/* 注記・展開 */}
                        <td></td><td></td>
                      </tr>
                    </tfoot>
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
                        <th className="text-left px-3 py-3 font-medium sticky left-0 z-20 bg-muted">職員番号 / 職員名</th>
                        <th className="text-left px-3 py-3 font-medium">役職</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">出勤日数</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">ヘルパー日数</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">有給</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">半有給</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">特休欠勤</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">出勤時間</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">実績時間</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">同行時間</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">訪問時間</th>
                        <th className="text-right px-3 py-3 font-medium text-blue-700">HRD</th>
                        <th className="text-right px-3 py-3 font-medium">出張距離</th>
                        <th className="text-right px-3 py-3 font-medium">通勤距離</th>
                        <th className="text-right px-3 py-3 font-medium">本人給</th>
                        <th className="text-right px-3 py-3 font-medium">職能給</th>
                        <th className="text-right px-3 py-3 font-medium">役職手当</th>
                        <th className="text-right px-3 py-3 font-medium">資格手当</th>
                        <th className="text-right px-3 py-3 font-medium text-green-700">勤続手当</th>
                        <th className="text-right px-3 py-3 font-medium">処遇改善</th>
                        <th className="text-right px-3 py-3 font-medium">特定処遇</th>
                        <th className="text-right px-3 py-3 font-medium">処遇補助金</th>
                        <th className="text-right px-3 py-3 font-medium">固定残業代</th>
                        <th className="text-right px-3 py-3 font-medium text-amber-700">残業代</th>
                        <th className="text-right px-3 py-3 font-medium text-amber-700">残業代（超過）</th>
                        <th className="text-right px-3 py-3 font-medium">特別報奨金</th>
                        <th className="text-right px-3 py-3 font-medium text-orange-700">介護超過手当</th>
                        <th className="text-right px-3 py-3 font-medium">出張手当</th>
                        <th className="text-right px-3 py-3 font-medium">通勤手当</th>
                        <th className="text-right px-3 py-3 font-medium">育児手当</th>
                        <th className="text-right px-3 py-3 font-medium font-bold">合計</th>
                        <th className="px-3 py-3"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthlyResults.map((p) => {
                        const s  = p.settings;
                        const sm = p.summary;
                        const fixed = s ? fixedTotal(s) : 0;
                        const total = monthlyGrandTotal(p, otSettings);
                        const cop   = careOvertimePay(p);
                        const yocho = yochoAllowance(p);
                        const isExpanded = expandedMonthly === p.employee_id;
                        return (
                          <>
                            <tr
                              key={p.employee_id}
                              className="border-b hover:bg-muted/30 cursor-pointer"
                              onClick={() => setExpandedMonthly(isExpanded ? null : p.employee_id)}
                            >
                              <td className="px-3 py-2 sticky left-0 z-10 bg-background">
                                <div className="flex flex-col">
                                  <span className="font-mono text-xs text-muted-foreground">{p.employee_number}</span>
                                  <span className="font-medium">{p.employee_name}</span>
                                </div>
                              </td>
                              <td className="px-3 py-2"><RoleBadge role={p.role_type} /></td>
                              <td className="px-3 py-2 text-right">{sm.workDays}</td>
                              <td className="px-3 py-2 text-right">{sm.helperDays || "—"}</td>
                              <td className="px-3 py-2 text-right">{sm.paidLeave || "—"}</td>
                              <td className="px-3 py-2 text-right">{sm.halfLeave || "—"}</td>
                              <td className="px-3 py-2 text-right">{sm.specialLeave || "—"}</td>
                              <td className="px-3 py-2 text-right">{formatWorkHours(sm.workHoursMin)}</td>
                              <td className="px-3 py-2 text-right">{sm.visitMinutesExcludingAccompanied ? formatMinutes(sm.visitMinutesExcludingAccompanied) : "—"}</td>
                              <td className="px-3 py-2 text-right">{(sm.visitMinutes - sm.visitMinutesExcludingAccompanied) > 0 ? formatMinutes(sm.visitMinutes - sm.visitMinutesExcludingAccompanied) : "—"}</td>
                              <td className="px-3 py-2 text-right">{sm.visitMinutes ? formatMinutes(sm.visitMinutes) : "—"}</td>
                              <td className="px-3 py-2 text-right">{sm.hrdCount || "—"}</td>
                              <td className="px-3 py-2 text-right">{effectiveTravelKm(p) > 0 ? `${formatKm(effectiveTravelKm(p))}km` : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right">{sm.commuteKmTotal > 0 ? `${formatKm(sm.commuteKmTotal)}km` : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right">{s && s.base_personal_salary > 0 ? yen(s.base_personal_salary) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right">{s && s.skill_salary > 0 ? yen(s.skill_salary) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right">{s && s.position_allowance > 0 ? yen(s.position_allowance) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right">{s && s.qualification_allowance > 0 ? yen(s.qualification_allowance) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right">
                                {s && s.tenure_allowance > 0
                                  ? <span className="font-medium text-green-700">{yen(s.tenure_allowance)}</span>
                                  : <span className="text-xs text-muted-foreground">—</span>}
                              </td>
                              <td className="px-3 py-2 text-right">{s && s.treatment_improvement > 0 ? yen(s.treatment_improvement) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right">{s && s.specific_treatment_improvement > 0 ? yen(s.specific_treatment_improvement) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right">{s && s.treatment_subsidy > 0 ? yen(s.treatment_subsidy) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right">{s && s.fixed_overtime_pay > 0 ? yen(s.fixed_overtime_pay) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right">
                                {(() => {
                                  const otPay = computeOvertimePay(p, otSettings);
                                  if (otPay > 0) return <span className="font-medium text-amber-700">{yen(otPay)}</span>;
                                  if (p.summary.overtimeMinutes > 0) return <span className="text-xs text-muted-foreground">単価未設定</span>;
                                  return <span className="text-xs text-muted-foreground">—</span>;
                                })()}
                              </td>
                              <td className="px-3 py-2 text-right">
                                {(() => {
                                  const excess = overtimeExcessPay(p, otSettings);
                                  if (excess > 0) return <span className="font-medium text-amber-700">{yen(excess)}</span>;
                                  return <span className="text-xs text-muted-foreground">—</span>;
                                })()}
                              </td>
                              <td className="px-3 py-2 text-right">{s && s.special_bonus > 0 ? yen(s.special_bonus) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right">
                                {p.role_type !== "社員"
                                  ? <span className="text-xs text-muted-foreground">—</span>
                                  : !s || s.care_overtime_threshold_hours <= 0
                                    ? <span className="text-xs text-muted-foreground">未設定</span>
                                    : cop > 0
                                      ? <span className="font-medium text-orange-700">{yen(cop)}</span>
                                      : <span className="text-xs text-muted-foreground">0円</span>}
                              </td>
                              <td className="px-3 py-2 text-right">{travelFeeAmount(p) > 0 ? yen(travelFeeAmount(p)) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right">{commuteFeeAmount(p) > 0 ? yen(commuteFeeAmount(p)) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right">{p.childcare_allowance > 0 ? yen(p.childcare_allowance) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right font-bold">{yen(total)}</td>
                              <td className="px-3 py-2 text-center text-muted-foreground text-xs">
                                {isExpanded ? "▲" : "▼"}
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr key={`${p.employee_id}-d`} className="bg-muted/10">
                                <td colSpan={30} className="px-8 py-4">
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
                                          <DetailLine label="残業代" v={computeOvertimePay(p, otSettings)} />
                                          <DetailLine label="特別報奨金" v={s.special_bonus} />
                                          {p.bonus_paid && s.bonus_amount > 0 && <DetailLine label="報奨金" v={s.bonus_amount} />}
                                          {travelFeeAmount(p) > 0 && <DetailLine label={`移動費(${effectiveTravelKm(p)}km)`} v={travelFeeAmount(p)} />}
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
                                            placeholder={p.travel_km_auto > 0 ? String(p.travel_km_auto) : "0"}
                                            onChange={(e) => updateMonthly(p.employee_id, { travel_km: parseFloat(e.target.value) || 0 })}
                                            className="w-24 text-right h-7 px-2"
                                          />
                                          <span className="text-muted-foreground">km</span>
                                          {p.travel_km_auto > 0 && p.travel_km === 0 && (
                                            <span className="text-xs text-muted-foreground">(自動: {p.travel_km_auto}km)</span>
                                          )}
                                          {travelFeeAmount(p) > 0 && <span className="text-muted-foreground">= {yen(travelFeeAmount(p))}</span>}
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
                      <tr className="bg-muted/30 font-bold border-t-2">
                        <td className="px-3 py-2 sticky left-0 z-10 bg-muted/30">合計</td>
                        <td></td>
                        <td className="px-3 py-2 text-right">{monthlyResults.reduce((s, p) => s + p.summary.workDays, 0)}</td>
                        <td className="px-3 py-2 text-right">{monthlyResults.reduce((s, p) => s + p.summary.helperDays, 0) || "—"}</td>
                        <td className="px-3 py-2 text-right">{monthlyResults.reduce((s, p) => s + p.summary.paidLeave, 0) || "—"}</td>
                        <td className="px-3 py-2 text-right">{monthlyResults.reduce((s, p) => s + p.summary.halfLeave, 0) || "—"}</td>
                        <td className="px-3 py-2 text-right">{monthlyResults.reduce((s, p) => s + p.summary.specialLeave, 0) || "—"}</td>
                        <td className="px-3 py-2 text-right">{formatWorkHours(monthlyResults.reduce((s, p) => s + p.summary.workHoursMin, 0))}</td>
                        <td className="px-3 py-2 text-right">{monthlyResults.reduce((s, p) => s + p.summary.recordCount, 0) || "—"}</td>
                        <td className="px-3 py-2 text-right">{monthlyResults.reduce((s, p) => s + p.summary.accompaniedCount, 0) || "—"}</td>
                        <td className="px-3 py-2 text-right">{formatMinutes(monthlyResults.reduce((s, p) => s + p.summary.visitMinutes, 0))}</td>
                        <td className="px-3 py-2 text-right">{monthlyResults.reduce((s, p) => s + p.summary.hrdCount, 0) || "—"}</td>
                        <td className="px-3 py-2 text-right">{monthlyResults.reduce((s, p) => s + effectiveTravelKm(p), 0) > 0 ? `${formatKm(monthlyResults.reduce((s, p) => s + effectiveTravelKm(p), 0))}km` : "—"}</td>
                        <td className="px-3 py-2 text-right">{monthlyResults.reduce((s, p) => s + p.summary.commuteKmTotal, 0) > 0 ? `${formatKm(monthlyResults.reduce((s, p) => s + p.summary.commuteKmTotal, 0))}km` : "—"}</td>
                        <td className="px-3 py-2 text-right">{yen(monthlyResults.reduce((s, p) => s + (p.settings?.base_personal_salary ?? 0), 0))}</td>
                        <td className="px-3 py-2 text-right">{yen(monthlyResults.reduce((s, p) => s + (p.settings?.skill_salary ?? 0), 0))}</td>
                        <td className="px-3 py-2 text-right">{yen(monthlyResults.reduce((s, p) => s + (p.settings?.position_allowance ?? 0), 0))}</td>
                        <td className="px-3 py-2 text-right">{yen(monthlyResults.reduce((s, p) => s + (p.settings?.qualification_allowance ?? 0), 0))}</td>
                        <td className="px-3 py-2 text-right">{yen(monthlyResults.reduce((s, p) => s + (p.settings?.tenure_allowance ?? 0), 0))}</td>
                        <td className="px-3 py-2 text-right">{yen(monthlyResults.reduce((s, p) => s + (p.settings?.treatment_improvement ?? 0), 0))}</td>
                        <td className="px-3 py-2 text-right">{yen(monthlyResults.reduce((s, p) => s + (p.settings?.specific_treatment_improvement ?? 0), 0))}</td>
                        <td className="px-3 py-2 text-right">{yen(monthlyResults.reduce((s, p) => s + (p.settings?.treatment_subsidy ?? 0), 0))}</td>
                        <td className="px-3 py-2 text-right">{yen(monthlyResults.reduce((s, p) => s + (p.settings?.fixed_overtime_pay ?? 0), 0))}</td>
                        <td className="px-3 py-2 text-right">{yen(monthlyResults.reduce((s, p) => s + computeOvertimePay(p, otSettings), 0))}</td>
                        <td className="px-3 py-2 text-right">{yen(monthlyResults.reduce((s, p) => s + overtimeExcessPay(p, otSettings), 0))}</td>
                        <td className="px-3 py-2 text-right">{yen(monthlyResults.reduce((s, p) => s + (p.settings?.special_bonus ?? 0), 0))}</td>
                        <td className="px-3 py-2 text-right">{yen(monthlyResults.reduce((s, p) => s + careOvertimePay(p), 0))}</td>
                        <td className="px-3 py-2 text-right">{yen(monthlyResults.reduce((s, p) => s + travelFeeAmount(p), 0))}</td>
                        <td className="px-3 py-2 text-right">{yen(monthlyResults.reduce((s, p) => s + commuteFeeAmount(p), 0))}</td>
                        <td className="px-3 py-2 text-right">{yen(monthlyResults.reduce((s, p) => s + p.childcare_allowance, 0))}</td>
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
