"use client";

import useSWR from "swr";
import { supabase } from "@/lib/supabase";
import { fetchAllPagesParallel } from "@/lib/fetch-all";
import type {
  Confirmation,
  EmployeeSetting,
  KyotakuAttendanceRecord,
  KyotakuRecord,
  RegionalRate,
  ServiceUnit,
  YobouRecord,
} from "@/lib/payroll/kyotaku-calc";
import type { KyotakuSalary } from "@/lib/payroll/kyotaku-salary-history";

/**
 * 居宅介護支援 給与計算 dashboard 用 SWR データ取得 hook。
 *
 * 撤去の容易さ:
 *   - 本ファイルが SWR を使う唯一の場所 (use-kyotaku-summary.ts と並んで)。
 *   - 撤去するときは本ファイル内部を `useState + useEffect` に書き換えるだけで
 *     呼び出し側 (KyotakuPayrollDashboard) は変更不要。
 *
 * Cache key: `kyotaku-dashboard:${sorted(officeNumbers).join(",")}`
 *   officeNumbers が変わると別 cache。officeNumbers が空 (= 該当 office 無し) なら
 *   fetch 走らず空のデータを返す。
 */

// =====================================================================
// 型 (component と共有するため export)
// =====================================================================

export type FullRecord = KyotakuRecord & {
  id: string;
  office_number: string;
  insured_number: string | null;
  insured_name: string | null;
  client_number: string | null;
  service_code: string | null;
};

/**
 * SettingRow: 居宅介護支援ケアマネ identity + (履歴の最新行から派生した) salary snapshot。
 *
 * - id / office_number / staff_name は employee identity
 * - honnin_kyu 以降の salary 数値は payroll_kyotaku_salary の「最新 row」を flatten
 *   したもの (= 履歴 table から effective_from DESC で 1 件目)
 * - 月別の active 値が必要な reader (= dashboard / summary 等) は本 SettingRow ではなく
 *   `kyotakuSalaryRows` + `getActiveKyotakuSalary(rows, employee_id, monthStart)` で
 *   対象月の row を解決すること。本 SettingRow の数値は「最新 row snapshot」であり
 *   過去月計算には使えない。
 */
export type SettingRow = EmployeeSetting & {
  id?: string;
  office_number: string;
};

export type ConfirmationRow = Confirmation & {
  id: string;
  office_number: string;
  confirmed_at: string;
  reverted_at: string | null;
};

export type YobouRow = YobouRecord & {
  id: string;
  tenant_id: string;
  office_number: string;
  source: "csv" | "manual";
  source_filename: string | null;
};

export type AttendanceWithStaffName = KyotakuAttendanceRecord & {
  office_number: string;
};

/**
 * 出勤簿 月次 (件数) 1 row。dashboard 仮計算 input。
 * staff_name は employees から解決済 (DB の row 自体は employee_id key)。
 */
export type MonthlyRow = {
  office_number: string;
  staff_name: string;
  month_start: string; // YYYY-MM-01
  kaigo_count: number;
  yobou_count: number;
};

/**
 * 出勤簿 月次 加算 1 row。
 * 規定加算 (kasan_unit + kasan_count) または 自由記述 (free_label + free_amount)。
 */
export type MonthlyKasanRow = {
  office_number: string;
  staff_name: string;
  month_start: string;
  kasan_unit: number | null;
  kasan_count: number | null;
  free_label: string | null;
  free_amount: number | null;
};

/**
 * 仮計算 snapshot 1 row。「確定」操作で保存された仮計算結果。
 * UI 上は (office_number, staff_name, month_start) で lookup する。
 */
export type ProvisionalSnapshotRow = {
  id: string;
  office_number: string;
  staff_name: string;
  month_start: string;
  provisional_amount: number;
  snapshot_at: string;
};

export type KyotakuDashboardData = {
  records: FullRecord[];
  settings: SettingRow[];
  /** 居宅ケアマネ給与履歴 (payroll_kyotaku_salary, append-only)。
   *  対象月の active row は `getActiveKyotakuSalary(rows, employee_id, monthStart)` で解決。 */
  kyotakuSalaryRows: KyotakuSalary[];
  units: ServiceUnit[];
  rates: RegionalRate[];
  confirmations: ConfirmationRow[];
  yobouRows: YobouRow[];
  attendanceRows: AttendanceWithStaffName[];
  officeTravelRateMap: Map<string, number>;
  monthlyRows: MonthlyRow[];
  monthlyKasanRows: MonthlyKasanRow[];
  provisionalSnapshots: ProvisionalSnapshotRow[];
};

