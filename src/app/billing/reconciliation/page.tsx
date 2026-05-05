"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { sortCompanies } from "@/lib/sort-companies";
import type { Company } from "@/types/database";
import {
  COMPANY_MASTER_JOIN,
  OFFICE_MASTER_JOIN,
  flattenCompanyMaster,
  flattenOfficeMaster,
} from "@/types/database";

/**
 * 突合・月次サマリダッシュボード
 * /billing/reconciliation
 *
 * 表示内容:
 *   1. 月次サマリ: ステータスごとの金額合計
 *   2. 未回収一覧 (invoiced + overdue) 利用者別
 *   3. 過誤調整履歴 (adjustment 行)
 *   4. 長期未回収警告 (overdue で 2ヶ月以上経過)
 */

type Row = {
  id: string;
  segment: "介護" | "障害" | "自費";
  office_number: string;
  client_number: string;
  client_name: string | null;
  billing_month: string;
  service_month: string | null;
  amount: number;
  invoiced_amount: number | null;
  paid_amount: number | null;
  billing_status: string;
  actual_issue_date: string | null;
  actual_withdrawal_date: string | null;
  parent_item_id: string | null;
  lifecycle_note: string | null;
  service_item: string | null;
};

type OfficeLite = { id: string; office_number: string; name: string; short_name: string; company_id: string | null };

function fmtMonth(m: string) {
  if (!m || m.length < 6) return m;
  return `${m.slice(0, 4)}/${m.slice(4, 6)}`;
}
function yen(n: number) {
  return n.toLocaleString("ja-JP");
}
function monthsDiff(a: string, b: string): number {
  // a → b の差（月数）
  const ya = parseInt(a.slice(0, 4), 10), ma = parseInt(a.slice(4, 6), 10);
  const yb = parseInt(b.slice(0, 4), 10), mb = parseInt(b.slice(4, 6), 10);
  return (yb - ya) * 12 + (mb - ma);
}

