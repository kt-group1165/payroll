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

type AmountRow = {
  segment: "介護" | "障害";
  office_number: string;
  client_number: string;
  client_name: string;
  billing_month: string;
  service_item: string;
  amount: number;
};

type OfficeLite = { id: string; office_number: string; name: string; short_name: string; company_id: string | null };

type BillingSegment = "介護" | "障害" | "自費";

type ClientRow = {
  client_number: string;
  client_name: string;
  current_total: number;
  by_segment: Record<BillingSegment, number>;
  carryover: number;
  paid_current: number;
  balance: number;
};

function fmtMonth(m: string) {
  return `${m.slice(0, 4)}年${parseInt(m.slice(4, 6), 10)}月`;
}
function yen(n: number) {
  return n.toLocaleString("ja-JP") + "円";
}

export default function BillingPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [offices, setOffices] = useState<OfficeLite[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [selectedMonth, setSelectedMonth] = useState("");
  const [availableMonths, setAvailableMonths] = useState<string[]>([]);
  const [rows, setRows] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      const [coRes, offRes] = await Promise.all([
        supabase.from("companies").select("*").order("name"),
        supabase.from("offices").select("id, office_number, name, short_name, company_id"),
      ]);
      if (coRes.data) setCompanies(coRes.data as Company[]);
      if (offRes.data) setOffices(offRes.data as OfficeLite[]);
      if (coRes.data && coRes.data.length > 0) setSelectedCompanyId((coRes.data as Company[])[0].id);

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

      // billing_amount_items から請求月の候補を取得
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

  const computeRows = useCallback(async () => {
    if (!selectedCompanyId || !selectedMonth) return;
    setLoading(true);
    try {
      const companyOffices = offices.filter((o) => o.company_id === selectedCompanyId).map((o) => o.office_number);
      const companyOfficeIds = new Set(offices.filter((o) => o.company_id === selectedCompanyId).map((o) => o.id));
      if (companyOffices.length === 0) { setRows([]); return; }

      // 当月分
      const currentRows: AmountRow[] = [];
      let fromIdx = 0;
      while (true) {
        const { data } = await supabase
          .from("billing_amount_items")
          .select("segment, office_number, client_number, client_name, billing_month, service_item, amount")
          .eq("billing_month", selectedMonth)
          .in("office_number", companyOffices)
          .range(fromIdx, fromIdx + 999);
        if (!data || data.length === 0) break;
        currentRows.push(...(data as AmountRow[]));
        if (data.length < 1000) break;
        fromIdx += 1000;
      }

      // 前月以前
      const pastRows: AmountRow[] = [];
      fromIdx = 0;
      while (true) {
        const { data } = await supabase
          .from("billing_amount_items")
          .select("segment, office_number, client_number, client_name, billing_month, service_item, amount")
          .lt("billing_month", selectedMonth)
          .in("office_number", companyOffices)
          .range(fromIdx, fromIdx + 999);
        if (!data || data.length === 0) break;
        pastRows.push(...(data as AmountRow[]));
        if (data.length < 1000) break;
        fromIdx += 1000;
      }

      // 入金
      const { data: payData } = await supabase
        .from("payments").select("*").eq("company_id", selectedCompanyId);
      const payments = (payData ?? []) as Payment[];

      // 利用者マスタ
      const companyClients = clients.filter((c) => companyOfficeIds.has(c.office_id));
      const clientByNumber = new Map<string, Client>();
      for (const c of companyClients) clientByNumber.set(c.client_number, c);

      // 利用者集計
      const clientMap = new Map<string, { name: string }>();
      for (const r of [...currentRows, ...pastRows]) {
        if (!clientMap.has(r.client_number)) {
          const info = clientByNumber.get(r.client_number);
          clientMap.set(r.client_number, { name: info?.name ?? r.client_name ?? r.client_number });
        }
      }

      const byCurrent = new Map<string, { total: number; bySeg: Record<BillingSegment, number> }>();
      for (const r of currentRows) {
        const seg: BillingSegment = r.segment === "介護" ? "介護" : "障害";
        if (!byCurrent.has(r.client_number)) byCurrent.set(r.client_number, { total: 0, bySeg: { 介護: 0, 障害: 0, 自費: 0 } });
        const o = byCurrent.get(r.client_number)!;
        o.total += r.amount ?? 0;
        o.bySeg[seg] += r.amount ?? 0;
      }
      const byPast = new Map<string, number>();
      for (const r of pastRows) byPast.set(r.client_number, (byPast.get(r.client_number) ?? 0) + (r.amount ?? 0));

      const pastPaidByClient = new Map<string, number>();
      const curPaidByClient = new Map<string, number>();
      for (const p of payments) {
        if (p.billing_month < selectedMonth) {
          pastPaidByClient.set(p.client_number, (pastPaidByClient.get(p.client_number) ?? 0) + p.amount);
        } else if (p.billing_month === selectedMonth) {
          curPaidByClient.set(p.client_number, (curPaidByClient.get(p.client_number) ?? 0) + p.amount);
        }
      }

      const result: ClientRow[] = [];
      for (const [cn, { name }] of clientMap) {
        const cur = byCurrent.get(cn) ?? { total: 0, bySeg: { 介護: 0, 障害: 0, 自費: 0 } };
        const pastBilled = byPast.get(cn) ?? 0;
        const pastPaid = pastPaidByClient.get(cn) ?? 0;
        const carryover = Math.max(0, pastBilled - pastPaid);
        const paidCurrent = curPaidByClient.get(cn) ?? 0;
        const balance = cur.total + carryover - paidCurrent;
        if (cur.total === 0 && carryover === 0 && paidCurrent === 0) continue;
        result.push({
          client_number: cn,
          client_name: name,
          current_total: cur.total,
          by_segment: cur.bySeg,
          carryover,
          paid_current: paidCurrent,
          balance,
        });
      }
      result.sort((a, b) => a.client_number.localeCompare(b.client_number));
      setRows(result);
    } finally {
      setLoading(false);
    }
  }, [selectedCompanyId, selectedMonth, offices, clients]);

  useEffect(() => {
    computeRows();
  }, [computeRows]);

  const totals = useMemo(() => {
    const t = { current: 0, carryover: 0, paid: 0, balance: 0 };
    for (const r of rows) {
      t.current += r.current_total;
      t.carryover += r.carryover;
      t.paid += r.paid_current;
      t.balance += r.balance;
    }
    return t;
  }, [rows]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 className="text-2xl font-bold">請求管理</h2>
        <Link href="/billing/import" className="text-sm underline text-blue-600">📁 請求CSV取り込み</Link>
      </div>

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div>
          <Label className="text-xs text-muted-foreground">法人</Label>
          <select
            className="border rounded px-3 py-1.5 text-sm bg-background min-w-[240px]"
            value={selectedCompanyId}
            onChange={(e) => setSelectedCompanyId(e.target.value)}
          >
            {companies.length === 0 && <option value="">（法人なし）</option>}
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">請求対象月</Label>
          <select
            className="border rounded px-3 py-1.5 text-sm bg-background"
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
          >
            {availableMonths.length === 0 && <option value="">（データなし）</option>}
            {availableMonths.map((m) => (
              <option key={m} value={m}>{fmtMonth(m)}</option>
            ))}
          </select>
        </div>
        <Button variant="outline" onClick={computeRows} disabled={loading}>
          {loading ? "集計中…" : "🔄 再集計"}
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <SummaryCard label="当月請求額" value={totals.current} />
        <SummaryCard label="繰越残高" value={totals.carryover} />
        <SummaryCard label="当月入金" value={totals.paid} />
        <SummaryCard label="未収残" value={totals.balance} emphasize />
      </div>

      <div className="border rounded-md overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead className="bg-muted/30 border-b">
              <tr>
                <th className="text-left px-3 py-2 font-medium">利用者番号</th>
                <th className="text-left px-3 py-2 font-medium">氏名</th>
                <th className="text-right px-3 py-2 font-medium">介護</th>
                <th className="text-right px-3 py-2 font-medium">障害</th>
                <th className="text-right px-3 py-2 font-medium">当月計</th>
                <th className="text-right px-3 py-2 font-medium">繰越</th>
                <th className="text-right px-3 py-2 font-medium">入金</th>
                <th className="text-right px-3 py-2 font-medium">未収残</th>
                <th className="text-center px-3 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={9} className="text-center text-muted-foreground py-6">
                  {loading ? "集計中…" : availableMonths.length === 0 ? "請求データが未取り込みです。" : "対象データがありません"}
                </td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.client_number} className="border-b last:border-b-0 hover:bg-muted/10">
                    <td className="px-3 py-1.5 font-mono text-xs">{r.client_number}</td>
                    <td className="px-3 py-1.5">{r.client_name}</td>
                    <td className="px-3 py-1.5 text-right">{r.by_segment.介護 ? yen(r.by_segment.介護) : "—"}</td>
                    <td className="px-3 py-1.5 text-right">{r.by_segment.障害 ? yen(r.by_segment.障害) : "—"}</td>
                    <td className="px-3 py-1.5 text-right font-medium">{yen(r.current_total)}</td>
                    <td className="px-3 py-1.5 text-right">{r.carryover > 0 ? yen(r.carryover) : "—"}</td>
                    <td className="px-3 py-1.5 text-right text-green-700">{r.paid_current > 0 ? yen(r.paid_current) : "—"}</td>
                    <td className={`px-3 py-1.5 text-right font-bold ${r.balance > 0 ? "text-red-700" : "text-muted-foreground"}`}>
                      {yen(r.balance)}
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      <PaymentDialog
                        companyId={selectedCompanyId}
                        clientNumber={r.client_number}
                        clientName={r.client_name}
                        billingMonth={selectedMonth}
                        currentBalance={r.balance}
                        onSaved={computeRows}
                      />
                      <Link
                        href={`/billing/invoice?company=${selectedCompanyId}&month=${selectedMonth}&client=${encodeURIComponent(r.client_number)}`}
                        target="_blank"
                        className="ml-1 text-xs text-blue-600 hover:underline"
                      >
                        請求書
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, emphasize }: { label: string; value: number; emphasize?: boolean }) {
  return (
    <div className={`border rounded-md p-3 ${emphasize ? "bg-primary/5" : ""}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-xl font-bold ${emphasize && value > 0 ? "text-primary" : ""}`}>
        {value.toLocaleString("ja-JP")}円
      </p>
    </div>
  );
}

