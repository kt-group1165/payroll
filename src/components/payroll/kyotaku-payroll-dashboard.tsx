"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fetchAllPagesParallel } from "@/lib/fetch-all";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  type KyotakuRecord,
  type RegionalRate,
  type ServiceUnit,
} from "@/lib/payroll/kyotaku-calc";
// 別 agent が並列実装中。本実装時点では雛形 export を想定し、見つからない場合は
// 表示を null にすることで build break を回避する。
import { KyotakuSettingsModal } from "./kyotaku-settings-modal";

/**
 * 居宅介護支援 給与計算 dashboard (Phase 2)
 *
 * 集計.py の Excel 5 sheet 相当 (給与計算 / 支払いサマリー / 売上表 / 利用者内訳 /
 * 差異明細) を Web UI で表示する。
 *
 * データソース:
 *   - payroll_kyotaku_records          国保連 CSV row (一覧)
 *   - payroll_kyotaku_settings         ケアマネ別 (基本給 / 単価)
 *   - payroll_kyotaku_service_units    項目別 単位数 (tenant 共通)
 *   - payroll_kyotaku_regional_rates   保険者 → 円/単位 (tenant 共通)
 *   - payroll_kyotaku_confirmations    支給済み (reverted_at IS NULL のみ active)
 *
 * 仕様: apps/居宅給与計算/SPEC.md §4
 */

type Props = {
  officeNumber: string;
  officeName: string;
};

// =====================================================================
// DB row 型 (calc.ts の KyotakuRecord を拡張: 利用者内訳 / 売上表で追加列が要る)
// =====================================================================

