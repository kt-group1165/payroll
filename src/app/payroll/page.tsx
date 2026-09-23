"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { OFFICE_MASTER_JOIN, flattenOfficeMaster } from "@/types/database";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { calcDayRoute, collectAddressPairs, secToHm } from "@/lib/distance-calculator";
import type { VisitForRoute } from "@/lib/distance-calculator";
import { KyotakuPayrollDashboard } from "@/components/payroll/kyotaku-payroll-dashboard";
import { buildActiveSalaryMap, selectedMonthToMonthStart, resolveEmploymentType, resolvePaidLeaveUnitPriceFromHistory } from "@/lib/payroll/salary-history";
import { isCareHours075 } from "@/lib/payroll/care-hours-075";
import { bathVisitCareMinutes, BONUS_PAID_KEY } from "@/lib/payroll/monthly-inputs";
import Link from "next/link";
import { getWeekendHolidayRates, getCareOvertimeLowerTiers, getMeetingFeeUnpaidOffices, getVisitAttendanceScreenOffices, getKmAnomalyLines, getCare075Offices, getJuhoShortVisitRates, getMeetingCountItems, getSougouSeikatsuRates, getDoukouEngoFlatRates, getOvertimeExcessPaidEmployees, getOvertimeOffsetFullCareOffices, getMonthlyTenureManualBase, getUseLegacyData, getOfficeWorkerCarePay } from "@/lib/app-settings";
import { findKmAnomalies, DEFAULT_KM_LINE, type KmAnomaly } from "@/lib/payroll/km-anomaly";
import { screenAttendanceToVisitRecords, type ScreenAttendanceRow } from "@/lib/payroll/visit-attendance-adapter";
import { extendedMonthRange } from "@/lib/payroll/attendance-calc";
import {
  computeTenureAllowance,
  computeTenureRate,
  resolveTenureAllowance,
  careOvertimePay,
  yochoAllowance,
  computeOvertimePay,
  effectiveTravelKm,
  travelFeeAmount,
  commuteFeeAmount,
  overtimeExcessPay,
  monthlyGrandTotal,
  hourlyTenure,
  hourlyTotalPay,
  weekendHolidayAllowanceAmount,
  DEFAULT_WEEKEND_HOLIDAY_RATE,
  weekendAllowanceMinutes,
  travelAllowanceAmount,
  adjustedCommuteDistanceM,
  normalizeYM,
  computeChildcareAllowance,
  computeMeetingFee,
  meetingMinutes,
  treatmentSubsidyAmount,
  cancelAllowanceFromCodes,
  communicationFeeAmount,
  hourlyCommuteFeeAmount,
  hourlyBusinessTripFeeAmount,
  visitPayAmount,
  yochoHoursFromRecords,
  paidLeaveDays,
  trainingMinutes,
  hourlyOvertimeMinutes,
  payMinutesOf,
  trainingMinutesByDay,
  legalWithinOvertimeMinutes,
  monthlyPaidLeaveAllowance,
  absenceDeduction,
  hourlyOvertimePayAmount,
  shoninshaTrainingMinutes,
  trainingPayAmount,
  TRAINING_RATE_PER_HOUR,
  careMinutesFromRecords,
  officeWorkPayAmount,
  employeeWorkMinutes,
  tenureMonthsForStep,
  manualTenureWithSteps,
  tokubiAllowanceAmount,
  isSpecialDay,
  allTrainingMinutes,
  parseDurationMinutes,
  midMonthWorkDays,
  hrdTrainingMinutes,
  shinyaHoursFromRecords,
  listedDateCount,
  activePaidLeaveGrant,
  paidLeaveAllowanceByGrant,
  officeFormPaidLeaveDays,
  type PaidLeaveGrant,
  prorateMonthlyFixed,
  computeSummary,
  type OvertimeSetting,
  type SalarySettings,
  type AttendanceSummary,
  type HourlyPayroll,
  type MonthlyPayroll,
  type VisitServiceRecord,
  type OfficeAttendanceRecord,
  type OfficeFormRecord,
} from "@/lib/payroll/payroll-calc";

// ─── 実勤続月数の基準月 ─────────────────────────────────────
// effective_service_months の初期データが何月時点の値かを設定する
// 初期データを入れ直す場合はここを変更する
const TENURE_BASE_YEAR  = 2026;
const TENURE_BASE_MONTH = 3;

// ─── 型定義 ──────────────────────────────────────────────────
// JAPAN_HOLIDAYS / isWeekendOrHoliday は src/lib/payroll/payroll-calc.ts からimport
// (2026-09-05 切り出し)。ServiceRecord/AttendanceRecord は同ファイルの
// VisitServiceRecord/OfficeAttendanceRecord の型エイリアス (既存の呼び出し箇所を変えないため)。

type ServiceRecord = VisitServiceRecord;
type AttendanceRecord = OfficeAttendanceRecord;

// OfficeFormRecord は src/lib/payroll/payroll-calc.ts からimport (2026-09-05 切り出し)

type ServiceTypeMapping = { service_code: string; category_id: string };
type CategoryHourlyRate  = { category_id: string; office_id: string; hourly_rate: number; effective_from?: string | null };
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
  care_qualification_from?: string | null;
  job_type: string;
  effective_service_months: number;
  office_id: string;
  social_insurance: boolean;
  paid_leave_unit_price: number;
  communication_fee_type: string;
  communication_fee_from: string | null;
  /** 事務員。事務時間 (= 出勤簿の出勤時間) × 事務時給 を本人給に足す */
  is_office_worker: boolean;
  /** Supabase Auth ユーザーID。兼務職員は同じ auth_user_id の複数行が存在し得る */
  auth_user_id: string | null;
};

// 勤怠サマリー（職員ごと）
// 時給者
// 月給者
// ─── ユーティリティ ──────────────────────────────────────────

// normalizeYM / parseDurationMinutes / parseWorkHoursMinutes / extractDay は
// src/lib/payroll/payroll-calc.ts からimport (2026-09-05 切り出し)

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

// ─── メインコンポーネント ─────────────────────────────────────

