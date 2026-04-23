"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import type { Client, Company, Payment } from "@/types/database";
import { categorizeBySegment, type BillingSegment } from "@/lib/billing/segment";

type SR = {
  id: string;
  client_number: string;
  service_date: string;
  service_type: string;
  service_category: string | null;
  service_code: string;
  amount: number | null;
  total: number | null;
  calc_duration: string;
  office_number: string;
  office_name: string;
};
type OfficeLite = { id: string; office_number: string; name: string; short_name: string; company_id: string | null };

function fmtMonth(m: string) {
  return `${m.slice(0, 4)}年${parseInt(m.slice(4, 6), 10)}月`;
}
function yen(n: number) {
  return n.toLocaleString("ja-JP");
}

export default function InvoicePrintPage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">読み込み中…</p>}>
      <InvoicePrintInner />
    </Suspense>
  );
}

function InvoicePrintInner() {
  const sp = useSearchParams();
  const companyId = sp.get("company") ?? "";
  const month = sp.get("month") ?? "";
  const clientNumber = sp.get("client") ?? "";

  const [company, setCompany] = useState<Company | null>(null);
  const [client, setClient] = useState<Client | null>(null);
  const [offices, setOffices] = useState<OfficeLite[]>([]);
  const [currentRecs, setCurrentRecs] = useState<SR[]>([]);
  const [pastBilled, setPastBilled] = useState<number>(0);
  const [pastPaid, setPastPaid] = useState<number>(0);

  useEffect(() => {
    if (!companyId || !month || !clientNumber) return;
    (async () => {
      const [coRes, cliRes, offRes] = await Promise.all([
        supabase.from("companies").select("*").eq("id", companyId).maybeSingle(),
        supabase.from("clients").select("*").eq("client_number", clientNumber).maybeSingle(),
        supabase.from("offices").select("id, office_number, name, short_name, company_id").eq("company_id", companyId),
      ]);
      if (coRes.data)  setCompany(coRes.data as Company);
      if (cliRes.data) setClient(cliRes.data as Client);
      if (offRes.data) setOffices(offRes.data as OfficeLite[]);

      const companyOffices = (offRes.data ?? []).map((o) => (o as OfficeLite).office_number);
      if (companyOffices.length === 0) return;

      // 当月分
      const cur: SR[] = [];
      let from = 0;
      while (true) {
        const { data } = await supabase.from("service_records")
          .select("id,client_number,service_date,service_type,service_category,service_code,amount,total,calc_duration,office_number,office_name")
          .eq("processing_month", month)
          .eq("client_number", clientNumber)
          .in("office_number", companyOffices)
          .range(from, from + 999);
        if (!data || data.length === 0) break;
        cur.push(...(data as SR[]));
        if (data.length < 1000) break;
        from += 1000;
      }
      setCurrentRecs(cur);

      // 過去の請求合計
      const past: SR[] = [];
      from = 0;
      while (true) {
        const { data } = await supabase.from("service_records")
          .select("amount,total")
          .lt("processing_month", month)
          .eq("client_number", clientNumber)
          .in("office_number", companyOffices)
          .range(from, from + 999);
        if (!data || data.length === 0) break;
        past.push(...(data as unknown as SR[]));
        if (data.length < 1000) break;
        from += 1000;
      }
      setPastBilled(past.reduce((s, r) => s + (r.total ?? r.amount ?? 0), 0));

      // 過去の入金
      const { data: payData } = await supabase.from("payments")
        .select("amount, billing_month")
        .eq("company_id", companyId)
        .eq("client_number", clientNumber)
        .lt("billing_month", month);
      setPastPaid((payData ?? []).reduce((s, p) => s + (p as Payment).amount, 0));
    })();
  }, [companyId, month, clientNumber]);

  // 事業所×区分ごとにグルーピング
  const groups = useMemo(() => {
    const m = new Map<string, { office: OfficeLite | undefined; seg: BillingSegment; records: SR[] }>();
    for (const r of currentRecs) {
      const off = offices.find((o) => o.office_number === r.office_number);
      const seg = categorizeBySegment(r.service_category);
      const key = `${r.office_number}|${seg}`;
      if (!m.has(key)) m.set(key, { office: off, seg, records: [] });
      m.get(key)!.records.push(r);
    }
    // 表示順: 介護 → 障害 → 自費、同一区分内は事業所名順
    const arr = [...m.values()];
    const segOrder: Record<BillingSegment, number> = { 介護: 0, 障害: 1, 自費: 2 };
    arr.sort((a, b) => {
      const so = segOrder[a.seg] - segOrder[b.seg];
      if (so !== 0) return so;
      const na = (a.office?.short_name || a.office?.name) ?? "";
      const nb = (b.office?.short_name || b.office?.name) ?? "";
      return na.localeCompare(nb, "ja");
    });
    return arr;
  }, [currentRecs, offices]);

  const currentTotal = useMemo(
    () => currentRecs.reduce((s, r) => s + (r.total ?? r.amount ?? 0), 0),
    [currentRecs]
  );
  const carryover = Math.max(0, pastBilled - pastPaid);
  const totalDue  = currentTotal + carryover;

  if (!companyId || !month || !clientNumber) {
    return <p className="p-6 text-sm text-muted-foreground">パラメータが不足しています（?company=&month=&client=）</p>;
  }

  const today = new Date();
  const issueDate = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
  const sealOn = client?.seal_required ?? false;

  return (
    <div className="invoice-root print:bg-white">
      <style jsx global>{`
        @media print {
          @page { size: A4; margin: 12mm; }
          body { background: white !important; }
          .no-print { display: none !important; }
          aside { display: none !important; }
          main { overflow: visible !important; }
          .invoice-root { max-width: unset !important; padding: 0 !important; }
        }
      `}</style>

      {/* 操作バー（印刷時非表示） */}
      <div className="no-print mb-4 flex gap-2">
        <button
          onClick={() => window.print()}
          className="border rounded px-4 py-2 text-sm bg-primary text-primary-foreground hover:opacity-90"
        >
          🖨️ 印刷
        </button>
        <button
          onClick={() => window.close()}
          className="border rounded px-4 py-2 text-sm hover:bg-muted"
        >
          閉じる
        </button>
      </div>

      <div className="max-w-[210mm] mx-auto bg-white border p-8 text-sm leading-6">
        {/* ヘッダ: 日付 / 受取人 / 差出人 */}
        <div className="flex justify-between items-start mb-4">
          <div className="text-xs text-right flex-1">
            <p className="text-sm">{issueDate}</p>
          </div>
        </div>
        <h1 className="text-2xl font-bold text-center mb-4">ご利用料金のご案内</h1>

        <div className="flex justify-between items-start mb-6">
          <div className="flex-1">
            {client?.address && <p className="text-xs">〒　{client.address}</p>}
            <p className="text-lg font-bold mt-1">{client?.name ?? "—"} 様</p>
            <p className="text-xs text-muted-foreground">（{clientNumber}）</p>
          </div>
          <div className="text-xs text-right">
            {company?.zipcode && <p>〒{company.zipcode}</p>}
            {company?.address && <p>{company.address}</p>}
            <p className="font-medium text-sm">{company?.formal_name || company?.name}</p>
            {company?.registration_number && <p>登録番号：{company.registration_number}</p>}
            {company?.tel && <p>TEL：{company.tel}</p>}
            <div className="mt-2 h-16 flex items-center justify-end">
              {sealOn && company?.seal_image_url ? (
                <img src={company.seal_image_url} alt="印" className="h-16 w-16 object-contain" />
              ) : (
                <span className="text-xs text-muted-foreground">※押印は省略させていただきます。</span>
              )}
            </div>
          </div>
        </div>

        <p className="text-xs whitespace-pre-wrap mb-4">
          {company?.invoice_greeting ?? "拝啓　毎々格別のお引立に預かり厚く御礼申し上げます。\nさて、ご利用分の請求書をお送りさせていただきましたので、ご査収の程よろしくお願いいたします。\n敬具"}
        </p>

        {/* 振替情報 */}
        {client?.payment_method === "withdrawal" && (
          <table className="w-full border-collapse mb-4 text-xs">
            <tbody>
              <tr className="border-y">
                <th className="border-r px-2 py-1 font-medium bg-muted/20 w-24">振替日</th>
                <th className="border-r px-2 py-1 font-medium bg-muted/20 w-24">金融機関</th>
                <th className="border-r px-2 py-1 font-medium bg-muted/20 w-20">支店名</th>
                <th className="border-r px-2 py-1 font-medium bg-muted/20">種目・口座番号</th>
                <th className="border-r px-2 py-1 font-medium bg-muted/20">口座名義人</th>
                <th className="px-2 py-1 font-medium bg-muted/20 w-28">お引落予定金額</th>
              </tr>
              <tr className="border-b">
                <td className="border-r px-2 py-1.5 text-center">
                  {client.withdrawal_day ? `${month.slice(0, 4)}年${parseInt(month.slice(4, 6), 10) + 1}月${client.withdrawal_day}日` : "—"}
                </td>
                <td className="border-r px-2 py-1.5 text-center">{client.bank_name ?? "—"}</td>
                <td className="border-r px-2 py-1.5 text-center">{client.bank_branch ?? "—"}</td>
                <td className="border-r px-2 py-1.5 text-center">
                  {client.bank_account_type ?? ""} {client.bank_account_number ?? ""}
                </td>
                <td className="border-r px-2 py-1.5 text-center">{client.bank_account_holder ?? "—"}</td>
                <td className="px-2 py-1.5 text-right font-bold">￥{yen(totalDue)}</td>
              </tr>
            </tbody>
          </table>
        )}

        {/* 引落金額内訳 */}
        <div className="border rounded mb-4">
          <div className="bg-muted/20 px-2 py-1 text-xs font-medium">引落金額内訳</div>
          <div className="px-2 py-1.5 text-xs space-y-1">
            {currentTotal > 0 && (
              <p>{client?.name ?? "—"}様　{fmtMonth(month)}利用　{yen(currentTotal)}円</p>
            )}
            {carryover > 0 && (
              <p className="text-red-700">{client?.name ?? "—"}様　前月までの未払い分　{yen(carryover)}円</p>
            )}
            <p className="font-bold border-t pt-1 mt-1">お引落予定金額　￥{yen(totalDue)}</p>
          </div>
        </div>

        {/* 事業所×区分のセクション */}
        {groups.map((g, gi) => {
          const subtotal = g.records.reduce((s, r) => s + (r.total ?? r.amount ?? 0), 0);
          const officeName = (g.office?.short_name || g.office?.name) ?? g.records[0]?.office_name ?? "—";
          return (
            <section key={gi} className="mb-5 border-t pt-3">
              <p className="text-xs font-semibold mb-1">
                {officeName}　【{g.seg}】　ご利用内訳（{client?.name ?? ""}様　{fmtMonth(month)}利用分）
                {client?.care_plan_provider && <span className="ml-2 text-muted-foreground">居宅介護支援事業者: {client.care_plan_provider}</span>}
              </p>
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-muted/20 border-y">
                    <th className="border-r px-2 py-1 text-left">日付</th>
                    <th className="border-r px-2 py-1 text-left">内訳</th>
                    <th className="border-r px-2 py-1 text-left">備考</th>
                    <th className="border-r px-2 py-1 text-right w-16">時間</th>
                    <th className="border-r px-2 py-1 text-right w-14">回数</th>
                    <th className="px-2 py-1 text-right w-24">金額</th>
                  </tr>
                </thead>
                <tbody>
                  {g.records
                    .slice()
                    .sort((a, b) => a.service_date.localeCompare(b.service_date))
                    .map((r) => (
                      <tr key={r.id} className="border-b">
                        <td className="border-r px-2 py-1 whitespace-nowrap">
                          {r.service_date.replace(/^\d{4}\//, "")}
                        </td>
                        <td className="border-r px-2 py-1">{r.service_type}</td>
                        <td className="border-r px-2 py-1 text-xs text-muted-foreground">{r.service_category}</td>
                        <td className="border-r px-2 py-1 text-right">{r.calc_duration || "—"}</td>
                        <td className="border-r px-2 py-1 text-right">1</td>
                        <td className="px-2 py-1 text-right">{yen(r.total ?? r.amount ?? 0)}</td>
                      </tr>
                    ))}
                  <tr className="font-bold bg-muted/10">
                    <td colSpan={5} className="border-r px-2 py-1.5 text-right">小計（{g.seg}）</td>
                    <td className="px-2 py-1.5 text-right">{yen(subtotal)}</td>
                  </tr>
                </tbody>
              </table>
            </section>
          );
        })}

        {/* 合計 */}
        <div className="border-t-2 border-black pt-3 flex justify-end text-sm">
          <div className="w-80">
            <div className="flex justify-between py-1">
              <span>当月ご利用料金合計</span>
              <span>{yen(currentTotal)}円</span>
            </div>
            {carryover > 0 && (
              <div className="flex justify-between py-1 text-red-700">
                <span>前月までの繰越残高</span>
                <span>{yen(carryover)}円</span>
              </div>
            )}
            <div className="flex justify-between py-2 border-t font-bold text-base">
              <span>ご請求金額</span>
              <span>￥{yen(totalDue)}</span>
            </div>
          </div>
        </div>

        {company?.inquiry_tel && (
          <p className="text-xs text-muted-foreground mt-6">お問い合わせ先　{company.inquiry_tel}</p>
        )}
      </div>
    </div>
  );
}
