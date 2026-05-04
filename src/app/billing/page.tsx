"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import type { Company, Client, Payment } from "@/types/database";
import { sortCompanies } from "@/lib/sort-companies";

type BillingSegment = "介護" | "障害" | "自費";
type PaymentMethod = "withdrawal" | "transfer" | "cash" | "other" | "";

type AmountRow = {
  segment: BillingSegment;
  office_number: string;
  client_number: string;
  client_name: string;
  billing_month: string;
  service_month: string | null;
  amount: number;
  invoiced_amount: number | null;
  paid_amount: number | null;
  billing_status: string | null;
};

type OfficeLite = { id: string; office_number: string; name: string; short_name: string; company_id: string | null };

/** 表示行（利用者×事業所×区分 ごとに1行） */
type TableRow = {
  client_number: string;
  client_name: string;
  furigana: string;         // 今は空（利用者マスタに未追加）
  office_number: string;
  office_name: string;
  segment: BillingSegment;
  payment_method: PaymentMethod;
  monthlyAmounts: Record<string, number>; // key: YYYYMM → 金額
  monthlyStatus: Record<string, string>;  // key: YYYYMM → billing_status (最多ステータス)
  totalBilled: number;      // 過去全請求合計
  totalPaid: number;        // 過去全入金合計
  outstanding: number;      // 売掛金残額
};

function fmtMonthShort(m: string) {
  return `${parseInt(m.slice(4, 6), 10)}月`;
}
function fmtMonth(m: string) {
  return `${m.slice(0, 4)}年${parseInt(m.slice(4, 6), 10)}月`;
}
function yen(n: number) {
  return n.toLocaleString("ja-JP");
}
function prevMonth(yyyymm: string): string {
  const y = parseInt(yyyymm.slice(0, 4), 10);
  const m = parseInt(yyyymm.slice(4, 6), 10);
  const d = new Date(y, m - 2, 1); // m-1 is current, so -2 = prev
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  withdrawal: "引落",
  transfer: "振込",
  cash: "集金",
  other: "その他",
  "": "",
};