export default function PayrollPage() {
  const [months, setMonths] = useState<string[]>([]);
  const [selectedMonth, setSelectedMonth] = useState("");
  const [offices, setOffices] = useState<Office[]>([]);
  const [selectedOfficeId, setSelectedOfficeId] = useState("");
  const [selectedOfficeType, setSelectedOfficeType] = useState<string>("訪問介護");
  const [tab, setTab] = useState<"hourly" | "monthly">("monthly");
  const [loading, setLoading] = useState(false);
  /** 計算中の進捗 (0〜100)。移動距離の取得が一番長いので 40〜90% をそこに割り当てる */
  const [progress, setProgress] = useState<{ pct: number; label: string } | null>(null);
  /** 直近の計算結果を DB に保存した時刻 (次の計算を始めるまで表示しておく) */
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState("");
  /** 移動距離・時間が取れなかったとき (Google の月間上限・エラー) の警告。移動手当・出張費が少なく出ている */
  const [distanceWarning, setDistanceWarning] = useState("");
  // 通勤km・出張km が事業所の確認ラインを超えた職員 (km-anomaly.ts)
  const [kmWarnings, setKmWarnings] = useState<KmAnomaly[]>([]);

  const [hourlyResults, setHourlyResults] = useState<HourlyPayroll[]>([]);
  const [expandedEmp, setExpandedEmp] = useState<string | null>(null);

  const [monthlyResults, setMonthlyResults] = useState<MonthlyPayroll[]>([]);
  const [expandedMonthly, setExpandedMonthly] = useState<string | null>(null);
  const [otSettings, setOtSettings] = useState<Map<string, OvertimeSetting>>(new Map());

  useEffect(() => {
    // service_records実データのある月を import_batches 経由で取得（高速）
    // kaigo_meisai = kaigo-app 直接モードの snapshot 取込 (格納先は同じ payroll_service_records)
    supabase
      .from("payroll_import_batches")
      .select("processing_month,record_count,import_type,status")
      .in("import_type", ["meisai", "kaigo_meisai"])
      .eq("status", "completed")
      .gt("record_count", 0)
      .order("processing_month", { ascending: false })
      .then(({ data }) => {
        if (!data) return;
        const unique = [...new Set((data as { processing_month: string }[]).map((r) => r.processing_month))];
        setMonths(unique);
        if (unique.length > 0) setSelectedMonth(unique[0]);
      });
    supabase.from("payroll_offices").select(`id,office_number,short_name,office_type,travel_unit_price,commute_unit_price,treatment_subsidy_amount,cancel_unit_price,travel_allowance_rate,meeting_unit_price, ${OFFICE_MASTER_JOIN}`).then(({ data }) => {
      if (!data) return;
      const flattened = flattenOfficeMaster(data as never) as unknown as Office[];
      flattened.sort((a, b) => a.name.localeCompare(b.name, "ja"));
      setOffices(flattened);
      // 訪問介護の最初の事業所を初期選択
      const firstVisitCare = flattened.find((o) => o.office_type === "訪問介護");
      if (firstVisitCare) setSelectedOfficeId(firstVisitCare.id);
      else if (flattened.length > 0) setSelectedOfficeId(flattened[0].id);
    });
  }, []);

  // ─── 給与計算実行 ─────────────────────────────────────────────

  async function calculate() {
    if (!selectedMonth || !selectedOfficeId) return;
    setLoading(true); setError(""); setDistanceWarning(""); setKmWarnings([]);
    setProgress({ pct: 0, label: "実績データを読み込み中" });
    setSavedAt(null);
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
          const { data, error } = await supabase
            .from("payroll_service_records")
            .select("id,employee_number,employee_name,service_date,calc_duration,service_code,office_number,accompanied_visit,client_number,dispatch_start_time,dispatch_end_time,time_period,holiday_type")
            .eq("processing_month", selectedMonth)
            .eq("office_number", selectedOffice.office_number)
            .order("id")
            .range(from, from + pageSize - 1);
          // 読み込みエラーを「データの終わり」と扱わない (2026-09-19: 同時計算で実績が途中で切れ、本人給が半分になった)
          if (error) throw new Error(`データの読み込みに失敗しました (もう一度計算してください): ${error.message}`);
          if (!data || data.length === 0) break;
          allServiceRecords.push(...(data as ServiceRecord[]));
          setProgress({ pct: Math.min(14, 2 + Math.floor(allServiceRecords.length / 1000) * 2), label: `実績データを読み込み中 (${allServiceRecords.length.toLocaleString()}件)` });
          if (data.length < pageSize) break;
          from += pageSize;
        }
      }

      // salary_settingsは将来1000件を超え得るためページング取得
      const fetchAllSalarySettings = async (): Promise<{ data: SalarySettings[] }> => {
        const all: SalarySettings[] = [];
        let sFrom = 0;
        while (true) {
          const { data, error } = await supabase
            .from("payroll_salary_settings").select("*").range(sFrom, sFrom + 999);
          // 読み込みエラーを「データの終わり」と扱わない (2026-09-19: 同時計算で実績が途中で切れ、本人給が半分になった)
          if (error) throw new Error(`データの読み込みに失敗しました (もう一度計算してください): ${error.message}`);
          if (!data || data.length === 0) break;
          all.push(...(data as SalarySettings[]));
          if (data.length < 1000) break;
          sFrom += 1000;
        }
        return { data: all };
      };

      // attendance_records は 1事業所×1ヶ月でも 1000 行を超え得るため paginate
      const fetchAllAttendance = async (): Promise<{ data: AttendanceRecord[] }> => {
        const all: AttendanceRecord[] = [];
        let aFrom = 0;
        while (true) {
          const { data, error } = await supabase.from("payroll_attendance_records")
            .select("employee_number,employee_name,day,work_note_1,work_note_2,work_note_3,work_note_4,work_note_5,start_time_1,end_time_1,start_time_2,end_time_2,start_time_3,end_time_3,start_time_4,end_time_4,start_time_5,end_time_5,break_time,work_hours,overtime_daily,overtime_weekly,commute_km,business_km")
            .eq("year", year).eq("month", month)
            .eq("office_number", selectedOffice.office_number)
            .order("id").range(aFrom, aFrom + 999);
          // 読み込みエラーを「データの終わり」と扱わない (2026-09-19: 同時計算で実績が途中で切れ、本人給が半分になった)
          if (error) throw new Error(`データの読み込みに失敗しました (もう一度計算してください): ${error.message}`);
          if (!data || data.length === 0) break;
          all.push(...(data as AttendanceRecord[]));
          if (data.length < 1000) break;
          aFrom += 1000;
        }
        return { data: all };
      };

      setProgress({ pct: 15, label: "職員・給与設定・出勤簿を読み込み中" });
      const [mappingRes, catRes, officeRes, rateRes, empRes, salRes, attRes, otRes, weekendRatesRes, careTiersRes, meetingUnpaidRes] = await Promise.all([
        supabase.from("payroll_service_type_mappings").select("service_code,category_id"),
        supabase.from("payroll_service_categories").select("id,name"),
        supabase.from("payroll_offices").select(`id,office_number,short_name,office_type,travel_unit_price,commute_unit_price,treatment_subsidy_amount,cancel_unit_price,travel_allowance_rate,communication_fee_amount,meeting_unit_price,distance_adjustment_rate, ${OFFICE_MASTER_JOIN}`),
        supabase.from("payroll_category_hourly_rates").select("category_id,office_id,hourly_rate,effective_from"),
        supabase.from("payroll_employees").select("id,employee_number,name,address,role_type,salary_type,employment_status,has_care_qualification,care_qualification_from,job_type,effective_service_months,office_id,social_insurance,paid_leave_unit_price,communication_fee_type,communication_fee_from,auth_user_id,is_office_worker,resignation_date").eq("office_id", selectedOfficeId)
          // 退職者でも 退職日が計算月の初日以降なら その月は在籍していたので含める (2026-09-17)
          .or(`employment_status.neq.退職者,resignation_date.gte.${year}-${String(month).padStart(2, "0")}-01`),
        fetchAllSalarySettings(),
        fetchAllAttendance(),
        supabase.from("payroll_overtime_settings").select("*"),
        getWeekendHolidayRates(supabase),
        getCareOvertimeLowerTiers(supabase),
        getMeetingFeeUnpaidOffices(supabase),
      ]);
      // 基本のデータの読み込みエラーを見逃さない (2026-09-19: 同時計算で読み込みが失敗し、時給・実績が欠けたまま計算していた)
      for (const [label, r] of [["サービス区分の対応", mappingRes], ["サービス区分", catRes], ["事業所", officeRes], ["区分の時給", rateRes], ["職員", empRes]] as const) {
        const err = (r as { error?: { message: string } | null }).error;
        if (err) throw new Error(`${label}の読み込みに失敗しました (もう一度計算してください): ${err.message}`);
      }
      for (const [label, r] of [["出勤簿", attRes], ["残業の設定", otRes]] as const) {
        const err = (r as { error?: { message: string } | null }).error;
        if (err) throw new Error(`${label}の読み込みに失敗しました (もう一度計算してください): ${err.message}`);
      }
      if (careTiersRes.error) throw new Error(`介護超過の段の設定の読み込みに失敗: ${careTiersRes.error}`);
      if (weekendRatesRes.error) throw new Error(`土日祝手当の時給設定の読み込みに失敗: ${weekendRatesRes.error}`);
      if (meetingUnpaidRes.error) throw new Error(`会議費を払わない事業所の設定の読み込みに失敗: ${meetingUnpaidRes.error}`);
      const weekendRates = weekendRatesRes.rates;

      // office_form_records は1000件上限を回避するためページネーション
      const allOfRecords: OfficeFormRecord[] = [];
      {
        const pageSize = 1000;
        let from = 0;
        while (true) {
          const { data, error } = await supabase
            .from("payroll_office_form_records")
            .select("id,employee_number,record_type,item_name,item_date,numeric_value,start_time,end_time,break_time,year_month,child_name,amount")
            .eq("processing_month", selectedMonth)
            .eq("office_number", selectedOffice.office_number)
            .order("id")
            .range(from, from + pageSize - 1);
          // 読み込みエラーを「データの終わり」と扱わない (2026-09-19: 同時計算で実績が途中で切れ、本人給が半分になった)
          if (error) throw new Error(`データの読み込みに失敗しました (もう一度計算してください): ${error.message}`);
          if (!data || data.length === 0) break;
          allOfRecords.push(...(data as OfficeFormRecord[]));
          if (data.length < pageSize) break;
          from += pageSize;
        }
      }

      setProgress({ pct: 30, label: "時給者を計算中" });
      const records    = allServiceRecords;
      const mappingMap = new Map((mappingRes.data ?? []).map((m: ServiceTypeMapping) => [m.service_code, m.category_id]));
      const categoryMap= new Map((catRes.data ?? []).map((c: ServiceCategory) => [c.id, c.name]));
      const officeRows        = flattenOfficeMaster(officeRes.data as never) as unknown as Office[];
      const officeMap         = new Map(officeRows.map((o: Office) => [o.office_number, o.id]));
      const officeByIdMap     = new Map(officeRows.map((o: Office) => [o.id, o]));
      const employeesRaw = (empRes.data ?? []) as Employee[];
      // 履歴化方式: 対象月 (selectedMonth = YYYYMM) で active な salary row を選ぶ。
      // effective_from <= 対象月 のうち最新を per-employee で 1 row 抽出。
      // 履歴がまだ無い employee は default '1970-01-01' の backfill row が当たる。
      const _monthStart = selectedMonthToMonthStart(selectedMonth);
      // 時給 (事業所 × 類型) は履歴で持つ (2026-09-22)。対象月の月初以前で最新の行を使う
      const rateMap = new Map<string, number>();
      {
        const fromOf = new Map<string, string>();
        for (const r of (rateRes.data ?? []) as CategoryHourlyRate[]) {
          const from = r.effective_from ?? "2000-01-01";
          if (from > _monthStart) continue;
          const k = `${r.office_id}:${r.category_id}`;
          if ((fromOf.get(k) ?? "") <= from) { fromOf.set(k, from); rateMap.set(k, r.hourly_rate); }
        }
      }
      const salMap     = buildActiveSalaryMap<SalarySettings>(
        (salRes.data ?? []) as SalarySettings[],
        _monthStart,
      );
      // 給与形態・役職は その月で有効な給与設定の行から決める (無ければ職員マスタ)。
      // 月の途中で時給 ↔ 月給が切り替わった人の過去月を、その月の形態で計算するため (2026-09-18)
      const employees = employeesRaw.map((e) => ({ ...e, ...resolveEmploymentType(e, salMap.get(e.id)),
        // 通信費タイプも その月の給与設定の行にあればそれ (その月から有効なので 職員マスタの開始日は見ない) (2026-09-22)
        ...(salMap.get(e.id)?.communication_fee_type
          ? { communication_fee_type: salMap.get(e.id)!.communication_fee_type!, communication_fee_from: null } : {}),
        // 有給単価 (円/日) も その月の給与設定の行 → 無ければ職員マスタ (2026-09-18)
        paid_leave_unit_price: resolvePaidLeaveUnitPriceFromHistory(e, (salRes.data ?? []) as SalarySettings[], _monthStart) }));
      // 出勤簿: 「画面入力を使う」事業所は kaigo-app の出勤簿 (payroll_kyotaku_attendance_records) から、
      // それ以外は今までどおり Excel 出勤簿の CSV 取込 (payroll_attendance_records) から読む (2026-09-18)
      let attRecords = (attRes.data ?? []) as AttendanceRecord[];
      const meetingItemsRes = await getMeetingCountItems(supabase);
      if (meetingItemsRes.error) throw new Error(`会議費の件数の項目の読み込みに失敗: ${meetingItemsRes.error}`);
      const doukouFlatRes = await getDoukouEngoFlatRates(supabase);
      if (doukouFlatRes.error) throw new Error(`同行援護の時給の読み込みに失敗: ${doukouFlatRes.error}`);
      const sougouRatesRes = await getSougouSeikatsuRates(supabase);
      if (sougouRatesRes.error) throw new Error(`総合事業の時給の読み込みに失敗: ${sougouRatesRes.error}`);
      const juhoShortRes = await getJuhoShortVisitRates(supabase);
      if (juhoShortRes.error) throw new Error(`重度訪問の短時間の時給の読み込みに失敗: ${juhoShortRes.error}`);
      const care075Res = await getCare075Offices(supabase);
      const tenureBaseRes = await getMonthlyTenureManualBase(supabase);
      // 旧システムのデータ (移動の日計・日別の出勤時間) を使うか。切り替えるまでは使う (user 2026-09-22)
      const useLegacyRes = await getUseLegacyData(supabase);
      const officeWorkerCareRes = await getOfficeWorkerCarePay(supabase);
      if (officeWorkerCareRes.error) throw new Error(`事務員の介護分の設定の読み込みに失敗: ${officeWorkerCareRes.error}`);
      if (useLegacyRes.error) throw new Error(`旧システムのデータを使うかの設定の読み込みに失敗: ${useLegacyRes.error}`);
      if (tenureBaseRes.error) throw new Error(`勤続手当の基準の月の設定の読み込みに失敗: ${tenureBaseRes.error}`);
      if (care075Res.error) throw new Error(`介護超過の 0.75 掛けの設定の読み込みに失敗: ${care075Res.error}`);
      // 特日 (会社休日: お盆・年末年始)。特日手当を払い、その日は土日祝手当の対象から外す (総括表 2026-08、2026-09-22)
      const specialDays = new Set<string>();
      {
        const ym = `${selectedMonth.slice(0, 4)}-${selectedMonth.slice(4, 6)}`;
        const next = new Date(Date.UTC(+selectedMonth.slice(0, 4), +selectedMonth.slice(4, 6), 1)).toISOString().slice(0, 10);
        const { data, error } = await supabase.from("payroll_company_holidays").select("holiday_date").gte("holiday_date", `${ym}-01`).lt("holiday_date", next);
        if (error) throw new Error(`会社休日 (特日) の読み込みに失敗: ${error.message}`);
        for (const r of (data ?? []) as { holiday_date: string }[]) specialDays.add(String(r.holiday_date).replace(/\D/g, ""));
      }
      const screenOfficesRes = await getVisitAttendanceScreenOffices(supabase);
      if (screenOfficesRes.error) throw new Error(`出勤簿の入力元の設定の読み込みに失敗: ${screenOfficesRes.error}`);
      if (screenOfficesRes.offices.has(selectedOffice.office_number)) {
        const ym = `${year}-${String(month).padStart(2, "0")}`;
        const { data: wk, error: wkErr } = await supabase.from("payroll_offices").select("work_week_start").eq("id", selectedOfficeId).maybeSingle();
        if (wkErr) throw new Error(`週の起算曜日の読み込みに失敗: ${wkErr.message}`);
        const weekStart = (wk?.work_week_start as number | null) ?? 0;
        const { start, end } = extendedMonthRange(ym, weekStart);
        const screenRows: ScreenAttendanceRow[] = [];
        for (let from = 0; ; from += 1000) {
          const { data, error } = await supabase.from("payroll_kyotaku_attendance_records").select("*")
            .eq("office_id", selectedOfficeId).gte("work_date", start).lte("work_date", end)
            .order("id").range(from, from + 999);
          if (error) throw new Error(`画面入力の出勤簿の読み込みに失敗: ${error.message}`);
          screenRows.push(...((data ?? []) as ScreenAttendanceRow[]));
          if (!data || data.length < 1000) break;
        }
        attRecords = screenAttendanceToVisitRecords(
          screenRows,
          new Map(employeesRaw.map((e) => [e.id, { employee_number: e.employee_number, name: e.name }])),
          ym, weekStart,
        ) as unknown as AttendanceRecord[];
      }
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

      // ── 勤続月数: 基準月より後は 稼働 (実績 or 出勤簿の出勤) のあった月だけ足す (2026-09-19 user「稼働がないと月数が増えない」) ──
      //   総括表 2026-03〜07 で 当方が高く出ていた人 (山武 石坂 5年以上/総括表 5年未満、ちはら台 戸谷・東郷 長谷川・おゆみ野 熊谷 1年以上/総括表 1年未満)
      //   基準月より後に 記録が 1 件も無い人 (出勤簿が見つからない人など) は 判断できないので 従来どおり全月を足す
      const workedMonthsAfterBase = new Map<string, number>();
      {
        const months: string[] = [];
        for (let ym = TENURE_BASE_YEAR * 12 + TENURE_BASE_MONTH; ym < year * 12 + month; ym++) {
          const y = Math.floor(ym / 12), m = ym % 12 + 1; // ym+1 を表す (基準月の翌月から)
          months.push(`${y}${String(m).padStart(2, "0")}`);
        }
        const add = (num: string, ymKey: string, seen: Map<string, Set<string>>) => {
          if (!seen.has(num)) seen.set(num, new Set());
          seen.get(num)!.add(ymKey);
        };
        const seen = new Map<string, Set<string>>();
        for (const ym of months) {
          if (ym === selectedMonth) {
            for (const [num, rs] of recsByEmp) if (rs.length > 0) add(num, ym, seen);
            for (const [num, as] of attByEmp) if (as.some((a) => String(a.start_time_1 ?? "").trim())) add(num, ym, seen);
            continue;
          }
          for (let from = 0; ; from += 1000) {
            const { data, error } = await supabase.from("payroll_service_records").select("employee_number")
              .eq("processing_month", ym).eq("office_number", selectedOffice.office_number).order("id").range(from, from + 999);
            if (error) throw new Error(`勤続月数用の実績の読み込みに失敗しました (もう一度計算してください): ${error.message}`);
            for (const r of (data ?? []) as { employee_number: string }[]) add(normEmp(r.employee_number), ym, seen);
            if (!data || data.length < 1000) break;
          }
          for (let from = 0; ; from += 1000) {
            const { data, error } = await supabase.from("payroll_attendance_records").select("employee_number,start_time_1")
              .eq("year", Number(ym.slice(0, 4))).eq("month", Number(ym.slice(4))).eq("office_number", selectedOffice.office_number)
              .neq("start_time_1", "").order("id").range(from, from + 999);
            if (error) throw new Error(`勤続月数用の出勤簿の読み込みに失敗しました (もう一度計算してください): ${error.message}`);
            for (const r of (data ?? []) as { employee_number: string }[]) add(normEmp(r.employee_number), ym, seen);
            if (!data || data.length < 1000) break;
          }
        }
        for (const [num, set] of seen) workedMonthsAfterBase.set(num, set.size);
      }
      // 勤続手当の資格要件: care_qualification_from があれば その日が処理月の末日以前のときだけ (途中で資格を取った人。2026-09-19)
      const monthEndIso = `${year}-${String(month).padStart(2, "0")}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;
      const qualifiedInMonth = (e: { has_care_qualification?: boolean | null; care_qualification_from?: string | null }) =>
        (e.has_care_qualification ?? false) && (!e.care_qualification_from || e.care_qualification_from <= monthEndIso);
      // ── 勤続月数の基準値: 旧システムの従業員データ (payroll_legacy_employee) を最優先する ──
      //   旧システムは「グループ勤続年数」を **月数** で持っていて、出力時点 (tenure_as_of) の値。
      //   総括表 2026-03〜07 のパート 575 人月で検算:
      //     グループ 563 一致 (97.9%) / 会社 562 (97.7%) / 事業所 557 (96.9%) / 入社日からの暦月 86.6%
      //   ⚠ 入社年月日は「その事業所に来た日」で転籍前が入っていないため使えない
      //     (東郷 細谷靖子 入社2015/12 → 暦月129ヶ月 だが グループ勤続 95ヶ月)
      //   ⚠ 社員No は事業所をまたぐと重複するので 所属名 と対で引く
      const legacyTenureMonths = new Map<string, number>();
      // 入社日 (月給の勤続手当の節目判定。tenureMonthsForStep)
      const legacyHireDate = new Map<string, string>();
      // 節目判定用の月数 = グループ勤続 と 会社勤続 の長い方 (KT姉崎 佐々木 2026-05: 会社 252 か月で 21 年目 / グループ 237。
      //   総括表 2026-03〜08 月給 1,004 人月: 入社日との長い方で グループのみ 902 → 会社も入れて 916)。時給者の勤続手当は グループのまま
      const legacyStepMonths = new Map<string, number>();
      {
        const normName = (x: string) => x.normalize("NFKC").replace(/[\s　]/g, "");
        const target = normName(selectedOffice.name ?? "");
        // ⚠ 1,656 行あるので必ずページングする。以前は 1 回の select で 先頭 1,000 行しか読めておらず、
        //   残りの人は 勤続月数・入社日が引けないまま 従来の月数で計算されていた (2026-09-22 判明)
        const data: { office_name: string; employee_number: string; group_tenure_months: number | null; company_tenure_months: number | null; tenure_as_of: string; hire_date: string | null }[] = [];
        let error: { message: string } | null = null;
        for (let from = 0; ; from += 1000) {
          const res = await supabase
            .from("payroll_legacy_employee")
            .select("office_name,employee_number,group_tenure_months,company_tenure_months,tenure_as_of,hire_date")
            .order("id").range(from, from + 999);
          if (res.error) { error = res.error; break; }
          data.push(...((res.data ?? []) as typeof data));
          if ((res.data ?? []).length < 1000) break;
        }
        if (error) console.warn("[payroll] 旧システムの従業員データを読めませんでした (従来の勤続月数で計算します):", error.message);
        for (const r of data) {
          if (r.group_tenure_months == null || normName(r.office_name) !== target) continue;
          if (r.hire_date) legacyHireDate.set(normEmp(r.employee_number), r.hire_date);
          const asOf = Number(r.tenure_as_of.slice(0, 4)) * 12 + Number(r.tenure_as_of.slice(4, 6));
          legacyTenureMonths.set(normEmp(r.employee_number), Math.max(0, r.group_tenure_months - (asOf - (year * 12 + month))));
          legacyStepMonths.set(normEmp(r.employee_number), Math.max(0, Math.max(r.group_tenure_months, r.company_tenure_months ?? 0) - (asOf - (year * 12 + month))));
        }
      }
      const tenureMonthsOf = (e: { employee_number: string | number; effective_service_months?: number | null }) => {
        const legacy = legacyTenureMonths.get(normEmp(e.employee_number));
        if (legacy !== undefined) return legacy;
        const worked = workedMonthsAfterBase.get(normEmp(e.employee_number));
        return worked === undefined ? adjustedMonths(e.effective_service_months ?? 0) : Math.max(0, (e.effective_service_months ?? 0) + worked);
      };

      // ── 月の途中で 時給 ↔ 月給 が切り替わる人 (2026-09-18 user ルール) ──
      // 給与設定の適用開始日を月の途中の日付 (例 2026-03-20) にすると、その月は
      //   その日より前 = 切替前の形態 / その日以降 = 切替後の形態 で、実績・出勤簿を分けて 2 行で計算する。
      //   月給の側は 勤務した日数で固定給を日割り (prorateMonthlyFixed)。総括表も 両方のシートに載せている
      const _monthEndDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const _monthEnd = `${selectedMonth.slice(0, 4)}-${selectedMonth.slice(4, 6)}-${String(_monthEndDay).padStart(2, "0")}`;
      const _monthStartStr = selectedMonthToMonthStart(selectedMonth);
      type MidSwitch = { date: string; hourlyBefore: boolean; preRow: SalarySettings | null; postRow: SalarySettings };
      const switchByNum = new Map<string, MidSwitch>();
      for (const e of employeesRaw) {
        const mid = ((salRes.data ?? []) as SalarySettings[])
          .filter((r) => r.employee_id === e.id && r.effective_from > _monthStartStr && r.effective_from <= _monthEnd)
          .sort((a, b) => a.effective_from.localeCompare(b.effective_from))[0];
        if (!mid) continue;
        const preRow = salMap.get(e.id) ?? null;
        const pre = resolveEmploymentType(e, preRow).salary_type;
        const post = resolveEmploymentType(e, mid).salary_type;
        if (pre === post) continue;
        switchByNum.set(normEmp(e.employee_number), { date: mid.effective_from.slice(0, 10), hourlyBefore: pre === "時給", preRow, postRow: mid });
      }
      const ymdOf = (d: string) => d.replace(/\//g, "-").slice(0, 10);
      const attDateOf = (day: number) => `${selectedMonth.slice(0, 4)}-${selectedMonth.slice(4, 6)}-${String(day).padStart(2, "0")}`;
      /** 時給の側か (切替の無い人は常に true。月給者はそもそも時給のループに入らない) */
      const isHourlySide = (empNum: string, date: string): boolean => {
        const sw = switchByNum.get(empNum);
        if (!sw) return true;
        const before = date < sw.date;
        return sw.hourlyBefore ? before : !before;
      };
      const recsByEmpH = new Map(recsByEmp), recsByEmpM = new Map(recsByEmp);
      const attByEmpH = new Map(attByEmp), attByEmpM = new Map(attByEmp);
      for (const num of switchByNum.keys()) {
        const rs = recsByEmp.get(num) ?? [];
        recsByEmpH.set(num, rs.filter((r) => isHourlySide(num, ymdOf(r.service_date))));
        recsByEmpM.set(num, rs.filter((r) => !isHourlySide(num, ymdOf(r.service_date))));
        const as = attByEmp.get(num) ?? [];
        attByEmpH.set(num, as.filter((a) => isHourlySide(num, attDateOf(a.day))));
        attByEmpM.set(num, as.filter((a) => !isHourlySide(num, attDateOf(a.day))));
      }

      // 勤怠サマリー計算 (computeSummary) は
      // src/lib/payroll/payroll-calc.ts からimport (2026-09-05 切り出し)。
      // 呼出側で対象職員ぶんの出勤簿・事業所書式レコードを絞ってから渡す (verbatim移植)。
      // 同行はサービスコード (010001 等) で決まり、同行者欄が空のことがある (高品)。
      // 勤続手当・土日祝手当の「同行を除く訪問時間」から外すため、区分が 同行 の明細は同行扱いにする
      //   (総括表 高品 2026-04/06: 勤続手当の時間 = 訪問 − 同行コードの時間 で 5 件一致)
      const withAccompanyByCode = (recs: ServiceRecord[]): ServiceRecord[] =>
        recs.map((r) => {
          if (r.accompanied_visit && r.accompanied_visit.trim() !== "") return r;
          const catId = mappingMap.get(r.service_code) ?? null;
          return catId && categoryMap.get(catId) === "同行" ? { ...r, accompanied_visit: "同行" } : r;
        });
      // 事務員 (役職=事務員 か 事務時給で払う人) は 通勤km を事業所書式優先、それ以外は出勤簿優先 (user 2026-09-18)
      const officeWorkerNums = new Set(employees.filter((e) => e.role_type === "事務員" || e.is_office_worker).map((e) => normEmp(e.employee_number)));
      const computeSummaryOf = (empNum: string, empRecs: ServiceRecord[], att?: AttendanceRecord[]): AttendanceSummary =>
        computeSummary(withAccompanyByCode(empRecs), att ?? attByEmp.get(normEmp(empNum)) ?? [], ofByEmp.get(normEmp(empNum)) ?? [],
          officeWorkerNums.has(normEmp(empNum)) ? "office_form_first" : "attendance_first", specialDays, selectedMonth);

      // ── 保育手当：参照月ごとの実績時間を事前取得 ──────────────
      // childcareレコードの year_month が処理月と異なる場合、その月のサービス実績を取得する
      const childcareRecs = ofRecords.filter((r) => r.record_type === "childcare");
      // visitMinutesByEmpMonth: key = "empNum:YYYYMM", value = その月の訪問時間 (同行込み)
      const visitMinutesByEmpMonth = new Map<string, number>();
      // まず現在の処理月のデータをセット
      for (const emp of employees) {
        const normNum = normEmp(emp.employee_number);
        const empRecs = recsByEmp.get(normNum) ?? [];
        // 育児手当の按分は 同行も含めた訪問時間で (2026-09-19 総括表 7月: 松原 3,350→3,450 / 長谷川 869→931 で一致。悪化 0)
        const visitMin = empRecs.reduce((s, r) => s + parseDurationMinutes(r.calc_duration), 0);
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
          const { data: ymData, error: ymError } = await supabase
            .from("payroll_service_records")
            .select("employee_number,calc_duration,accompanied_visit")
            .eq("processing_month", ym)
            .eq("office_number", selectedOffice.office_number)
            .order("id")
            .range(ymFrom, ymFrom + 999);
          if (ymError) throw new Error(`育児手当の按分用の実績の読み込みに失敗しました (もう一度計算してください): ${ymError.message}`);
          if (!ymData || ymData.length === 0) break;
          for (const r of ymData as { employee_number: string; calc_duration: string; accompanied_visit: string }[]) {
            const k = normEmp(r.employee_number);
            if (!byEmpYm.has(k)) byEmpYm.set(k, 0);
            byEmpYm.set(k, (byEmpYm.get(k) ?? 0) + parseDurationMinutes(r.calc_duration));
          }
          if (ymData.length < 1000) break;
          ymFrom += 1000;
        }
        for (const [en, min] of byEmpYm) {
          visitMinutesByEmpMonth.set(`${en}:${ym}`, min);
        }
      }

      // computeChildcareAllowance / computeMeetingFee は
      // src/lib/payroll/payroll-calc.ts からimport (2026-09-05 切り出し)。
      // 呼出側で対象職員ぶんのフィルタ・lookupを済ませてから渡す (verbatim移植)。
      const childcareRecsOf = (empNum: string) =>
        childcareRecs.filter((r) => normEmp(r.employee_number) === empNum);

      // ── 旧システムの従業員契約情報 (payroll_legacy_contract。2026-09-21) ──
      // 給与のルールは職員ごとに違う。事業所単位の設定より優先する。
      //   育児手当支給限度額 20,000円49名 / 30,000円20名 / 40,000円2名 / 育児手当指定割合 40%が19名
      //   ⚠ 出張費単価も入っているが そちらは「今の値」でガソリン単価に連動して月ごとに変わるので使わない
      // ⚠ テーブルが無い環境でも計算は続ける (SQL 未適用でも落とさない)
      const contractOf = new Map<string, { childcare_limit: number | null; childcare_rate_pct: number | null; childcare_method: string | null }>();
      {
        const { data, error } = await supabase
          .from("payroll_legacy_contract")
          .select("employee_number,childcare_limit,childcare_rate_pct,childcare_method")
          .eq("office_number", selectedOffice.office_number);
        if (error) console.warn("[payroll] 従業員契約情報を読めませんでした (事業所の設定で計算します):", error.message);
        for (const r of data ?? []) contractOf.set(normEmp(r.employee_number), r);
      }
      const meetingUnitPriceOf = (officeId: string) =>
        officeByIdMap.get(officeId)?.meeting_unit_price ?? 0;

      // ── 有給の付与ごとの日当 (payroll_paid_leave_grants。2026-09-18) ──
      // 付与日から 前年度繰越 を使い切るまでは前年度の日当、以降は今年度の日当。
      // 前月までの使用日数は 事業所書式 (付与月〜前月) の有給から数える
      const grantByEmpId = new Map<string, PaidLeaveGrant>();
      /** その職員の 有給管理簿シートが carrying している最初の月 (= 最新の付与日の月)。
       *  管理簿の 4月〜3月 の列は ★その行の付与日から 1 年ぶんしか無い。
       *  それより前の月に 0 を書き込んでいたため、事業所書式に日数があっても 0 円になっていた
       *  (おゆみ野 2026-03 の 16 名 ¥372,297。2026-09-21 実測)。 */
      const ledgerFromByEmpId = new Map<string, string>();
      const usedBeforeByNum = new Map<string, number>();
      const ledgerDaysByNum = new Map<string, Map<string, number>>();
      {
        const empIds = employees.map((e) => e.id);
        const grants: (PaidLeaveGrant & { employee_id: string })[] = [];
        for (let i = 0; i < empIds.length; i += 150) {
          const { data, error } = await supabase.from("payroll_paid_leave_grants")
            .select("employee_id,grant_date,carry_days,prev_rate,cur_rate").in("employee_id", empIds.slice(i, i + 150));
          if (error) throw new Error(`有給の付与の取得に失敗: ${error.message}`);
          grants.push(...((data ?? []) as (PaidLeaveGrant & { employee_id: string })[]));
        }
        const byEmp = new Map<string, (PaidLeaveGrant & { employee_id: string })[]>();
        for (const g of grants) byEmp.set(g.employee_id, [...(byEmp.get(g.employee_id) ?? []), g]);
        for (const [id, gs] of byEmp) {
          const g = activePaidLeaveGrant(gs, _monthEnd);
          if (g) grantByEmpId.set(id, g);
          const latest = gs.map((x) => x.grant_date).sort().at(-1);
          if (latest) ledgerFromByEmpId.set(id, latest.slice(0, 7).replace("-", ""));
        }
        const firstMonth = [...grantByEmpId.values()].map((g) => g.grant_date.slice(0, 7).replace("-", "")).sort()[0];
        // 有給管理簿の月ごとの使用日数 (payroll_monthly_inputs paid_leave_days)。載っている人は 事業所書式より優先 (2026-09-18)
        {
          const { data, error } = await supabase.from("payroll_monthly_inputs")
            .select("employee_number,processing_month,numeric_value")
            .eq("office_number", selectedOffice.office_number).eq("item_key", "paid_leave_days")
            .gte("processing_month", firstMonth && firstMonth < selectedMonth ? firstMonth : selectedMonth)
            .lte("processing_month", selectedMonth);
          if (error) throw new Error(`有給管理簿の日数の取得に失敗: ${error.message}`);
          for (const r of (data ?? []) as { employee_number: string; processing_month: string; numeric_value: number | null }[]) {
            const num = normEmp(r.employee_number);
            if (!ledgerDaysByNum.has(num)) ledgerDaysByNum.set(num, new Map());
            ledgerDaysByNum.get(num)!.set(r.processing_month, Number(r.numeric_value ?? 0));
          }
        }
        if (firstMonth && firstMonth < selectedMonth) {
          const prevRecs: OfficeFormRecord[] = [];
          for (let from = 0; ; from += 1000) {
            const { data, error } = await supabase.from("payroll_office_form_records")
              .select("employee_number,processing_month,record_type,item_name,item_date,numeric_value")
              .eq("office_number", selectedOffice.office_number)
              .gte("processing_month", firstMonth).lt("processing_month", selectedMonth)
              .like("item_name", "%有給%")
              .order("id").range(from, from + 999);
            if (error) throw new Error(`前月までの有給の取得に失敗: ${error.message}`);
            prevRecs.push(...((data ?? []) as unknown as OfficeFormRecord[]));
            if (!data || data.length < 1000) break;
          }
          for (const e of employees) {
            const g = grantByEmpId.get(e.id);
            if (!g) continue;
            const gm = g.grant_date.slice(0, 7).replace("-", "");
            const num = normEmp(e.employee_number);
            const mine = prevRecs.filter((r) => normEmp(r.employee_number) === num && (r as OfficeFormRecord & { processing_month: string }).processing_month >= gm);
            const led = ledgerDaysByNum.get(num);
            usedBeforeByNum.set(num, led
              ? [...led.entries()].filter(([m]) => m >= gm && m < selectedMonth).reduce((a, [, v]) => a + v, 0)
              : officeFormPaidLeaveDays(mine));
          }
        }
      }
      // 当月の有給日数: 有給管理簿に当月の行があればそれ (総括表 4〜7 月 967 件中 940 件一致)、無ければ事業所書式
      //   ⚠ 管理簿が carrying していない月 (最新の付与日より前) は 0 が入っていても信用しない。
      //     シートの月列は 付与日から 1 年ぶんしか無く、それより前は 取込が 0 を書いただけ
      const paidLeaveDaysOf = (empId: string, empNum: string, days: number): number => {
        const from = ledgerFromByEmpId.get(empId);
        if (from && selectedMonth < from) return days;
        return ledgerDaysByNum.get(empNum)?.get(selectedMonth) ?? days;
      };
      const paidLeaveAllowanceOf = (empId: string, empNum: string, days: number, fallbackRate: number): number =>
        paidLeaveAllowanceByGrant(paidLeaveDaysOf(empId, empNum, days), usedBeforeByNum.get(empNum) ?? 0, grantByEmpId.get(empId) ?? null, fallbackRate);

      // 月ごとの手入力の 調整手当・過誤 (payroll_monthly_inputs adjustment)。時給者は error_adjustment、月給者は adjustment
      const adjustmentByNum = new Map<string, number>();
      // 社会保険 (処遇改善補助金・通信手当の判定) の月ごとの値。無ければ職員マスタの今の値 (2026-09-19)
      const socialInsuranceByNum = new Map<string, boolean>();
      // 報奨金をこの月に支給する人 (/bonus-payments で決める。金額は給与設定の bonus_amount)。2026-09-22
      const bonusPaidNums = new Set<string>();
      // 出張km の手入力 (交通費精算書の合計)。入っていれば 事業所書式・出勤簿より優先 (2026-09-23 八千代 社員の書式入力漏れ)
      const manualTripKmByNum = new Map<string, number>();
      // 研修・会議の時間の手入力 (分)。事業所書式に無い分を補う。本稼働後は書式が唯一の元 (2026-09-23 user)
      const manualTrainingMinByNum = new Map<string, number>();
      {
        const { data, error } = await supabase.from("payroll_monthly_inputs")
          .select("employee_number,item_key,numeric_value")
          .eq("office_number", selectedOffice.office_number).eq("processing_month", selectedMonth)
          .in("item_key", ["adjustment", "social_insurance", BONUS_PAID_KEY, "business_km", "training_minutes"]);
        if (error) throw new Error(`調整手当の取得に失敗: ${error.message}`);
        for (const r of (data ?? []) as { employee_number: string; item_key: string; numeric_value: number | null }[]) {
          if (r.item_key === "adjustment") adjustmentByNum.set(normEmp(r.employee_number), Number(r.numeric_value ?? 0));
          if (r.item_key === "social_insurance") socialInsuranceByNum.set(normEmp(r.employee_number), Number(r.numeric_value ?? 0) > 0);
          if (r.item_key === BONUS_PAID_KEY && Number(r.numeric_value ?? 0) > 0) bonusPaidNums.add(normEmp(r.employee_number));
          if (r.item_key === "business_km" && Number(r.numeric_value ?? 0) > 0) manualTripKmByNum.set(normEmp(r.employee_number), Number(r.numeric_value));
          if (r.item_key === "training_minutes" && Number(r.numeric_value ?? 0) > 0) manualTrainingMinByNum.set(normEmp(r.employee_number), Number(r.numeric_value));
        }
      }

      // 出張km の決め方: 手入力 (精算書) > 事業所書式 > 出勤簿。地図の距離は使わない (出張は自宅からも含む = 移動距離とは別物)
      const tripKmOf = (empNum: string, attendanceKm: number) => {
        const manual = manualTripKmByNum.get(normEmp(empNum));
        if (manual !== undefined) return manual;
        const of = (ofByEmp.get(normEmp(empNum)) ?? [])
          .filter((r) => r.record_type === "km" && r.item_name === "出張km")
          .reduce((s, r) => s + (r.numeric_value ?? 0), 0);
        return of > 0 ? of : attendanceKm;
      };

      // 旧システムの確定値 (payroll_legacy_travel_daily)。あればこれを使い、Google の推定は使わない。
      //   2026-03〜07 を実測: 当方の推定は 総括表の移動手当と ¥676,520 ずれていたが、旧システムの値なら 94.5% 一致する。
      //   1行 = 1職員×1日。travel_paid_min = 移動手当の対象時間 / travel_full_min = 移動の全量 (出勤時間に乗る分)。
      //   ⚠ 通勤費・出張費の距離は この CSV に無いので 従来どおり Google の距離を使う。
      const legacyTravel = new Map<string, { paidSecByDay: Map<string, number>; paidSec: number; fullSec: number; otMin: number; svcTotalMin: number; allowance: number; hourly: boolean }>();
      if (useLegacyRes.enabled) {
        const PAGE = 1000;
        let lFrom = 0;
        while (true) {
          const { data, error } = await supabase
            .from("payroll_legacy_travel_daily")
            .select("work_date,employee_number,pay_type,travel_paid_min,travel_full_min,ot_service_min,ot_travel_min,service_total_min,travel_allowance")
            .eq("processing_month", selectedMonth)
            .eq("office_number", selectedOffice.office_number)
            .order("id").range(lFrom, lFrom + PAGE - 1);
          if (error) throw new Error(`旧システムの移動データの読み込みに失敗しました: ${error.message}`);
          if (!data || data.length === 0) break;
          for (const r of data) {
            const num = normEmp(r.employee_number);
            if (!legacyTravel.has(num)) legacyTravel.set(num, { paidSecByDay: new Map(), paidSec: 0, fullSec: 0, otMin: 0, svcTotalMin: 0, allowance: 0, hourly: true });
            const x = legacyTravel.get(num)!;
            const date = String(r.work_date).replace(/-/g, "/"); // 実績側は "2026/06/01" 形式
            const sec = (r.travel_paid_min ?? 0) * 60;
            x.paidSecByDay.set(date, (x.paidSecByDay.get(date) ?? 0) + sec);
            x.paidSec += sec;
            x.fullSec += (r.travel_full_min ?? 0) * 60;
            x.otMin += (r.ot_service_min ?? 0) + (r.ot_travel_min ?? 0);
            x.svcTotalMin += r.service_total_min ?? 0;
            // 旧システムの「移動手当」(円)。対象時間 × 20 に 残業中の移動の割増が乗っている (中央 SYED 3/7: 6分 + 残業17分 → 540円)。
            //   3〜7月の時給者 1,914人月で総括表と突合: 分×20 は 1,723 一致 / この列の合計は 1,755 一致 (悪くなる人は 0)。2026-09-23
            x.allowance += r.travel_allowance ?? 0;
            // ⚠ 旧システムの「移動」は 時給者は手当の対象時間 / 月給者は移動の全量 (手当は付かない)。
            //   当方が時給扱いでも 旧が月給なら ×20 して手当にしてはいけない
            //   (さつきが丘 米倉 2026-03: 613分 → ¥12,260 になるが 総括表は ¥540)
            if (r.pay_type === "月給") x.hourly = false;
          }
          if (data.length < PAGE) break;
          lFrom += PAGE;
        }
      }

      // 旧システムの「従業員日別データ」(payroll_legacy_daily)。work_min = その日の出勤時間。
      //   出勤簿がある人は 出勤簿 (始業〜終業−休憩) から、無い人は サービス+移動 から 旧システムが出した値。
      //   ⚠ 当方に 出勤簿が無い人の「出勤時間」だけに使う。残業・手当の計算は当方のロジックのまま。
      //   実測 (2026-03〜07・総括表の「出勤」と突合): パート 90.4% 一致
      //   (当方の推定 サービス+移動 は 69.7%)。月給者は 50.7% (推定 35.4%)。
      const legacyDailyWorkMin = new Map<string, number>();
      // 月給者の残業 (分)。旧システムの日別 overtime_min の合計 (2026-09-23)。
      //   旧は 1日の出勤時間に 出勤簿の外の訪問・移動も含めて 8h 超を数える (大網 髙橋 7/1: 出勤簿 585分 / 旧 627分 → 残業 147分)。
      //   3〜7月の月給者 911人月で総括表の残業時間と突合: 当方の計算 229 一致 / 旧の値 623 / ★旧 (>0) → 無ければ当方 655
      const legacyDailyOtMin = new Map<string, number>();
      if (useLegacyRes.enabled) {
        const PAGE = 1000;
        let dFrom = 0;
        while (true) {
          const { data, error } = await supabase
            .from("payroll_legacy_daily")
            .select("employee_number,work_min,overtime_min,pay_type")
            .eq("processing_month", selectedMonth)
            .eq("office_number", selectedOffice.office_number)
            .order("id").range(dFrom, dFrom + PAGE - 1);
          if (error) { console.warn("[payroll] 旧システムの日別データを読めませんでした (出勤時間の補完は行いません):", error.message); break; }
          if (!data || data.length === 0) break;
          for (const r of data) {
            const num = normEmp(r.employee_number);
            legacyDailyWorkMin.set(num, (legacyDailyWorkMin.get(num) ?? 0) + (r.work_min ?? 0));
            if (r.pay_type === "月給") legacyDailyOtMin.set(num, (legacyDailyOtMin.get(num) ?? 0) + (r.overtime_min ?? 0));
          }
          if (data.length < PAGE) break;
          dFrom += PAGE;
        }
      }

      /** 出勤簿が当方に無い人の その月の出勤時間 (分)。旧システムの日別 work_min を優先する */
      const legacyWorkMinOf = (num: string): number | null => {
        const w = legacyDailyWorkMin.get(num);
        if (w != null && w > 0) return w;
        const x = legacyTravel.get(num);
        if (!x) return null;
        const v = x.svcTotalMin + Math.round(x.fullSec / 60);
        return v > 0 ? v : null;
      };

      // 時給者
      const roleMap = new Map(employees.map((e) => [normEmp(e.employee_number), {
        name: e.name,
        role: e.role_type,
        salary: e.salary_type,
        hasQual: qualifiedInMonth(e),
        jobType: e.job_type ?? "",
        serviceMonths: tenureMonthsOf(e),
        empId: e.id,
        officeId: e.office_id,
        socialInsurance: socialInsuranceByNum.get(normEmp(e.employee_number)) ?? e.social_insurance ?? false,
        paidLeaveUnitPrice: e.paid_leave_unit_price ?? 0,
        // 貸与 (lend / lend_fee) は 始まった月が人によって違うが 列は「今の値」1つしかない。
        //   適用開始日より前の月は none 扱いにする (高品 菊池 4月から / 中村 6月から。2026-09-21)
        communicationFeeType: (e.communication_fee_from && e.communication_fee_from > monthEndIso) ? "none" : (e.communication_fee_type ?? "none"),
        isOfficeWorker: e.is_office_worker ?? false,
      }]));
      const hourlyEmpMap = new Map<string, HourlyPayroll>();

      // 研修手当の時給 = その事業所の 同行 の時給
      // 実績・出勤簿が無くても 事業所書式だけある人 (会議費・研修のみ) も対象にする (2026-09-17)
      for (const empNum of new Set([...recsByEmp.keys(), ...attByEmp.keys(), ...ofByEmp.keys()])) {
        const info    = roleMap.get(empNum);
        // 選択事業所の職員マスタに存在しない番号はスキップ（他事業所の番号衝突対策）
        if (!info) continue;
        const sw = switchByNum.get(empNum);
        if (info.salary === "月給" && !sw) continue;
        const empRecs = recsByEmpH.get(empNum) ?? [];
        const firstRec = empRecs[0] ?? (recsByEmp.get(empNum) ?? [])[0];
        const sal = sw && !sw.hourlyBefore ? sw.postRow : (info ? salMap.get(info.empId) : null);
        const baseEmpSummary = computeSummaryOf(empNum, empRecs, attByEmpH.get(empNum) ?? []);
        // 出勤簿の無い時給者の出勤時間 = 訪問時間 (+ 移動時間は経路計算の後で足す)。2026-09-17
        const empSummary = {
          ...baseEmpSummary,
          workHoursMin: employeeWorkMinutes((attByEmpH.get(empNum) ?? []).length, baseEmpSummary.workHoursMin, baseEmpSummary.visitMinutes, 0, legacyWorkMinOf(empNum), allTrainingMinutes(ofByEmp.get(empNum) ?? [])),
        };
        const empOffice = officeByIdMap.get(info?.officeId ?? "");
        const isVisitCare = info?.jobType === "訪問介護";
        const hasSocialInsurance = info?.socialInsurance ?? false;
        const treatmentSubsidy = treatmentSubsidyAmount(
          isVisitCare, hasSocialInsurance, empSummary.visitMinutes,
          empOffice?.treatment_subsidy_amount ?? 0, sal?.treatment_subsidy ?? 0,
        );
        const cancelRecs = empRecs.filter((r) => {
          const catId = mappingMap.get(r.service_code) ?? null;
          return catId ? categoryMap.get(catId) === "キャンセル" : false;
        });
        const cancelCount = cancelRecs.length;
        const cancelAllowance = cancelAllowanceFromCodes(cancelRecs.map((r) => r.service_code), empOffice?.cancel_unit_price ?? 0);
        const paidLeaveAllowance = paidLeaveAllowanceOf(info.empId, empNum, paidLeaveDays(empSummary.paidLeave, empSummary.halfLeave), info?.paidLeaveUnitPrice ?? 0);
        // 研修・会議の時間は 全事業所 一律 1,150円/時 (総括表① で実測。以前は同行の時給で 0.75 掛けの事業所が 863円になっていた)
        const trainingRate = TRAINING_RATE_PER_HOUR;
        const trainingPay = trainingPayAmount(
          trainingMinutes(ofByEmp.get(empNum) ?? []) + shoninshaTrainingMinutes(ofByEmp.get(empNum) ?? [])
            + (manualTrainingMinByNum.get(empNum) ?? 0),
          trainingRate);
        const communicationFee = communicationFeeAmount(info?.socialInsurance ?? false, empSummary.visitMinutes, info?.communicationFeeType ?? "none");
        const commuteFee = hourlyCommuteFeeAmount(empSummary.commuteKmTotal, empOffice?.commute_unit_price ?? 0, empSummary.commuteYenTotal ?? 0);
        // 出張距離: 手入力 (精算書) > 事業所書式 > 出勤簿 (tripKmOf)。2026-09-17 user 方針: 地図の距離は使わない
        // ⚠ 出張費単価は 従業員契約情報 にも入っているが そちらは「今 (2026-09) の値」で、
        //   ガソリン単価に連動して月ごとに変わる (事業所 12.3〜12.7 に対し 契約は 12.0〜12.1)。
        //   過去月に当てると壊れるので 事業所の単価 (総括表 3〜7月に合わせた値) を使う。2026-09-21
        const businessTripFee = hourlyBusinessTripFeeAmount(tripKmOf(empNum, empSummary.businessKmTotal), empOffice?.travel_unit_price ?? 0);
        // 会議費 = 件数 × 会議単価 ＋ 会議時間 × 同行の時給 (総括表 2026-05〜07 の 四街道・やわた で確認)
        const meetingFee = meetingUnpaidRes.offices.has(empOffice?.office_number ?? "")
          ? 0
          : computeMeetingFee(ofByEmp.get(empNum) ?? [], meetingUnitPriceOf(info?.officeId ?? ""))
            + (trainingPayAmount(meetingMinutes(ofByEmp.get(empNum) ?? []), trainingRate) ?? 0);
        const officeWorkMinutes = info.isOfficeWorker ? empSummary.workHoursMin : 0;
        const officeWorkRate = sal?.office_work_hourly_rate ?? 0;
        hourlyEmpMap.set(empNum, {
          employee_number: empNum,
          employee_name: firstRec?.employee_name || (attByEmp.get(empNum)?.[0] as {employee_name?: string})?.employee_name || info.name || empNum,
          role_type: info?.role ?? "",
          has_care_qualification: info?.hasQual ?? false,
          job_type: info?.jobType ?? "",
          effective_service_months: info?.serviceMonths ?? 0,
          care_plan_count: 0,
          error_adjustment: sw && !sw.hourlyBefore ? 0 : (adjustmentByNum.get(empNum) ?? 0),
          treatment_subsidy: treatmentSubsidy,
          paid_leave_allowance: paidLeaveAllowance,
          cancel_count: cancelCount,
          weekend_holiday_rate: weekendRates[empOffice?.office_number ?? ""] ?? DEFAULT_WEEKEND_HOLIDAY_RATE,
          weekend_holiday_sunday_only: weekendRatesRes.sundayHolidayOnly.has(empOffice?.office_number ?? ""),
          cancel_allowance: cancelAllowance,
          tokubi_allowance: tokubiAllowanceAmount(empSummary.tokubiMinutes ?? 0),
          travel_time_sec: 0,
          travel_allowance: 0,
          communication_fee: communicationFee,
          meeting_fee: meetingFee,
          training_pay: trainingPay,
          ...(() => { const m = (attByEmpH.get(empNum) ?? []).length === 0 ? hourlyOvertimeMinutes(empRecs) : 0; return { overtime_minutes: m, overtime_pay: hourlyOvertimePayAmount(m) }; })(),
          childcare_allowance: computeChildcareAllowance(childcareRecsOf(empNum), "時給", visitMinutesByEmpMonth, empNum, selectedMonth, { limit: contractOf.get(empNum)?.childcare_limit, ratePct: contractOf.get(empNum)?.childcare_rate_pct, method: contractOf.get(empNum)?.childcare_method }),
          commute_fee: commuteFee,
          commute_distance_m: 0,
          business_trip_fee: businessTripFee,
          office_work_minutes: officeWorkMinutes,
          office_work_hourly_rate: officeWorkRate,
          office_work_pay: officeWorkPayAmount(info.isOfficeWorker, empSummary.workHoursMin, officeWorkRate),
          records: [],
          totalMinutes: 0,
          totalPay: 0,
          unmappedCount: 0,
          summary: empSummary,
        });
      }

      // 1.5時間を超えた分の時給 = その事業所の 生活援助 の時給 (visitPayAmount)
      const lifeSupportCategoryId = [...categoryMap.entries()].find(([, name]) => name === "生活援助")?.[0] ?? null;
      // 訪問 1 件の本人給。時給者と「訪問分を払う事務員 (月給)」の両方で使う (2026-09-22 事務員の介護分)
      const recordPayOf = (rec: ServiceRecord) => {
        const minutes    = parseDurationMinutes(rec.calc_duration);
        const categoryId = mappingMap.get(rec.service_code) ?? null;
        const catName    = categoryId ? (categoryMap.get(categoryId) ?? "不明") : "未マッピング";
        const officeId   = officeMap.get(rec.office_number) ?? null;
        const longRate = categoryId && officeId ? (rateMap.get(`${officeId}:${categoryId}`) ?? null) : null;
        // 重度訪問は 1 回 1.5 時間以下なら短時間の時給 (事業所ごとの設定がある区分だけ)
        const shortRate = juhoShortRes.rates[rec.office_number]?.[catName];
        // 総合事業 (A…) で生活援助に結び付いている訪問は 事業所ごとの総合事業の時給 (船橋 1,400)
        const sougouRate = /^A/.test(rec.service_code) && catName === "生活援助" ? sougouRatesRes.rates[rec.office_number] : undefined;
        // 同行援護 (021008) を固定の時給で払う事業所 (五井・やわた 1,750 / KT姉崎 2,100)。段階式にしない
        const doukouFlat = String(rec.service_code).padStart(6, "0") === "021008" ? doukouFlatRes.rates[rec.office_number] : undefined;
        const hourlyRate = doukouFlat !== undefined && longRate !== null ? doukouFlat
          : sougouRate !== undefined && longRate !== null ? sougouRate
          : longRate !== null && shortRate !== undefined && minutes <= 90 ? shortRate : longRate;
        const overflowRate = officeId && lifeSupportCategoryId ? (rateMap.get(`${officeId}:${lifeSupportCategoryId}`) ?? null) : null;
        // 本人給は 1 回の訪問時間を 5 分単位に切り上げて払う (2026-09-19。姉ム 竹内 44分→45分 ×3件 = 78円 / 姉ム 小岩 59→60 = 35円 /
        //   おゆみ野 澤木 72→75 = 131円 が 総括表の差と一致)。時間の集計 (介護超過・残業など) は切り上げない
        const pay        = visitPayAmount(payMinutesOf(minutes), hourlyRate, catName, rec.time_period, doukouFlat !== undefined ? null : overflowRate);
        return { minutes, catName, hourlyRate, pay };
      };
      for (const rec of records) {
        const emp = hourlyEmpMap.get(rec.employee_number);
        if (!emp) continue;
        if (!isHourlySide(normEmp(rec.employee_number), ymdOf(rec.service_date))) continue;
        const { minutes, catName, hourlyRate, pay } = recordPayOf(rec);
        emp.records.push({ id: rec.id, service_date: rec.service_date, minutes, service_code: rec.service_code, category_name: catName, hourly_rate: hourlyRate, pay });
        emp.totalMinutes += minutes;
        if (pay !== null) emp.totalPay += pay; else emp.unmappedCount++;
      }

      // ── 移動手当計算（訪問介護・時給者） + 社員の移動時間（月給・出勤簿なし） ──
      // 社員の出勤時間 = サービス時間 + 訪問間の移動時間の全量 (employeeWorkMinutes)。月給者のループで使う
      const monthlyTravelFullSec = new Map<string, number>();
      const monthlyTravelSecByDay = new Map<string, Map<string, number>>();
      {
        const visitCareEmps = employees.filter(
          // 住所が空の職員も対象にする (2026-09-19)。移動手当・移動時間は 訪問と訪問の間の区間だけで決まり自宅は要らない
          //   (旧システムの Gmap結果も 前の利用者→利用者 の区間だけ)。住所が空だと 26xx 入社の新人など 7月だけで 56名 81,400円 が 0 になっていた。
          //   自宅の区間は collectAddressPairs / calcDayRoute が空の住所を飛ばす
          (e) => e.job_type === "訪問介護" &&
            (e.salary_type === "時給" || switchByNum.has(normEmp(e.employee_number)) || (e.salary_type === "月給" && (attByEmp.get(normEmp(e.employee_number)) ?? []).length === 0))
        );
        if (visitCareEmps.length > 0) {
          // payroll_clients は 1 事業所で 1000 行を超え得るため paginate
          const clientData: { client_number: string; address: string; map_address: string | null; map_latitude: number | null; map_longitude: number | null }[] = [];
          {
            const PAGE = 1000;
            let cFrom = 0;
            while (true) {
              const { data, error } = await supabase
                .from("payroll_clients")
                .select("client_number,address,map_address,map_latitude,map_longitude")
                .eq("office_id", selectedOfficeId)
                .order("id").range(cFrom, cFrom + PAGE - 1);
              // 読み込みエラーを「データの終わり」と扱わない (2026-09-19: 同時計算で実績が途中で切れ、本人給が半分になった)
              if (error) throw new Error(`データの読み込みに失敗しました (もう一度計算してください): ${error.message}`);
              if (!data || data.length === 0) break;
              clientData.push(...(data as { client_number: string; address: string; map_address: string | null; map_latitude: number | null; map_longitude: number | null }[]));
              if (data.length < PAGE) break;
              cFrom += PAGE;
            }
          }
          // マップ用座標 → 地図用住所 (map_address) → 登録住所 の順 (座標は "lat,lng" 文字列として Distance Matrix API に渡せる)
          // map_address = 登録住所と訪問場所が違う利用者 (旧システムの MAP住所。おゆみ野 2113113372 東金市 → 川戸町のグループホーム。2026-09-19)
          const clientMap = new Map(
            clientData.map((c) => {
              const addr = (c.map_latitude != null && c.map_longitude != null)
                ? `${c.map_latitude},${c.map_longitude}`
                : (c.map_address?.trim() || c.address);
              return [c.client_number, addr];
            })
          );

          const byEmpNum = new Map<string, { address: string; dayMap: Map<string, VisitForRoute[]> }>();
          for (const emp of visitCareEmps) {
            const normNum = normEmp(emp.employee_number);
            // 切替のある人は 時給の側の日だけ (移動手当は時給の側で払う)
            const empRecs = recsByEmpH.get(normNum) ?? [];
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
            if (dayMap.size > 0) byEmpNum.set(normNum, { address: emp.address ?? "", dayMap });
          }

          // 旧システムの移動データで置き換えられる人は Google に距離を取りに行かない (2026-09-22)。
          //   Google の距離は その人については 画面の通勤距離の表示にしか使っておらず、金額 (移動手当・出勤時間・残業) は旧データで決まる。
          //   以前は全員の全区間を先に取りに行っていて、旧データのある 3〜8 月の再計算で 月の API 上限 (20,000件) を使い切った
          const coveredByLegacy = (normNum: string) => {
            const legacy = legacyTravel.get(normNum);
            if (!legacy) return false;
            return hourlyEmpMap.has(normNum) ? legacy.hourly : true;
          };
          const allPairs: { origin: string; destination: string }[] = [];
          for (const [normNum, { address, dayMap }] of byEmpNum) {
            if (coveredByLegacy(normNum)) continue;
            allPairs.push(...collectAddressPairs(address, dayMap));
          }

          // ⚠ 区間が 0 件 (全員が旧データで置き換わる) でも 下の人ごとの処理は必ず通す。if (allPairs.length > 0) にすると旧データの差し替えごと飛ぶ
          {
            // 1 回の /api/distance で投げる区間数。1 事業所 600 区間で 50 ずつだと 12 往復 = 約 60 秒かかる。
            //   中でやるのは payroll_distance_cache の .in(origin) 照会なので 200 でも重くならない
            //   (.in() は 350 件を超えると seq scan に落ちるので それより十分小さく取る。2026-09-21)
            const BATCH_SIZE = 200;
            const distResultsArr: { origin: string; destination: string; distance_meters: number; duration_seconds: number }[] = [];
            // 2026-09-17: 取れなかった区間を黙って 0 にしない。上限・Google エラーを画面に出す
            const distIssues = new Set<string>();
            let skippedByLimit = 0;
            let usageInfo: { month: string; used: number; limit: number } | null = null;
            for (let i = 0; i < allPairs.length; i += BATCH_SIZE) {
              const batch = allPairs.slice(i, i + BATCH_SIZE);
              setProgress({ pct: 40 + Math.floor((50 * i) / allPairs.length), label: `移動距離を取得中 (${i.toLocaleString()} / ${allPairs.length.toLocaleString()} 区間)` });
              const res = await fetch("/api/distance", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pairs: batch, office_number: selectedOffice.office_number, source: "payroll" }),
              });
              const json = await res.json().catch(() => ({}));
              distResultsArr.push(...(json.results ?? []));
              if (!res.ok || json.error) distIssues.add(`距離APIエラー: ${json.error ?? res.status}`);
              for (const g of json.googleErrors ?? []) distIssues.add(`Google: ${g}`);
              if (json.limitReached) skippedByLimit += json.skippedPairs ?? 0;
              if (json.usage) usageInfo = json.usage;
            }
            const uniquePairCount = new Set(allPairs.map((p) => `${p.origin}|||${p.destination}`)).size;
            const missingPairs = uniquePairCount - new Set(distResultsArr.map((r) => `${r.origin}|||${r.destination}`)).size;
            if (skippedByLimit > 0 || distIssues.size > 0) {
              const parts: string[] = [];
              if (skippedByLimit > 0) parts.push(`今月の Google API 利用上限に達しました (${usageInfo ? `${usageInfo.used.toLocaleString()} / ${usageInfo.limit.toLocaleString()} 件` : ""})。${skippedByLimit} 区間を取得していません。`);
              parts.push(...distIssues);
              parts.push(`移動距離・時間が取れなかった区間 ${missingPairs} / ${uniquePairCount}。移動手当・通勤費・出張費が少なく計算されています。`);
              setDistanceWarning(parts.join(" "));
            }
            const distMap = new Map<string, { distance_meters: number; duration_seconds: number }>(
              distResultsArr.map((r) => [`${r.origin}|||${r.destination}`, { distance_meters: r.distance_meters, duration_seconds: r.duration_seconds }])
            );

            for (const [normNum, { address, dayMap }] of byEmpNum) {
              const entry = hourlyEmpMap.get(normNum);
              const legacy = legacyTravel.get(normNum);
              if (!entry) {
                // 月給・出勤簿なしの社員: 移動時間の全量だけ控える
                if (legacy) {
                  monthlyTravelFullSec.set(normNum, legacy.fullSec);
                  monthlyTravelSecByDay.set(normNum, legacy.paidSecByDay);
                  continue;
                }
                let fullSec = 0;
                const byDay = new Map<string, number>();
                for (const [date, visits] of dayMap) {
                  const sec = calcDayRoute(date, address, visits, distMap)?.travel_time_full_sec ?? 0;
                  fullSec += sec;
                  byDay.set(date, sec);
                }
                monthlyTravelFullSec.set(normNum, fullSec);
                monthlyTravelSecByDay.set(normNum, byDay);
                continue;
              }
              const empObj = employees.find((e) => normEmp(e.employee_number) === normNum);
              const empOffice = officeByIdMap.get(empObj?.office_id ?? "");
              const rate = empOffice?.travel_allowance_rate ?? 0;
              let totalSec = 0;
              let totalFullSec = 0;
              let totalCommuteM = 0;
              let paidTravelSecByDay = new Map<string, number>();
              for (const [date, visits] of dayMap) {
                const day = calcDayRoute(date, address, visits, distMap);
                if (day) {
                  totalSec += day.travel_time_sec;
                  totalFullSec += day.travel_time_full_sec;
                  totalCommuteM += day.commute_distance_m; // 通勤費・出張費の距離は旧システムに無いので Google のまま
                  paidTravelSecByDay.set(date, day.travel_time_sec);
                }
              }
              // 旧システムの確定値があれば 移動時間だけ差し替える (距離は差し替えない)
              if (legacy && legacy.hourly) {
                totalSec = legacy.paidSec;
                totalFullSec = legacy.fullSec;
                paidTravelSecByDay = legacy.paidSecByDay;
              }
              // 出勤簿の無い時給者の残業 = 訪問時間 + 移動手当の対象時間 (区間ごとの 15 分超過分) で 日8h超 + 週40h超。2026-09-19
              //   総括表データ (残業時間合計) と 7月21名で突合: 訪問のみ 誤差計1,340分 / 移動全量 7,719分 / ★15分超過分 1,020分。
              //   旧の移動手当から逆算した移動時間で置き換えると 660分 (峰 +8 / 石本 +6 / 加藤 +7) = 式はこれで、残差は移動時間の見積もり差
              if ((attByEmpH.get(normNum) ?? []).length === 0) {
                // 旧システムが残業を確定させているならそれを使う (2026-09-21)。
                //   総括表と突合: 当方の計算 82/130 (63.1%) に対し 旧システムの値は 121/130 (93.1%)。
                //   旧は 1日ごとに max(0, 総合計 - 8h) で、週40時間の判定は入っていない (53,255行で 99.1% 再現)
                const m = legacy && legacy.hourly
                  ? legacy.otMin
                  : hourlyOvertimeMinutes(recsByEmpH.get(normNum) ?? [], paidTravelSecByDay, trainingMinutesByDay(ofByEmp.get(normNum) ?? [], selectedMonth));
                entry.overtime_minutes = m;
                entry.overtime_pay = hourlyOvertimePayAmount(m);
              }
              // 出勤簿の無い時給者は 出勤時間 = 訪問 + 移動の全量 (社員と同じ。さつきが丘 2026-07 で総括表と照合)
              entry.summary = {
                ...entry.summary,
                workHoursMin: employeeWorkMinutes((attByEmpH.get(normNum) ?? []).length, entry.summary.workHoursMin, entry.summary.visitMinutes, totalFullSec, legacyWorkMinOf(normNum), allTrainingMinutes(ofByEmp.get(normNum) ?? [])),
              };
              const adjustedDistanceM = adjustedCommuteDistanceM(totalCommuteM, empOffice?.distance_adjustment_rate ?? 100);
              entry.travel_time_sec = totalSec;
              entry.travel_allowance = legacy && legacy.hourly ? legacy.allowance : travelAllowanceAmount(totalSec, rate);
              entry.commute_distance_m = adjustedDistanceM;
              // 出張費は事業所書式の出張km で計算済み (地図の距離では上書きしない)
            }
          }
        }
      }

      const hourlySorted = [...hourlyEmpMap.values()].sort((a, b) => a.employee_name.localeCompare(b.employee_name, "ja"));
      // 旧システムのデータを使った項目を残す (流用した結果だと分かるように。user 2026-09-22)
      for (const e of hourlySorted) {
        const num = normEmp(e.employee_number);
        const used: string[] = [];
        if (legacyTravel.get(num)?.hourly) used.push("移動時間");
        if ((attByEmpH.get(num) ?? []).length === 0 && legacyWorkMinOf(num) != null) used.push("出勤時間");
        if (used.length) e.legacy_used = used;
      }
      setHourlyResults(hourlySorted);

      setProgress({ pct: 92, label: "月給者を計算中" });
      // 月ごとの手入力 (payroll_monthly_inputs)。入浴件数は 社員の介護超過の時間に 件数 × 1.12h を足す (2026-09-18)
      const bathCountByEmp = new Map<string, number>();
      const bathMinutesByEmp = new Map<string, number>();
      {
        const { data, error } = await supabase.from("payroll_monthly_inputs")
          .select("employee_number,item_key,numeric_value")
          .eq("office_number", selectedOffice.office_number).eq("processing_month", selectedMonth);
        if (error) throw new Error(`月ごとの手入力の取得に失敗: ${error.message}`);
        for (const r of (data ?? []) as { employee_number: string; item_key: string; numeric_value: number | null }[]) {
          if (r.item_key === "bath_visit_count") bathCountByEmp.set(normEmp(r.employee_number), Number(r.numeric_value ?? 0));
          // 入浴時間 (分) はそのまま足す (リンクス茂原 総括表「入浴時間」。木村 2026-03: 8,440 + 1,500 分 → 45.67h × 2,500 = 114,167)
          if (r.item_key === "bath_minutes") bathMinutesByEmp.set(normEmp(r.employee_number), Number(r.numeric_value ?? 0));
        }
      }
      const overtimeExcessPaidRes = await getOvertimeExcessPaidEmployees(supabase);
      if (overtimeExcessPaidRes.error) throw new Error(`固定残業の超過を払う提責の設定の読み込みに失敗: ${overtimeExcessPaidRes.error}`);
      const offsetFullCareRes = await getOvertimeOffsetFullCareOffices(supabase);
      if (offsetFullCareRes.error) throw new Error(`残業代から介護超過を差し引く事業所の設定の読み込みに失敗: ${offsetFullCareRes.error}`);
      // 月給者
      const monthlyEmps = employees.filter(
        (e) => (e.salary_type === "月給" || switchByNum.has(normEmp(e.employee_number))) && (!e.employment_status || e.employment_status === "在職者" || e.employment_status === "退職者")
      );
      const monthlySorted = monthlyEmps.sort((a, b) => a.name.localeCompare(b.name, "ja")).map((e) => {
          const sw = switchByNum.get(normEmp(e.employee_number));
          // 切替のある人: 月給の側の給与設定 (時給→月給なら 月の途中から始まる行 / 月給→時給なら 月初の行)
          const sal = sw ? (sw.hourlyBefore ? sw.postRow : sw.preRow) : (salMap.get(e.id) ?? null);
          const roleM = sw && sw.hourlyBefore ? resolveEmploymentType(e, sw.postRow).role_type : e.role_type;
          // 勤続手当: tenure_allowance_auto=true (default) なら自動計算、false なら手動入力値
          const computedTenure = computeTenureAllowance(
            qualifiedInMonth(e),
            tenureMonthsOf(e),
            "月給",
            e.job_type ?? "",
            0, 0, 0
          );
          // 手入力の勤続手当は 基準の月 (既定 202607) の額。それより後の月は 節目を越えた分だけ上げる (user 2026-09-22)
          const manualTenure = sal && (sal as SalarySettings & { tenure_allowance_auto?: boolean }).tenure_allowance_auto === false;
          // 自動計算の人も 資格フラグが false だと常に 0 円になる。基準の月に 1 年未満だった人は 資格ありとみなして
          // 入社日からの月数も使って出す (市原 石川 2026-08: 入社 2025-08 → 1 年で 1,000円)。基準の月以前は変えない
          const autoFirstYear = !manualTenure && !qualifiedInMonth(e) && selectedMonth > tenureBaseRes.month
            ? (() => {
                const num = normEmp(e.employee_number);
                const offset = (year * 12 + month) - (Number(tenureBaseRes.month.slice(0, 4)) * 12 + Number(tenureBaseRes.month.slice(4, 6)));
                const g = legacyStepMonths.get(num) ?? tenureMonthsOf(e);
                if (tenureMonthsForStep(Math.max(0, g - offset), legacyHireDate.get(num), tenureBaseRes.month) >= 12) return null;
                return computeTenureAllowance(true, tenureMonthsForStep(g, legacyHireDate.get(num), selectedMonth), "月給", e.job_type ?? "", 0, 0, 0);
              })()
            : null;
          // 基準の月 = 設定の基準の月 と 給与設定の適用開始月 の遅い方 (2026-08-01 から入れた行の額は 8月時点で上がった後の額)
          const rowMonth = sal?.effective_from ? sal.effective_from.slice(0, 7).replace("-", "") : "";
          const tenureBase = rowMonth > tenureBaseRes.month ? rowMonth : tenureBaseRes.month;
          const resolvedTenure = autoFirstYear !== null ? autoFirstYear : manualTenure && selectedMonth > tenureBase
            ? (() => {
                const num = normEmp(e.employee_number);
                const offset = (year * 12 + month) - (Number(tenureBase.slice(0, 4)) * 12 + Number(tenureBase.slice(4, 6)));
                const g = legacyStepMonths.get(num) ?? tenureMonthsOf(e);
                const stored = sal!.tenure_allowance ?? 0;
                const monthsNow = tenureMonthsForStep(g, legacyHireDate.get(num), selectedMonth);
                const monthsBase = tenureMonthsForStep(Math.max(0, g - offset), legacyHireDate.get(num), tenureBase);
                // ⚠ 月給者の資格フラグ (has_care_qualification) は 366 名中 363 名が false で使えない (2026-09-22 実測)。
                //   手入力が 0 円より大きい = 勤続手当が出ている = 資格あり。0 円でも 基準の月に 1 年未満なら 0 円の理由は年数なので資格ありとみなす
                //   (市原 石川・袖ケ浦 坂尾 2026-08: 入社 1 年で 0 → 1,000円)。基準の月に 1 年以上で 0 円の人は 資格なしとみなし上げない
                const qualified = qualifiedInMonth(e) || stored > 0 || monthsBase < 12;
                const now = computeTenureAllowance(qualified, monthsNow, "月給", e.job_type ?? "", 0, 0, 0);
                const atBase = computeTenureAllowance(qualified, monthsBase, "月給", e.job_type ?? "", 0, 0, 0);
                return manualTenureWithSteps(stored, now, atBase);
              })()
            : resolveTenureAllowance(sal, computedTenure);
          const settingsFull = sal ? { ...sal, tenure_allowance: resolvedTenure } : null;
          // 月の途中で切り替わった人は 月給の側で勤務した日数で日割り (payroll-calc の prorateMonthlyFixed)
          const settingsWithTenure = settingsFull && sw
            ? (() => {
                const num = normEmp(e.employee_number);
                const days = new Map<string, { serviceMinutes: number; workMinutes: number; halfDay: boolean }>();
                const dayOf = (d: string) => { if (!days.has(d)) days.set(d, { serviceMinutes: 0, workMinutes: 0, halfDay: false }); return days.get(d)!; };
                for (const r of recsByEmpM.get(num) ?? []) dayOf(ymdOf(r.service_date)).serviceMinutes += parseDurationMinutes(r.calc_duration);
                for (const a of attByEmpM.get(num) ?? []) {
                  const d = dayOf(attDateOf(a.day));
                  d.workMinutes += parseDurationMinutes(a.work_hours ?? "");
                  if ([a.work_note_1, a.work_note_2, a.work_note_3, a.work_note_4, a.work_note_5].some((n) => /半/.test(n ?? ""))) d.halfDay = true;
                }
                const workDays = midMonthWorkDays([...days.values()], roleM);
                return prorateMonthlyFixed(settingsFull, workDays, roleM === "事務員" || (e.is_office_worker ?? false));
              })()
            : settingsFull;
          // ⚠ 2026-09-05 是正: recsByEmp は normEmp() 済みキーで格納されているが、
          //   ここだけ生の employee_number でlookupしていた (直下のofByEmp.get は
          //   正しくnormEmp済み)。実データ(月給者355名)では先頭ゼロ付きemployee_numberが
          //   0件のため現状の影響は無いが、揃えておく。
          const baseSummary = computeSummaryOf(String(e.employee_number), recsByEmpM.get(normEmp(e.employee_number)) ?? [], attByEmpM.get(normEmp(e.employee_number)) ?? []);
          const summary = {
            ...baseSummary,
            workHoursMin: employeeWorkMinutes(
              (attByEmpM.get(normEmp(e.employee_number)) ?? []).length,
              baseSummary.workHoursMin,
              baseSummary.visitMinutes,
              monthlyTravelFullSec.get(normEmp(e.employee_number)) ?? 0,
              legacyWorkMinOf(normEmp(e.employee_number)),
              allTrainingMinutes(ofByEmp.get(normEmp(e.employee_number)) ?? []),
            ),
            // 出勤簿の無い社員の残業 (分) = 日ごとの (訪問 + 移動の全量) で 日8h超 + 週40h超 (日曜始まり)。2026-09-19
            //   総括表データ (提責_社員 の 残業時間合計) と 7月 社員100名で突合: 訪問 + 移動全量 誤差計 8,469分 /
            //   訪問のみ 21,065分 / 移動15分超過分のみ 19,584分 (中島 -2 / 東條 -1 / 緑川 0 / 赤間 -3)。
            //   時給者 (移動は15分超過分だけ) と違い、社員は移動を全部数える。
            //   (2026-09-18 の 日8h超だけの仮説 dailyOvertimeFromVisits は 週40h と 介護超過の差し引きが無く外れていた)
            ...((attByEmpM.get(normEmp(e.employee_number)) ?? []).length === 0 && e.role_type === "社員"
              ? { overtimeMinutes: hourlyOvertimeMinutes(recsByEmpM.get(normEmp(e.employee_number)) ?? [], monthlyTravelSecByDay.get(normEmp(e.employee_number)), trainingMinutesByDay(ofByEmp.get(normEmp(e.employee_number)) ?? [], selectedMonth)) }
              : {}),
            // 旧システムの残業時間があれば それを使う (上の legacyDailyOtMin の注記)
            ...((legacyDailyOtMin.get(normEmp(e.employee_number)) ?? 0) > 0
              ? { overtimeMinutes: legacyDailyOtMin.get(normEmp(e.employee_number))! }
              : {}),
          };
          // 出張km: 手入力 (精算書) > 事業所書式 > 出勤簿
          const empOfRecs = ofByEmp.get(normEmp(e.employee_number)) ?? [];
          const travelKmAuto = tripKmOf(e.employee_number, summary.businessKmTotal);
          const office = officeByIdMap.get(e.office_id);

          return {
            employee_id: e.id,
            employee_number: e.employee_number,
            employee_name: e.name,
            role_type: roleM,
            job_type: e.job_type ?? "",
            auth_user_id: e.auth_user_id ?? null,
            settings: settingsWithTenure,
            bonus_paid: bonusPaidNums.has(normEmp(e.employee_number)),
            travel_km: 0,
            travel_km_auto: travelKmAuto,
            office_travel_unit_price: office?.travel_unit_price ?? 0,
            office_commute_unit_price: office?.commute_unit_price ?? 0,
            business_trip_fee: 0,
            childcare_allowance: computeChildcareAllowance(childcareRecsOf(normEmp(e.employee_number)), "月給", visitMinutesByEmpMonth, normEmp(e.employee_number), selectedMonth, { limit: contractOf.get(normEmp(e.employee_number))?.childcare_limit, ratePct: contractOf.get(normEmp(e.employee_number))?.childcare_rate_pct, method: contractOf.get(normEmp(e.employee_number))?.childcare_method }),
            // 夜朝の時間は実績の時間帯から自動で出す (2026-09-17)。画面で手入力すれば上書きできる
            yocho_hours: yochoHoursFromRecords(recsByEmpM.get(normEmp(e.employee_number)) ?? []),
            adjustment: adjustmentByNum.get(normEmp(e.employee_number)) ?? 0,
            overtime_excess_paid: overtimeExcessPaidRes.keys.has(`${selectedOffice.office_number}|${normEmp(e.employee_number)}`),
            // 事務員の訪問分 (介護): 時給者と同じ訪問ごとの金額 + 土日祝手当 (事業所の時給・日祝のみ の設定どおり)。2026-09-22
            office_worker_care_pay: officeWorkerCareRes.keys.has(`${selectedOffice.office_number}|${normEmp(e.employee_number)}`)
              ? (() => {
                  const recs = recsByEmpM.get(normEmp(e.employee_number)) ?? [];
                  const visitPay = recs.reduce((s, r) => s + (recordPayOf(r).pay ?? 0), 0);
                  const weekend = weekendHolidayAllowanceAmount(
                    weekendAllowanceMinutes({ summary, weekend_holiday_sunday_only: weekendRatesRes.sundayHolidayOnly.has(selectedOffice.office_number) }),
                    weekendRates[selectedOffice.office_number] ?? DEFAULT_WEEKEND_HOLIDAY_RATE);
                  return visitPay + weekend;
                })()
              : 0,
            overtime_offset_full_care: offsetFullCareRes.offices.has(selectedOffice.office_number),
            shinya_hours: shinyaHoursFromRecords(recsByEmpM.get(normEmp(e.employee_number)) ?? []),
            // 特日手当: Hana系 (0.75 掛けの事業所) は 介護時間と同じく 0.75 掛け対象を ×0.75 した時間で払う (おゆみ野 峯島 2026-08 960分 → 2,400円)
            tokubi_allowance: tokubiAllowanceAmount(care075Res.offices.has(selectedOffice.office_number)
              ? careMinutesFromRecords(withAccompanyByCode(recsByEmpM.get(normEmp(e.employee_number)) ?? [])
                  .filter((r) => isSpecialDay(r.service_date, specialDays) && (!r.accompanied_visit || r.accompanied_visit.trim() === "")), isCareHours075)
              : (summary.tokubiMinutes ?? 0)),
            // 介護時間 = 訪問 (0.75掛け対象は×0.75) + 研修・HRD研修の時間 (米倉・大治 2026-05 HRD研修1h で総括表と一致)
            // 0.75 掛けの減算は Hana 系だけ。他は 訪問時間 (同行込み) + 研修時間 (総括表 2026-03〜07、2026-09-18)
            care_minutes: careMinutesFromRecords(recsByEmpM.get(normEmp(e.employee_number)) ?? [],
              care075Res.offices.has(selectedOffice.office_number) ? isCareHours075 : () => false) + hrdTrainingMinutes(empOfRecs)
              // 研修の手入力 (書式に無い分) も 介護時間に足す。旧システムは HRD を介護超過の時間に入れている
              //   (おゆみ野 山本純子 2026-04: 訪問144.25 + HRD 1.0 + 重度×0.75 − 重度 − 120 = 18.125h × 2,500 = 45,313円)
              + (manualTrainingMinByNum.get(normEmp(e.employee_number)) ?? 0)
              + bathVisitCareMinutes(bathCountByEmp.get(normEmp(e.employee_number)) ?? 0)
              + Math.max(0, bathMinutesByEmp.get(normEmp(e.employee_number)) ?? 0),
            legal_within_minutes: legalWithinOvertimeMinutes(attByEmpM.get(normEmp(e.employee_number)) ?? [], empOfRecs),
            paid_leave_unit_price: e.paid_leave_unit_price ?? 0,
            // 欠勤日数: 出勤簿があれば出勤簿の「欠勤」(半欠勤 0.5)、無ければ事業所書式 (東郷 戸田 2026-03 は出勤簿で 4 日 = 総括表)
            absence_days: (() => {
              const att = attByEmpM.get(normEmp(e.employee_number)) ?? [];
              const notes = (a: AttendanceRecord) => [a.work_note_1, a.work_note_2, a.work_note_3, a.work_note_4, a.work_note_5].map((n) => n ?? "");
              if (att.length > 0) return att.reduce((s, a) => s + (notes(a).some((n) => n.includes("半欠")) ? 0.5 : notes(a).some((n) => n.includes("欠勤")) ? 1 : 0), 0);
              const cnt = (r: OfficeFormRecord) => (r.record_type === "km" ? Math.round((r.numeric_value as number) ?? 1) : listedDateCount(r.item_date));
              return empOfRecs.filter((r) => r.item_name === "欠勤").reduce((s, r) => s + cnt(r), 0)
                + empOfRecs.filter((r) => r.item_name === "半欠勤").reduce((s, r) => s + cnt(r), 0) * 0.5;
            })(),
            is_office_worker_for_deduction: roleM === "事務員" || (e.is_office_worker ?? false),
            // 月給者も 付与ごとの日当 (有給管理簿シートの値) で計算する。付与が無い人だけ 給与設定 → 職員マスタ の単価。
            // ⚠ 個人シートの日当は 前年度パートだった社員で総括表と食い違う (さつき 米倉 個人シート 7,712 / 管理簿 906)。
            //   有給管理簿シートの日当なら 2026-04〜07 の社員 224 件中 206 件一致
            // 提責・事務員は 有給休暇手当なし (総括表 2026-03〜07 で 357 件中 356 件が 0 円)。給与設定の単価があっても払わない (さつき 宮野 3 月の 54 円を引き継いでいた)
            paid_leave_allowance_override: ["提責", "事務員"].includes(roleM)
              ? 0
              : grantByEmpId.has(e.id)
              ? paidLeaveAllowanceOf(e.id, normEmp(e.employee_number), paidLeaveDays(summary.paidLeave, summary.halfLeave), e.paid_leave_unit_price ?? 0)
              : undefined,
            care_overtime_lower_tier: careTiersRes.tiers[office?.office_number ?? ""] ?? null,
            summary,
          };
        });
      for (const p of monthlySorted) {
        const num = normEmp(p.employee_number);
        const used: string[] = [];
        if (legacyTravel.has(num) && !legacyTravel.get(num)!.hourly) used.push("移動時間");
        if ((attByEmpM.get(num) ?? []).length === 0 && legacyWorkMinOf(num) != null) used.push("出勤時間");
        if ((legacyDailyOtMin.get(num) ?? 0) > 0) used.push("残業時間");
        if (used.length) (p as { legacy_used?: string[] }).legacy_used = used;
      }
      setMonthlyResults(monthlySorted);

      // 距離の確認: 1 日あたりの通勤km・出張km が 事業所の確認ラインを超えた人を出す (計算は止めない)
      {
        const linesRes = await getKmAnomalyLines(supabase);
        if (linesRes.error) throw new Error(`距離の確認ラインの読み込みに失敗: ${linesRes.error}`);
        const line = linesRes.lines[selectedOffice.office_number] ?? DEFAULT_KM_LINE;
        const tripKmOfHourly = (empNum: string, s: AttendanceSummary) => tripKmOf(empNum, s.businessKmTotal);
        setKmWarnings(findKmAnomalies([
          ...hourlySorted.map((e) => ({ employee_number: e.employee_number, employee_name: e.employee_name, commute_km: e.summary.commuteKmTotal, trip_km: tripKmOfHourly(e.employee_number, e.summary), work_days: e.summary.workDays })),
          ...monthlySorted.map((p) => ({ employee_number: String(p.employee_number), employee_name: p.employee_name, commute_km: p.summary.commuteKmTotal, trip_km: effectiveTravelKm(p), work_days: p.summary.workDays })),
        ], line));
      }

      // 総括表用に計算結果を保存。支給合計 (grand_total) は この画面と同じ関数で計算して持たせる
      // (総括表画面が別の式で合計していて、勤続手当・残業などが漏れていたため)
      const payload = {
        office_id: selectedOfficeId,
        office_number: selectedOffice.office_number,
        office_name: selectedOffice.short_name || selectedOffice.name,
        processing_month: selectedMonth,
        calculated_at: new Date().toISOString(),
        hourly: hourlySorted.map((e) => ({ ...e, grand_total: hourlyTotalPay(e) })),
        monthly: monthlySorted.map((p) => ({ ...p, grand_total: monthlyGrandTotal(p, otMap) })),
        overtime_settings: [...otMap.values()],
        // 旧システムのデータを使ったか (切り替えの前後を後から見分けるため)
        legacy_data: {
          enabled: useLegacyRes.enabled,
          hourly: hourlySorted.filter((e) => e.legacy_used?.length).length,
          monthly: monthlySorted.filter((p) => (p as { legacy_used?: string[] }).legacy_used?.length).length,
        },
      };
      // DB に保存 (2026-09-17)。別 PC からも総括表が見え、Excel との突合にも使う
      setProgress({ pct: 97, label: "計算結果を保存中" });
      {
        const { error: saveErr } = await supabase.from("payroll_calc_results").upsert({
          office_id: selectedOfficeId,
          office_number: selectedOffice.office_number,
          processing_month: selectedMonth,
          calculated_at: payload.calculated_at,
          payload,
        }, { onConflict: "office_number,processing_month" });
        if (!saveErr) {
          setSavedAt(payload.calculated_at);
          // 「DBに保存しました」を一瞬で消さず少しだけ見せる。
          // ⚠ ここを await しない (2026-09-20)。全事業所を続けて回すとき タブが裏に回ると
          //   Chrome の intensive throttling で setTimeout が 1分に引き延ばされ、1事業所あたり 1分 無駄になる
          setProgress({ pct: 100, label: "DBに保存しました" });
        }
        if (saveErr) {
          console.error("[payroll] 計算結果の DB 保存に失敗:", saveErr.message);
          setError(`計算は完了しましたが、結果をDBに保存できませんでした (${saveErr.message})。総括表はこのブラウザでのみ見られます。`);
        }
      }
      // ブラウザにも残す (DB 未適用環境・オフライン閲覧用)
      try {
        const key = `payroll-summary:${selectedOffice.office_number}:${selectedMonth}`;
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
      setProgress(null);
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
      "合計算定時間(分)","合計算定時間","本人給（パート）(円)","勤続手当単価","勤続手当(円)","資格手当(円)","処遇改善補助金手当(円)","報奨金(円)","移動時間","移動手当(円)","有給休暇手当(円)","調整手当(円)","育児手当(円)","HRD研修(円)","会議費(円)","保育手当(円)","その他手当(円)","通信手当(円)","土日祝手当(円)","キャンセル手当(円)","特日手当(円)","残業(円)","休日(円)","残業総額(円)","通勤費(円)","出張距離(km)","出張費(円)","総支給額(円)",
    ]];
    for (const e of hourlyResults) {
      const s = e.summary;
      const tenure = hourlyTenure(e);
      const total = hourlyTotalPay(e);
      rows.push([
        e.employee_number, e.employee_name, e.role_type,
        String(s.workDays), String(s.helperDays), String(s.paidLeave), String(s.halfLeave), String(s.specialLeave),
        formatWorkHours(s.workHoursMin),
        formatMinutes(s.visitMinutesExcludingAccompanied), formatMinutes(s.visitMinutes - s.visitMinutesExcludingAccompanied), formatMinutes(s.visitMinutes), formatMinutes(s.hrdMinutes),
        String(e.totalMinutes), formatMinutes(e.totalMinutes), String(e.totalPay + e.office_work_pay),
        String(computeTenureRate(e.has_care_qualification, e.effective_service_months, e.job_type)),
        String(tenure), "0", String(e.treatment_subsidy), "0",
        e.travel_time_sec > 0 ? secToHm(e.travel_time_sec) : "0:00", String(e.travel_allowance),
        String(e.paid_leave_allowance), "0", "0", String(e.training_pay), String(e.meeting_fee), String(e.childcare_allowance), "0",
        String(e.communication_fee),
        String(weekendHolidayAllowanceAmount(weekendAllowanceMinutes(e), e.weekend_holiday_rate)),
        String(e.cancel_allowance), String(e.tokubi_allowance ?? 0), "0", "0", "0",
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
    // monthlyResults の通常行 + 兼務職員の合算行（auth_user_id が同じ rows が 2+ ある場合のみ）
    // 各人物の最終行直後に「（合算）」行を 1 つ追加
    const authCountsCsv = new Map<string, number>();
    for (const p of monthlyResults) {
      if (!p.auth_user_id) continue;
      authCountsCsv.set(p.auth_user_id, (authCountsCsv.get(p.auth_user_id) ?? 0) + 1);
    }
    type SumAcc = {
      name: string;
      workDays: number; helperDays: number; paidLeave: number; halfLeave: number; specialLeave: number;
      workHoursMin: number; visitMinExcl: number; visitMinAcc: number; visitMin: number; hrdCount: number;
      travelKm: number; travelFee: number; commuteKm: number; commuteFee: number;
      base: number; skill: number; position: number; qual: number; tenure: number;
      treatImp: number; specTreat: number; treatSubsidy: number; fixedOt: number;
      otPay: number; otExcess: number; specialBonus: number; bonusPaid: number;
      travelMove: number; businessTrip: number; childcare: number; yochoHours: number; yochoAmt: number; careOt: number;
      total: number;
      rowCount: number;
    };
    const sumAcc = new Map<string, SumAcc>();
    const lastIdxByAuthCsv = new Map<string, number>();
    monthlyResults.forEach((p, i) => {
      if (p.auth_user_id && (authCountsCsv.get(p.auth_user_id) ?? 0) >= 2) {
        lastIdxByAuthCsv.set(p.auth_user_id, i);
      }
    });
    monthlyResults.forEach((p, i) => {
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
      // 合算用に蓄積
      if (p.auth_user_id && (authCountsCsv.get(p.auth_user_id) ?? 0) >= 2) {
        const cur = sumAcc.get(p.auth_user_id) ?? {
          name: p.employee_name,
          workDays: 0, helperDays: 0, paidLeave: 0, halfLeave: 0, specialLeave: 0,
          workHoursMin: 0, visitMinExcl: 0, visitMinAcc: 0, visitMin: 0, hrdCount: 0,
          travelKm: 0, travelFee: 0, commuteKm: 0, commuteFee: 0,
          base: 0, skill: 0, position: 0, qual: 0, tenure: 0,
          treatImp: 0, specTreat: 0, treatSubsidy: 0, fixedOt: 0,
          otPay: 0, otExcess: 0, specialBonus: 0, bonusPaid: 0,
          travelMove: 0, businessTrip: 0, childcare: 0, yochoHours: 0, yochoAmt: 0, careOt: 0,
          total: 0,
          rowCount: 0,
        };
        cur.workDays += sm.workDays; cur.helperDays += sm.helperDays; cur.paidLeave += sm.paidLeave;
        cur.halfLeave += sm.halfLeave; cur.specialLeave += sm.specialLeave;
        cur.workHoursMin += sm.workHoursMin;
        cur.visitMinExcl += sm.visitMinutesExcludingAccompanied;
        cur.visitMinAcc += (sm.visitMinutes - sm.visitMinutesExcludingAccompanied);
        cur.visitMin += sm.visitMinutes;
        cur.hrdCount += sm.hrdCount;
        cur.travelKm += effectiveTravelKm(p); cur.travelFee += travelFeeAmount(p);
        cur.commuteKm += sm.commuteKmTotal; cur.commuteFee += commuteFeeAmount(p);
        cur.base += s?.base_personal_salary ?? 0;
        cur.skill += s?.skill_salary ?? 0;
        cur.position += s?.position_allowance ?? 0;
        cur.qual += s?.qualification_allowance ?? 0;
        cur.tenure += s?.tenure_allowance ?? 0;
        cur.treatImp += s?.treatment_improvement ?? 0;
        cur.specTreat += s?.specific_treatment_improvement ?? 0;
        cur.treatSubsidy += s?.treatment_subsidy ?? 0;
        cur.fixedOt += s?.fixed_overtime_pay ?? 0;
        cur.otPay += computeOvertimePay(p, otSettings);
        cur.otExcess += overtimeExcessPay(p, otSettings);
        cur.specialBonus += s?.special_bonus ?? 0;
        cur.bonusPaid += p.bonus_paid ? (s?.bonus_amount ?? 0) : 0;
        cur.travelMove += travelFeeAmount(p);
        cur.businessTrip += p.business_trip_fee;
        cur.childcare += p.childcare_allowance;
        cur.yochoHours += p.yocho_hours;
        cur.yochoAmt += yochoAllowance(p);
        cur.careOt += careOvertimePay(p);
        cur.total += monthlyGrandTotal(p, otSettings);
        cur.rowCount += 1;
        sumAcc.set(p.auth_user_id, cur);
        // 最終行で合算を出力
        if (lastIdxByAuthCsv.get(p.auth_user_id) === i) {
          rows.push([
            "—", `${cur.name}（合算）`, `合算${cur.rowCount}件`,
            String(cur.workDays), String(cur.helperDays), String(cur.paidLeave), String(cur.halfLeave), String(cur.specialLeave),
            formatWorkHours(cur.workHoursMin),
            formatMinutes(cur.visitMinExcl), formatMinutes(cur.visitMinAcc), formatMinutes(cur.visitMin), String(cur.hrdCount),
            String(cur.travelKm), String(cur.travelFee), String(cur.commuteKm), String(cur.commuteFee),
            String(cur.base), String(cur.skill), String(cur.position), String(cur.qual), String(cur.tenure),
            String(cur.treatImp), String(cur.specTreat), String(cur.treatSubsidy),
            String(cur.fixedOt), String(cur.otPay), String(cur.otExcess), String(cur.specialBonus), String(cur.bonusPaid),
            String(cur.travelMove), String(cur.businessTrip),
            String(cur.childcare), String(cur.yochoHours), String(cur.yochoAmt), String(cur.careOt),
            String(cur.total),
          ]);
        }
      }
    });
    downloadCsv(`給与計算_${label}_月給者.csv`, rows);
  }

  const hourlyTenureTotal  = hourlyResults.reduce((s, e) => s + hourlyTenure(e), 0);
  const hourlyGrandTotal   = hourlyResults.reduce((s, e) => s + hourlyTotalPay(e), 0);
  const hourlyGrandMinutes = hourlyResults.reduce((s, e) => s + e.totalMinutes, 0);
  const monthlyGrandSum    = monthlyResults.reduce((s, p) => s + monthlyGrandTotal(p, otSettings), 0);

  // ─── 兼務職員の合算行（月給者タブ） ───────────────────────────
  // 同じ auth_user_id を持つ MonthlyPayroll が 2+ 件あれば、
  // 各 row の下に「合算」行を 1 つ挿入。auth_user_id NULL の行は対象外。
  // 通常 monthlyResults は 1 事業所内のため、同じ auth_user_id が 2+ 件
  // 出るケースは限定的だが、将来複数事業所をまたぐ表示にしても破綻しないよう実装。
  type MonthlyRow =
    | { kind: "row"; p: MonthlyPayroll }
    | { kind: "sum"; key: string; name: string; total: number; basePersonalSalary: number; visitMinutes: number; workHoursMin: number; rowCount: number };
  const monthlyAuthCounts = new Map<string, number>();
  for (const p of monthlyResults) {
    if (!p.auth_user_id) continue;
    monthlyAuthCounts.set(p.auth_user_id, (monthlyAuthCounts.get(p.auth_user_id) ?? 0) + 1);
  }
  const monthlySumByAuth = new Map<string, { name: string; total: number; basePersonalSalary: number; visitMinutes: number; workHoursMin: number; rowCount: number }>();
  for (const p of monthlyResults) {
    if (!p.auth_user_id || (monthlyAuthCounts.get(p.auth_user_id) ?? 0) < 2) continue;
    const cur = monthlySumByAuth.get(p.auth_user_id) ?? { name: p.employee_name, total: 0, basePersonalSalary: 0, visitMinutes: 0, workHoursMin: 0, rowCount: 0 };
    cur.total += monthlyGrandTotal(p, otSettings);
    cur.basePersonalSalary += p.settings?.base_personal_salary ?? 0;
    cur.visitMinutes += p.summary.visitMinutes;
    cur.workHoursMin += p.summary.workHoursMin;
    cur.rowCount += 1;
    monthlySumByAuth.set(p.auth_user_id, cur);
  }
  const monthlyLastIdxByAuth = new Map<string, number>();
  monthlyResults.forEach((p, i) => {
    if (p.auth_user_id && (monthlyAuthCounts.get(p.auth_user_id) ?? 0) >= 2) {
      monthlyLastIdxByAuth.set(p.auth_user_id, i);
    }
  });
  const monthlyRowsWithSum: MonthlyRow[] = [];
  monthlyResults.forEach((p, i) => {
    monthlyRowsWithSum.push({ kind: "row", p });
    if (p.auth_user_id && monthlyLastIdxByAuth.get(p.auth_user_id) === i) {
      const sum = monthlySumByAuth.get(p.auth_user_id);
      if (sum) monthlyRowsWithSum.push({ kind: "sum", key: `sum:${p.auth_user_id}`, ...sum });
    }
  });

  // ─── 描画 ─────────────────────────────────────────────────────

  // 居宅介護支援 office を選択中は専用 dashboard を表示
  // (訪問介護とは給与計算ロジック/データ source が異なる: 国保連 CSV ベース)
  // 全社横断 view が default で、選択中 office があれば初期絞り込みとして渡す。
  const currentOffice = offices.find((o) => o.id === selectedOfficeId);
  if (currentOffice?.office_type === "居宅介護支援") {
    const allKyotakuOffices = offices
      .filter((o) => o.office_type === "居宅介護支援")
      .map((o) => ({
        id: o.id,
        office_number: o.office_number,
        short_name: o.short_name || o.name,
        name: o.name,
      }));
    return (
      <KyotakuPayrollDashboard
        allKyotakuOffices={allKyotakuOffices}
        initialOfficeNumber={currentOffice.office_number}
      />
    );
  }

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
              {loading ? `計算中… ${progress?.pct ?? 0}%` : "給与計算を実行"}
            </Button>
          </div>
          {!loading && savedAt && (
            <div className="mt-4 rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800">
              ✓ 計算が完了し、結果をDBに保存しました（{new Date(savedAt).toLocaleString("ja-JP")}）。総括表の画面でも見られます。
            </div>
          )}
          {loading && progress && (
            <div className="mt-4" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.pct}>
              <div className="flex justify-between text-xs text-muted-foreground mb-1">
                <span>{progress.label}</span>
                <span className="font-mono">{progress.pct}%</span>
              </div>
              <div className="h-2 w-full rounded bg-muted overflow-hidden">
                <div className="h-full bg-primary transition-all duration-300" style={{ width: `${progress.pct}%` }} />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {error && (
        <div className="mb-4 p-3 bg-destructive/10 text-destructive rounded text-sm">{error}</div>
      )}
      {kmWarnings.length > 0 && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-300 text-amber-900 rounded text-sm">
          <p className="font-medium">⚠ 距離を確認してください（1日あたりの距離が この事業所の確認ラインを超えています）</p>
          <ul className="mt-1 space-y-0.5">
            {kmWarnings.map((w) => (
              <li key={`${w.employee_number}-${w.kind}`}>
                {w.employee_name}（{w.employee_number}）{w.kind}距離 {w.km.toLocaleString()}km ÷ 出勤 {w.days}日 = <b>{w.per_day.toLocaleString()}km/日</b>（ライン {w.line}km/日）
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs">入力ミス（金額や小数点の打ち間違い）でないか事業所書式・出勤簿を確かめてください。本当に遠い場合はそのままで構いません。</p>
        </div>
      )}
      {distanceWarning && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-300 text-amber-900 rounded text-sm">⚠ {distanceWarning}</div>
      )}
      {(() => {
        const h = hourlyResults.filter((e) => e.legacy_used?.length).length;
        const m = monthlyResults.filter((p) => p.legacy_used?.length).length;
        return h + m > 0 ? (
          <div className="mb-4 p-3 bg-sky-50 border border-sky-200 text-sky-900 rounded text-sm">
            旧システムのデータ (移動時間・出勤時間) を使った人: 時給 {h} 名 / 月給 {m} 名。名前の横の「旧」で分かります。
            本格稼働の前に 設定 use_legacy_data を切り替えると 当システムだけで計算します。
          </div>
        ) : null;
      })()}

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

              {/*
                有給を取っているのに手当が 0 円になっている職員。

                労基法39条9項は有給の日に「平均賃金」「通常の賃金」「標準報酬日額」の
                いずれかを支払うことを求めていて、**0 円は選択肢に無い**。
                2026-09-01 時点で payroll_employees.paid_leave_unit_price は
                在職 778 名すべて 0 で、実績側には 53 行 / 25 名の有給がある。

                ⚠ いくら払うかは就業規則で決めるものなので **ここで金額を作らない**。
                  黙って 0 円で CSV に出るのを止めて、設定へ誘導するだけにする。

                ⚠ 半有給 (halfLeave) は CSV と一覧には出るが **どの支給式にも入っていない**。
                  単価を設定しても半休ぶんは 0 円のままなので、それも併せて出す。
              */}
              {(() => {
                const rows = hourlyResults
                  .filter((e) => (e.summary.paidLeave > 0 || e.summary.halfLeave > 0) && e.paid_leave_allowance <= 0)
                  .map((e) => ({ name: e.employee_name, no: e.employee_number,
                                 full: e.summary.paidLeave, half: e.summary.halfLeave }))
                  .sort((a, b) => (b.full + b.half) - (a.full + a.half));
                if (rows.length === 0) return null;
                const totalFull = rows.reduce((s, r) => s + r.full, 0);
                const totalHalf = rows.reduce((s, r) => s + r.half, 0);
                return (
                  <Card className="mb-4 border-red-300 bg-red-50/50">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm text-red-900">
                        ⚠ 有給を取得しているのに手当が 0 円: {rows.length}名 / 全休{totalFull}日
                        {totalHalf > 0 ? ` ・半休${totalHalf}日` : ""}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                      <p className="px-3 pb-2 text-xs text-red-800">
                        従業員マスタの<strong>有給単価</strong>が未設定です。労基法39条9項は有給の日に
                        「平均賃金」「通常の賃金」「標準報酬日額」のいずれかを払うことを求めており、0 円は選択肢にありません。
                        <a href="/employees" className="underline ml-1">従業員マスタで設定する</a>
                        {totalHalf > 0 && (
                          <>
                            <br />
                            なお<strong>半有給はどの支給式にも入っていない</strong>ため、単価を設定しても半休ぶんは 0 円のままです。
                          </>
                        )}
                      </p>
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-red-200 bg-red-100/50">
                            <th className="text-left px-3 py-1.5 font-medium">社員No</th>
                            <th className="text-left px-3 py-1.5 font-medium">氏名</th>
                            <th className="text-right px-3 py-1.5 font-medium">全休</th>
                            <th className="text-right px-3 py-1.5 font-medium">半休</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr key={r.no} className="border-b border-red-100">
                              <td className="px-3 py-1 font-mono">{r.no}</td>
                              <td className="px-3 py-1">{r.name}</td>
                              <td className="px-3 py-1 text-right">{r.full || "—"}</td>
                              <td className="px-3 py-1 text-right">{r.half || "—"}</td>
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
                        const tenure = hourlyTenure(emp);
                        const grandTotal = hourlyTotalPay(emp);
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
                                  {emp.legacy_used?.length ? <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-800" title={`旧システムのデータを使用: ${emp.legacy_used.join("・")}`}>旧</span> : null}
                                </div>
                              </td>
                              <td className="px-3 py-2"><RoleBadge role={emp.role_type} /></td>
                              <td className="px-3 py-2 text-right">{sm.workDays}</td>
                              <td className="px-3 py-2 text-right">{sm.helperDays}</td>
                              <td className="px-3 py-2 text-right">{sm.paidLeave || "—"}</td>
                              <td className="px-3 py-2 text-right">{sm.specialLeave || "—"}</td>
                              <td className="px-3 py-2 text-right text-muted-foreground text-xs">—</td>
                              <td className="px-3 py-2 text-right">{formatWorkHours(sm.workHoursMin)}</td>
                              <td className="px-3 py-2 text-right">
                                {emp.office_work_minutes > 0
                                  ? <span title={`事務時給 ${emp.office_work_hourly_rate.toLocaleString()}円`}>{formatWorkHours(emp.office_work_minutes)}{emp.office_work_pay > 0 ? <span className="ml-1 text-xs text-muted-foreground">({yen(emp.office_work_pay)})</span> : <span className="ml-1 text-xs text-yellow-700">(事務時給未設定)</span>}</span>
                                  : <span className="text-muted-foreground text-xs">—</span>}
                              </td>
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
                              <td className="px-3 py-2 text-right">{(emp.tokubi_allowance ?? 0) > 0 ? yen(emp.tokubi_allowance ?? 0) : <span className="text-muted-foreground text-xs">—</span>}</td>
                              <td className="px-3 py-2 text-right">{weekendAllowanceMinutes(emp) > 0 ? yen(weekendHolidayAllowanceAmount(weekendAllowanceMinutes(emp), emp.weekend_holiday_rate)) : <span className="text-muted-foreground text-xs">—</span>}</td>
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
                                        <td className="py-2 text-right">{yen(emp.totalPay)}{emp.office_work_pay > 0 ? ` + 事務 ${yen(emp.office_work_pay)}` : ""}{tenure > 0 ? ` + 勤続 ${yen(tenure)}` : ""}{emp.office_work_pay > 0 || tenure > 0 ? ` (総支給 ${yen(grandTotal)})` : ""}</td>
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
                        <td className="px-3 py-2 text-right">{hourlyResults.some((e) => e.office_work_minutes > 0) ? formatWorkHours(hourlyResults.reduce((s, e) => s + e.office_work_minutes, 0)) : ""}</td><td></td><td></td>
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
                        <td className="px-3 py-2 text-right">{yen(hourlyResults.reduce((s, e) => s + (e.tokubi_allowance ?? 0), 0))}</td>
                        {/* 土日祝 */}
                        <td className="px-3 py-2 text-right">{yen(hourlyResults.reduce((s, e) => s + weekendHolidayAllowanceAmount(weekendAllowanceMinutes(e), e.weekend_holiday_rate), 0))}</td>
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
                      {monthlyRowsWithSum.map((row) => {
                        if (row.kind === "sum") {
                          return (
                            <tr
                              key={row.key}
                              className="border-b bg-muted/30 italic text-muted-foreground"
                              title="兼務職員の合算（複数事業所の合計）"
                            >
                              <td className="px-3 py-2 sticky left-0 z-10 bg-muted/30">
                                <div className="flex flex-col">
                                  <span className="font-mono text-xs">—</span>
                                  <span className="font-medium">{row.name}（合算）</span>
                                </div>
                              </td>
                              <td className="px-3 py-2"><span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-600">合算 {row.rowCount}件</span></td>
                              {/* 出勤日数～HRD: 7列 */}
                              <td></td><td></td><td></td><td></td><td></td>
                              <td className="px-3 py-2 text-right">{formatWorkHours(row.workHoursMin)}</td>
                              <td></td><td></td>
                              <td className="px-3 py-2 text-right">{row.visitMinutes ? formatMinutes(row.visitMinutes) : "—"}</td>
                              <td></td>
                              {/* 出張距離・通勤距離 */}
                              <td></td><td></td>
                              {/* 本人給 */}
                              <td className="px-3 py-2 text-right">{row.basePersonalSalary > 0 ? yen(row.basePersonalSalary) : "—"}</td>
                              {/* 職能給, 役職手当, 資格手当, 勤続手当, 処遇改善, 特定処遇, 処遇補助金, 固定残業代, 残業代, 残業代超過, 特別報奨金, 介護超過手当, 出張手当, 通勤手当, 育児手当: 15 列空 */}
                              <td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td>
                              <td></td><td></td><td></td><td></td><td></td><td></td><td></td>
                              {/* 合計 */}
                              <td className="px-3 py-2 text-right font-bold">{yen(row.total)}</td>
                              {/* 展開 chevron 列 */}
                              <td></td>
                            </tr>
                          );
                        }
                        const p = row.p;
                        const s  = p.settings;
                        const sm = p.summary;
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
                                  {p.legacy_used?.length ? <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-800" title={`旧システムのデータを使用: ${p.legacy_used.join("・")}`}>旧</span> : null}
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
                                          {monthlyPaidLeaveAllowance(p) > 0 && <DetailLine label="有給休暇手当" v={monthlyPaidLeaveAllowance(p)} />}
                                          {absenceDeduction(p) > 0 && <DetailLine label={`欠勤控除 (${p.absence_days ?? 0}日)`} v={-absenceDeduction(p)} />}
                                          {(p.adjustment ?? 0) !== 0 && <DetailLine label="調整手当・過誤 (手入力)" v={p.adjustment ?? 0} />}
                                          <DetailLine label="特別報奨金" v={s.special_bonus} />
                                          {p.bonus_paid && s.bonus_amount > 0 && <DetailLine label="報奨金" v={s.bonus_amount} />}
                                          {(p.office_worker_care_pay ?? 0) > 0 && <DetailLine label="介護 (事務員の訪問分)" v={p.office_worker_care_pay ?? 0} />}
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
                                          <p className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
                                            <span>報奨金 {yen(s.bonus_amount)}: <span className="font-medium">{p.bonus_paid ? "支給する" : "支給しない"}</span></span>
                                            <Link href="/bonus-payments" className="text-xs text-blue-700 underline">報奨金の支給で変える</Link>
                                          </p>
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
