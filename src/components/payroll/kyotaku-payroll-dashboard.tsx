"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fetchAllPagesParallel } from "@/lib/fetch-all";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MonthInputButton } from "@/components/ui/month-input-button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  addMonths,
  calcAdjustments,
  calcPaymentForMonth,
  calcSalary,
  getBaseUnit,
  type CalcConfig,
  type Confirmation,
  type EmployeeSetting,
  type KyotakuAttendanceRecord,
  type KyotakuRecord,
  type RegionalRate,
  type ServiceUnit,
  type YobouRecord,
} from "@/lib/payroll/kyotaku-calc";
import { KyotakuSettingsModal } from "./kyotaku-settings-modal";

/**
 * 居宅介護支援 給与計算 dashboard (Phase 2 / 全社横断 view)
 *
 * 集計.py の Excel 5 sheet 相当 (給与計算 / 支払いサマリー / 売上表 / 利用者内訳 /
 * 差異明細) を Web UI で表示する。本社運用想定で複数事業所を default 横断集計し、
 * chip filter で個別事業所に絞り込みも可能。
 *
 * データソース:
 *   - payroll_kyotaku_records          国保連 CSV row (一覧)
 *   - payroll_employees                ケアマネ別 (6 列分解: kyotaku_honnin_kyu / shokuno_kyu /
 *                                       kotei_zangyo / shikaku_teate / kotei / tokutei_shogu /
 *                                       + kyotaku_kaigo_rate / kyotaku_shien_rate)
 *                                       ※ 旧 kyotaku_base_salary は DB 残置 (rollback 用、参照しない)
 *   - payroll_kyotaku_service_units    項目別 単位数 (tenant 共通)
 *   - payroll_kyotaku_regional_rates   保険者 → 円/単位 (tenant 共通)
 *   - payroll_kyotaku_confirmations    支給済み (reverted_at IS NULL のみ active)
 *
 * 仕様: apps/居宅給与計算/SPEC.md §4
 */

type KyotakuOffice = {
  /** payroll_offices.id (UUID)。payroll_employees.office_id への FK 値として使用 */
  id: string;
  office_number: string;
  short_name: string;
  name: string;
};

type Props = {
  /** 居宅介護支援 office 一覧 (page から渡される。空配列なら empty 表示) */
  allKyotakuOffices: KyotakuOffice[];
  /** 初期絞り込み office_number (省略時は「全社」mode で起動) */
  initialOfficeNumber?: string | null;
};

// =====================================================================
// DB row 型 (calc.ts の KyotakuRecord を拡張: 利用者内訳 / 売上表で追加列が要る)
// =====================================================================

type FullRecord = KyotakuRecord & {
  id: string;
  office_number: string;
  insured_number: string | null;
  insured_name: string | null;
  client_number: string | null;
  service_code: string | null;
};

type SettingRow = EmployeeSetting & {
  id?: string;
  office_number: string;
};

type ConfirmationRow = Confirmation & {
  id: string;
  office_number: string;
  confirmed_at: string;
  reverted_at: string | null;
};

type YobouRow = YobouRecord & {
  id: string;
  tenant_id: string;
  office_number: string;
  source: "csv" | "manual";
  source_filename: string | null;
};

/**
 * 出勤簿 row (出張距離手当 用、staff_name 解決済)。
 * 元 row (payroll_kyotaku_attendance_records) は employee_id key だが、
 * 給与計算は staff_name key なので payroll_employees の (id → name) で
 * 変換した形で保持する。
 */
type AttendanceWithStaffName = KyotakuAttendanceRecord & {
  office_number: string;
};

// =====================================================================
// utility
// =====================================================================

const TENANT_ID = "kt-group";
const ALL_OFFICES_KEY = "__ALL__";

/** YYYY-MM-01 → "2025年05月" (header 表示用) */
function fmtMonthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(month);
  if (!m) return month;
  return `${m[1]}年${m[2]}月`;
}

/** number → "1,234" (整数前提)。0 は "0"。負値は "-1,234" */
function fmtYen(n: number): string {
  if (!Number.isFinite(n)) return "";
  return Math.round(n).toLocaleString("ja-JP");
}

/** 数値の符号表示 (差異明細用): +1234 / -1234 / 0 */
function fmtSigned(n: number): string {
  const r = Math.round(n);
  if (r === 0) return "0";
  if (r > 0) return `+${r.toLocaleString("ja-JP")}`;
  return r.toLocaleString("ja-JP");
}

/** 集合 key (office_number|staff_name) 用の helper */
function staffKey(officeNumber: string, staffName: string): string {
  return `${officeNumber}|${staffName}`;
}

/** all_months から pay_months (各月の +1 / +2 / +3 の和集合) を返す */
function deriveAllPayMonths(months: string[]): string[] {
  const s = new Set<string>();
  for (const m of months) {
    s.add(addMonths(m, 1));
    s.add(addMonths(m, 2));
    s.add(addMonths(m, 3));
  }
  return Array.from(s).sort();
}

/** 保険者名 → rate map (見つからなければ 10.0) */
function makeRateMap(rates: RegionalRate[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rates) m.set(r.insurer_name, r.rate);
  return m;
}

/** records を office_number 別に partition */
function partitionByOffice<T extends { office_number: string }>(
  rows: T[],
): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const arr = m.get(r.office_number) ?? [];
    arr.push(r);
    m.set(r.office_number, arr);
  }
  return m;
}

// =====================================================================
// 件数集計 (給与計算 sheet の上半分: 8 行 × month の表)
// =====================================================================

type CountKey =
  | "same_shien"
  | "same_kaigo"
  | "normal_shien"
  | "normal_kaigo"
  | "late1_shien"
  | "late1_kaigo"
  | "late2_shien"
  | "late2_kaigo";

const COUNT_ROWS: ReadonlyArray<{ key: CountKey; label: string }> = [
  { key: "same_shien", label: "要支援件数（当月請求）" },
  { key: "same_kaigo", label: "要介護件数（当月請求）" },
  { key: "normal_shien", label: "要支援件数（翌月請求）" },
  { key: "normal_kaigo", label: "要介護件数（翌月請求）" },
  { key: "late1_shien", label: "月遅れ要支援（翌々月請求）" },
  { key: "late1_kaigo", label: "月遅れ要介護（翌々月請求）" },
  { key: "late2_shien", label: "月遅れ要支援（3か月後請求）" },
  { key: "late2_kaigo", label: "月遅れ要介護（3か月後請求）" },
];

/** YYYY-MM-01 形式の月文字列 m1, m2 の月差 (= m2 - m1)。失敗時は NaN。 */
function monthDelayDiff(serviceMonth: string, billingMonth: string): number {
  const sm = serviceMonth.slice(0, 7);
  const bm = billingMonth.slice(0, 7);
  if (!sm || !bm) return NaN;
  const smN = parseInt(sm.replace("-", ""), 10);
  const bmN = parseInt(bm.replace("-", ""), 10);
  if (!Number.isFinite(smN) || !Number.isFinite(bmN)) return NaN;
  const sy = Math.floor(smN / 100);
  const ssm = smN % 100;
  const by = Math.floor(bmN / 100);
  const bbm = bmN % 100;
  return (by - sy) * 12 + (bbm - ssm);
}

/**
 * 件数を「office 内の records だけ」「該当 staff_name のみ」で集計する。
 * 全社 view では office_number で事前 partition した records を渡す前提。
 *
 * yobouRecords (介護予防支援) は別 source として 要支援1/2 件数を delay 別に加算する。
 */
function countCells(
  officeRecords: FullRecord[],
  staff: string,
  month: string,
  officeYobou?: YobouRow[],
): Record<CountKey, number> {
  const out: Record<CountKey, number> = {
    same_shien: 0,
    same_kaigo: 0,
    normal_shien: 0,
    normal_kaigo: 0,
    late1_shien: 0,
    late1_kaigo: 0,
    late2_shien: 0,
    late2_kaigo: 0,
  };

  for (const r of officeRecords) {
    if (r.staff_name !== staff) continue;
    if (r.service_month !== month) continue;
    if (r.detail_row_no !== "1") continue;
    if (!r.care_level) continue;

    const isKaigo = r.care_level.startsWith("要介護");
    const isShien = r.care_level.startsWith("要支援");
    if (!isKaigo && !isShien) continue;

    const delay = monthDelayDiff(r.service_month, r.billing_month);
    if (!Number.isFinite(delay)) continue;

    if (delay <= 0) {
      if (isKaigo) out.same_kaigo += 1;
      else out.same_shien += 1;
    } else if (delay === 1) {
      if (isKaigo) out.normal_kaigo += 1;
      else out.normal_shien += 1;
    } else if (delay === 2) {
      if (isKaigo) out.late1_kaigo += 1;
      else out.late1_shien += 1;
    } else {
      if (isKaigo) out.late2_kaigo += 1;
      else out.late2_shien += 1;
    }
  }

  if (officeYobou && officeYobou.length > 0) {
    for (const yr of officeYobou) {
      if (yr.staff_name !== staff) continue;
      if (yr.service_month !== month) continue;
      const add = (yr.yobou1_count ?? 0) + (yr.yobou2_count ?? 0);
      if (add === 0) continue;
      const delay = monthDelayDiff(yr.service_month, yr.billing_month);
      if (!Number.isFinite(delay)) continue;

      if (delay <= 0) out.same_shien += add;
      else if (delay === 1) out.normal_shien += add;
      else if (delay === 2) out.late1_shien += add;
      else out.late2_shien += add;
    }
  }

  return out;
}

// =====================================================================
// 売上表 (項目別売上、地域加算込)
// =====================================================================

/**
 * care_level (records 由来、全角想定: 要介護１/要介護２/.../要支援１/要支援２) を
 * 売上表 master の item_name (要介護１～２ / 要介護３～５ / 要支援１ / 要支援２) に
 * マッピングする。半角数字混入も保険として吸収。
 * 該当 master 行が units に存在しなければ null (= 単位数 master 未投入で skip)。
 */
function mapCareLevelToMasterItem(
  careLevel: string,
  units: ServiceUnit[],
): string | null {
  // 半角 → 全角 数字正規化 (master / records どちら向きでも吸収できる)
  const z = careLevel.replace(/[0-9]/g, (d) =>
    String.fromCharCode(d.charCodeAt(0) + 0xfee0),
  );
  // master 側に存在する key を返す (全角チルダ U+FF5E / 互換 U+301C を許容)
  const findExisting = (...keys: string[]): string | null => {
    for (const k of keys) {
      if (units.some((u) => u.item_name === k)) return k;
    }
    return null;
  };
  if (z === "要介護１" || z === "要介護２") {
    return findExisting("要介護１～２", "要介護１〜２");
  }
  if (z === "要介護３" || z === "要介護４" || z === "要介護５") {
    return findExisting("要介護３～５", "要介護３〜５");
  }
  if (z === "要支援１") return findExisting("要支援１");
  if (z === "要支援２") return findExisting("要支援２");
  return null;
}

function resolveRecordUnit(
  r: FullRecord,
  units: ServiceUnit[],
): { itemName: string; unit: number } | null {
  if (r.detail_row_no === "1") {
    if (!r.care_level) return null;
    const u = getBaseUnit(r.care_level, units);
    if (u === 0) return null;
    const itemName = mapCareLevelToMasterItem(r.care_level, units);
    if (!itemName) return null;
    return { itemName, unit: u };
  }
  if (!r.service_name) return null;
  for (const u of units) {
    if (!u.item_name) continue;
    if (r.service_name.includes(u.item_name)) {
      return { itemName: u.item_name, unit: u.unit_count };
    }
  }
  return null;
}

// =====================================================================
// 確定 button helper
// =====================================================================

/** activeConfirmations から (office_number, staff, pay_month) → amount を作る */
function buildPaidMap(confirmations: ConfirmationRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of confirmations) {
    if (c.reverted_at) continue;
    m.set(`${c.office_number}|${c.staff_name}|${c.pay_month}`, c.amount);
  }
  return m;
}