const EMPTY_DATA: KyotakuDashboardData = {
  records: [],
  settings: [],
  kyotakuSalaryRows: [],
  units: [],
  rates: [],
  confirmations: [],
  yobouRows: [],
  attendanceRows: [],
  officeTravelRateMap: new Map(),
  monthlyRows: [],
  monthlyKasanRows: [],
  provisionalSnapshots: [],
};

// =====================================================================
// fetcher (SWR から呼ばれる)
// =====================================================================

async function fetchKyotakuDashboardData(
  officeNumbers: string[],
  officeIds: string[],
): Promise<KyotakuDashboardData> {
  if (officeNumbers.length === 0) {
    return EMPTY_DATA;
  }

  const [
    recs,
    setRes,
    salaryRes,
    unitRes,
    rateRes,
    confRes,
    yobouRes,
    attRes,
    officeRes,
    monthlyRes,
    monthlyKasanRes,
    provSnapRes,
  ] = await Promise.all([
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
      // 居宅介護支援ケアマネ identity 取得。payroll_employees.office_id は
      // payroll_offices.id への FK。office_number で partition したいので embed で
      // payroll_offices.office_number を引き寄せる。
      // 全 employees fetch すると PostgREST default 1000 行 limit に引っ掛かり、
      // id 順で範囲外の居宅介護支援ケアマネが落ちる (memory: 1253 件 backfill 済)。
      // 居宅介護支援 office (~30 件) に絞れば数百件で完結し limit を回避できる。
      //
      // 給与数値 (honnin_kyu 等) は payroll_employees.kyotaku_* (旧 source) ではなく
      // payroll_kyotaku_salary (= 履歴 table) から月別に解決する (salaryRes 参照)。
      // ここでは identity (id, name, office_number) のみ取得する。
      supabase
        .from("payroll_employees")
        .select(
          "id, name, office:payroll_offices!office_id(office_number)",
        )
        .in("office_id", officeIds),
      // 居宅ケアマネ給与履歴。append-only / per-employee × effective_from。
      // 件数は ~30 office × ~ケアマネ数 × (履歴件数 ~1-数件) で数百〜数千 row の見込み。
      // 1000 行 PostgREST default 対策で limit(10000) を明示。
      // DB 未 apply 段階は error 握り潰し → 空配列 fallback (= 旧仕様互換挙動)。
      supabase
        .from("payroll_kyotaku_salary")
        .select(
          "id, tenant_id, employee_id, effective_from, honnin_kyu, shokuno_kyu, kotei_zangyo, shikaku_teate, kotei, tokutei_shogu, kaigo_rate, shien_rate",
        )
        .limit(10000),
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
      // 出勤簿 月次本体 (件数)。1 row = staff × month、~30 office × ~12 ヶ月 ×
      // ~ケアマネ数 で数千行に収まる前提。DB 未 apply 段階は error 握り潰し。
      // 1000 行 PostgREST default 対策で limit(10000) を明示。
      supabase
        .from("payroll_kyotaku_attendance_monthly")
        .select("employee_id, month_start, kaigo_count, yobou_count, office_id")
        .in("office_id", officeIds)
        .limit(10000),
      // 出勤簿 月次加算明細 (規定 + 自由記述)。multi-row per (employee, month)。
      supabase
        .from("payroll_kyotaku_attendance_monthly_kasan")
        .select(
          "employee_id, month_start, kasan_unit, kasan_count, free_label, free_amount, office_id",
        )
        .in("office_id", officeIds)
        .limit(10000),
      // 仮計算 snapshot (確定済み)。1 row = staff × month。
      // DB 未 apply 段階は error 握り潰し → 空 fallback。
      supabase
        .from("payroll_kyotaku_provisional_snapshots")
        .select(
          "id, employee_id, month_start, provisional_amount, snapshot_at, office_id",
        )
        .in("office_id", officeIds)
        .limit(10000),
    ]);

  if (setRes.error) throw setRes.error;
  if (unitRes.error) throw unitRes.error;
  if (rateRes.error) throw rateRes.error;
  if (confRes.error) throw confRes.error;
  // yobouRes / salaryRes は DB 未 apply 段階の error を許容 (空配列 fallback)

  // payroll_employees row → identity だけ取り出す。office_number は embed 経由で
  // 取り出す。embed は 1:1 (employees.office_id → offices.id) なので object。
  // 居宅介護支援以外の office に紐づく employee は office_number が
  // officeNumbers 集合に含まれないため後段の partition で自然に除外される。
  type RawEmployeeRow = {
    id: string;
    name: string;
    office: { office_number: string | null } | null;
  };
  const officeNumberSet = new Set(officeNumbers);

  // 履歴 row: employee_id → 全 row。同 employee の中で effective_from DESC で 1 件目を
  // 「最新 row snapshot」として SettingRow に焼き込む。月別 active 値が必要な reader
  // (= dashboard / summary) は SettingRow ではなく kyotakuSalaryRows を直接参照する。
  const kyotakuSalaryRows: KyotakuSalary[] = salaryRes.error
    ? []
    : ((salaryRes.data ?? []) as unknown as KyotakuSalary[]);
  const latestSalaryByEmp = new Map<string, KyotakuSalary>();
  for (const s of kyotakuSalaryRows) {
    const prev = latestSalaryByEmp.get(s.employee_id);
    if (!prev || s.effective_from > prev.effective_from) {
      latestSalaryByEmp.set(s.employee_id, s);
    }
  }

  const mappedSettings: SettingRow[] = [];
  for (const r of (setRes.data ?? []) as unknown as RawEmployeeRow[]) {
    const officeNumber = r.office?.office_number ?? "";
    if (!officeNumber || !officeNumberSet.has(officeNumber)) continue;
    if (!r.name) continue;
    const latest = latestSalaryByEmp.get(r.id);
    mappedSettings.push({
      id: r.id,
      office_number: officeNumber,
      staff_name: r.name,
      honnin_kyu: latest ? latest.honnin_kyu : null,
      shokuno_kyu: latest ? latest.shokuno_kyu : null,
      kotei_zangyo: latest ? latest.kotei_zangyo : null,
      shikaku_teate: latest ? latest.shikaku_teate : null,
      kotei: latest ? latest.kotei : null,
      tokutei_shogu: latest ? latest.tokutei_shogu : null,
      kaigo_rate: latest ? latest.kaigo_rate : null,
      shien_rate: latest ? latest.shien_rate : null,
    });
  }

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
      const km =
        typeof ar.business_km === "string"
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

  // payroll_offices.travel_unit_price → Map<office_number, number>
  type RawOfficeRow = {
    office_number: string;
    travel_unit_price: number | string | null;
  };
  const travelMap = new Map<string, number>();
  if (!officeRes.error) {
    for (const o of (officeRes.data ?? []) as unknown as RawOfficeRow[]) {
      if (!o.office_number) continue;
      const v =
        typeof o.travel_unit_price === "string"
          ? parseFloat(o.travel_unit_price)
          : (o.travel_unit_price ?? 0);
      travelMap.set(o.office_number, Number.isFinite(v) ? v : 0);
    }
  }

  // ── 月次本体 + 月次加算 + 仮計算 snapshot を staff_name 解決済の形に整形 ──
  // 各 row は employee_id key だが、dashboard 計算は staff_name key で動く。
  // employeeIdMap は上で組み済 (居宅介護支援 office に限定済)。
  type RawMonthlyRow = {
    employee_id: string;
    month_start: string;
    kaigo_count: number | null;
    yobou_count: number | null;
  };
  const mappedMonthly: MonthlyRow[] = [];
  if (!monthlyRes.error) {
    for (const r of (monthlyRes.data ?? []) as unknown as RawMonthlyRow[]) {
      const emp = employeeIdMap.get(r.employee_id);
      if (!emp) continue;
      if (!r.month_start) continue;
      mappedMonthly.push({
        office_number: emp.office_number,
        staff_name: emp.name,
        month_start: r.month_start,
        kaigo_count: r.kaigo_count ?? 0,
        yobou_count: r.yobou_count ?? 0,
      });
    }
  }

  type RawKasanRow = {
    employee_id: string;
    month_start: string;
    kasan_unit: number | null;
    kasan_count: number | null;
    free_label: string | null;
    free_amount: number | null;
  };
  const mappedKasan: MonthlyKasanRow[] = [];
  if (!monthlyKasanRes.error) {
    for (const r of (monthlyKasanRes.data ?? []) as unknown as RawKasanRow[]) {
      const emp = employeeIdMap.get(r.employee_id);
      if (!emp) continue;
      if (!r.month_start) continue;
      mappedKasan.push({
        office_number: emp.office_number,
        staff_name: emp.name,
        month_start: r.month_start,
        kasan_unit: r.kasan_unit,
        kasan_count: r.kasan_count,
        free_label: r.free_label,
        free_amount: r.free_amount,
      });
    }
  }

  type RawProvSnapRow = {
    id: string;
    employee_id: string;
    month_start: string;
    provisional_amount: number | null;
    snapshot_at: string;
  };
  const mappedProvSnap: ProvisionalSnapshotRow[] = [];
  if (!provSnapRes.error) {
    for (const r of (provSnapRes.data ?? []) as unknown as RawProvSnapRow[]) {
      const emp = employeeIdMap.get(r.employee_id);
      if (!emp) continue;
      if (!r.month_start) continue;
      mappedProvSnap.push({
        id: r.id,
        office_number: emp.office_number,
        staff_name: emp.name,
        month_start: r.month_start,
        provisional_amount: r.provisional_amount ?? 0,
        snapshot_at: r.snapshot_at,
      });
    }
  }

  return {
    records: recs,
    settings: mappedSettings,
    kyotakuSalaryRows,
    units: (unitRes.data ?? []) as ServiceUnit[],
    rates: (rateRes.data ?? []) as RegionalRate[],
    confirmations: (confRes.data ?? []) as ConfirmationRow[],
    yobouRows: yobouRes.error ? [] : ((yobouRes.data ?? []) as YobouRow[]),
    attendanceRows: mappedAttendance,
    officeTravelRateMap: travelMap,
    monthlyRows: mappedMonthly,
    monthlyKasanRows: mappedKasan,
    provisionalSnapshots: mappedProvSnap,
  };
}