function PaymentDialog({
  companyId, clientNumber, clientName, billingMonth, currentBalance, onSaved,
}: {
  companyId: string;
  clientNumber: string;
  clientName: string;
  billingMonth: string;
  currentBalance: number;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState<string>("");
  const [paidAt, setPaidAt] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<string>("withdrawal");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    const amt = parseInt(amount, 10);
    if (!amt || amt <= 0) { toast.error("金額を入力してください"); return; }
    setSaving(true);
    const { error } = await supabase.from("payments").insert({
      company_id: companyId,
      client_number: clientNumber,
      billing_month: billingMonth,
      amount: amt,
      paid_at: paidAt,
      method,
      note: note || null,
    });
    setSaving(false);
    if (error) { toast.error(`保存エラー: ${error.message}`); return; }
    toast.success("入金を記録しました");
    setOpen(false);
    setAmount(""); setNote("");
    onSaved();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o && currentBalance > 0) setAmount(String(currentBalance)); }}>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>入金</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{clientName} 入金登録（{fmtMonth(billingMonth)}分）</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>金額（円）</Label>
            <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={String(currentBalance)} />
            {currentBalance > 0 && (
              <p className="text-xs text-muted-foreground mt-1">現在の未収残: {yen(currentBalance)}</p>
            )}
          </div>
          <div>
            <Label>入金日</Label>
            <Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
          </div>
          <div>
            <Label>支払方法</Label>
            <select
              className="w-full border rounded px-2 py-1 text-sm bg-background"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              <option value="withdrawal">口座引落</option>
              <option value="transfer">振込</option>
              <option value="cash">集金</option>
              <option value="other">その他</option>
            </select>
          </div>
          <div>
            <Label>メモ（任意）</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <Button onClick={handleSubmit} disabled={saving} className="w-full">
            {saving ? "保存中…" : "登録"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