export default function ReconciliationPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [offices, setOffices] = useState<OfficeLite[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [filterMonth, setFilterMonth] = useState(""); // 対象月（YYYYMM）。空なら全期間
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      const [coRes, offRes] = await Promise.all([
        supabase.from("payroll_companies").select(`*, ${COMPANY_MASTER_JOIN}`),
        supabase.from("payroll_offices").select(`id, office_number, short_name, company_id, ${OFFICE_MASTER_JOIN}`),
      ]);
      if (coRes.data) {
        const flattened = flattenCompanyMaster(coRes.data as never) as unknown as Company[];
        const sorted = sortCompanies(flattened);
        setCompanies(sorted);
        if (sorted.length > 0 && !selectedCompanyId) setSelectedCompanyId(sorted[0].id);
      }
      if (offRes.data) {
        const flattened = flattenOfficeMaster(offRes.data as never) as unknown as OfficeLite[];
        setOffices(flattened);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const companyOffices = useMemo(
    () => offices.filter((o) => o.company_id === selectedCompanyId),
    [offices, selectedCompanyId]
  );
  const officeNameByNumber = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of offices) m.set(o.office_number, o.short_name || o.name);
    return m;
  }, [offices]);

  const fetchRows = useCallback(async () => {
    if (!selectedCompanyId) { setRows([]); return; }
    setLoading(true);
    try {
      const officeNums = companyOffices.map((o) => o.office_number);
      if (officeNums.length === 0) { setRows([]); return; }
      const all: Row[] = [];
      let from = 0;
      const pageSize = 1000;
      while (true) {
        let q = supabase
          .from("payroll_billing_amount_items")
          .select("id, segment, office_number, client_number, client_name, billing_month, service_month, amount, invoiced_amount, paid_amount, billing_status, actual_issue_date, actual_withdrawal_date, parent_item_id, lifecycle_note, service_item")
          .in("office_number", officeNums)
          .range(from, from + pageSize - 1);
        if (filterMonth) q = q.eq("billing_month", filterMonth);
        const { data } = await q;
        if (!data || data.length === 0) break;
        all.push(...(data as Row[]));
        if (data.length < pageSize) break;
        from += pageSize;
      }
      setRows(all);
    } finally {
      setLoading(false);
    }
  }, [selectedCompanyId, companyOffices, filterMonth]);
  // mount 時の async data fetch (HANDOVER §2 参照)。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchRows();
  }, [fetchRows]);

  // ── 集計 ──
  const summary = useMemo(() => {
    const s = { draft: 0, scheduled: 0, invoiced: 0, paid: 0, overdue: 0, adjustment: 0, cancelled: 0, deferred: 0 };
    for (const r of rows) {
      const st = (r.billing_status ?? "scheduled") as keyof typeof s;
      if (st === "paid") {
        s[st] += r.paid_amount ?? r.invoiced_amount ?? r.amount;
      } else if (st === "invoiced" || st === "overdue") {
        s[st] += r.invoiced_amount ?? r.amount;
      } else {
        s[st] += r.amount;
      }
    }
    return s;
  }, [rows]);

  // 未回収一覧 (invoiced + overdue)
  type ReceivableRow = { key: string; client_number: string; client_name: string; office_name: string; segment: string; billing_month: string; amount: number; status: string; monthsOverdue: number };
  const receivables = useMemo<ReceivableRow[]>(() => {
    const nowM = new Date();
    const nowYYYYMM = `${nowM.getFullYear()}${String(nowM.getMonth() + 1).padStart(2, "0")}`;
    const list: ReceivableRow[] = [];
    for (const r of rows) {
      if (r.billing_status !== "invoiced" && r.billing_status !== "overdue") continue;
      list.push({
        key: r.id,
        client_number: r.client_number,
        client_name: r.client_name || r.client_number,
        office_name: officeNameByNumber.get(r.office_number) || r.office_number,
        segment: r.segment,
        billing_month: r.billing_month,
        amount: r.invoiced_amount ?? r.amount,
        status: r.billing_status,
        monthsOverdue: monthsDiff(r.billing_month, nowYYYYMM),
      });
    }
    list.sort((a, b) => {
      // 長期未回収を優先
      if (a.monthsOverdue !== b.monthsOverdue) return b.monthsOverdue - a.monthsOverdue;
      return a.client_name.localeCompare(b.client_name, "ja");
    });
    return list;
  }, [rows, officeNameByNumber]);

  // 利用者別の未回収集計
  const receivablesByClient = useMemo(() => {
    const m = new Map<string, { client_number: string; client_name: string; total: number; items: ReceivableRow[]; maxMonthsOverdue: number }>();
    for (const r of receivables) {
      if (!m.has(r.client_number)) m.set(r.client_number, { client_number: r.client_number, client_name: r.client_name, total: 0, items: [], maxMonthsOverdue: 0 });
      const entry = m.get(r.client_number)!;
      entry.total += r.amount;
      entry.items.push(r);
      if (r.monthsOverdue > entry.maxMonthsOverdue) entry.maxMonthsOverdue = r.monthsOverdue;
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  }, [receivables]);

  // 過誤調整履歴
  const adjustments = useMemo(
    () => rows.filter((r) => r.billing_status === "adjustment").sort((a, b) => b.billing_month.localeCompare(a.billing_month)),
    [rows]
  );

  // 月選択候補
  const monthOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.billing_month) set.add(r.billing_month);
    return [...set].sort().reverse();
  }, [rows]);

  const totalReceivable = receivablesByClient.reduce((s, c) => s + c.total, 0);
  const longOverdueCount = receivablesByClient.filter((c) => c.maxMonthsOverdue >= 2).length;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-3">突合・月次サマリ</h2>

      {/* フィルタ */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <label className="text-sm">法人
          <select className="ml-2 border rounded px-2 py-1 text-sm bg-background"
            value={selectedCompanyId} onChange={(e) => setSelectedCompanyId(e.target.value)}>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="text-sm">請求月
          <select className="ml-2 border rounded px-2 py-1 text-sm bg-background"
            value={filterMonth} onChange={(e) => setFilterMonth(e.target.value)}>
            <option value="">全期間</option>
            {monthOptions.map((m) => (
              <option key={m} value={m}>{fmtMonth(m)}</option>
            ))}
          </select>
        </label>
        <button className="text-xs text-blue-600 hover:underline" onClick={fetchRows} disabled={loading}>
          🔄 再集計
        </button>
        {loading && <span className="text-xs text-muted-foreground">集計中…</span>}
      </div>

      {/* 月次サマリ */}
      <section className="mb-6">
        <h3 className="text-sm font-semibold mb-2">月次サマリ</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-4 gap-2">
          <SummaryCard label="請求予定 (未発行)" value={summary.scheduled} color="gray" />
          <SummaryCard label="発行済み未入金" value={summary.invoiced} color="blue" highlight={summary.invoiced > 0} />
          <SummaryCard label="引落不可 (未回収)" value={summary.overdue} color="red" highlight={summary.overdue > 0} />
          <SummaryCard label="入金済" value={summary.paid} color="green" />
          <SummaryCard label="翌月繰越" value={summary.deferred} color="yellow" />
          <SummaryCard label="キャンセル" value={summary.cancelled} color="gray" muted />
          <SummaryCard label="過誤調整純額" value={summary.adjustment} color="orange" sign />
          <SummaryCard label="売掛金残額 合計" value={totalReceivable} color="red" highlight={totalReceivable > 0} bold />
        </div>
      </section>

      {/* 長期未回収警告 */}
      {longOverdueCount > 0 && (
        <section className="mb-6 border border-red-400 rounded-md bg-red-50 p-3">
          <p className="text-sm font-semibold text-red-800">⚠ 長期未回収 (2ヶ月以上): {longOverdueCount} 名</p>
          <p className="text-xs text-red-700 mt-1">該当利用者は下の未回収一覧で確認してください。</p>
        </section>
      )}

      {/* 未回収一覧 */}
      <section className="mb-6">
        <h3 className="text-sm font-semibold mb-2">未回収一覧 (invoiced + overdue)</h3>
        {receivablesByClient.length === 0 ? (
          <p className="text-xs text-muted-foreground">未回収はありません</p>
        ) : (
          <div className="border rounded-md overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-muted/40">
                <tr>
                  <th className="text-left px-3 py-1.5">利用者</th>
                  <th className="text-right px-3 py-1.5 w-28">未回収額</th>
                  <th className="text-center px-3 py-1.5 w-24">最長月数</th>
                  <th className="text-left px-3 py-1.5">内訳</th>
                </tr>
              </thead>
              <tbody>
                {receivablesByClient.map((c) => (
                  <tr key={c.client_number} className={`border-t ${c.maxMonthsOverdue >= 2 ? "bg-red-50/40" : ""}`}>
                    <td className="px-3 py-1.5">
                      <span className="font-medium">{c.client_name}</span>
                      <span className="text-muted-foreground ml-2 font-mono text-[10px]">({c.client_number})</span>
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono font-bold text-red-700">¥{yen(c.total)}</td>
                    <td className="px-3 py-1.5 text-center">
                      {c.maxMonthsOverdue >= 2 && <span className="bg-red-100 text-red-800 rounded px-1.5 py-0.5 text-[10px] mr-1">⚠</span>}
                      {c.maxMonthsOverdue}ヶ月前〜
                    </td>
                    <td className="px-3 py-1.5 text-[10px] text-muted-foreground">
                      {c.items.map((i) => (
                        <span key={i.key} className="inline-block mr-2">
                          {fmtMonth(i.billing_month)} {i.segment} {i.office_name} ¥{yen(i.amount)}
                          <span className={`ml-1 ${i.status === "overdue" ? "text-red-700" : "text-blue-700"}`}>[{i.status}]</span>
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 過誤調整履歴 */}
      <section className="mb-6">
        <h3 className="text-sm font-semibold mb-2">過誤調整履歴 (status=adjustment)</h3>
        {adjustments.length === 0 ? (
          <p className="text-xs text-muted-foreground">過誤調整はありません</p>
        ) : (
          <div className="border rounded-md overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-muted/40">
                <tr>
                  <th className="text-left px-3 py-1.5">請求月</th>
                  <th className="text-left px-3 py-1.5">提供月</th>
                  <th className="text-left px-3 py-1.5">利用者</th>
                  <th className="text-left px-3 py-1.5">事業所/区分</th>
                  <th className="text-right px-3 py-1.5 w-24">調整額</th>
                  <th className="text-left px-3 py-1.5">理由</th>
                </tr>
              </thead>
              <tbody>
                {adjustments.map((a) => (
                  <tr key={a.id} className="border-t">
                    <td className="px-3 py-1.5 font-mono">{fmtMonth(a.billing_month)}</td>
                    <td className="px-3 py-1.5 font-mono">{a.service_month ? fmtMonth(a.service_month) : "—"}</td>
                    <td className="px-3 py-1.5">{a.client_name ?? a.client_number}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">
                      {officeNameByNumber.get(a.office_number) ?? a.office_number} / {a.segment}
                    </td>
                    <td className={`px-3 py-1.5 text-right font-mono font-bold ${a.amount < 0 ? "text-blue-700" : "text-red-700"}`}>
                      {a.amount > 0 ? "+" : ""}¥{yen(a.amount)}
                    </td>
                    <td className="px-3 py-1.5 text-[11px] text-muted-foreground">{a.lifecycle_note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="mt-8 text-[11px] text-muted-foreground space-y-0.5 border-t pt-3">
        <p>・売掛金残額: invoiced + overdue + adjustment(符号) − 個別入金 で計算。</p>
        <p>・長期未回収: billing_month が現在月より 2 ヶ月以上前の overdue/invoiced。</p>
        <p>・利用者ごとの詳細は <Link href="/billing" className="text-blue-600 hover:underline">請求管理</Link> 画面で月セルをクリック。</p>
      </div>
    </div>
  );
}

function SummaryCard({
  label, value, color, highlight, muted, bold, sign,
}: {
  label: string;
  value: number;
  color: "gray" | "blue" | "red" | "green" | "yellow" | "orange";
  highlight?: boolean;
  muted?: boolean;
  bold?: boolean;
  sign?: boolean;
}) {
  const palette: Record<string, { bg: string; text: string; border: string }> = {
    gray:   { bg: "bg-gray-50",   text: "text-gray-700",   border: "border-gray-300" },
    blue:   { bg: "bg-blue-50",   text: "text-blue-700",   border: "border-blue-300" },
    red:    { bg: "bg-red-50",    text: "text-red-700",    border: "border-red-300" },
    green:  { bg: "bg-green-50",  text: "text-green-700",  border: "border-green-300" },
    yellow: { bg: "bg-yellow-50", text: "text-yellow-800", border: "border-yellow-300" },
    orange: { bg: "bg-orange-50", text: "text-orange-700", border: "border-orange-300" },
  };
  const p = palette[color];
  const display = sign && value > 0 ? `+¥${value.toLocaleString("ja-JP")}` : `¥${value.toLocaleString("ja-JP")}`;
  return (
    <div className={`border rounded-md p-3 ${p.bg} ${p.border} ${muted ? "opacity-60" : ""} ${highlight ? "ring-2 ring-offset-1" : ""}`}>
      <p className={`text-[11px] ${p.text}`}>{label}</p>
      <p className={`${bold ? "text-xl font-bold" : "text-lg font-semibold"} ${p.text} mt-1`}>{display}</p>
    </div>
  );
}