/** (office_number, staff, pay_month) の active confirmation row を返す */
function findActiveConfirmation(
  confirmations: ConfirmationRow[],
  officeNumber: string,
  staff: string,
  payMonth: string,
): ConfirmationRow | null {
  for (const c of confirmations) {
    if (c.reverted_at) continue;
    if (c.office_number !== officeNumber) continue;
    if (c.staff_name !== staff) continue;
    if (c.pay_month !== payMonth) continue;
    return c;
  }
  return null;
}

// =====================================================================
// Main Component
// =====================================================================

export function KyotakuPayrollDashboard({
  allKyotakuOffices,
  initialOfficeNumber,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [records, setRecords] = useState<FullRecord[]>([]);
  const [settings, setSettings] = useState<SettingRow[]>([]);
  const [units, setUnits] = useState<ServiceUnit[]>([]);
  const [rates, setRates] = useState<RegionalRate[]>([]);
  const [confirmations, setConfirmations] = useState<ConfirmationRow[]>([]);
  const [yobouRows, setYobouRows] = useState<YobouRow[]>([]);
  /** 出勤簿 row (staff_name 解決済)、出張距離手当 算出用 */
  const [attendanceRows, setAttendanceRows] = useState<AttendanceWithStaffName[]>([]);
  /** office_number → travel_unit_price (円/km)。出張距離手当 単価 */
  const [officeTravelRateMap, setOfficeTravelRateMap] = useState<Map<string, number>>(
    new Map(),
  );

  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  // 設定 modal は office_number 単位なので、開く時に対象 office を保持する
  const [settingsModalOffice, setSettingsModalOffice] =
    useState<KyotakuOffice | null>(null);
  const [busyPay, setBusyPay] = useState<string | null>(null);

  /** 絞り込み office_number。null = 全社横断 mode */
  const [filterOfficeNumber, setFilterOfficeNumber] = useState<string | null>(
    initialOfficeNumber ?? null,
  );

  // ----------------------- data fetch -----------------------
  // 全居宅介護支援 office の records を一括 fetch (RLS は authenticated_all なので OK)。
  // 絞り込みは memo 段階で行う (記録の二重 fetch 回避)。

  const officeNumbers = useMemo(
    () => allKyotakuOffices.map((o) => o.office_number),
    [allKyotakuOffices],
  );

  // payroll_employees.office_id (= payroll_offices.id) で絞り込むために UUID list を作る。
  // 1000 行 PostgREST default limit 対策: 全 employees fetch (~数千件) は limit に
  // 引っ掛かるが、居宅介護支援 office (~30 件) だけに絞れば数百件で完結する。
  const officeIds = useMemo(
    () => allKyotakuOffices.map((o) => o.id),
    [allKyotakuOffices],
  );

  // office_number → office (short_name 解決) の lookup
  const officeMap = useMemo(() => {
    const m = new Map<string, KyotakuOffice>();
    for (const o of allKyotakuOffices) m.set(o.office_number, o);
    return m;
  }, [allKyotakuOffices]);

  // 表示順 (allKyotakuOffices の順番 = page 側の sort 結果を尊重)
  const officeOrder = useMemo(() => {
    const m = new Map<string, number>();
    allKyotakuOffices.forEach((o, i) => m.set(o.office_number, i));
    return m;
  }, [allKyotakuOffices]);

  const fetchAll = async () => {
    setLoading(true);
    setErr(null);
    try {
      if (officeNumbers.length === 0) {
        setRecords([]);
        setSettings([]);
        setUnits([]);
        setRates([]);
        setConfirmations([]);
        setYobouRows([]);
        setAttendanceRows([]);
        setOfficeTravelRateMap(new Map());
        return;
      }

      const [recs, setRes, unitRes, rateRes, confRes, yobouRes, attRes, officeRes] = await Promise.all([
        fetchAllPagesParallel<FullRecord>(
          () =>
            supabase
              .from("payroll_kyotaku_records")
              .select("*", { count: "exact", head: true })
              .in("office_number", officeNumbers),
          (from, to) =>
            supabase
              .from("payroll_kyotaku_records")
              .select("*")
              .in("office_number", officeNumbers)
              .order("office_number")
              .order("service_month")
              .range(from, to) as unknown as PromiseLike<{
              data: FullRecord[] | null;
            }>,
        ),
        // 給与設定は payroll_employees の 3 列に集約 (2026-05-13 移行)。
        // payroll_employees.office_id は payroll_offices.id への FK。office_number で
        // partition したいので embed で payroll_offices.office_number を引き寄せる。
        // 全 employees fetch すると PostgREST default 1000 行 limit に引っ掛かり、
        // id 順で範囲外の居宅介護支援ケアマネが落ちる (memory: 1253 件 backfill 済)。
        // 居宅介護支援 office (~30 件) に絞れば数百件で完結し limit を回避できる。
        supabase
          .from("payroll_employees")
          .select(
            "id, name, kyotaku_honnin_kyu, kyotaku_shokuno_kyu, kyotaku_kotei_zangyo, kyotaku_shikaku_teate, kyotaku_kotei, kyotaku_tokutei_shogu, kyotaku_kaigo_rate, kyotaku_shien_rate, office:payroll_offices!office_id(office_number)",
          )
          .in("office_id", officeIds),
        supabase.from("payroll_kyotaku_service_units").select("*"),
        supabase.from("payroll_kyotaku_regional_rates").select("*"),
        supabase
          .from("payroll_kyotaku_confirmations")
          .select("*")
          .in("office_number", officeNumbers)
          .is("reverted_at", null),
        // 介護予防支援件数 (CSV 取込 + 手入力)。1 row = staff × 提供月 × 請求月 の
        // 集約形式なので、~30 office × ~数年 × ~ケアマネ数 でも数千行に収まる前提。
        // DB に table 未 apply の段階では空配列を fallback (error は捕捉して握り潰す)。
        supabase
          .from("payroll_kyotaku_yobou_records")
          .select("*")
          .in("office_number", officeNumbers),
        // 出勤簿 (出張距離手当 算出用)。employee_id + work_date + business_km のみ。
        // ~30 office × ~ケアマネ数 × ~日数 = 数千〜数万行になり得る。1000 行 PostgREST
        // limit を超える前提なら fetchAllPagesParallel に切替が必要だが、まずは
        // .limit(10000) で運用 (DB 未 apply 時は error 握り潰し → 空 fallback)。
        // business_km は migration apply 前は列が無いので error になり得る → 同じく
        // 空 fallback。
        supabase
          .from("payroll_kyotaku_attendance_records")
          .select("employee_id, work_date, business_km, office_id")
          .in("office_id", officeIds)
          .not("business_km", "is", null)
          .limit(10000),
        // 事業所の出張距離単価 (NUMERIC 10,2)。office_number → travel_unit_price。
        supabase
          .from("payroll_offices")
          .select("office_number, travel_unit_price")
          .in("office_number", officeNumbers),
      ]);

      if (setRes.error) throw setRes.error;
      if (unitRes.error) throw unitRes.error;
      if (rateRes.error) throw rateRes.error;
      if (confRes.error) throw confRes.error;
      // yobouRes は DB 未 apply 段階の error を許容 (空配列 fallback)

      setRecords(recs);
      // payroll_employees row → SettingRow に flatten。office_number は embed 経由で
      // 取り出す。embed は 1:1 (employees.office_id → offices.id) なので object。
      // 居宅介護支援以外の office に紐づく employee は office_number が
      // officeNumbers 集合に含まれないため partitionByOffice で自然に除外される。
      type RawEmployeeRow = {
        id: string;
        name: string;
        kyotaku_honnin_kyu: number | null;
        kyotaku_shokuno_kyu: number | null;
        kyotaku_kotei_zangyo: number | null;
        kyotaku_shikaku_teate: number | null;
        kyotaku_kotei: number | null;
        kyotaku_tokutei_shogu: number | null;
        kyotaku_kaigo_rate: number | null;
        kyotaku_shien_rate: number | null;
        office: { office_number: string | null } | null;
      };
      const officeNumberSet = new Set(officeNumbers);
      const mappedSettings: SettingRow[] = [];
      for (const r of (setRes.data ?? []) as unknown as RawEmployeeRow[]) {
        const officeNumber = r.office?.office_number ?? "";
        if (!officeNumber || !officeNumberSet.has(officeNumber)) continue;
        if (!r.name) continue;
        mappedSettings.push({
          id: r.id,
          office_number: officeNumber,
          staff_name: r.name,
          honnin_kyu: r.kyotaku_honnin_kyu,
          shokuno_kyu: r.kyotaku_shokuno_kyu,
          kotei_zangyo: r.kyotaku_kotei_zangyo,
          shikaku_teate: r.kyotaku_shikaku_teate,
          kotei: r.kyotaku_kotei,
          tokutei_shogu: r.kyotaku_tokutei_shogu,
          kaigo_rate: r.kyotaku_kaigo_rate,
          shien_rate: r.kyotaku_shien_rate,
        });
      }
      setSettings(mappedSettings);
      setUnits((unitRes.data ?? []) as ServiceUnit[]);
      setRates((rateRes.data ?? []) as RegionalRate[]);
      setConfirmations((confRes.data ?? []) as ConfirmationRow[]);
      setYobouRows(yobouRes.error ? [] : ((yobouRes.data ?? []) as YobouRow[]));

      // ── 出張距離手当 用 attendance + office travel rate を整形 ──────────────
      // attendance は employee_id key だが計算は staff_name key。
      // setRes.data (= 同じく居宅介護支援 office に限定された payroll_employees) で
      // (id → name, office_number) の map を組み、attendance を staff_name 解決済の
      // 形に flatten する。
      type RawAttendanceRow = {
        employee_id: string;
        work_date: string | null;
        business_km: number | string | null;
        office_id: string;
      };
      type EmployeeIdMapEntry = { name: string; office_number: string };
      const employeeIdMap = new Map<string, EmployeeIdMapEntry>();
      for (const r of (setRes.data ?? []) as unknown as RawEmployeeRow[]) {
        const officeNumber = r.office?.office_number ?? "";
        if (!officeNumber || !officeNumberSet.has(officeNumber)) continue;
        if (!r.name) continue;
        employeeIdMap.set(r.id, { name: r.name, office_number: officeNumber });
      }

      const mappedAttendance: AttendanceWithStaffName[] = [];
      if (!attRes.error) {
        for (const ar of (attRes.data ?? []) as unknown as RawAttendanceRow[]) {
          if (!ar.employee_id || !ar.work_date) continue;
          if (ar.business_km === null || ar.business_km === undefined) continue;
          const emp = employeeIdMap.get(ar.employee_id);
          if (!emp) continue;
          // NUMERIC は文字列で返ることがあるので Number 化
          const km = typeof ar.business_km === "string"
            ? parseFloat(ar.business_km)
            : ar.business_km;
          if (!Number.isFinite(km) || km <= 0) continue;
          mappedAttendance.push({
            staff_name: emp.name,
            office_number: emp.office_number,
            work_date: ar.work_date,
            business_km: km,
          });
        }
      }
      setAttendanceRows(mappedAttendance);

      // payroll_offices.travel_unit_price → Map<office_number, number>
      type RawOfficeRow = {
        office_number: string;
        travel_unit_price: number | string | null;
      };
      const travelMap = new Map<string, number>();
      if (!officeRes.error) {
        for (const o of (officeRes.data ?? []) as unknown as RawOfficeRow[]) {
          if (!o.office_number) continue;
          const v = typeof o.travel_unit_price === "string"
            ? parseFloat(o.travel_unit_price)
            : (o.travel_unit_price ?? 0);
          travelMap.set(o.office_number, Number.isFinite(v) ? v : 0);
        }
      }
      setOfficeTravelRateMap(travelMap);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- office 集合切替時の async fetch */
    fetchAll().catch(() => undefined);
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [officeNumbers.join(",")]);

  // ----------------------- 絞り込み済み view -----------------------

  // filterOfficeNumber を適用した records / settings / confirmations
  const filteredRecords = useMemo(
    () =>
      filterOfficeNumber === null
        ? records
        : records.filter((r) => r.office_number === filterOfficeNumber),
    [records, filterOfficeNumber],
  );
  const filteredSettings = useMemo(
    () =>
      filterOfficeNumber === null
        ? settings
        : settings.filter((s) => s.office_number === filterOfficeNumber),
    [settings, filterOfficeNumber],
  );
  const filteredConfirmations = useMemo(
    () =>
      filterOfficeNumber === null
        ? confirmations
        : confirmations.filter((c) => c.office_number === filterOfficeNumber),
    [confirmations, filterOfficeNumber],
  );
  const filteredYobou = useMemo(
    () =>
      filterOfficeNumber === null
        ? yobouRows
        : yobouRows.filter((y) => y.office_number === filterOfficeNumber),
    [yobouRows, filterOfficeNumber],
  );
  const filteredAttendance = useMemo(
    () =>
      filterOfficeNumber === null
        ? attendanceRows
        : attendanceRows.filter((a) => a.office_number === filterOfficeNumber),
    [attendanceRows, filterOfficeNumber],
  );

  // ----------------------- derived data -----------------------

  // allMonths は records と yobou の和集合 (介護予防のみ取込済の staff/月も含める)
  const allMonths = useMemo(() => {
    const s = new Set<string>();
    for (const r of filteredRecords) if (r.service_month) s.add(r.service_month);
    for (const y of filteredYobou) if (y.service_month) s.add(y.service_month);
    return Array.from(s).sort();
  }, [filteredRecords, filteredYobou]);
  // staff の identity を (office_number, staff_name) に格上げ。同名ケアマネを区別する。
  // records / yobou 双方から導出 (yobou-only staff も対象)
  const allStaffKeys = useMemo(() => {
    type Pseudo = { office_number: string; staff_name: string };
    const seen = new Set<string>();
    const merged: Pseudo[] = [];
    const push = (officeNumber: string, staffName: string) => {
      if (!officeNumber || !staffName) return;
      const k = `${officeNumber}|${staffName}`;
      if (seen.has(k)) return;
      seen.add(k);
      merged.push({ office_number: officeNumber, staff_name: staffName });
    };
    for (const r of filteredRecords) push(r.office_number, r.staff_name);
    for (const y of filteredYobou) push(y.office_number, y.staff_name);
    // distinctStaffKeys と同 sort key で並べ直す
    merged.sort((a, b) => {
      const oa = officeOrder.get(a.office_number) ?? 9999;
      const ob = officeOrder.get(b.office_number) ?? 9999;
      if (oa !== ob) return oa - ob;
      return a.staff_name.localeCompare(b.staff_name, "ja");
    });
    return merged.map((r) => ({
      officeNumber: r.office_number,
      staffName: r.staff_name,
    }));
  }, [filteredRecords, filteredYobou, officeOrder]);
  const allPayMonths = useMemo(
    () => deriveAllPayMonths(allMonths),
    [allMonths],
  );
  const rateMap = useMemo(() => makeRateMap(rates), [rates]);

  // ITEMS = display_order でソートした units 全部
  const items = useMemo(() => {
    return [...units].sort((a, b) => {
      const ao = (a as unknown as { display_order?: number }).display_order ?? 999;
      const bo = (b as unknown as { display_order?: number }).display_order ?? 999;
      if (ao !== bo) return ao - bo;
      return a.item_name.localeCompare(b.item_name);
    });
  }, [units]);

  // records / settings / confirmations を office_number で partition (calc は office 単位で動く)
  const recordsByOffice = useMemo(
    () => partitionByOffice(filteredRecords),
    [filteredRecords],
  );
  const settingsByOffice = useMemo(
    () => partitionByOffice(filteredSettings),
    [filteredSettings],
  );
  const confirmationsByOffice = useMemo(
    () => partitionByOffice(filteredConfirmations),
    [filteredConfirmations],
  );
  const yobouByOffice = useMemo(
    () => partitionByOffice(filteredYobou),
    [filteredYobou],
  );
  const attendanceByOffice = useMemo(
    () => partitionByOffice(filteredAttendance),
    [filteredAttendance],
  );

  /** office_number → 該当 office の CalcConfig */
  const calcConfigByOffice = useMemo(() => {
    const m = new Map<string, CalcConfig>();
    for (const o of allKyotakuOffices) {
      m.set(o.office_number, {
        settings: settingsByOffice.get(o.office_number) ?? [],
        units,
        rates,
        yobouRecords: yobouByOffice.get(o.office_number) ?? [],
        attendanceRecords: attendanceByOffice.get(o.office_number) ?? [],
        officeTravelUnitPrice: officeTravelRateMap.get(o.office_number) ?? 0,
      });
    }
    return m;
  }, [
    allKyotakuOffices,
    settingsByOffice,
    units,
    rates,
    yobouByOffice,
    attendanceByOffice,
    officeTravelRateMap,
  ]);

  // staff × month の salary cache (key: officeNumber|staff|month)
  const salaryCache = useMemo(() => {
    const m = new Map<string, ReturnType<typeof calcSalary>>();
    for (const k of allStaffKeys) {
      const recs = recordsByOffice.get(k.officeNumber) ?? [];
      const cfg = calcConfigByOffice.get(k.officeNumber);
      if (!cfg) continue;
      for (const mo of allMonths) {
        m.set(
          `${k.officeNumber}|${k.staffName}|${mo}`,
          calcSalary(recs, k.staffName, mo, cfg),
        );
      }
    }
    return m;
  }, [allStaffKeys, allMonths, recordsByOffice, calcConfigByOffice]);

  // staff × pay_month の payment cache (key: officeNumber|staff|pm)
  const paymentCache = useMemo(() => {
    const m = new Map<string, number>();
    for (const k of allStaffKeys) {
      const recs = recordsByOffice.get(k.officeNumber) ?? [];
      const cfg = calcConfigByOffice.get(k.officeNumber);
      if (!cfg) continue;
      for (const pm of allPayMonths) {
        m.set(
          `${k.officeNumber}|${k.staffName}|${pm}`,
          calcPaymentForMonth(recs, k.staffName, pm, cfg),
        );
      }
    }
    return m;
  }, [allStaffKeys, allPayMonths, recordsByOffice, calcConfigByOffice]);

  // adjustments cache (key: officeNumber|staff|month)
  const adjustmentsByStaffMonth = useMemo(() => {
    const m = new Map<string, { late_adj: number; sayi_adj: number }>();
    for (const k of allStaffKeys) {
      const recs = recordsByOffice.get(k.officeNumber) ?? [];
      const cfg = calcConfigByOffice.get(k.officeNumber);
      if (!cfg) continue;
      const officeConfs = confirmationsByOffice.get(k.officeNumber) ?? [];
      const confs: Confirmation[] = officeConfs.map((c) => ({
        staff_name: c.staff_name,
        pay_month: c.pay_month,
        amount: c.amount,
      }));
      for (const mo of allMonths) {
        m.set(
          `${k.officeNumber}|${k.staffName}|${mo}`,
          calcAdjustments(recs, k.staffName, mo, {
            ...cfg,
            confirmations: confs,
          }),
        );
      }
    }
    return m;
  }, [
    allStaffKeys,
    allMonths,
    recordsByOffice,
    calcConfigByOffice,
    confirmationsByOffice,
  ]);

  const paidMap = useMemo(
    () => buildPaidMap(filteredConfirmations),
    [filteredConfirmations],
  );

  // ----------------------- 確定 / 解除 -----------------------

  const confirmPayment = async (
    officeNumber: string,
    staff: string,
    payMonth: string,
    amount: number,
  ) => {
    const lockKey = `${officeNumber}|${staff}|${payMonth}`;
    if (busyPay) return;
    setBusyPay(lockKey);
    try {
      const { error } = await supabase
        .from("payroll_kyotaku_confirmations")
        .insert({
          tenant_id: TENANT_ID,
          office_number: officeNumber,
          staff_name: staff,
          pay_month: payMonth,
          amount: Math.round(amount),
          confirmed_at: new Date().toISOString(),
        });
      if (error) throw error;
      await fetchAll();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(`確定に失敗: ${msg}`);
    } finally {
      setBusyPay(null);
    }
  };

  const revertConfirmation = async (
    officeNumber: string,
    staff: string,
    payMonth: string,
  ) => {
    const lockKey = `${officeNumber}|${staff}|${payMonth}`;
    if (busyPay) return;
    const row = findActiveConfirmation(
      confirmations,
      officeNumber,
      staff,
      payMonth,
    );
    if (!row) return;
    setBusyPay(lockKey);
    try {
      const { error } = await supabase
        .from("payroll_kyotaku_confirmations")
        .update({ reverted_at: new Date().toISOString() })
        .eq("id", row.id);
      if (error) throw error;
      await fetchAll();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(`確定解除に失敗: ${msg}`);
    } finally {
      setBusyPay(null);
    }
  };

  // ----------------------- header / chip group ------------------

  /** 現在の表示 mode 文言 */
  const headerSubtitle = useMemo(() => {
    if (filterOfficeNumber === null) {
      return `全 ${allKyotakuOffices.length} 事業所 / 提供月 ${allMonths.length} ヶ月 ・ ケアマネ ${allStaffKeys.length} 名`;
    }
    const o = officeMap.get(filterOfficeNumber);
    return `${o?.short_name ?? o?.name ?? filterOfficeNumber} (${filterOfficeNumber}) / 提供月 ${allMonths.length} ヶ月 ・ ケアマネ ${allStaffKeys.length} 名`;
  }, [filterOfficeNumber, allKyotakuOffices.length, allMonths.length, allStaffKeys.length, officeMap]);

  // 設定 modal をどの office に対して開いているか。filter が「全社」のときは
  // ユーザに office を選ばせる必要があるが、現状は「絞り込み office があれば
  // それで開く / 全社モードでは disable」とする (将来 modal 側で office 選択 UI 追加可)
  const settingsModalDisabled = filterOfficeNumber === null;

  // ----------------------- render: loading / empty -----------------------

  if (allKyotakuOffices.length === 0) {
    return (
      <div className="space-y-4 p-4">
        <header>
          <h1 className="text-xl font-bold">居宅介護支援 給与計算</h1>
        </header>
        <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
          居宅介護支援 type の事業所が登録されていません。
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-4 p-4">
        <header>
          <h1 className="text-xl font-bold">居宅介護支援 給与計算</h1>
          <p className="text-sm text-gray-500">読込中…</p>
        </header>
      </div>
    );
  }

  if (err) {
    return (
      <div className="space-y-4 p-4">
        <header>
          <h1 className="text-xl font-bold">居宅介護支援 給与計算</h1>
          <p className="text-sm text-gray-500">{headerSubtitle}</p>
        </header>
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          エラー: {err}
        </div>
        <Button onClick={() => fetchAll()} variant="outline" size="sm">
          再読込
        </Button>
      </div>
    );
  }

  const chipGroup = (
    <div className="flex items-center gap-2">
      <label className="text-xs text-muted-foreground whitespace-nowrap">事業所:</label>
      <select
        value={filterOfficeNumber ?? ""}
        onChange={(e) => setFilterOfficeNumber(e.target.value === "" ? null : e.target.value)}
        className="border rounded px-2 py-1 text-sm bg-background min-w-[200px]"
      >
        <option value="">全事業所 ({allKyotakuOffices.length})</option>
        {allKyotakuOffices.map((o) => (
          <option key={o.office_number} value={o.office_number} title={`${o.name} (${o.office_number})`}>
            {o.short_name || o.name}
          </option>
        ))}
      </select>
    </div>
  );

  const openSettingsModal = () => {
    if (filterOfficeNumber === null) return;
    const o = officeMap.get(filterOfficeNumber);
    if (!o) return;
    setSettingsModalOffice(o);
    setSettingsModalOpen(true);
  };

  if (records.length === 0 && yobouRows.length === 0) {
    return (
      <div className="space-y-4 p-4">
        <header className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <div>
              <h1 className="text-xl font-bold">居宅介護支援 給与計算</h1>
              <p className="text-sm text-gray-500">{headerSubtitle}</p>
            </div>
            {chipGroup}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={openSettingsModal}
            disabled={settingsModalDisabled}
            title={
              settingsModalDisabled
                ? "事業所を 1 つ選択すると設定できます"
                : undefined
            }
          >
            ⚙ 設定
          </Button>
        </header>
        <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
          まだ国保連 CSV / 介護予防件数データを取り込んでいません。
          <br />
          <a href="/csv-import" className="text-primary underline">
            /csv-import
          </a>{" "}
          から取り込むか、「予防件数」タブから手入力できます。
        </div>
        {settingsModalOffice && (
          <KyotakuSettingsModal
            open={settingsModalOpen}
            onClose={() => setSettingsModalOpen(false)}
            tenantId={TENANT_ID}
            officeNumber={settingsModalOffice.office_number}
            staffNames={[]}
            onSaved={() => fetchAll()}
          />
        )}
      </div>
    );
  }

  // ----------------------- render: tabs -----------------------

  return (
    <div className="space-y-4 p-4">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <div>
            <h1 className="text-xl font-bold">居宅介護支援 給与計算</h1>
            <p className="text-sm text-gray-500">{headerSubtitle}</p>
          </div>
          {chipGroup}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={openSettingsModal}
          disabled={settingsModalDisabled}
          title={
            settingsModalDisabled
              ? "事業所を 1 つ選択すると設定できます"
              : undefined
          }
        >
          ⚙ 設定
        </Button>
      </header>

      <Tabs defaultValue="kyuyo">
        <TabsList>
          <TabsTrigger value="kyuyo">給与計算</TabsTrigger>
          <TabsTrigger value="pay">支払いサマリー</TabsTrigger>
          <TabsTrigger value="uriage">売上表</TabsTrigger>
          <TabsTrigger value="riyosha">利用者内訳</TabsTrigger>
          <TabsTrigger value="sayi">差異明細</TabsTrigger>
          <TabsTrigger value="yobou">予防件数</TabsTrigger>
        </TabsList>

        <TabsContent value="kyuyo" className="mt-4">
          <KyuyoTab
            allStaffKeys={allStaffKeys}
            allMonths={allMonths}
            recordsByOffice={recordsByOffice}
            yobouByOffice={yobouByOffice}
            officeMap={officeMap}
            salaryCache={salaryCache}
            adjustmentsByStaffMonth={adjustmentsByStaffMonth}
            paidMap={paidMap}
          />
        </TabsContent>

        <TabsContent value="pay" className="mt-4">
          <PaymentTab
            allStaffKeys={allStaffKeys}
            allPayMonths={allPayMonths}
            officeMap={officeMap}
            paymentCache={paymentCache}
            paidMap={paidMap}
            confirmations={filteredConfirmations}
            busyPay={busyPay}
            onConfirm={confirmPayment}
            onRevert={revertConfirmation}
          />
        </TabsContent>

        <TabsContent value="uriage" className="mt-4">
          <UriageTab
            records={filteredRecords}
            yobouRecords={filteredYobou}
            allMonths={allMonths}
            allStaffKeys={allStaffKeys}
            officeMap={officeMap}
            items={items}
            rateMap={rateMap}
            units={units}
          />
        </TabsContent>

        <TabsContent value="riyosha" className="mt-4">
          <RiyoshaTab
            records={filteredRecords}
            units={units}
            allStaffKeys={allStaffKeys}
            allMonths={allMonths}
          />
        </TabsContent>

        <TabsContent value="sayi" className="mt-4">
          <SayiTab
            allStaffKeys={allStaffKeys}
            allMonths={allMonths}
            officeMap={officeMap}
            recordsByOffice={recordsByOffice}
            calcConfigByOffice={calcConfigByOffice}
            salaryCache={salaryCache}
            adjustmentsByStaffMonth={adjustmentsByStaffMonth}
            paidMap={paidMap}
          />
        </TabsContent>

        <TabsContent value="yobou" className="mt-4">
          <YobouTab
            tenantId={TENANT_ID}
            allKyotakuOffices={allKyotakuOffices}
            filterOfficeNumber={filterOfficeNumber}
            yobouRows={filteredYobou}
            allStaffKeys={allStaffKeys}
            officeMap={officeMap}
            onSaved={fetchAll}
          />
        </TabsContent>
      </Tabs>

      {settingsModalOffice && (
        <KyotakuSettingsModal
          open={settingsModalOpen}
          onClose={() => setSettingsModalOpen(false)}
          tenantId={TENANT_ID}
          officeNumber={settingsModalOffice.office_number}
          staffNames={Array.from(
            new Set(
              filteredRecords
                .filter(
                  (r) => r.office_number === settingsModalOffice.office_number,
                )
                .map((r) => r.staff_name),
            ),
          )}
          onSaved={() => fetchAll()}
        />
      )}
    </div>
  );
}

// =====================================================================
// office 略称 helper (各 tab で staff key → 事業所略称表示に使う)
// =====================================================================

function officeShortLabel(
  officeMap: Map<string, KyotakuOffice>,
  officeNumber: string,
): string {
  const o = officeMap.get(officeNumber);
  if (!o) return officeNumber;
  return o.short_name || o.name || officeNumber;
}

// 担当ケアマネ表示。上部 selector で office を選択している前提なので staff 名のみ。
// (officeMap, officeNumber は同名ケアマネ区別が必要になった際の拡張ポイント)
function formatStaffLabel(
  _officeMap: Map<string, KyotakuOffice>,
  _officeNumber: string,
  staffName: string,
): string {
  return staffName;
}

// =====================================================================
// Tab: 給与計算 (件数 8 行 + 給与 13 行 = 21 行 / staff)
// 6 列分解 (2026-05-13): 基本給 1 行 → 本人給 / 職能給 / 固定残業手当 の 3 行に分解、
// さらに資格手当 / 勤続手当 / 特定処遇改善 の 3 独立加算行を追加。
// 出張距離手当 (月合計 km × payroll_offices.travel_unit_price) を 2026-05-13 に追加。
// (「固定」ラベルは「勤続手当」へ。DB 列名 kyotaku_kotei / sal.kotei は据え置き)
// =====================================================================

const SALARY_ROWS = [
  "本人給",
  "職能給",
  "固定残業手当",
  "プラン手当",
  "加算手当",
  "調整手当",
  "資格手当",
  "勤続手当",
  "特定処遇改善",
  "出張距離手当",
  "合計額",
  "支給済み",
  "差異",
] as const;

function KyuyoTab({
  allStaffKeys,
  allMonths,
  recordsByOffice,
  yobouByOffice,
  officeMap,
  salaryCache,
  adjustmentsByStaffMonth,
  paidMap,
}: {
  allStaffKeys: Array<{ officeNumber: string; staffName: string }>;
  allMonths: string[];
  recordsByOffice: Map<string, FullRecord[]>;
  yobouByOffice: Map<string, YobouRow[]>;
  officeMap: Map<string, KyotakuOffice>;
  salaryCache: Map<string, ReturnType<typeof calcSalary>>;
  adjustmentsByStaffMonth: Map<string, { late_adj: number; sayi_adj: number }>;
  paidMap: Map<string, number>;
}) {
  return (
    <div className="overflow-auto rounded-lg border">
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 z-10 bg-background min-w-20">
              担当ケアマネ
            </TableHead>
            <TableHead className="sticky left-20 z-10 bg-background min-w-32">
              項目
            </TableHead>
            {allMonths.map((m) => (
              <TableHead key={m} className="text-right min-w-20">
                {fmtMonthLabel(m)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {allStaffKeys.map((k) => (
            <StaffBlock
              key={staffKey(k.officeNumber, k.staffName)}
              officeNumber={k.officeNumber}
              staff={k.staffName}
              officeMap={officeMap}
              records={recordsByOffice.get(k.officeNumber) ?? []}
              yobouRecords={yobouByOffice.get(k.officeNumber) ?? []}
              allMonths={allMonths}
              salaryCache={salaryCache}
              adjustmentsByStaffMonth={adjustmentsByStaffMonth}
              paidMap={paidMap}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function StaffBlock({
  officeNumber,
  staff,
  officeMap,
  records,
  yobouRecords,
  allMonths,
  salaryCache,
  adjustmentsByStaffMonth,
  paidMap,
}: {
  officeNumber: string;
  staff: string;
  officeMap: Map<string, KyotakuOffice>;
  records: FullRecord[];
  yobouRecords: YobouRow[];
  allMonths: string[];
  salaryCache: Map<string, ReturnType<typeof calcSalary>>;
  adjustmentsByStaffMonth: Map<string, { late_adj: number; sayi_adj: number }>;
  paidMap: Map<string, number>;
}) {
  const perMonth = allMonths.map((m) => {
    const sal = salaryCache.get(`${officeNumber}|${staff}|${m}`);
    const adj = adjustmentsByStaffMonth.get(
      `${officeNumber}|${staff}|${m}`,
    ) ?? {
      late_adj: 0,
      sayi_adj: 0,
    };
    const counts = countCells(records, staff, m, yobouRecords);
    const payMonth = addMonths(m, 1);
    const paid = paidMap.get(`${officeNumber}|${staff}|${payMonth}`) ?? 0;
    const chosei = adj.late_adj + adj.sayi_adj;
    // total: base (= honnin+shokuno+kotei_zangyo) + plan + kazan + chosei
    //        + 独立加算 (shikaku + kotei + tokutei + business_trip_teate)
    const total = sal
      ? sal.base +
        sal.plan +
        sal.kazan +
        chosei +
        sal.shikaku +
        sal.kotei +
        sal.tokutei +
        sal.business_trip_teate
      : 0;
    const diff = paid > 0 ? total - paid : null;
    return { m, sal, counts, chosei, total, paid, diff };
  });

  const label = formatStaffLabel(officeMap, officeNumber, staff);

  return (
    <>
      {COUNT_ROWS.map((row, idx) => (
        <TableRow key={`${officeNumber}|${staff}|count|${row.key}`}>
          {idx === 0 ? (
            <TableCell
              rowSpan={COUNT_ROWS.length + SALARY_ROWS.length}
              className="sticky left-0 z-10 bg-background align-top font-medium border-r whitespace-nowrap"
            >
              {label}
            </TableCell>
          ) : null}
          <TableCell className="sticky left-20 z-10 bg-background border-r">
            {row.label}
          </TableCell>
          {perMonth.map((pm) => (
            <TableCell key={pm.m} className="text-right tabular-nums">
              {pm.counts[row.key] || ""}
            </TableCell>
          ))}
        </TableRow>
      ))}
      {SALARY_ROWS.map((label) => (
        <TableRow
          key={`${officeNumber}|${staff}|salary|${label}`}
          className="bg-muted/30"
        >
          <TableCell className="sticky left-20 z-10 bg-muted/50 border-r font-medium">
            {label}
          </TableCell>
          {perMonth.map((pm) => {
            let v: number | null = null;
            if (label === "本人給") v = pm.sal?.honnin ?? 0;
            else if (label === "職能給") v = pm.sal?.shokuno ?? 0;
            else if (label === "固定残業手当") v = pm.sal?.kotei_zangyo ?? 0;
            else if (label === "プラン手当") v = pm.sal?.plan ?? 0;
            else if (label === "加算手当") v = pm.sal?.kazan ?? 0;
            else if (label === "調整手当") v = pm.chosei;
            else if (label === "資格手当") v = pm.sal?.shikaku ?? 0;
            else if (label === "勤続手当") v = pm.sal?.kotei ?? 0;
            else if (label === "特定処遇改善") v = pm.sal?.tokutei ?? 0;
            else if (label === "出張距離手当") v = pm.sal?.business_trip_teate ?? 0;
            else if (label === "合計額") v = pm.total;
            else if (label === "支給済み") v = pm.paid > 0 ? pm.paid : null;
            else if (label === "差異") v = pm.diff;

            const showRed = label === "差異" && v !== null && v !== 0;
            return (
              <TableCell
                key={pm.m}
                className={`text-right tabular-nums ${
                  showRed ? "text-destructive font-medium" : ""
                }`}
              >
                {v === null ? "" : fmtYen(v)}
              </TableCell>
            );
          })}
        </TableRow>
      ))}
    </>
  );
}

// =====================================================================
// Tab: 支払いサマリー (3 行 / staff × pay_month + 事業所合計行)
// =====================================================================

function PaymentTab({
  allStaffKeys,
  allPayMonths,
  officeMap,
  paymentCache,
  paidMap,
  confirmations,
  busyPay,
  onConfirm,
  onRevert,
}: {
  allStaffKeys: Array<{ officeNumber: string; staffName: string }>;
  allPayMonths: string[];
  officeMap: Map<string, KyotakuOffice>;
  paymentCache: Map<string, number>;
  paidMap: Map<string, number>;
  confirmations: ConfirmationRow[];
  busyPay: string | null;
  onConfirm: (
    officeNumber: string,
    staff: string,
    payMonth: string,
    amount: number,
  ) => void;
  onRevert: (officeNumber: string, staff: string, payMonth: string) => void;
}) {
  // 事業所 (office_number) ごとの合計
  const officeTotalsByPay = useMemo(() => {
    // Map<office_number, Map<pay_month, total>>
    const m = new Map<string, Map<string, number>>();
    for (const k of allStaffKeys) {
      const inner = m.get(k.officeNumber) ?? new Map<string, number>();
      for (const pm of allPayMonths) {
        const v =
          paymentCache.get(`${k.officeNumber}|${k.staffName}|${pm}`) ?? 0;
        inner.set(pm, (inner.get(pm) ?? 0) + v);
      }
      m.set(k.officeNumber, inner);
    }
    return m;
  }, [allStaffKeys, allPayMonths, paymentCache]);

  // 全社合計
  const grandTotalByPay = useMemo(() => {
    const m = new Map<string, number>();
    for (const pm of allPayMonths) {
      let sum = 0;
      for (const inner of officeTotalsByPay.values()) {
        sum += inner.get(pm) ?? 0;
      }
      m.set(pm, sum);
    }
    return m;
  }, [officeTotalsByPay, allPayMonths]);

  // staff key を office_number でグルーピング (表示順は allStaffKeys 通り)
  const staffsByOffice = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const k of allStaffKeys) {
      const arr = m.get(k.officeNumber) ?? [];
      arr.push(k.staffName);
      m.set(k.officeNumber, arr);
    }
    return m;
  }, [allStaffKeys]);

  // office 表示順 (allStaffKeys 出現順)
  const officeOrderArr = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const k of allStaffKeys) {
      if (seen.has(k.officeNumber)) continue;
      seen.add(k.officeNumber);
      out.push(k.officeNumber);
    }
    return out;
  }, [allStaffKeys]);

  return (
    <div className="overflow-auto rounded-lg border">
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 z-10 bg-background min-w-20">
              担当ケアマネ
            </TableHead>
            <TableHead className="sticky left-20 z-10 bg-background min-w-28">
              支払種別
            </TableHead>
            {allPayMonths.map((pm) => (
              <TableHead key={pm} className="text-right min-w-24">
                {fmtMonthLabel(pm)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {officeOrderArr.map((officeNumber) => {
            const staffs = staffsByOffice.get(officeNumber) ?? [];
            const officeTotal = officeTotalsByPay.get(officeNumber);
            return (
              <PaymentOfficeBlock
                key={officeNumber}
                officeNumber={officeNumber}
                officeMap={officeMap}
                staffs={staffs}
                allPayMonths={allPayMonths}
                paymentCache={paymentCache}
                paidMap={paidMap}
                confirmations={confirmations}
                busyPay={busyPay}
                officeTotal={officeTotal}
                onConfirm={onConfirm}
                onRevert={onRevert}
              />
            );
          })}
          {officeOrderArr.length > 1 ? (
            <TableRow className="border-t-2 bg-primary/10 font-bold">
              <TableCell
                colSpan={2}
                className="sticky left-0 z-10 bg-primary/15 border-r"
              >
                全事業所合計（計算額）
              </TableCell>
              {allPayMonths.map((pm) => (
                <TableCell key={pm} className="text-right tabular-nums">
                  {fmtYen(grandTotalByPay.get(pm) ?? 0)}
                </TableCell>
              ))}
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  );
}

function PaymentOfficeBlock({
  officeNumber,
  officeMap,
  staffs,
  allPayMonths,
  paymentCache,
  paidMap,
  confirmations,
  busyPay,
  officeTotal,
  onConfirm,
  onRevert,
}: {
  officeNumber: string;
  officeMap: Map<string, KyotakuOffice>;
  staffs: string[];
  allPayMonths: string[];
  paymentCache: Map<string, number>;
  paidMap: Map<string, number>;
  confirmations: ConfirmationRow[];
  busyPay: string | null;
  officeTotal: Map<string, number> | undefined;
  onConfirm: (
    officeNumber: string,
    staff: string,
    payMonth: string,
    amount: number,
  ) => void;
  onRevert: (officeNumber: string, staff: string, payMonth: string) => void;
}) {
  return (
    <>
      {staffs.map((staff) => (
        <PaymentStaffBlock
          key={`${officeNumber}|${staff}`}
          officeNumber={officeNumber}
          officeMap={officeMap}
          staff={staff}
          allPayMonths={allPayMonths}
          paymentCache={paymentCache}
          paidMap={paidMap}
          confirmations={confirmations}
          busyPay={busyPay}
          onConfirm={onConfirm}
          onRevert={onRevert}
        />
      ))}
      <TableRow className="border-t-2 bg-muted/50 font-medium">
        <TableCell
          colSpan={2}
          className="sticky left-0 z-10 bg-muted/50 border-r"
        >
          {officeShortLabel(officeMap, officeNumber)} 合計（計算額）
        </TableCell>
        {allPayMonths.map((pm) => (
          <TableCell key={pm} className="text-right tabular-nums">
            {fmtYen(officeTotal?.get(pm) ?? 0)}
          </TableCell>
        ))}
      </TableRow>
    </>
  );
}

function PaymentStaffBlock({
  officeNumber,
  officeMap,
  staff,
  allPayMonths,
  paymentCache,
  paidMap,
  confirmations,
  busyPay,
  onConfirm,
  onRevert,
}: {
  officeNumber: string;
  officeMap: Map<string, KyotakuOffice>;
  staff: string;
  allPayMonths: string[];
  paymentCache: Map<string, number>;
  paidMap: Map<string, number>;
  confirmations: ConfirmationRow[];
  busyPay: string | null;
  onConfirm: (
    officeNumber: string,
    staff: string,
    payMonth: string,
    amount: number,
  ) => void;
  onRevert: (officeNumber: string, staff: string, payMonth: string) => void;
}) {
  const labels = ["計算額", "支給済み", "差異"] as const;
  const label = formatStaffLabel(officeMap, officeNumber, staff);

  return (
    <>
      {labels.map((rowLabel, idx) => (
        <TableRow
          key={`${officeNumber}|${staff}|${rowLabel}`}
          className={idx === 2 ? "border-b-2" : ""}
        >
          {idx === 0 ? (
            <TableCell
              rowSpan={3}
              className="sticky left-0 z-10 bg-background border-r align-top font-medium whitespace-nowrap"
            >
              {label}
            </TableCell>
          ) : null}
          <TableCell className="sticky left-20 z-10 bg-background border-r">
            {rowLabel}
          </TableCell>
          {allPayMonths.map((pm) => {
            const calc = paymentCache.get(`${officeNumber}|${staff}|${pm}`) ?? 0;
            const paid = paidMap.get(`${officeNumber}|${staff}|${pm}`) ?? 0;
            const hasActive = !!findActiveConfirmation(
              confirmations,
              officeNumber,
              staff,
              pm,
            );
            const diff = hasActive ? calc - paid : null;
            const lockKey = `${officeNumber}|${staff}|${pm}`;
            const isBusy = busyPay === lockKey;

            if (rowLabel === "計算額") {
              return (
                <TableCell key={pm} className="text-right tabular-nums">
                  <div className="flex items-center justify-end gap-1.5">
                    <span>{fmtYen(calc)}</span>
                    {calc > 0 ? (
                      hasActive ? (
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={isBusy}
                          onClick={() => onRevert(officeNumber, staff, pm)}
                        >
                          解除
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={isBusy}
                          onClick={() => onConfirm(officeNumber, staff, pm, calc)}
                        >
                          確定
                        </Button>
                      )
                    ) : null}
                  </div>
                </TableCell>
              );
            }
            if (rowLabel === "支給済み") {
              return (
                <TableCell key={pm} className="text-right tabular-nums">
                  {hasActive ? fmtYen(paid) : ""}
                </TableCell>
              );
            }
            // 差異
            const showRed = diff !== null && diff !== 0;
            return (
              <TableCell
                key={pm}
                className={`text-right tabular-nums ${
                  showRed ? "text-destructive font-medium" : ""
                }`}
              >
                {diff === null ? "" : fmtYen(diff)}
              </TableCell>
            );
          })}
        </TableRow>
      ))}
    </>
  );
}

// =====================================================================
// Tab: 売上表 (項目別売上、地域加算込)
// =====================================================================

function UriageTab({
  records,
  yobouRecords,
  allMonths,
  allStaffKeys,
  officeMap,
  items,
  rateMap,
  units,
}: {
  records: FullRecord[];
  yobouRecords: YobouRow[];
  allMonths: string[];
  allStaffKeys: Array<{ officeNumber: string; staffName: string }>;
  officeMap: Map<string, KyotakuOffice>;
  items: ServiceUnit[];
  rateMap: Map<string, number>;
  units: ServiceUnit[];
}) {
  // revenue[month][office|staff][item] を作る
  // records (国保連 CSV = 介護給付) + yobouRecords (介護予防 = 要支援1/2) の和。
  // 売上表は「提供月」集計 (月遅れ請求も提供月へ寄せる)。
  // yobouRecords は insurer_name を持たないため地域加算は default 10 円
  // (= 集計.py の chiiki fallback と同じ)。
  const revenue = useMemo(() => {
    const m = new Map<string, Map<string, Map<string, number>>>();
    const bump = (
      month: string,
      sk: string,
      itemName: string,
      yen: number,
    ) => {
      if (!month || !sk || !itemName) return;
      if (yen === 0) return;
      const a = m.get(month) ?? new Map<string, Map<string, number>>();
      const b = a.get(sk) ?? new Map<string, number>();
      b.set(itemName, (b.get(itemName) ?? 0) + yen);
      a.set(sk, b);
      m.set(month, a);
    };

    // 1) records (介護給付): 基本サービス + 加算
    for (const r of records) {
      const resolved = resolveRecordUnit(r, units);
      if (!resolved) continue;
      const chiiki = rateMap.get(r.insurer_name ?? "") ?? 10.0;
      const yen = resolved.unit * chiiki;
      const sk = staffKey(r.office_number, r.staff_name);
      bump(r.service_month, sk, resolved.itemName, yen);
    }

    // 2) yobouRecords (介護予防支援): 要支援1/2 件数 × 単位 × 10 円
    //    master に「要支援１」「要支援２」が無ければ skip (= 未投入)。
    const yobou1Unit =
      units.find((u) => u.item_name === "要支援１")?.unit_count ?? 0;
    const yobou2Unit =
      units.find((u) => u.item_name === "要支援２")?.unit_count ?? 0;
    for (const yr of yobouRecords) {
      const sk = staffKey(yr.office_number, yr.staff_name);
      const chiiki = 10.0; // yobou_records は insurer_name を持たないため default
      const c1 = yr.yobou1_count ?? 0;
      const c2 = yr.yobou2_count ?? 0;
      if (c1 > 0 && yobou1Unit > 0) {
        bump(yr.service_month, sk, "要支援１", c1 * yobou1Unit * chiiki);
      }
      if (c2 > 0 && yobou2Unit > 0) {
        bump(yr.service_month, sk, "要支援２", c2 * yobou2Unit * chiiki);
      }
    }
    return m;
  }, [records, yobouRecords, units, rateMap]);

  // office 表示順 (allStaffKeys 出現順)
  const officeOrderArr = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const k of allStaffKeys) {
      if (seen.has(k.officeNumber)) continue;
      seen.add(k.officeNumber);
      out.push(k.officeNumber);
    }
    return out;
  }, [allStaffKeys]);

  const staffsByOffice = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const k of allStaffKeys) {
      const arr = m.get(k.officeNumber) ?? [];
      arr.push(k.staffName);
      m.set(k.officeNumber, arr);
    }
    return m;
  }, [allStaffKeys]);

  return (
    <div className="overflow-auto rounded-lg border">
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 z-10 bg-background min-w-20">
              担当ケアマネ
            </TableHead>
            <TableHead className="sticky left-20 z-10 bg-background min-w-32">
              項目
            </TableHead>
            {allMonths.map((m) => (
              <TableHead key={m} className="text-right min-w-20">
                {fmtMonthLabel(m)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {officeOrderArr.map((officeNumber) => {
            const staffs = staffsByOffice.get(officeNumber) ?? [];
            return (
              <UriageOfficeBlock
                key={officeNumber}
                officeNumber={officeNumber}
                officeMap={officeMap}
                staffs={staffs}
                allMonths={allMonths}
                items={items}
                revenue={revenue}
              />
            );
          })}
          {officeOrderArr.length > 1 ? (
            <UriageGrandTotal
              allMonths={allMonths}
              allStaffKeys={allStaffKeys}
              items={items}
              revenue={revenue}
            />
          ) : null}
        </TableBody>
      </Table>
    </div>
  );
}

function UriageOfficeBlock({
  officeNumber,
  officeMap,
  staffs,
  allMonths,
  items,
  revenue,
}: {
  officeNumber: string;
  officeMap: Map<string, KyotakuOffice>;
  staffs: string[];
  allMonths: string[];
  items: ServiceUnit[];
  revenue: Map<string, Map<string, Map<string, number>>>;
}) {
  return (
    <>
      {staffs.map((staff) => (
        <UriageStaffBlock
          key={`${officeNumber}|${staff}`}
          officeNumber={officeNumber}
          officeMap={officeMap}
          staff={staff}
          allMonths={allMonths}
          items={items}
          revenue={revenue}
        />
      ))}
      <UriageOfficeTotalRow
        officeNumber={officeNumber}
        officeMap={officeMap}
        staffs={staffs}
        allMonths={allMonths}
        items={items}
        revenue={revenue}
      />
    </>
  );
}

function UriageStaffBlock({
  officeNumber,
  officeMap,
  staff,
  allMonths,
  items,
  revenue,
}: {
  officeNumber: string;
  officeMap: Map<string, KyotakuOffice>;
  staff: string;
  allMonths: string[];
  items: ServiceUnit[];
  revenue: Map<string, Map<string, Map<string, number>>>;
}) {
  const sk = staffKey(officeNumber, staff);
  const lookup = (m: string, item: string): number => {
    return revenue.get(m)?.get(sk)?.get(item) ?? 0;
  };
  const sumPerMonth = (m: string): number => {
    const sm = revenue.get(m)?.get(sk);
    if (!sm) return 0;
    let s = 0;
    for (const v of sm.values()) s += v;
    return s;
  };

  const label = formatStaffLabel(officeMap, officeNumber, staff);

  return (
    <>
      {items.map((item, idx) => (
        <TableRow key={`${sk}|${item.item_name}`}>
          {idx === 0 ? (
            <TableCell
              rowSpan={items.length + 1}
              className="sticky left-0 z-10 bg-background border-r align-top font-medium whitespace-nowrap"
            >
              {label}
            </TableCell>
          ) : null}
          <TableCell className="sticky left-20 z-10 bg-background border-r">
            {item.item_name}
          </TableCell>
          {allMonths.map((m) => {
            const v = lookup(m, item.item_name);
            return (
              <TableCell key={m} className="text-right tabular-nums">
                {v ? fmtYen(v) : ""}
              </TableCell>
            );
          })}
        </TableRow>
      ))}
      <TableRow className="bg-muted/30 font-medium border-b-2">
        <TableCell className="sticky left-20 z-10 bg-muted/40 border-r">
          個人合計
        </TableCell>
        {allMonths.map((m) => (
          <TableCell key={m} className="text-right tabular-nums">
            {fmtYen(sumPerMonth(m))}
          </TableCell>
        ))}
      </TableRow>
    </>
  );
}

function UriageOfficeTotalRow({
  officeNumber,
  officeMap,
  staffs,
  allMonths,
  items,
  revenue,
}: {
  officeNumber: string;
  officeMap: Map<string, KyotakuOffice>;
  staffs: string[];
  allMonths: string[];
  items: ServiceUnit[];
  revenue: Map<string, Map<string, Map<string, number>>>;
}) {
  return (
    <TableRow className="bg-muted/50 font-medium border-t-2">
      <TableCell
        colSpan={2}
        className="sticky left-0 z-10 bg-muted/50 border-r"
      >
        {officeShortLabel(officeMap, officeNumber)} 合計
      </TableCell>
      {allMonths.map((m) => {
        let sum = 0;
        for (const s of staffs) {
          const sk = staffKey(officeNumber, s);
          const inner = revenue.get(m)?.get(sk);
          if (!inner) continue;
          for (const item of items) {
            sum += inner.get(item.item_name) ?? 0;
          }
        }
        return (
          <TableCell key={m} className="text-right tabular-nums">
            {fmtYen(sum)}
          </TableCell>
        );
      })}
    </TableRow>
  );
}

function UriageGrandTotal({
  allMonths,
  allStaffKeys,
  items,
  revenue,
}: {
  allMonths: string[];
  allStaffKeys: Array<{ officeNumber: string; staffName: string }>;
  items: ServiceUnit[];
  revenue: Map<string, Map<string, Map<string, number>>>;
}) {
  return (
    <TableRow className="bg-primary/10 font-bold border-t-2">
      <TableCell
        colSpan={2}
        className="sticky left-0 z-10 bg-primary/15 border-r"
      >
        全事業所合計
      </TableCell>
      {allMonths.map((m) => {
        let sum = 0;
        for (const k of allStaffKeys) {
          const sk = staffKey(k.officeNumber, k.staffName);
          const inner = revenue.get(m)?.get(sk);
          if (!inner) continue;
          for (const item of items) {
            sum += inner.get(item.item_name) ?? 0;
          }
        }
        return (
          <TableCell key={m} className="text-right tabular-nums">
            {fmtYen(sum)}
          </TableCell>
        );
      })}
    </TableRow>
  );
}

// =====================================================================
// Tab: 利用者内訳 (明細 1 行 1 サービス)
// =====================================================================

function RiyoshaTab({
  records,
  units,
  allStaffKeys,
  allMonths,
}: {
  records: FullRecord[];
  units: ServiceUnit[];
  allStaffKeys: Array<{ officeNumber: string; staffName: string }>;
  allMonths: string[];
}) {
  // 月選択 state (default = 最新月 = allMonths 末尾)
  const [selectedMonth, setSelectedMonth] = useState<string | null>(
    () => allMonths[allMonths.length - 1] ?? null,
  );
  // allMonths 変化時に selected が範囲外なら更新
  useEffect(() => {
    if (!selectedMonth || !allMonths.includes(selectedMonth)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (props/data 変化に追随する初期化)
      setSelectedMonth(allMonths[allMonths.length - 1] ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allMonths]);

  const monthIdx = selectedMonth ? allMonths.indexOf(selectedMonth) : -1;
  const goPrev = () => { if (monthIdx > 0) setSelectedMonth(allMonths[monthIdx - 1]); };
  const goNext = () => { if (monthIdx >= 0 && monthIdx < allMonths.length - 1) setSelectedMonth(allMonths[monthIdx + 1]); };

  // ソート + 選択月で絞り込み + dedup
  const sorted = useMemo(() => {
    const staffIdx = new Map(
      allStaffKeys.map((k, i) => [staffKey(k.officeNumber, k.staffName), i]),
    );
    const seen = new Set<string>();
    const filtered: FullRecord[] = [];
    for (const r of records) {
      if (!r.insured_number) continue;
      if (selectedMonth && r.service_month !== selectedMonth) continue;
      const dk = [
        r.office_number,
        r.staff_name,
        r.service_month,
        r.client_number ?? r.insured_number,
        r.service_code ?? "",
        r.detail_row_no ?? "",
      ].join("|");
      if (seen.has(dk)) continue;
      seen.add(dk);
      filtered.push(r);
    }
    filtered.sort((a, b) => {
      const ai = staffIdx.get(staffKey(a.office_number, a.staff_name)) ?? 9999;
      const bi = staffIdx.get(staffKey(b.office_number, b.staff_name)) ?? 9999;
      if (ai !== bi) return ai - bi;
      const an = a.client_number ?? a.insured_number ?? "";
      const bn = b.client_number ?? b.insured_number ?? "";
      return an.localeCompare(bn);
    });
    return filtered;
  }, [records, allStaffKeys, selectedMonth]);

  // ケアマネ別単位数合計
  const staffTotals = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of sorted) {
      const k = staffKey(r.office_number, r.staff_name);
      const resolved = resolveRecordUnit(r, units);
      m.set(k, (m.get(k) ?? 0) + (resolved?.unit ?? 0));
    }
    return m;
  }, [sorted, units]);

  // 月遷移コントロール
  const monthControl = (
    <div className="flex items-center gap-3 px-1">
      <Button onClick={goPrev} disabled={monthIdx <= 0} size="sm" variant="outline">← 前月</Button>
      {selectedMonth ? (
        <MonthInputButton
          value={selectedMonth.slice(0, 7)}
          onChange={(next) => setSelectedMonth(`${next}-01`)}
          formatLabel={(ym) => fmtMonthLabel(`${ym}-01`)}
        />
      ) : (
        <span className="text-sm font-medium min-w-[110px] text-center">—</span>
      )}
      <Button onClick={goNext} disabled={monthIdx < 0 || monthIdx >= allMonths.length - 1} size="sm" variant="outline">次月 →</Button>
      <span className="text-xs text-muted-foreground ml-2">
        ({sorted.length} 件)
      </span>
    </div>
  );

  if (allMonths.length === 0) {
    return (
      <div className="space-y-2">
        {monthControl}
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          利用者明細がありません
        </div>
      </div>
    );
  }

  // staff 単位で group して描画 (各 group の末尾に合計行)
  const groups: Array<{ key: string; rows: FullRecord[]; total: number }> = [];
  let curKey = "";
  let curRows: FullRecord[] = [];
  for (const r of sorted) {
    const k = staffKey(r.office_number, r.staff_name);
    if (k !== curKey) {
      if (curRows.length > 0) {
        groups.push({ key: curKey, rows: curRows, total: staffTotals.get(curKey) ?? 0 });
      }
      curKey = k;
      curRows = [];
    }
    curRows.push(r);
  }
  if (curRows.length > 0) {
    groups.push({ key: curKey, rows: curRows, total: staffTotals.get(curKey) ?? 0 });
  }

  return (
    <div className="space-y-2">
      {monthControl}
      <div className="overflow-auto rounded-lg border">
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-28">担当ケアマネ</TableHead>
              <TableHead className="min-w-28">利用者名</TableHead>
              <TableHead className="min-w-20">介護度</TableHead>
              <TableHead className="min-w-24">保険者</TableHead>
              <TableHead className="min-w-52">サービス名</TableHead>
              <TableHead className="min-w-20 text-right">単位数</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
                  この月のデータはありません
                </TableCell>
              </TableRow>
            ) : groups.map((g) => {
              const first = g.rows[0];
              // 連続する同値セルを空欄化するため、前 row の利用者識別子を保持
              let prevClient: string | null = null;
              return (
                <Fragment key={g.key}>
                  {g.rows.map((r, rowIdx) => {
                    const resolved = resolveRecordUnit(r, units);
                    // 担当ケアマネ は group 内で一定なので先頭行だけ表示
                    const showStaff = rowIdx === 0;
                    // 利用者単位で 介護度 / 保険者 は同値が続くため、利用者切替時のみ表示
                    const clientKey = r.client_number ?? r.insured_number ?? r.insured_name ?? "";
                    const isNewClient = clientKey !== prevClient;
                    prevClient = clientKey;
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="text-muted-foreground/70">
                          {showStaff ? r.staff_name : ""}
                        </TableCell>
                        <TableCell>{isNewClient ? (r.insured_name ?? "") : ""}</TableCell>
                        <TableCell className="text-muted-foreground/70">
                          {isNewClient ? (r.care_level ?? "") : ""}
                        </TableCell>
                        <TableCell className="text-muted-foreground/70">
                          {isNewClient ? (r.insurer_name ?? "") : ""}
                        </TableCell>
                        <TableCell>{r.service_name ?? ""}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {resolved ? resolved.unit.toLocaleString("ja-JP") : ""}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  <TableRow className="bg-muted/50 font-medium">
                    <TableCell colSpan={5} className="text-right">
                      {first.staff_name} 合計
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {g.total.toLocaleString("ja-JP")}
                    </TableCell>
                  </TableRow>
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// =====================================================================
// Tab: 差異明細
// =====================================================================

type SayiEntry = {
  officeNumber: string;
  staff: string;
  serviceMonth: string;
  payMonth: string;
  kind: "late1" | "late2" | "kakutei" | "shikyu";
  relatedMonth: string;
  amount: number;
  note: string;
};

function SayiTab({
  allStaffKeys,
  allMonths,
  officeMap,
  recordsByOffice,
  calcConfigByOffice,
  salaryCache,
  adjustmentsByStaffMonth,
  paidMap,
}: {
  allStaffKeys: Array<{ officeNumber: string; staffName: string }>;
  allMonths: string[];
  officeMap: Map<string, KyotakuOffice>;
  recordsByOffice: Map<string, FullRecord[]>;
  calcConfigByOffice: Map<string, CalcConfig>;
  salaryCache: Map<string, ReturnType<typeof calcSalary>>;
  adjustmentsByStaffMonth: Map<string, { late_adj: number; sayi_adj: number }>;
  paidMap: Map<string, number>;
}) {
  const entries = useMemo(() => {
    const out: SayiEntry[] = [];

    for (const k of allStaffKeys) {
      const { officeNumber, staffName: staff } = k;
      const recs = recordsByOffice.get(officeNumber) ?? [];
      const cfg = calcConfigByOffice.get(officeNumber);
      if (!cfg) continue;

      // 月遅れ調整 (late1 / late2): T-1 / T-2 由来の chosei が T+1 で支払われる
      for (const month of allMonths) {
        const payMonth = addMonths(month, 1);
        const prev1 = addMonths(month, -1);
        const sal1 = salaryCache.get(`${officeNumber}|${staff}|${prev1}`);
        if (sal1 && sal1.chosei1 !== 0) {
          out.push({
            officeNumber,
            staff,
            serviceMonth: month,
            payMonth,
            kind: "late1",
            relatedMonth: prev1,
            amount: sal1.chosei1,
            note: `${fmtMonthLabel(prev1)} 提供分の翌々月請求調整`,
          });
        }
        const prev2 = addMonths(month, -2);
        const sal2 = salaryCache.get(`${officeNumber}|${staff}|${prev2}`);
        if (sal2 && sal2.chosei2 !== 0) {
          out.push({
            officeNumber,
            staff,
            serviceMonth: month,
            payMonth,
            kind: "late2",
            relatedMonth: prev2,
            amount: sal2.chosei2,
            note: `${fmtMonthLabel(prev2)} 提供分の 3 か月後請求調整`,
          });
        }
      }

      // 確定差異
      for (const month of allMonths) {
        const adj = adjustmentsByStaffMonth.get(
          `${officeNumber}|${staff}|${month}`,
        );
        if (!adj || adj.sayi_adj === 0) continue;
        const paidStaffMonths = allMonths.filter(
          (m) =>
            m < month &&
            (paidMap.get(`${officeNumber}|${staff}|${addMonths(m, 1)}`) ?? 0) >
              0,
        );
        for (const pm of paidStaffMonths) {
          const sal = salaryCache.get(`${officeNumber}|${staff}|${pm}`);
          if (!sal) continue;
          const paid =
            paidMap.get(`${officeNumber}|${staff}|${addMonths(pm, 1)}`) ?? 0;
          // 過去月の確定差異: T+1 支払対象 = base + plan + kazan + 独立手当
          //                                  + business_trip_teate
          const diff =
            sal.base +
            sal.plan +
            sal.kazan +
            sal.shikaku +
            sal.kotei +
            sal.tokutei +
            sal.business_trip_teate -
            paid;
          if (diff === 0) continue;
          out.push({
            officeNumber,
            staff,
            serviceMonth: month,
            payMonth: addMonths(month, 1),
            kind: "kakutei",
            relatedMonth: pm,
            amount: diff,
            note: `${fmtMonthLabel(pm)} 提供分の確定差異`,
          });
        }
      }

      // 支給済みとの差異
      for (const month of allMonths) {
        const payMonth = addMonths(month, 1);
        const paid = paidMap.get(`${officeNumber}|${staff}|${payMonth}`) ?? 0;
        if (paid === 0) continue;
        const calc = calcPaymentForMonth(recs, staff, payMonth, cfg);
        const diff = calc - paid;
        if (diff === 0) continue;
        out.push({
          officeNumber,
          staff,
          serviceMonth: month,
          payMonth,
          kind: "shikyu",
          relatedMonth: payMonth,
          amount: diff,
          note: "支給済みとの差異",
        });
      }
    }

    out.sort((a, b) => {
      if (a.officeNumber !== b.officeNumber) {
        return a.officeNumber.localeCompare(b.officeNumber);
      }
      if (a.staff !== b.staff) return a.staff.localeCompare(b.staff);
      if (a.serviceMonth !== b.serviceMonth) {
        return a.serviceMonth.localeCompare(b.serviceMonth);
      }
      return a.kind.localeCompare(b.kind);
    });
    return out;
  }, [
    allStaffKeys,
    allMonths,
    recordsByOffice,
    calcConfigByOffice,
    salaryCache,
    adjustmentsByStaffMonth,
    paidMap,
  ]);

  if (entries.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        差異はありません
      </div>
    );
  }

  return (
    <div className="overflow-auto rounded-lg border">
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-28">事業所</TableHead>
            <TableHead className="min-w-32">担当ケアマネ</TableHead>
            <TableHead className="min-w-24">計算対象月</TableHead>
            <TableHead className="min-w-24">支払い月</TableHead>
            <TableHead className="min-w-40">原因種別</TableHead>
            <TableHead className="min-w-24">関連月</TableHead>
            <TableHead className="min-w-24 text-right">金額</TableHead>
            <TableHead className="min-w-52">備考</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((e, i) => {
            const kindLabel =
              e.kind === "late1"
                ? "月遅れ調整（翌々月請求）"
                : e.kind === "late2"
                  ? "月遅れ調整（3か月後請求）"
                  : e.kind === "kakutei"
                    ? "確定差異（過去月）"
                    : "支給済みとの差異";
            const kindBg =
              e.kind === "late1"
                ? "bg-sky-50 dark:bg-sky-950/30"
                : e.kind === "late2"
                  ? "bg-blue-50 dark:bg-blue-950/30"
                  : e.kind === "kakutei"
                    ? "bg-pink-50 dark:bg-pink-950/30"
                    : "bg-yellow-50 dark:bg-yellow-950/30";
            const isNeg = e.amount < 0;
            return (
              <TableRow key={i} className={kindBg}>
                <TableCell>
                  {officeShortLabel(officeMap, e.officeNumber)}
                </TableCell>
                <TableCell>{e.staff}</TableCell>
                <TableCell>{fmtMonthLabel(e.serviceMonth)}</TableCell>
                <TableCell>{fmtMonthLabel(e.payMonth)}</TableCell>
                <TableCell>{kindLabel}</TableCell>
                <TableCell>{fmtMonthLabel(e.relatedMonth)}</TableCell>
                <TableCell
                  className={`text-right tabular-nums ${
                    isNeg ? "text-destructive font-bold" : ""
                  }`}
                >
                  {fmtSigned(e.amount)}
                </TableCell>
                <TableCell className="text-muted-foreground">{e.note}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// `ALL_OFFICES_KEY` は将来 modal 内 office 選択 sentinel として保持 (現状未使用)
void ALL_OFFICES_KEY;

// =====================================================================
// Tab: 予防件数 (介護予防支援 件数の手入力 UI + 取込済の読み取り表示)
// =====================================================================

/**
 * 編集中 row の中間状態。
 * - existingId 有 → 既存 row の編集 (upsert で id を渡す)
 * - existingId 無 → 新規行追加 (upsert は UNIQUE 制約に当たる)
 * - locked: source='csv' の row は読み取り専用
 */
type EditableYobouRow = {
  key: string; // staffName|billingMonth
  staffName: string;
  billingMonth: string; // YYYY-MM-01
  yobou1: number;
  yobou2: number;
  source: "csv" | "manual" | "new";
  existingId: string | null;
  locked: boolean;
};

function YobouTab({
  tenantId,
  allKyotakuOffices,
  filterOfficeNumber,
  yobouRows,
  allStaffKeys,
  officeMap,
  onSaved,
}: {
  tenantId: string;
  allKyotakuOffices: KyotakuOffice[];
  filterOfficeNumber: string | null;
  yobouRows: YobouRow[];
  allStaffKeys: Array<{ officeNumber: string; staffName: string }>;
  officeMap: Map<string, KyotakuOffice>;
  onSaved: () => void | Promise<void>;
}) {
  // 「予防件数」tab は office 単位での編集を強制。全社 view では先頭 office を default 採用。
  const [selectedOfficeNumber, setSelectedOfficeNumber] = useState<string>(
    () => filterOfficeNumber ?? allKyotakuOffices[0]?.office_number ?? "",
  );
  useEffect(() => {
    if (filterOfficeNumber && filterOfficeNumber !== selectedOfficeNumber) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- props 変化追随
      setSelectedOfficeNumber(filterOfficeNumber);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterOfficeNumber]);

  // 月リスト (yobou + allStaffKeys 由来) は service_month 単位で
  const allYobouMonths = useMemo(() => {
    const s = new Set<string>();
    for (const y of yobouRows) {
      if (y.office_number === selectedOfficeNumber && y.service_month) {
        s.add(y.service_month);
      }
    }
    // 取込済が無くても、最低 1 ヶ月 (今月) は表示できるよう default month を追加
    if (s.size === 0) {
      const now = new Date();
      const y = now.getUTCFullYear();
      const mo = String(now.getUTCMonth() + 1).padStart(2, "0");
      s.add(`${y}-${mo}-01`);
    }
    return Array.from(s).sort();
  }, [yobouRows, selectedOfficeNumber]);

  const [selectedMonth, setSelectedMonth] = useState<string | null>(
    () => allYobouMonths[allYobouMonths.length - 1] ?? null,
  );
  useEffect(() => {
    // 初期化時のみ default 月を設定。ユーザが選択中の月はデータ有無に関わらず保持。
    if (!selectedMonth) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 初期化
      setSelectedMonth(allYobouMonths[allYobouMonths.length - 1] ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allYobouMonths]);

  // 月遷移は freestyle (= 既存データ無い月も自由に遷移、入力後に DB に追加される)
  const shiftMonth = (ym: string | null, delta: number): string | null => {
    if (!ym) return null;
    const [y, m] = ym.slice(0, 7).split("-").map(Number);
    if (!y || !m) return null;
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    const ny = d.getUTCFullYear();
    const nm = String(d.getUTCMonth() + 1).padStart(2, "0");
    return `${ny}-${nm}-01`;
  };
  const goPrev = () => {
    const prev = shiftMonth(selectedMonth, -1);
    if (prev) setSelectedMonth(prev);
  };
  const goNext = () => {
    const next = shiftMonth(selectedMonth, 1);
    if (next) setSelectedMonth(next);
  };

  // 選択中 office の staff 一覧 (allStaffKeys 経由)
  const officeStaffs = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const k of allStaffKeys) {
      if (k.officeNumber !== selectedOfficeNumber) continue;
      if (seen.has(k.staffName)) continue;
      seen.add(k.staffName);
      out.push(k.staffName);
    }
    return out;
  }, [allStaffKeys, selectedOfficeNumber]);

  // 編集中の row state (key: staffName|billingMonth)。
  // 初期化は selectedMonth + officeStaffs + yobouRows から導出。
  const [editRows, setEditRows] = useState<Map<string, EditableYobouRow>>(
    () => new Map(),
  );
  const [savingState, setSavingState] = useState<"idle" | "saving">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  // selectedMonth / officeStaffs / yobouRows が変わったら edit state を rebuild
  useEffect(() => {
    if (!selectedMonth) return;
    const next = new Map<string, EditableYobouRow>();

    // 既存 yobou row (csv / manual) を取り込み
    for (const y of yobouRows) {
      if (y.office_number !== selectedOfficeNumber) continue;
      if (y.service_month !== selectedMonth) continue;
      const k = `${y.staff_name}|${y.billing_month}`;
      next.set(k, {
        key: k,
        staffName: y.staff_name,
        billingMonth: y.billing_month,
        yobou1: y.yobou1_count ?? 0,
        yobou2: y.yobou2_count ?? 0,
        source: y.source,
        existingId: y.id,
        locked: y.source === "csv",
      });
    }

    // 未登録 staff について「翌月請求」default の空 row を追加 (= UI で 0 を表示)
    const defaultBilling = addMonths(selectedMonth, 1);
    for (const staff of officeStaffs) {
      const k = `${staff}|${defaultBilling}`;
      if (next.has(k)) continue;
      next.set(k, {
        key: k,
        staffName: staff,
        billingMonth: defaultBilling,
        yobou1: 0,
        yobou2: 0,
        source: "new",
        existingId: null,
        locked: false,
      });
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect -- 選択月切替時の rebuild
    setEditRows(next);
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMonth, selectedOfficeNumber, yobouRows, officeStaffs.join(",")]);

  const updateField = (
    key: string,
    field: "yobou1" | "yobou2",
    val: number,
  ) => {
    setEditRows((prev) => {
      const next = new Map(prev);
      const r = next.get(key);
      if (!r || r.locked) return prev;
      next.set(key, { ...r, [field]: val });
      return next;
    });
  };

  // 行追加: staff を選んで billingMonth を入力させる。同 staff/billingMonth が
  // 既にあれば追加せず focus を促すだけ。
  const [addStaffName, setAddStaffName] = useState<string>("");
  const [addBillingMonth, setAddBillingMonth] = useState<string>("");

  const handleAddRow = () => {
    if (!selectedMonth) return;
    const staff = addStaffName.trim();
    const bmRaw = addBillingMonth.trim();
    if (!staff) {
      setSaveError("行追加: 担当ケアマネを選んでください");
      return;
    }
    // YYYY-MM 入力を YYYY-MM-01 に正規化
    let bm: string;
    if (/^\d{4}-\d{2}$/.test(bmRaw)) {
      bm = `${bmRaw}-01`;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(bmRaw)) {
      bm = `${bmRaw.slice(0, 7)}-01`;
    } else {
      setSaveError("行追加: 請求年月は YYYY-MM 形式で入力してください");
      return;
    }
    const k = `${staff}|${bm}`;
    setEditRows((prev) => {
      if (prev.has(k)) return prev;
      const next = new Map(prev);
      next.set(k, {
        key: k,
        staffName: staff,
        billingMonth: bm,
        yobou1: 0,
        yobou2: 0,
        source: "new",
        existingId: null,
        locked: false,
      });
      return next;
    });
    setSaveError(null);
    setAddStaffName("");
    setAddBillingMonth("");
  };

  const handleSave = async () => {
    if (!selectedMonth) return;
    if (!selectedOfficeNumber) {
      setSaveError("事業所が未選択です");
      return;
    }
    setSavingState("saving");
    setSaveError(null);
    try {
      // 編集対象は locked=false の row のみ。
      // 既存 (existingId 有) は値が変わった row のみ送る。
      // 新規 (existingId 無) は yobou1+yobou2 > 0 の row のみ送る (空 row 無駄送り回避)
      const original = new Map<string, YobouRow>();
      for (const y of yobouRows) {
        if (y.office_number !== selectedOfficeNumber) continue;
        if (y.service_month !== selectedMonth) continue;
        original.set(`${y.staff_name}|${y.billing_month}`, y);
      }

      const toUpsert: Array<{
        tenant_id: string;
        office_number: string;
        service_month: string;
        billing_month: string;
        staff_name: string;
        yobou1_count: number;
        yobou2_count: number;
        source: "manual";
        source_filename: null;
      }> = [];

      for (const r of editRows.values()) {
        if (r.locked) continue;
        const orig = original.get(r.key);
        if (orig) {
          if (
            (orig.yobou1_count ?? 0) === r.yobou1 &&
            (orig.yobou2_count ?? 0) === r.yobou2
          ) {
            continue; // 変更なし
          }
        } else {
          // 新規かつ全 0 は送らない
          if (r.yobou1 === 0 && r.yobou2 === 0) continue;
        }
        toUpsert.push({
          tenant_id: tenantId,
          office_number: selectedOfficeNumber,
          service_month: selectedMonth,
          billing_month: r.billingMonth,
          staff_name: r.staffName,
          yobou1_count: r.yobou1,
          yobou2_count: r.yobou2,
          source: "manual",
          source_filename: null,
        });
      }

      if (toUpsert.length === 0) {
        setSaveError("変更がありません");
        setSavingState("idle");
        return;
      }

      const { error } = await supabase
        .from("payroll_kyotaku_yobou_records")
        .upsert(toUpsert, {
          onConflict:
            "office_number,service_month,billing_month,staff_name",
          ignoreDuplicates: false,
        });
      if (error) throw error;
      await onSaved();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingState("idle");
    }
  };

  if (allKyotakuOffices.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        居宅介護支援 type の事業所が登録されていません。
      </div>
    );
  }

  // edit rows を表示順 sort: source=csv 先頭 / staff 順 / billingMonth 順
  const rowsSorted = Array.from(editRows.values()).sort((a, b) => {
    if (a.staffName !== b.staffName) {
      return a.staffName.localeCompare(b.staffName, "ja");
    }
    return a.billingMonth.localeCompare(b.billingMonth);
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 px-1 flex-wrap">
        {/* office 切替 (全社 mode のみ表示。固定 mode は filter で既に絞り込まれ済) */}
        {filterOfficeNumber === null ? (
          <select
            value={selectedOfficeNumber}
            onChange={(e) => setSelectedOfficeNumber(e.target.value)}
            className="border rounded px-2 py-1 text-sm bg-background"
          >
            {allKyotakuOffices.map((o) => (
              <option key={o.office_number} value={o.office_number}>
                {o.short_name || o.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-sm font-medium">
            {officeShortLabel(officeMap, selectedOfficeNumber)}
          </span>
        )}

        <Button onClick={goPrev} disabled={!selectedMonth} size="sm" variant="outline">
          ← 前月
        </Button>
        {selectedMonth ? (
          <MonthInputButton
            value={selectedMonth.slice(0, 7)}
            onChange={(next) => setSelectedMonth(`${next}-01`)}
            formatLabel={(ym) => `提供月: ${fmtMonthLabel(`${ym}-01`)}`}
          />
        ) : (
          <span className="text-sm font-medium min-w-[110px] text-center">提供月: —</span>
        )}
        <Button onClick={goNext} disabled={!selectedMonth} size="sm" variant="outline">
          次月 →
        </Button>
        <span className="text-xs text-muted-foreground ml-2">
          ({rowsSorted.length} 行)
        </span>
        <Button
          onClick={handleSave}
          disabled={savingState === "saving"}
          size="sm"
        >
          {savingState === "saving" ? "保存中..." : "保存"}
        </Button>
      </div>

      {/* 行追加 UI */}
      <div className="flex items-center gap-2 px-1 flex-wrap text-xs">
        <label className="text-muted-foreground">行追加:</label>
        <select
          value={addStaffName}
          onChange={(e) => setAddStaffName(e.target.value)}
          className="border rounded px-2 py-1 text-xs bg-background"
        >
          <option value="">担当ケアマネ…</option>
          {officeStaffs.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          type="month"
          value={addBillingMonth}
          onChange={(e) => setAddBillingMonth(e.target.value)}
          className="border rounded px-2 py-1 text-xs bg-background"
          placeholder="請求年月"
        />
        <Button
          onClick={handleAddRow}
          size="xs"
          variant="outline"
          disabled={!addStaffName || !addBillingMonth}
        >
          ＋ 追加
        </Button>
      </div>

      {saveError && (
        <div className="rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {saveError}
        </div>
      )}

      <div className="overflow-auto rounded-lg border">
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-32">担当ケアマネ</TableHead>
              <TableHead className="min-w-28">請求年月</TableHead>
              <TableHead className="min-w-24">区分</TableHead>
              <TableHead className="min-w-24 text-right">要支援1件数</TableHead>
              <TableHead className="min-w-24 text-right">要支援2件数</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rowsSorted.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                  この月のデータはありません
                </TableCell>
              </TableRow>
            ) : (
              rowsSorted.map((r) => {
                const delay = monthDelayDiff(selectedMonth ?? "", r.billingMonth);
                const delayLabel = !Number.isFinite(delay)
                  ? "—"
                  : delay <= 0
                    ? "当月請求"
                    : delay === 1
                      ? "翌月請求"
                      : delay === 2
                        ? "月遅れ(翌々月)"
                        : `月遅れ(${delay}か月後)`;
                return (
                  <TableRow key={r.key} className={r.locked ? "bg-muted/30" : ""}>
                    <TableCell>{r.staffName}</TableCell>
                    <TableCell className="tabular-nums">
                      {r.billingMonth.slice(0, 7)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <span className="text-muted-foreground">{delayLabel}</span>
                        {r.source === "csv" ? (
                          <Badge variant="secondary" className="text-[10px]">
                            CSV
                          </Badge>
                        ) : r.source === "manual" ? (
                          <Badge variant="outline" className="text-[10px]">
                            手入力
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={r.yobou1}
                        onChange={(e) =>
                          updateField(
                            r.key,
                            "yobou1",
                            Math.max(0, Math.floor(Number(e.target.value) || 0)),
                          )
                        }
                        disabled={r.locked}
                        className="w-20 text-right border rounded px-1 py-0.5 bg-background tabular-nums disabled:bg-muted disabled:cursor-not-allowed"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={r.yobou2}
                        onChange={(e) =>
                          updateField(
                            r.key,
                            "yobou2",
                            Math.max(0, Math.floor(Number(e.target.value) || 0)),
                          )
                        }
                        disabled={r.locked}
                        className="w-20 text-right border rounded px-1 py-0.5 bg-background tabular-nums disabled:bg-muted disabled:cursor-not-allowed"
                      />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
