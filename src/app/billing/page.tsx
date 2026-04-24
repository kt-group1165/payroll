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

type BillingSegment = "介護" | "障害" | "自費";
type PaymentMethod = "withdrawal" | "transfer" | "cash" | "other" | "";

type AmountRow = {
  segment: BillingSegment;
  office_number: string;
  client_number: string;
  client_name: string;
  billing_month: string;
  amount: number;
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

  // ─── 初期データ取得 ─────────────────────────────────
  useEffect(() => {
    (async () => {
      const [coRes, offRes] = await Promise.all([
        supabase.from("companies").select("*").order("name"),
        supabase.from("offices").select("id, office_number, name, short_name, company_id"),
      ]);
      if (coRes.data) setCompanies(coRes.data as Company[]);
      if (offRes.data) setOffices(offRes.data as OfficeLite[]);
      if (coRes.data && coRes.data.length > 0) setSelectedCompanyId((coRes.data as Company[])[0].id);

      // 利用者（ページング）
      const allClients: Client[] = [];
      let from = 0;
      while (true) {
        const { data } = await supabase.from("clients").select("*").range(from, from + 999);
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
        const { data } = await supabase.from("billing_amount_items").select("billing_month").range(from, from + 999);
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
          .from("billing_amount_items")
          .select("segment, office_number, client_number, client_name, billing_month, amount")
          .in("office_number", companyOfficeNums)
          .range(from, from + 999);
        if (!data || data.length === 0) break;
        allAmounts.push(...(data as AmountRow[]));
        if (data.length < 1000) break;
        from += 1000;
      }

      // 入金
      const { data: payData } = await supabase
        .from("payments").select("*").eq("company_id", selectedCompanyId);
      const payments = (payData ?? []) as Payment[];

      // 利用者マスタ
      const companyClients = clients.filter((c) => companyOfficeIds.has(c.office_id));
      const clientByNumber = new Map<string, Client>();
      for (const c of companyClients) clientByNumber.set(c.client_number, c);

      // key: `${office_number}|${client_number}|${segment}` → TableRow
      const map = new Map<string, TableRow>();
      const monthSet = new Set(monthColumns);
      for (const a of allAmounts) {
        const off = offices.find((o) => o.office_number === a.office_number);
        const officeName = (off?.short_name || off?.name) ?? a.office_number;
        const key = `${a.office_number}|${a.client_number}|${a.segment}`;
        if (!map.has(key)) {
          const c = clientByNumber.get(a.client_number);
          map.set(key, {
            client_number: a.client_number,
            client_name: c?.name ?? a.client_name ?? a.client_number,
            furigana: "", // 現状マスタに無いので空
            office_number: a.office_number,
            office_name: officeName,
            segment: a.segment,
            payment_method: (c?.payment_method as PaymentMethod) ?? "",
            monthlyAmounts: {},
            totalBilled: 0,
            totalPaid: 0,
            outstanding: 0,
          });
        }
        const r = map.get(key)!;
        r.totalBilled += a.amount ?? 0;
        if (monthSet.has(a.billing_month)) {
          r.monthlyAmounts[a.billing_month] = (r.monthlyAmounts[a.billing_month] ?? 0) + (a.amount ?? 0);
        }
      }

      // 入金を利用者単位で合算（事業別の入金は区別していない → 未収残は利用者×事業で按分せず全体での概算）
      // 簡易に: 入金は利用者単位で「過去全入金」を返す
      const paidByClient = new Map<string, number>();
      for (const p of payments) paidByClient.set(p.client_number, (paidByClient.get(p.client_number) ?? 0) + p.amount);

      // 利用者ごとの総請求額も集計（売掛残計算用）
      const billedByClient = new Map<string, number>();
      for (const a of allAmounts) billedByClient.set(a.client_number, (billedByClient.get(a.client_number) ?? 0) + (a.amount ?? 0));

      // 売掛金残額を各行に割り振る: 同じ client_number の行は同じ値を持つ
      const clientOutstanding = new Map<string, number>();
      for (const [cn, billed] of billedByClient) {
        const paid = paidByClient.get(cn) ?? 0;
        clientOutstanding.set(cn, Math.max(0, billed - paid));
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
      .filter((r) => !filterOutstandingOnly || r.outstanding > 0);
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
                      <tr key={`${group.client_number}-${idx}`} className="hover:bg-muted/10">
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
                          return (
                            <td key={m} className="border px-2 py-1 text-right font-mono">
                              {v > 0 ? yen(v) : ""}
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
                          <td rowSpan={spanRows} className={`border px-2 py-1 text-right font-mono font-bold ${r.outstanding > 0 ? "text-red-700" : "text-muted-foreground"}`}>
                            {r.outstanding > 0 ? yen(r.outstanding) : "0"}
                          </td>
                        )}
                      </tr>
                    );
                  })
                )
              )}
            </tbody>
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
    const { error } = await supabase.from("payments").insert({
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