export default function BillingPage() {
  // ─── フィルタ状態 ────────────────────────────────────
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [selectedOfficeNum, setSelectedOfficeNum] = useState<string>("");
  const [selectedMonth, setSelectedMonth] = useState("");
  const [searchName, setSearchName] = useState("");
  const [filterPaymentMethod, setFilterPaymentMethod] = useState<PaymentMethod>("");
  const [filterOutstandingOnly, setFilterOutstandingOnly] = useState(false);

  // ─── データ状態 ────────────────────────────────────
  const [companies, setCompanies] = useState<Company[]>([]);
  const [offices, setOffices] = useState<OfficeLite[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [availableMonths, setAvailableMonths] = useState<string[]>([]);
  const [rows, setRows] = useState<TableRow[]>([]);
  const [loading, setLoading] = useState(false);
  // セル詳細ダイアログ
  const [cellDetail, setCellDetail] = useState<{
    office_number: string;
    client_number: string;
    client_name: string;
    office_name: string;
    segment: BillingSegment;
    billing_month: string;
  } | null>(null);

  // ─── 初期データ取得 ─────────────────────────────────
  useEffect(() => {
    (async () => {
      const [coRes, offRes] = await Promise.all([
        supabase.from("payroll_companies").select("*").order("name"),
        supabase.from("payroll_offices").select("id, office_number, name, short_name, company_id"),
      ]);
      const sortedCompanies = coRes.data ? sortCompanies(coRes.data as Company[]) : [];
      setCompanies(sortedCompanies);
      if (offRes.data) setOffices(offRes.data as OfficeLite[]);
      if (sortedCompanies.length > 0) setSelectedCompanyId(sortedCompanies[0].id);

      // 利用者（ページング）
      const allClients: Client[] = [];
      let from = 0;
      while (true) {
        const { data } = await supabase.from("payroll_clients").select("*").range(from, from + 999);
        if (!data || data.length === 0) break;
        allClients.push(...(data as Client[]));
        if (data.length < 1000) break;
        from += 1000;
      }
      setClients(allClients);

      // 月候補
      const monthsSet = new Set<string>();
      from = 0;
      while (true) {
        const { data } = await supabase.from("payroll_billing_amount_items").select("billing_month").range(from, from + 999);
        if (!data || data.length === 0) break;
        for (const r of data) monthsSet.add((r as { billing_month: string }).billing_month);
        if (data.length < 1000) break;
        from += 1000;
      }
      const months = [...monthsSet].sort().reverse();
      setAvailableMonths(months);
      if (months.length > 0) setSelectedMonth(months[0]);
    })();
  }, []);

  // ─── 月リスト（選択月 + 過去6ヶ月） ─────────────────
  const monthColumns = useMemo(() => {
    if (!selectedMonth) return [];
    const list: string[] = [];
    let m = selectedMonth;
    for (let i = 0; i < 7; i++) {
      list.push(m);
      m = prevMonth(m);
    }
    return list; // 新しい順
  }, [selectedMonth]);

  // ─── データ集計 ─────────────────────────────────────
  const computeRows = useCallback(async () => {
    if (!selectedCompanyId || monthColumns.length === 0) return;
    setLoading(true);
    try {
      const companyOffices = offices
        .filter((o) => o.company_id === selectedCompanyId)
        .filter((o) => !selectedOfficeNum || o.office_number === selectedOfficeNum);
      const companyOfficeIds = new Set(companyOffices.map((o) => o.id));
      const companyOfficeNums = companyOffices.map((o) => o.office_number);
      if (companyOfficeNums.length === 0) { setRows([]); return; }

      // 選択月から7ヶ月分のデータ + それ以前の過去全請求合計のために全期間が必要
      // 効率化: 全 billing_amount_items を取得（法人分のみ）
      const allAmounts: AmountRow[] = [];
      let from = 0;
      while (true) {
        const { data } = await supabase
          .from("payroll_billing_amount_items")
          .select("segment, office_number, client_number, client_name, billing_month, service_month, amount, invoiced_amount, paid_amount, billing_status")
          .in("office_number", companyOfficeNums)
          .range(from, from + 999);
        if (!data || data.length === 0) break;
        allAmounts.push(...(data as AmountRow[]));
        if (data.length < 1000) break;
        from += 1000;
      }

      // 入金
      const { data: payData } = await supabase
        .from("payroll_payments").select("*").eq("company_id", selectedCompanyId);
      const payments = (payData ?? []) as Payment[];

      // 利用者マスタ
      const companyClients = clients.filter((c) => companyOfficeIds.has(c.office_id));
      const clientByNumber = new Map<string, Client>();
      for (const c of companyClients) clientByNumber.set(c.client_number, c);

      // key: `${office_number}|${client_number}|${segment}` → TableRow
      const map = new Map<string, TableRow>();
      // 同じキーについて最新月レコードを追跡（name/office_name を最新のCSV値で上書きするため）
      const latestMonthForKey = new Map<string, string>();
      const monthSet = new Set(monthColumns);
      for (const a of allAmounts) {
        const off = offices.find((o) => o.office_number === a.office_number);
        const officeName = (off?.short_name || off?.name) ?? a.office_number;
        const key = `${a.office_number}|${a.client_number}|${a.segment}`;
        const c = clientByNumber.get(a.client_number);
        // 名前はCSVの利用者名を最優先（番号の使い回し・マスタ古データによる誤表示を防ぐ）
        // マスタは補助（CSVに名前が入っていない時のみ使う）
        const resolvedName = a.client_name?.trim() || c?.name || a.client_number;
        if (!map.has(key)) {
          map.set(key, {
            client_number: a.client_number,
            client_name: resolvedName,
            furigana: "", // 現状マスタに無いので空
            office_number: a.office_number,
            office_name: officeName,
            segment: a.segment,
            payment_method: (c?.payment_method as PaymentMethod) ?? "",
            monthlyAmounts: {},
            monthlyStatus: {},
            totalBilled: 0,
            totalPaid: 0,
            outstanding: 0,
          });
          latestMonthForKey.set(key, a.billing_month ?? "");
        } else {
          // より新しい月のレコードが来たら name/office_name を上書き（人が替わった番号対策）
          const prev = latestMonthForKey.get(key) ?? "";
          if ((a.billing_month ?? "") >= prev) {
            const r = map.get(key)!;
            r.client_name = resolvedName;
            r.office_name = officeName;
            latestMonthForKey.set(key, a.billing_month ?? "");
          }
        }
        const r = map.get(key)!;
        r.totalBilled += a.amount ?? 0;
        if (monthSet.has(a.billing_month)) {
          r.monthlyAmounts[a.billing_month] = (r.monthlyAmounts[a.billing_month] ?? 0) + (a.amount ?? 0);
          // ステータスは「代表1つ」: 優先度 overdue > invoiced > paid > adjustment > deferred > cancelled > scheduled
          const statusPriority: Record<string, number> = {
            overdue: 7, invoiced: 6, paid: 5, adjustment: 4, deferred: 3, cancelled: 2, scheduled: 1, draft: 0,
          };
          const prev = r.monthlyStatus[a.billing_month];
          const cur = a.billing_status ?? "scheduled";
          if (!prev || (statusPriority[cur] ?? 0) > (statusPriority[prev] ?? 0)) {
            r.monthlyStatus[a.billing_month] = cur;
          }
        }
      }

      // 入金を利用者単位で合算（payments テーブル由来の個別入金）
      const paidByClient = new Map<string, number>();
      for (const p of payments) paidByClient.set(p.client_number, (paidByClient.get(p.client_number) ?? 0) + p.amount);

      // ── 売掛金残額の計算（ライフサイクル対応版）──
      // 売掛として見なすのは以下のケース:
      //   invoiced                → 未入金: +invoiced_amount (invoiced_amount 空なら amount)
      //   overdue                 → 未回収: +invoiced_amount
      //   paid                    → 残差が出ることがある: +(invoiced_amount - paid_amount)
      //   adjustment              → 過誤調整: +expected_amount (符号そのまま、減額なら負)
      // 除外: draft / scheduled / deferred / cancelled
      const outstandingByClient = new Map<string, number>();
      const addOutstanding = (cn: string, v: number) => {
        outstandingByClient.set(cn, (outstandingByClient.get(cn) ?? 0) + v);
      };
      for (const a of allAmounts) {
        const st = a.billing_status ?? "scheduled";
        const inv = a.invoiced_amount ?? a.amount ?? 0;
        const pay = a.paid_amount ?? 0;
        const amt = a.amount ?? 0;
        switch (st) {
          case "invoiced":
          case "overdue":
            addOutstanding(a.client_number, inv);
            break;
          case "paid":
            addOutstanding(a.client_number, inv - pay);
            break;
          case "adjustment":
            addOutstanding(a.client_number, amt);
            break;
          default:
            // draft / scheduled / deferred / cancelled は売掛に含めない
            break;
        }
      }
      // payments テーブルの個別入金も差し引く (billing_status=paid 以外の手動入金を反映)
      const clientOutstanding = new Map<string, number>();
      for (const [cn, bal] of outstandingByClient) {
        const extraPaid = paidByClient.get(cn) ?? 0;
        clientOutstanding.set(cn, bal - extraPaid);
      }

      // Map → Array + 利用者単位の集計値を充填
      const result = [...map.values()].map((r) => ({
        ...r,
        totalPaid: paidByClient.get(r.client_number) ?? 0,
        outstanding: clientOutstanding.get(r.client_number) ?? 0,
      }));

      result.sort((a, b) => {
        const byName = a.client_name.localeCompare(b.client_name, "ja");
        if (byName !== 0) return byName;
        const byOffice = a.office_name.localeCompare(b.office_name, "ja");
        if (byOffice !== 0) return byOffice;
        const segOrder: Record<BillingSegment, number> = { 介護: 0, 障害: 1, 自費: 2 };
        return segOrder[a.segment] - segOrder[b.segment];
      });
      setRows(result);
    } finally {
      setLoading(false);
    }
  }, [selectedCompanyId, selectedOfficeNum, monthColumns, offices, clients]);

  useEffect(() => {
    computeRows();
  }, [computeRows]);

  // ─── 絞り込み適用 ─────────────────────────────────
  const displayRows = useMemo(() => {
    const q = searchName.trim().toLowerCase();
    return rows
      .filter((r) => !q || r.client_name.toLowerCase().includes(q) || r.client_number.toLowerCase().includes(q))
      .filter((r) => !filterPaymentMethod || r.payment_method === filterPaymentMethod)
      .filter((r) => !filterOutstandingOnly || r.outstanding !== 0);
  }, [rows, searchName, filterPaymentMethod, filterOutstandingOnly]);

  // ─── 同一(顧客送付先=client_number)で rowspan するため、利用者ごとにまとめる ─
  const groupedRows = useMemo(() => {
    const groups: { client_number: string; rows: TableRow[] }[] = [];
    const indexMap = new Map<string, number>();
    for (const r of displayRows) {
      if (!indexMap.has(r.client_number)) {
        indexMap.set(r.client_number, groups.length);
        groups.push({ client_number: r.client_number, rows: [] });
      }
      groups[indexMap.get(r.client_number)!].rows.push(r);
    }
    return groups;
  }, [displayRows]);

  const availableOffices = useMemo(
    () => offices.filter((o) => o.company_id === selectedCompanyId),
    [offices, selectedCompanyId]
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h2 className="text-2xl font-bold">請求一覧</h2>
        <Link href="/billing/import" className="text-sm underline text-blue-600">📁 請求CSV取り込み</Link>
      </div>

      {/* ─── フィルタ ─── */}
      <div className="border rounded-md p-3 mb-3 space-y-2">
        {/* 利用月 */}
        <div className="flex items-center gap-2">
          <Label className="text-xs w-16">利用月</Label>
          <select
            className="border rounded px-2 py-1 text-sm bg-background"
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
          >
            {availableMonths.length === 0 && <option value="">（データなし）</option>}
            {availableMonths.map((m) => <option key={m} value={m}>{fmtMonth(m)}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Label className="text-xs w-16">事業所</Label>
          <select
            className="border rounded px-2 py-1 text-sm bg-background min-w-[200px]"
            value={selectedCompanyId}
            onChange={(e) => { setSelectedCompanyId(e.target.value); setSelectedOfficeNum(""); }}
          >
            {companies.length === 0 && <option value="">（法人なし）</option>}
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select
            className="border rounded px-2 py-1 text-sm bg-background min-w-[240px]"
            value={selectedOfficeNum}
            onChange={(e) => setSelectedOfficeNum(e.target.value)}
          >
            <option value="">事業所を選択（全て）</option>
            {availableOffices.map((o) => (
              <option key={o.id} value={o.office_number}>{o.short_name || o.name}</option>
            ))}
          </select>
          <Label className="text-xs">利用者</Label>
          <Input
            className="w-48"
            placeholder="氏名 or 番号で検索"
            value={searchName}
            onChange={(e) => setSearchName(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Label className="text-xs w-16">請求方法</Label>
          <select
            className="border rounded px-2 py-1 text-sm bg-background"
            value={filterPaymentMethod}
            onChange={(e) => setFilterPaymentMethod(e.target.value as PaymentMethod)}
          >
            <option value="">すべて</option>
            <option value="withdrawal">引落</option>
            <option value="transfer">振込</option>
            <option value="cash">集金</option>
            <option value="other">その他</option>
          </select>
          <label className="text-xs inline-flex items-center gap-1">
            <input
              type="checkbox"
              checked={filterOutstandingOnly}
              onChange={(e) => setFilterOutstandingOnly(e.target.checked)}
            />
            未回収金あり
          </label>
          <Button variant="outline" size="sm" onClick={computeRows} disabled={loading}>
            {loading ? "集計中…" : "🔄 再集計"}
          </Button>
          <BulkIssueButton
            companyId={selectedCompanyId}
            officeNumbers={availableOffices.filter((o) => !selectedOfficeNum || o.office_number === selectedOfficeNum).map((o) => o.office_number)}
            billingMonth={selectedMonth}
            onDone={computeRows}
          />
        </div>
      </div>

      {/* ─── テーブル ─── */}
      <div className="border rounded-md overflow-hidden">
        <div className="overflow-x-auto max-h-[calc(100vh-260px)] overflow-y-auto">
          <table className="text-xs whitespace-nowrap border-collapse">
            <thead className="bg-muted/60 sticky top-0 z-20">
              <tr>
                <th className="sticky left-0 bg-muted/60 z-30 border px-2 py-1 min-w-[96px]">顧客No</th>
                <th className="sticky left-[96px] bg-muted/60 z-30 border px-2 py-1 min-w-[100px]">送付先</th>
                <th className="sticky left-[196px] bg-muted/60 z-30 border px-2 py-1 min-w-[100px]">フリガナ</th>
                <th className="sticky left-[296px] bg-muted/60 z-30 border px-2 py-1 min-w-[80px]">支払方法</th>
                <th className="sticky left-[376px] bg-muted/60 z-30 border px-2 py-1 min-w-[120px]">利用者名</th>
                <th className="sticky left-[496px] bg-muted/60 z-30 border px-2 py-1 min-w-[180px]">事業所名</th>
                <th className="sticky left-[676px] bg-muted/60 z-30 border px-2 py-1 min-w-[48px]">事業</th>
                {monthColumns.map((m) => (
                  <th key={m} className="border px-2 py-1 min-w-[60px]">{fmtMonthShort(m)}</th>
                ))}
                <th className="border px-2 py-1 min-w-[80px]">過誤合計額</th>
                <th className="border px-2 py-1 min-w-[90px]">過誤処理</th>
                <th className="border px-2 py-1 min-w-[80px]">次回請求額</th>
                <th className="border px-2 py-1 min-w-[90px]">次々回請求額</th>
                <th className="border px-2 py-1 min-w-[90px]">次回請求方法</th>
                <th className="border px-2 py-1 min-w-[70px]">請求設定</th>
                <th className="border px-2 py-1 min-w-[80px]">売掛金残額</th>
              </tr>
            </thead>
            <tbody>
              {groupedRows.length === 0 ? (
                <tr>
                  <td colSpan={7 + monthColumns.length + 7} className="text-center text-muted-foreground py-6">
                    {loading ? "集計中…" : "対象データがありません"}
                  </td>
                </tr>
              ) : (
                groupedRows.flatMap((group) =>
                  group.rows.map((r, idx) => {
                    const isFirst = idx === 0;
                    const spanRows = group.rows.length;
                    return (
                      <tr key={`${group.client_number}-${idx}`} className="hover:bg-muted/10 align-top">
                        {isFirst && (
                          <>
                            <td rowSpan={spanRows} className="sticky left-0 bg-background z-10 border px-2 py-1 font-mono text-[10px]">
                              {r.client_number}
                            </td>
                            <td rowSpan={spanRows} className="sticky left-[96px] bg-background z-10 border px-2 py-1">
                              {r.client_name}
                            </td>
                            <td rowSpan={spanRows} className="sticky left-[196px] bg-background z-10 border px-2 py-1 text-muted-foreground">
                              {r.furigana || "—"}
                            </td>
                            <td rowSpan={spanRows} className="sticky left-[296px] bg-background z-10 border px-2 py-1">
                              {PAYMENT_METHOD_LABELS[r.payment_method] || "—"}
                            </td>
                          </>
                        )}
                        <td className="sticky left-[376px] bg-background z-10 border px-2 py-1">{r.client_name}</td>
                        <td className="sticky left-[496px] bg-background z-10 border px-2 py-1 text-[10px]">{r.office_name}</td>
                        <td className="sticky left-[676px] bg-background z-10 border px-2 py-1 text-center text-[10px]">
                          {r.segment}
                        </td>
                        {monthColumns.map((m) => {
                          const v = r.monthlyAmounts[m] ?? 0;
                          const st = r.monthlyStatus[m];
                          const clickable = v !== 0;
                          return (
                            <td
                              key={m}
                              className={`border px-2 py-1 font-mono ${clickable ? "cursor-pointer hover:bg-blue-50" : ""}`}
                              onClick={() => {
                                if (!clickable) return;
                                setCellDetail({
                                  office_number: r.office_number,
                                  client_number: r.client_number,
                                  client_name: r.client_name,
                                  office_name: r.office_name,
                                  segment: r.segment,
                                  billing_month: m,
                                });
                              }}
                              title={clickable ? "クリックで明細ダイアログを開く" : undefined}
                            >
                              <div className="flex items-center justify-between gap-1">
                                <span className="w-5 flex-shrink-0">
                                  {st && v !== 0 && <StatusBadge status={st} />}
                                </span>
                                <span>{v !== 0 ? yen(v) : ""}</span>
                              </div>
                            </td>
                          );
                        })}
                        {/* 過誤関連はデータが無いので空欄 */}
                        <td className="border px-2 py-1 text-right text-muted-foreground/40">—</td>
                        <td className="border px-2 py-1 text-center text-muted-foreground/40">—</td>
                        {/* 次回/次々回請求額は実装なし（将来） */}
                        <td className="border px-2 py-1 text-right text-muted-foreground/40">—</td>
                        <td className="border px-2 py-1 text-right text-muted-foreground/40">—</td>
                        <td className="border px-2 py-1 text-center">
                          {isFirst ? PAYMENT_METHOD_LABELS[r.payment_method] || "—" : ""}
                        </td>
                        <td className="border px-2 py-1 text-center">
                          {isFirst && (
                            <Link
                              href={`/billing/invoice?company=${selectedCompanyId}&month=${selectedMonth}&client=${encodeURIComponent(r.client_number)}`}
                              target="_blank"
                              className="text-blue-600 hover:underline"
                            >
                              請求書
                            </Link>
                          )}
                        </td>
                        {isFirst && (
                          <td rowSpan={spanRows} className={`border px-2 py-1 text-right font-mono font-bold ${r.outstanding > 0 ? "text-red-700" : r.outstanding < 0 ? "text-blue-700" : "text-muted-foreground"}`}>
                            {r.outstanding !== 0 ? yen(r.outstanding) : "0"}
                          </td>
                        )}
                      </tr>
                    );
                  })
                )
              )}
            </tbody>
            {/* ─── 合計行 ─── */}
            {groupedRows.length > 0 && (() => {
              // 売掛金残額は「利用者単位」で重複しないように合算
              const uniqueOutstanding = new Map<string, number>();
              for (const r of displayRows) {
                if (!uniqueOutstanding.has(r.client_number)) {
                  uniqueOutstanding.set(r.client_number, r.outstanding);
                }
              }
              const outstandingSum = [...uniqueOutstanding.values()].reduce((s, v) => s + v, 0);
              const monthSums: Record<string, number> = {};
              for (const m of monthColumns) {
                monthSums[m] = displayRows.reduce((s, r) => s + (r.monthlyAmounts[m] ?? 0), 0);
              }
              return (
                <tfoot className="bg-muted/40 sticky bottom-0 z-20 font-bold">
                  <tr>
                    <td
                      colSpan={7}
                      className="sticky left-0 bg-muted/40 z-30 border px-2 py-1 text-right"
                    >
                      合計
                    </td>
                    {monthColumns.map((m) => (
                      <td key={m} className="border px-2 py-1 text-right font-mono">
                        {monthSums[m] > 0 ? yen(monthSums[m]) : ""}
                      </td>
                    ))}
                    <td className="border px-2 py-1 text-muted-foreground/40">—</td>
                    <td className="border px-2 py-1 text-muted-foreground/40">—</td>
                    <td className="border px-2 py-1 text-muted-foreground/40">—</td>
                    <td className="border px-2 py-1 text-muted-foreground/40">—</td>
                    <td className="border px-2 py-1 text-muted-foreground/40">—</td>
                    <td className="border px-2 py-1 text-muted-foreground/40">—</td>
                    <td className={`border px-2 py-1 text-right font-mono ${outstandingSum > 0 ? "text-red-700" : "text-muted-foreground"}`}>
                      {outstandingSum > 0 ? yen(outstandingSum) : "0"}
                    </td>
                  </tr>
                </tfoot>
              );
            })()}
          </table>
        </div>
      </div>

      {/* 入金登録のフローティングボタン的な位置づけは省略。必要に応じて行クリックでダイアログ起動等に拡張可。 */}
      <div className="mt-3 text-xs text-muted-foreground">
        <p>※ 過誤合計・過誤処理・次回/次々回請求額・請求設定は未実装（データ準備ができたら対応）</p>
        <p>※ 売掛金残額は「利用者の過去全請求額 − 過去全入金額」で計算</p>
      </div>

      <PaymentQuickDialog
        companyId={selectedCompanyId}
        defaultMonth={selectedMonth}
        rows={displayRows}
        onSaved={computeRows}
      />

      {/* セル詳細・行アクションダイアログ */}
      {cellDetail && (
        <CellDetailDialog
          detail={cellDetail}
          onClose={() => setCellDetail(null)}
          onChanged={() => {
            computeRows();
          }}
        />
      )}
    </div>
  );
}

// ─── 入金登録ダイアログ（画面下部） ─────────────────
function PaymentQuickDialog({
  companyId, defaultMonth, rows, onSaved,
}: {
  companyId: string;
  defaultMonth: string;
  rows: TableRow[];
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [clientNumber, setClientNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [paidAt, setPaidAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState("withdrawal");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (!clientNumber) { toast.error("利用者を選んでください"); return; }
    const amt = parseInt(amount, 10);
    if (!amt || amt <= 0) { toast.error("金額を入力してください"); return; }
    setSaving(true);
    const { error } = await supabase.from("payroll_payments").insert({
      company_id: companyId,
      client_number: clientNumber,
      billing_month: defaultMonth,
      amount: amt,
      paid_at: paidAt,
      method,
      note: note || null,
    });
    setSaving(false);
    if (error) { toast.error(`保存エラー: ${error.message}`); return; }
    toast.success("入金を記録しました");
    setOpen(false);
    setClientNumber(""); setAmount(""); setNote("");
    onSaved();
  };

  const clientOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) if (!seen.has(r.client_number)) seen.set(r.client_number, r.client_name);
    return [...seen.entries()];
  }, [rows]);

  return (
    <div className="fixed bottom-4 right-4 z-40">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger render={<Button />}>💴 入金登録</DialogTrigger>
        <DialogContent>
          <DialogHeader><DialogTitle>入金登録</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>利用者</Label>
              <select className="w-full border rounded px-2 py-1 text-sm bg-background" value={clientNumber} onChange={(e) => setClientNumber(e.target.value)}>
                <option value="">選択してください</option>
                {clientOptions.map(([num, name]) => <option key={num} value={num}>{name}（{num}）</option>)}
              </select>
            </div>
            <div>
              <Label>金額（円）</Label>
              <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div>
              <Label>入金日</Label>
              <Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
            </div>
            <div>
              <Label>支払方法</Label>
              <select className="w-full border rounded px-2 py-1 text-sm bg-background" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="withdrawal">引落</option>
                <option value="transfer">振込</option>
                <option value="cash">集金</option>
                <option value="other">その他</option>
              </select>
            </div>
            <div>
              <Label>メモ</Label>
              <Input value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <Button onClick={handleSubmit} disabled={saving} className="w-full">
              {saving ? "保存中…" : "登録"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── ステータスバッジ（月セルに表示する小さい印） ──────────────
function StatusBadge({ status }: { status: string }) {
  const meta: Record<string, { bg: string; text: string; label: string; title: string }> = {
    scheduled:  { bg: "bg-gray-100",    text: "text-gray-700",    label: "未",  title: "未発行（請求予定）" },
    invoiced:   { bg: "bg-blue-100",    text: "text-blue-800",    label: "発",  title: "発行済" },
    paid:       { bg: "bg-green-100",   text: "text-green-800",   label: "済",  title: "入金済" },
    overdue:    { bg: "bg-red-100",     text: "text-red-800",     label: "未",  title: "引落不可・未回収" },
    deferred:   { bg: "bg-yellow-100",  text: "text-yellow-800",  label: "繰",  title: "翌月繰越" },
    cancelled:  { bg: "bg-gray-200",    text: "text-gray-500",    label: "×",  title: "請求キャンセル" },
    adjustment: { bg: "bg-orange-100",  text: "text-orange-800",  label: "調",  title: "過誤調整" },
    draft:      { bg: "bg-gray-100",    text: "text-gray-500",    label: "草",  title: "下書き" },
  };
  const m = meta[status] ?? meta.scheduled;
  return (
    <span
      className={`${m.bg} ${m.text} text-[9px] leading-none rounded px-1 py-0.5 shrink-0`}
      title={m.title}
    >
      {m.label}
    </span>
  );
}

// ─── 一括発行ボタン ──────────────
function BulkIssueButton({
  companyId,
  officeNumbers,
  billingMonth,
  onDone,
}: {
  companyId: string;
  officeNumbers: string[];
  billingMonth: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const handleClick = async () => {
    if (!companyId || !billingMonth || officeNumbers.length === 0) {
      toast.error("法人と月を選択してください");
      return;
    }
    // 対象 (scheduled 行) を取得
    const { data: targets, error: e1 } = await supabase
      .from("payroll_billing_amount_items")
      .select("id, amount")
      .eq("billing_month", billingMonth)
      .in("office_number", officeNumbers)
      .eq("billing_status", "scheduled");
    if (e1) { toast.error(`取得エラー: ${e1.message}`); return; }
    const list = (targets ?? []) as { id: string; amount: number }[];
    if (list.length === 0) {
      toast.info("一括発行の対象（未発行）データがありません");
      return;
    }
    if (!confirm(`${billingMonth.slice(0, 4)}年${parseInt(billingMonth.slice(4, 6), 10)}月分の未発行 ${list.length} 件を「発行済」にします。\nよろしいですか？`)) return;

    setBusy(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const chunkSize = 100;
      for (let i = 0; i < list.length; i += chunkSize) {
        const chunk = list.slice(i, i + chunkSize);
        await Promise.all(
          chunk.map((t) =>
            supabase
              .from("payroll_billing_amount_items")
              .update({
                billing_status: "invoiced",
                actual_issue_date: today,
                invoiced_amount: t.amount,
              })
              .eq("id", t.id)
          )
        );
      }
      toast.success(`${list.length} 件を発行済にしました`);
      onDone();
    } catch (e) {
      toast.error(`更新エラー: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button variant="default" size="sm" onClick={handleClick} disabled={busy}>
      {busy ? "発行中…" : "🧾 一括発行"}
    </Button>
  );
}

// ─── セル詳細・行アクションダイアログ ──────────────
type DetailItem = {
  id: string;
  service_item: string | null;
  amount: number;
  invoiced_amount: number | null;
  paid_amount: number | null;
  billing_status: string;
  parent_item_id: string | null;
  billing_month: string;
  service_month: string | null;
  actual_issue_date: string | null;
  lifecycle_note: string | null;
};

function CellDetailDialog({
  detail,
  onClose,
  onChanged,
}: {
  detail: {
    office_number: string;
    client_number: string;
    client_name: string;
    office_name: string;
    segment: BillingSegment;
    billing_month: string;
  };
  onClose: () => void;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<DetailItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // 編集用: 各行の新しい金額入力値
  const [editAmount, setEditAmount] = useState<Record<string, string>>({});

  const fetchItems = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("payroll_billing_amount_items")
      .select("id, service_item, amount, invoiced_amount, paid_amount, billing_status, parent_item_id, billing_month, service_month, actual_issue_date, lifecycle_note")
      .eq("office_number", detail.office_number)
      .eq("client_number", detail.client_number)
      .eq("segment", detail.segment)
      .eq("billing_month", detail.billing_month)
      .order("service_item");
    setItems((data ?? []) as DetailItem[]);
    setLoading(false);
  }, [detail]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  const monthLabel = `${detail.billing_month.slice(0, 4)}年${parseInt(detail.billing_month.slice(4, 6), 10)}月`;
  const nextMonth = (m: string) => {
    const y = parseInt(m.slice(0, 4), 10);
    const mm = parseInt(m.slice(4, 6), 10);
    const d = new Date(y, mm, 1);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
  };

  const handleSaveAmount = async (item: DetailItem) => {
    const raw = editAmount[item.id];
    if (raw === undefined || raw === "") return;
    const newAmt = parseInt(raw, 10);
    if (isNaN(newAmt)) { toast.error("金額が不正です"); return; }
    setSaving(true);
    try {
      if (item.billing_status === "scheduled" || item.billing_status === "draft") {
        // 発行前: 直接上書き
        const { error } = await supabase
          .from("payroll_billing_amount_items")
          .update({ amount: newAmt })
          .eq("id", item.id);
        if (error) throw error;
        toast.success("金額を修正しました");
      } else {
        // 発行後: 差額で調整行を自動作成（元はそのまま）
        const diff = newAmt - item.amount;
        if (diff === 0) {
          toast.info("差額がありません");
          setSaving(false);
          return;
        }
        const adjustmentMonth = nextMonth(detail.billing_month);
        const { error } = await supabase.from("payroll_billing_amount_items").insert({
          segment: detail.segment,
          office_number: detail.office_number,
          client_number: detail.client_number,
          client_name: detail.client_name,
          billing_month: adjustmentMonth,
          service_month: item.service_month,
          service_item: item.service_item,
          amount: diff,
          billing_status: "adjustment",
          parent_item_id: item.id,
          source: "manual",
          lifecycle_note: `過誤調整（元請求${item.amount}→${newAmt}の差額）`,
        });
        if (error) throw error;
        toast.success(`差額 ${diff > 0 ? "+" : ""}${diff} の調整行を ${adjustmentMonth.slice(0, 4)}/${adjustmentMonth.slice(4, 6)} 請求月に作成しました`);
      }
      setEditAmount((p) => { const n = { ...p }; delete n[item.id]; return n; });
      fetchItems();
      onChanged();
    } catch (e) {
      toast.error(`保存エラー: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDefer = async (item: DetailItem) => {
    if (item.billing_status !== "scheduled") {
      toast.error("scheduled（未発行）の行のみ翌月繰越できます");
      return;
    }
    const newMonth = nextMonth(item.billing_month);
    const { error } = await supabase
      .from("payroll_billing_amount_items")
      .update({
        billing_month: newMonth,
        lifecycle_note: `翌月繰越 ${item.billing_month.slice(0, 4)}/${item.billing_month.slice(4, 6)} → ${newMonth.slice(0, 4)}/${newMonth.slice(4, 6)}`,
      })
      .eq("id", item.id);
    if (error) { toast.error(`保存エラー: ${error.message}`); return; }
    toast.success(`${newMonth.slice(0, 4)}/${newMonth.slice(4, 6)} に繰越しました`);
    fetchItems();
    onChanged();
  };

  const handleCancel = async (item: DetailItem) => {
    if (!confirm(`この明細（${item.service_item} ¥${item.amount.toLocaleString()}）をキャンセルしますか？`)) return;
    const { error } = await supabase
      .from("payroll_billing_amount_items")
      .update({ billing_status: "cancelled", lifecycle_note: `キャンセル（旧状態: ${item.billing_status}）` })
      .eq("id", item.id);
    if (error) { toast.error(`保存エラー: ${error.message}`); return; }
    toast.success("キャンセルしました");
    fetchItems();
    onChanged();
  };

  const handleMarkPaid = async (item: DetailItem) => {
    if (item.billing_status !== "invoiced" && item.billing_status !== "overdue") {
      toast.error("invoiced または overdue の行のみ入金記録できます");
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const { error } = await supabase
      .from("payroll_billing_amount_items")
      .update({
        billing_status: "paid",
        actual_withdrawal_date: today,
        paid_amount: item.invoiced_amount ?? item.amount,
      })
      .eq("id", item.id);
    if (error) { toast.error(`保存エラー: ${error.message}`); return; }
    toast.success("入金済にしました");
    fetchItems();
    onChanged();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-background border rounded-lg max-w-4xl w-full max-h-[85vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b">
          <h3 className="text-lg font-semibold">{detail.client_name} 様 / {detail.segment} / {detail.office_name}</h3>
          <p className="text-xs text-muted-foreground mt-1">請求月: {monthLabel}</p>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">読み込み中…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">明細がありません</p>
          ) : (
            <table className="w-full text-xs border-collapse">
              <thead className="bg-muted/40">
                <tr>
                  <th className="border px-2 py-1 text-left">利用料項目</th>
                  <th className="border px-2 py-1 text-right w-24">元金額</th>
                  <th className="border px-2 py-1 w-28">新金額</th>
                  <th className="border px-2 py-1 text-center w-20">状態</th>
                  <th className="border px-2 py-1 text-left">アクション</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id} className="align-top">
                    <td className="border px-2 py-1">
                      <div>{it.service_item || "—"}</div>
                      {it.lifecycle_note && (
                        <div className="text-[10px] text-muted-foreground mt-0.5">{it.lifecycle_note}</div>
                      )}
                      {it.parent_item_id && (
                        <div className="text-[10px] text-orange-700 mt-0.5">調整行 (parent: {it.parent_item_id.slice(0, 8)}…)</div>
                      )}
                    </td>
                    <td className="border px-2 py-1 text-right font-mono">{it.amount.toLocaleString()}</td>
                    <td className="border px-2 py-1">
                      <Input
                        type="number"
                        className="h-7 text-xs"
                        value={editAmount[it.id] ?? ""}
                        onChange={(e) => setEditAmount({ ...editAmount, [it.id]: e.target.value })}
                        placeholder="新しい金額"
                      />
                    </td>
                    <td className="border px-2 py-1 text-center">
                      <StatusBadge status={it.billing_status} />
                    </td>
                    <td className="border px-2 py-1">
                      <div className="flex gap-1 flex-wrap">
                        <Button variant="outline" size="sm" onClick={() => handleSaveAmount(it)} disabled={saving || !editAmount[it.id]}>
                          💾 金額変更
                        </Button>
                        {it.billing_status === "scheduled" && (
                          <Button variant="outline" size="sm" onClick={() => handleDefer(it)} disabled={saving}>
                            ⏭️ 翌月繰越
                          </Button>
                        )}
                        {(it.billing_status === "invoiced" || it.billing_status === "overdue") && (
                          <Button variant="outline" size="sm" onClick={() => handleMarkPaid(it)} disabled={saving}>
                            💴 入金済にする
                          </Button>
                        )}
                        {it.billing_status !== "cancelled" && it.billing_status !== "paid" && (
                          <Button variant="outline" size="sm" onClick={() => handleCancel(it)} disabled={saving}>
                            ❌ キャンセル
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="mt-3 text-[11px] text-muted-foreground space-y-0.5">
            <p>・金額変更: 発行前（scheduled）は直接上書き、発行後は差額の調整行を翌月請求として自動作成します。</p>
            <p>・翌月繰越: 未発行の行だけ billing_month を +1月 にずらします。</p>
            <p>・キャンセル: 請求対象から外します（売掛金残額に含まれなくなる）。</p>
          </div>
        </div>
        <div className="p-4 border-t flex justify-end">
          <Button variant="ghost" onClick={onClose}>閉じる</Button>
        </div>
      </div>
    </div>
  );
}