// =====================================================================
// 公開 hook
// =====================================================================

export type UseKyotakuDashboardDataResult = KyotakuDashboardData & {
  isLoading: boolean;
  error: Error | null;
  /** 強制再 fetch (確定/取消/設定保存 後など) */
  mutate: () => void;
};

export function useKyotakuDashboardData(
  officeNumbers: string[],
  officeIds: string[],
): UseKyotakuDashboardDataResult {
  // cache key は officeNumbers の並び順に依存しないよう sort してから join。
  // officeNumbers が空ならば fetch しない (= key=null)。
  const sortedNumbers = [...officeNumbers].sort();
  const key =
    officeNumbers.length === 0
      ? null
      : `kyotaku-dashboard:${sortedNumbers.join(",")}`;

  const { data, error, isLoading, mutate } = useSWR<KyotakuDashboardData>(
    key,
    () => fetchKyotakuDashboardData(officeNumbers, officeIds),
    {
      // 一度取得した cache を維持しつつ、focus/再 mount で background revalidate
      revalidateOnFocus: false,
      revalidateOnReconnect: true,
      keepPreviousData: true,
    },
  );

  const effective = data ?? EMPTY_DATA;

  return {
    records: effective.records,
    settings: effective.settings,
    kyotakuSalaryRows: effective.kyotakuSalaryRows,
    units: effective.units,
    rates: effective.rates,
    confirmations: effective.confirmations,
    yobouRows: effective.yobouRows,
    attendanceRows: effective.attendanceRows,
    officeTravelRateMap: effective.officeTravelRateMap,
    monthlyRows: effective.monthlyRows,
    monthlyKasanRows: effective.monthlyKasanRows,
    provisionalSnapshots: effective.provisionalSnapshots,
    isLoading,
    error: error ?? null,
    mutate: () => {
      void mutate();
    },
  };
}