type FullRecord = KyotakuRecord & {
  id: string;
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

// =====================================================================
// utility
// =====================================================================

const TENANT_ID = "kt-group";

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

/** records から service_month の sort 済み distinct 配列を返す */
function distinctMonths(records: FullRecord[]): string[] {
  const s = new Set<string>();
  for (const r of records) if (r.service_month) s.add(r.service_month);
  return Array.from(s).sort();
}

/** records から staff_name の distinct 配列 (出現順保持) を返す */
function distinctStaffs(records: FullRecord[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of records) {
    if (!r.staff_name) continue;
    if (seen.has(r.staff_name)) continue;
    seen.add(r.staff_name);
    out.push(r.staff_name);
  }
  return out.sort();
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

function countCells(
  records: FullRecord[],
  staff: string,
  month: string,
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

  for (const r of records) {
    if (r.staff_name !== staff) continue;
    if (r.service_month !== month) continue;
    if (r.detail_row_no !== "1") continue;
    if (!r.care_level) continue;

    const isKaigo = r.care_level.startsWith("要介護");
    const isShien = r.care_level.startsWith("要支援");
    if (!isKaigo && !isShien) continue;

    // monthDiff を呼ばず文字列比較で年月数値化
    const sm = r.service_month.slice(0, 7);
    const bm = r.billing_month.slice(0, 7);
    if (!sm || !bm) continue;
    const smN = parseInt(sm.replace("-", ""), 10);
    const bmN = parseInt(bm.replace("-", ""), 10);
    if (!Number.isFinite(smN) || !Number.isFinite(bmN)) continue;
    // 単純 month_diff (calc.ts と同等 — yymm 差を月数に変換)
    const sy = Math.floor(smN / 100);
    const ssm = smN % 100;
    const by = Math.floor(bmN / 100);
    const bbm = bmN % 100;
    const delay = (by - sy) * 12 + (bbm - ssm);

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

  return out;
}

// =====================================================================
// 売上表 (項目別売上、地域加算込)
// =====================================================================

/**
 * 1 record の単位数を解決:
 *   - detail_row_no === "1" (基本サービス行) → getBaseUnit(care_level)
 *   - それ以外 → service_name に含まれる加算項目があれば、その unit_count
 *   - 該当なし → null
 */
function resolveRecordUnit(
  r: FullRecord,
  units: ServiceUnit[],
): { itemName: string; unit: number } | null {
  if (r.detail_row_no === "1") {
    if (!r.care_level) return null;
    const u = getBaseUnit(r.care_level, units);
    if (u === 0) return null;
    return { itemName: r.care_level, unit: u };
  }
  if (!r.service_name) return null;
  // 部分一致で最初に match した加算項目を採用
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

/** activeConfirmations から (staff, pay_month) → amount を作る */
function buildPaidMap(confirmations: ConfirmationRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of confirmations) {
    if (c.reverted_at) continue;
    m.set(`${c.staff_name}__${c.pay_month}`, c.amount);
  }
  return m;
}

/** (staff, pay_month) の active confirmation row を返す (なければ null) */
function findActiveConfirmation(
  confirmations: ConfirmationRow[],
  staff: string,
  payMonth: string,
): ConfirmationRow | null {
  for (const c of confirmations) {
    if (c.reverted_at) continue;
    if (c.staff_name !== staff) continue;
    if (c.pay_month !== payMonth) continue;
    return c;
  }
  return null;
}

// =====================================================================
// Main Component
// =====================================================================

export function KyotakuPayrollDashboard({ officeNumber, officeName }: Props) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [records, setRecords] = useState<FullRecord[]>([]);
  const [settings, setSettings] = useState<SettingRow[]>([]);
  const [units, setUnits] = useState<ServiceUnit[]>([]);
  const [rates, setRates] = useState<RegionalRate[]>([]);
  const [confirmations, setConfirmations] = useState<ConfirmationRow[]>([]);

  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [busyPay, setBusyPay] = useState<string | null>(null); // "staff__pay_month" lock

  // ----------------------- data fetch -----------------------

  const fetchAll = async () => {
    setLoading(true);
    setErr(null);
    try {
      const [recs, setRes, unitRes, rateRes, confRes] = await Promise.all([
        fetchAllPagesParallel<FullRecord>(
          () =>
            supabase
              .from("payroll_kyotaku_records")
              .select("*", { count: "exact", head: true })
              .eq("office_number", officeNumber),
          (from, to) =>
            supabase
              .from("payroll_kyotaku_records")
              .select("*")
              .eq("office_number", officeNumber)
              .order("service_month")
              .range(from, to) as unknown as PromiseLike<{
              data: FullRecord[] | null;
            }>,
        ),
        supabase
          .from("payroll_kyotaku_settings")
          .select("*")
          .eq("office_number", officeNumber),
        supabase.from("payroll_kyotaku_service_units").select("*"),
        supabase.from("payroll_kyotaku_regional_rates").select("*"),
        supabase
          .from("payroll_kyotaku_confirmations")
          .select("*")
          .eq("office_number", officeNumber)
          .is("reverted_at", null),
      ]);

      if (setRes.error) throw setRes.error;
      if (unitRes.error) throw unitRes.error;
      if (rateRes.error) throw rateRes.error;
      if (confRes.error) throw confRes.error;

      setRecords(recs);
      setSettings((setRes.data ?? []) as SettingRow[]);
      setUnits((unitRes.data ?? []) as ServiceUnit[]);
      setRates((rateRes.data ?? []) as RegionalRate[]);
      setConfirmations((confRes.data ?? []) as ConfirmationRow[]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- officeNumber 切替時の async fetch (HANDOVER §2 参照) */
    fetchAll().catch(() => undefined);
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [officeNumber]);

  // ----------------------- derived data -----------------------

  const allMonths = useMemo(() => distinctMonths(records), [records]);
  const allStaffs = useMemo(() => distinctStaffs(records), [records]);
  const allPayMonths = useMemo(() => deriveAllPayMonths(allMonths), [allMonths]);
  const rateMap = useMemo(() => makeRateMap(rates), [rates]);
  // ITEMS = display_order でソートした units 全部
  const items = useMemo(() => {
    return [...units].sort((a, b) => {
      // display_order が無い場合は item_name で fallback
      // ServiceUnit 型に display_order が無いので unknown cast
      const ao = (a as unknown as { display_order?: number }).display_order ?? 999;
      const bo = (b as unknown as { display_order?: number }).display_order ?? 999;
      if (ao !== bo) return ao - bo;
      return a.item_name.localeCompare(b.item_name);
    });
  }, [units]);

  // calc.ts に渡す config (calcAdjustments 等で使用)
  const calcConfig: CalcConfig = useMemo(
    () => ({ settings, units, rates }),
    [settings, units, rates],
  );

  // staff × month の salary cache (重複計算抑止)
  const salaryCache = useMemo(() => {
    const m = new Map<
      string,
      ReturnType<typeof calcSalary>
    >();
    for (const s of allStaffs) {
      for (const mo of allMonths) {
        m.set(`${s}__${mo}`, calcSalary(records, s, mo, calcConfig));
      }
    }
    return m;
  }, [allStaffs, allMonths, records, calcConfig]);

  // staff × pay_month の payment cache
  const paymentCache = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of allStaffs) {
      for (const pm of allPayMonths) {
        m.set(`${s}__${pm}`, calcPaymentForMonth(records, s, pm, calcConfig));
      }
    }
    return m;
  }, [allStaffs, allPayMonths, records, calcConfig]);

  // staff → adjustments (latest_unconfirmed 月のみ非ゼロ)
  const adjustmentsByStaffMonth = useMemo(() => {
    const m = new Map<string, { late_adj: number; sayi_adj: number }>();
    for (const s of allStaffs) {
      for (const mo of allMonths) {
        const adj = calcAdjustments(records, s, mo, {
          ...calcConfig,
          confirmations: confirmations.map((c) => ({
            staff_name: c.staff_name,
            pay_month: c.pay_month,
            amount: c.amount,
          })),
        });
        m.set(`${s}__${mo}`, adj);
      }
    }
    return m;
  }, [allStaffs, allMonths, records, calcConfig, confirmations]);

  const paidMap = useMemo(() => buildPaidMap(confirmations), [confirmations]);

  // ----------------------- 確定 / 解除 -----------------------

  const confirmPayment = async (
    staff: string,
    payMonth: string,
    amount: number,
  ) => {
    const lockKey = `${staff}__${payMonth}`;
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
    staff: string,
    payMonth: string,
  ) => {
    const lockKey = `${staff}__${payMonth}`;
    if (busyPay) return;
    const row = findActiveConfirmation(confirmations, staff, payMonth);
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

  // ----------------------- render: loading / empty -----------------------

  if (loading) {
    return (
      <div className="space-y-4 p-4">
        <header>
          <h1 className="text-xl font-bold">居宅介護支援 給与計算</h1>
          <p className="text-sm text-gray-500">
            {officeName} ({officeNumber})
          </p>
        </header>
        <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-gray-400">
          読込中…
        </div>
      </div>
    );
  }

  if (err) {
    return (
      <div className="space-y-4 p-4">
        <header>
          <h1 className="text-xl font-bold">居宅介護支援 給与計算</h1>
          <p className="text-sm text-gray-500">
            {officeName} ({officeNumber})
          </p>
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

  if (records.length === 0) {
    return (
      <div className="space-y-4 p-4">
        <header className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-bold">居宅介護支援 給与計算</h1>
            <p className="text-sm text-gray-500">
              {officeName} ({officeNumber})
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSettingsModalOpen(true)}
          >
            ⚙ 設定
          </Button>
        </header>
        <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
          まだ国保連 CSV を取り込んでいません。
          <br />
          <a href="/csv-import" className="text-primary underline">
            /csv-import
          </a>{" "}
          から取り込んでください。
        </div>
        <KyotakuSettingsModal
          open={settingsModalOpen}
          onClose={() => setSettingsModalOpen(false)}
          tenantId={TENANT_ID}
          officeNumber={officeNumber}
          staffNames={[]}
          onSaved={() => fetchAll()}
        />
      </div>
    );
  }

  // ----------------------- render: tabs -----------------------

  return (
    <div className="space-y-4 p-4">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold">居宅介護支援 給与計算</h1>
          <p className="text-sm text-gray-500">
            {officeName} ({officeNumber}) / 提供月 {allMonths.length} ヶ月 ・
            ケアマネ {allStaffs.length} 名
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setSettingsModalOpen(true)}
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
        </TabsList>

        <TabsContent value="kyuyo" className="mt-4">
          <KyuyoTab
            records={records}
            allMonths={allMonths}
            allStaffs={allStaffs}
            salaryCache={salaryCache}
            adjustmentsByStaffMonth={adjustmentsByStaffMonth}
            paidMap={paidMap}
          />
        </TabsContent>

        <TabsContent value="pay" className="mt-4">
          <PaymentTab
            allStaffs={allStaffs}
            allPayMonths={allPayMonths}
            paymentCache={paymentCache}
            paidMap={paidMap}
            confirmations={confirmations}
            busyPay={busyPay}
            onConfirm={confirmPayment}
            onRevert={revertConfirmation}
          />
        </TabsContent>

        <TabsContent value="uriage" className="mt-4">
          <UriageTab
            records={records}
            allMonths={allMonths}
            allStaffs={allStaffs}
            items={items}
            rateMap={rateMap}
            units={units}
          />
        </TabsContent>

        <TabsContent value="riyosha" className="mt-4">
          <RiyoshaTab records={records} units={units} allStaffs={allStaffs} />
        </TabsContent>

        <TabsContent value="sayi" className="mt-4">
          <SayiTab
            allStaffs={allStaffs}
            allMonths={allMonths}
            salaryCache={salaryCache}
            adjustmentsByStaffMonth={adjustmentsByStaffMonth}
            paidMap={paidMap}
            records={records}
            calcConfig={calcConfig}
          />
        </TabsContent>
      </Tabs>

      <KyotakuSettingsModal
        open={settingsModalOpen}
        onClose={() => setSettingsModalOpen(false)}
        tenantId={TENANT_ID}
        officeNumber={officeNumber}
        staffNames={allStaffs}
        onSaved={() => fetchAll()}
      />
    </div>
  );
}

// =====================================================================
// Tab: 給与計算 (件数 8 行 + 給与 7 行 = 15 行 / staff)
// =====================================================================

const SALARY_ROWS = [
  "基本給",
  "プラン手当",
  "加算手当",
  "調整手当",
  "合計額",
  "支給済み",
  "差異",
] as const;

function KyuyoTab({
  records,
  allMonths,
  allStaffs,
  salaryCache,
  adjustmentsByStaffMonth,
  paidMap,
}: {
  records: FullRecord[];
  allMonths: string[];
  allStaffs: string[];
  salaryCache: Map<string, ReturnType<typeof calcSalary>>;
  adjustmentsByStaffMonth: Map<string, { late_adj: number; sayi_adj: number }>;
  paidMap: Map<string, number>;
}) {
  return (
    <div className="overflow-auto rounded-lg border">
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 z-10 bg-background min-w-32">
              担当ケアマネ
            </TableHead>
            <TableHead className="sticky left-32 z-10 bg-background min-w-44">
              項目
            </TableHead>
            {allMonths.map((m) => (
              <TableHead key={m} className="text-right min-w-24">
                {fmtMonthLabel(m)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {allStaffs.map((staff) => (
            <StaffBlock
              key={staff}
              staff={staff}
              records={records}
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
  staff,
  records,
  allMonths,
  salaryCache,
  adjustmentsByStaffMonth,
  paidMap,
}: {
  staff: string;
  records: FullRecord[];
  allMonths: string[];
  salaryCache: Map<string, ReturnType<typeof calcSalary>>;
  adjustmentsByStaffMonth: Map<string, { late_adj: number; sayi_adj: number }>;
  paidMap: Map<string, number>;
}) {
  // 各 (staff, month) を 1 回計算しておく
  const perMonth = allMonths.map((m) => {
    const sal = salaryCache.get(`${staff}__${m}`);
    const adj = adjustmentsByStaffMonth.get(`${staff}__${m}`) ?? {
      late_adj: 0,
      sayi_adj: 0,
    };
    const counts = countCells(records, staff, m);
    const payMonth = addMonths(m, 1);
    const paid = paidMap.get(`${staff}__${payMonth}`) ?? 0;
    const chosei = adj.late_adj + adj.sayi_adj;
    const total = sal ? sal.base + sal.plan + sal.kazan + chosei : 0;
    const diff = paid > 0 ? total - paid : null;
    return { m, sal, counts, chosei, total, paid, diff };
  });

  return (
    <>
      {COUNT_ROWS.map((row, idx) => (
        <TableRow key={`${staff}__count__${row.key}`}>
          {idx === 0 ? (
            <TableCell
              rowSpan={COUNT_ROWS.length + SALARY_ROWS.length}
              className="sticky left-0 z-10 bg-background align-top font-medium border-r"
            >
              {staff}
            </TableCell>
          ) : null}
          <TableCell className="sticky left-32 z-10 bg-background border-r">
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
        <TableRow key={`${staff}__salary__${label}`} className="bg-muted/30">
          <TableCell className="sticky left-32 z-10 bg-muted/50 border-r font-medium">
            {label}
          </TableCell>
          {perMonth.map((pm) => {
            let v: number | null = null;
            if (label === "基本給") v = pm.sal?.base ?? 0;
            else if (label === "プラン手当") v = pm.sal?.plan ?? 0;
            else if (label === "加算手当") v = pm.sal?.kazan ?? 0;
            else if (label === "調整手当") v = pm.chosei;
            else if (label === "合計額") v = pm.total;
            else if (label === "支給済み") v = pm.paid > 0 ? pm.paid : null;
            else if (label === "差異") v = pm.diff;

            const showRed =
              label === "差異" && v !== null && v !== 0;
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
  allStaffs,
  allPayMonths,
  paymentCache,
  paidMap,
  confirmations,
  busyPay,
  onConfirm,
  onRevert,
}: {
  allStaffs: string[];
  allPayMonths: string[];
  paymentCache: Map<string, number>;
  paidMap: Map<string, number>;
  confirmations: ConfirmationRow[];
  busyPay: string | null;
  onConfirm: (staff: string, payMonth: string, amount: number) => void;
  onRevert: (staff: string, payMonth: string) => void;
}) {
  // 事業所合計（計算額）
  const officeTotalByPay = useMemo(() => {
    const m = new Map<string, number>();
    for (const pm of allPayMonths) {
      let sum = 0;
      for (const s of allStaffs) {
        sum += paymentCache.get(`${s}__${pm}`) ?? 0;
      }
      m.set(pm, sum);
    }
    return m;
  }, [allStaffs, allPayMonths, paymentCache]);

  return (
    <div className="overflow-auto rounded-lg border">
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 z-10 bg-background min-w-32">
              担当ケアマネ
            </TableHead>
            <TableHead className="sticky left-32 z-10 bg-background min-w-32">
              支払種別
            </TableHead>
            {allPayMonths.map((pm) => (
              <TableHead key={pm} className="text-right min-w-32">
                {fmtMonthLabel(pm)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {allStaffs.map((staff) => (
            <PaymentStaffBlock
              key={staff}
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
              事業所合計（計算額）
            </TableCell>
            {allPayMonths.map((pm) => (
              <TableCell key={pm} className="text-right tabular-nums">
                {fmtYen(officeTotalByPay.get(pm) ?? 0)}
              </TableCell>
            ))}
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

function PaymentStaffBlock({
  staff,
  allPayMonths,
  paymentCache,
  paidMap,
  confirmations,
  busyPay,
  onConfirm,
  onRevert,
}: {
  staff: string;
  allPayMonths: string[];
  paymentCache: Map<string, number>;
  paidMap: Map<string, number>;
  confirmations: ConfirmationRow[];
  busyPay: string | null;
  onConfirm: (staff: string, payMonth: string, amount: number) => void;
  onRevert: (staff: string, payMonth: string) => void;
}) {
  const labels = ["計算額", "支給済み", "差異"] as const;

  return (
    <>
      {labels.map((label, idx) => (
        <TableRow key={`${staff}__${label}`} className={idx === 2 ? "border-b-2" : ""}>
          {idx === 0 ? (
            <TableCell
              rowSpan={3}
              className="sticky left-0 z-10 bg-background border-r align-top font-medium"
            >
              {staff}
            </TableCell>
          ) : null}
          <TableCell className="sticky left-32 z-10 bg-background border-r">
            {label}
          </TableCell>
          {allPayMonths.map((pm) => {
            const calc = paymentCache.get(`${staff}__${pm}`) ?? 0;
            const paid = paidMap.get(`${staff}__${pm}`) ?? 0;
            const hasActive = !!findActiveConfirmation(confirmations, staff, pm);
            const diff = hasActive ? calc - paid : null;
            const lockKey = `${staff}__${pm}`;
            const isBusy = busyPay === lockKey;

            if (label === "計算額") {
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
                          onClick={() => onRevert(staff, pm)}
                        >
                          解除
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={isBusy}
                          onClick={() => onConfirm(staff, pm, calc)}
                        >
                          確定
                        </Button>
                      )
                    ) : null}
                  </div>
                </TableCell>
              );
            }
            if (label === "支給済み") {
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
  allMonths,
  allStaffs,
  items,
  rateMap,
  units,
}: {
  records: FullRecord[];
  allMonths: string[];
  allStaffs: string[];
  items: ServiceUnit[];
  rateMap: Map<string, number>;
  units: ServiceUnit[];
}) {
  // revenue[month][staff][item] を作る
  const revenue = useMemo(() => {
    const m = new Map<string, Map<string, Map<string, number>>>();
    for (const r of records) {
      const resolved = resolveRecordUnit(r, units);
      if (!resolved) continue;
      const chiiki = rateMap.get(r.insurer_name ?? "") ?? 10.0;
      const yen = resolved.unit * chiiki;
      const a = m.get(r.service_month) ?? new Map();
      const b = a.get(r.staff_name) ?? new Map();
      b.set(resolved.itemName, (b.get(resolved.itemName) ?? 0) + yen);
      a.set(r.staff_name, b);
      m.set(r.service_month, a);
    }
    return m;
  }, [records, units, rateMap]);

  return (
    <div className="overflow-auto rounded-lg border">
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 z-10 bg-background min-w-32">
              担当ケアマネ
            </TableHead>
            <TableHead className="sticky left-32 z-10 bg-background min-w-44">
              項目
            </TableHead>
            {allMonths.map((m) => (
              <TableHead key={m} className="text-right min-w-24">
                {fmtMonthLabel(m)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {allStaffs.map((staff) => (
            <UriageStaffBlock
              key={staff}
              staff={staff}
              allMonths={allMonths}
              items={items}
              revenue={revenue}
            />
          ))}
          {/* 事業所合計 */}
          <UriageOfficeTotal
            allMonths={allMonths}
            allStaffs={allStaffs}
            items={items}
            revenue={revenue}
          />
        </TableBody>
      </Table>
    </div>
  );
}

function UriageStaffBlock({
  staff,
  allMonths,
  items,
  revenue,
}: {
  staff: string;
  allMonths: string[];
  items: ServiceUnit[];
  revenue: Map<string, Map<string, Map<string, number>>>;
}) {
  const lookup = (m: string, item: string): number => {
    return revenue.get(m)?.get(staff)?.get(item) ?? 0;
  };
  const sumPerMonth = (m: string): number => {
    const sm = revenue.get(m)?.get(staff);
    if (!sm) return 0;
    let s = 0;
    for (const v of sm.values()) s += v;
    return s;
  };

  return (
    <>
      {items.map((item, idx) => (
        <TableRow key={`${staff}__${item.item_name}`}>
          {idx === 0 ? (
            <TableCell
              rowSpan={items.length + 1}
              className="sticky left-0 z-10 bg-background border-r align-top font-medium"
            >
              {staff}
            </TableCell>
          ) : null}
          <TableCell className="sticky left-32 z-10 bg-background border-r">
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
        <TableCell className="sticky left-32 z-10 bg-muted/40 border-r">
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

function UriageOfficeTotal({
  allMonths,
  allStaffs,
  items,
  revenue,
}: {
  allMonths: string[];
  allStaffs: string[];
  items: ServiceUnit[];
  revenue: Map<string, Map<string, Map<string, number>>>;
}) {
  return (
    <TableRow className="bg-muted/50 font-medium border-t-2">
      <TableCell
        colSpan={2}
        className="sticky left-0 z-10 bg-muted/50 border-r"
      >
        事業所合計
      </TableCell>
      {allMonths.map((m) => {
        let sum = 0;
        for (const s of allStaffs) {
          const sm = revenue.get(m)?.get(s);
          if (!sm) continue;
          for (const item of items) {
            sum += sm.get(item.item_name) ?? 0;
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
  allStaffs,
}: {
  records: FullRecord[];
  units: ServiceUnit[];
  allStaffs: string[];
}) {
  // ソート: staff (allStaffs 順) → service_month → client_number/insured_number
  const sorted = useMemo(() => {
    const staffIdx = new Map(allStaffs.map((s, i) => [s, i]));
    const seen = new Set<string>();
    const filtered: FullRecord[] = [];
    for (const r of records) {
      if (!r.insured_number) continue;
      const dk = [
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
      const ai = staffIdx.get(a.staff_name) ?? 999;
      const bi = staffIdx.get(b.staff_name) ?? 999;
      if (ai !== bi) return ai - bi;
      if (a.service_month !== b.service_month) {
        return a.service_month.localeCompare(b.service_month);
      }
      const an = a.client_number ?? a.insured_number ?? "";
      const bn = b.client_number ?? b.insured_number ?? "";
      return an.localeCompare(bn);
    });
    return filtered;
  }, [records, allStaffs]);

  if (sorted.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        利用者明細がありません
      </div>
    );
  }

  return (
    <div className="overflow-auto rounded-lg border">
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-32">担当ケアマネ</TableHead>
            <TableHead className="min-w-24">提供年月</TableHead>
            <TableHead className="min-w-28">利用者名</TableHead>
            <TableHead className="min-w-20">介護度</TableHead>
            <TableHead className="min-w-24">保険者</TableHead>
            <TableHead className="min-w-52">サービス名</TableHead>
            <TableHead className="min-w-20 text-right">単位数</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((r) => {
            const resolved = resolveRecordUnit(r, units);
            return (
              <TableRow key={r.id}>
                <TableCell>{r.staff_name}</TableCell>
                <TableCell>{fmtMonthLabel(r.service_month)}</TableCell>
                <TableCell>{r.insured_name ?? ""}</TableCell>
                <TableCell>{r.care_level ?? ""}</TableCell>
                <TableCell>{r.insurer_name ?? ""}</TableCell>
                <TableCell>{r.service_name ?? ""}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {resolved ? resolved.unit.toLocaleString("ja-JP") : ""}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// =====================================================================
// Tab: 差異明細
// =====================================================================

type SayiEntry = {
  staff: string;
  serviceMonth: string;
  payMonth: string;
  kind: "late1" | "late2" | "kakutei" | "shikyu";
  relatedMonth: string;
  amount: number;
  note: string;
};

function SayiTab({
  allStaffs,
  allMonths,
  salaryCache,
  adjustmentsByStaffMonth,
  paidMap,
  records,
  calcConfig,
}: {
  allStaffs: string[];
  allMonths: string[];
  salaryCache: Map<string, ReturnType<typeof calcSalary>>;
  adjustmentsByStaffMonth: Map<string, { late_adj: number; sayi_adj: number }>;
  paidMap: Map<string, number>;
  records: FullRecord[];
  calcConfig: CalcConfig;
}) {
  const entries = useMemo(() => {
    const out: SayiEntry[] = [];

    for (const staff of allStaffs) {
      // 月遅れ調整 (late1 / late2): 各 service_month T において、過去月から流れる
      // chosei が late_adj。late1 / late2 を分けて出すには、過去月 T' で
      //   chosei1(T') が T+1 に届く (T'=T-1)
      //   chosei2(T') が T+1 に届く (T'=T-2)
      for (const month of allMonths) {
        const payMonth = addMonths(month, 1);
        // T-1 由来の chosei1
        const prev1 = addMonths(month, -1);
        const sal1 = salaryCache.get(`${staff}__${prev1}`);
        if (sal1 && sal1.chosei1 !== 0) {
          out.push({
            staff,
            serviceMonth: month,
            payMonth,
            kind: "late1",
            relatedMonth: prev1,
            amount: sal1.chosei1,
            note: `${fmtMonthLabel(prev1)} 提供分の翌々月請求調整`,
          });
        }
        // T-2 由来の chosei2
        const prev2 = addMonths(month, -2);
        const sal2 = salaryCache.get(`${staff}__${prev2}`);
        if (sal2 && sal2.chosei2 !== 0) {
          out.push({
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

      // 確定差異 (過去月の計算値 vs 支給済み) — 最新未確定月の調整手当に集約
      // adjustments の sayi_adj が 0 でない月で個別 diff を再構築する
      for (const month of allMonths) {
        const adj = adjustmentsByStaffMonth.get(`${staff}__${month}`);
        if (!adj || adj.sayi_adj === 0) continue;
        // 個別差異を抽出して列挙する (集約後の合計と一致するように再計算)
        // 走査: 過去月で paid > 0 のものに対し (base+plan+kazan) - paid を出す
        const paidStaffMonths = allMonths.filter(
          (m) => m < month && (paidMap.get(`${staff}__${addMonths(m, 1)}`) ?? 0) > 0,
        );
        for (const pm of paidStaffMonths) {
          const sal = salaryCache.get(`${staff}__${pm}`);
          if (!sal) continue;
          const paid = paidMap.get(`${staff}__${addMonths(pm, 1)}`) ?? 0;
          const diff = sal.base + sal.plan + sal.kazan - paid;
          if (diff === 0) continue;
          out.push({
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

      // 支給済みとの差異 (現在 active な確定月で計算値 ≠ 支給額)
      for (const month of allMonths) {
        const payMonth = addMonths(month, 1);
        const paid = paidMap.get(`${staff}__${payMonth}`) ?? 0;
        if (paid === 0) continue;
        // 計算額 = calcPaymentForMonth(staff, payMonth)
        const calc = calcPaymentForMonth(records, staff, payMonth, calcConfig);
        const diff = calc - paid;
        if (diff === 0) continue;
        out.push({
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
      if (a.staff !== b.staff) return a.staff.localeCompare(b.staff);
      if (a.serviceMonth !== b.serviceMonth) {
        return a.serviceMonth.localeCompare(b.serviceMonth);
      }
      return a.kind.localeCompare(b.kind);
    });
    return out;
  }, [
    allStaffs,
    allMonths,
    salaryCache,
    adjustmentsByStaffMonth,
    paidMap,
    records,
    calcConfig,
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
