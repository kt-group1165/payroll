"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import type { Client, Company, Payment } from "@/types/database";

type BillingSegment = "介護" | "障害" | "自費";

type AmountItem = {
  id: string;
  segment: BillingSegment;
  office_number: string;
  client_number: string;
  client_name: string;
  billing_month: string;
  service_item_code: string | null;
  service_item: string;
  unit_price: number | null;
  quantity: number | null;
  amount: number;
  tax_amount: number | null;
  reduction_amount: number | null;
  medical_deduction: number | null;
  period_start: string | null;
  period_end: string | null;
};
type UnitItem = {
  id: string;
  segment: BillingSegment;
  office_number: string;
  client_number: string;
  billing_month: string;
  service_name: string;
  service_code: string | null;
  unit_count: number | null;
  unit_type: string | null;
  repetition: number | null;
  amount: number | null;
};
type DailyItem = {
  id: string;
  segment: BillingSegment;
  office_number: string;
  client_number: string;
  billing_month: string;
  service_name: string;
  service_code: string | null;
  day: number;
  quantity: number;
};
type OfficeLite = {
  id: string; office_number: string; name: string; short_name: string;
  company_id: string | null;
};

function fmtMonth(m: string) {
  return `${m.slice(0, 4)}年${parseInt(m.slice(4, 6), 10)}月`;
}
function yen(n: number) {
  return n.toLocaleString("ja-JP");
}
function fmtDate(d: string | null): string {
  if (!d) return "";
  const m = d.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return d;
  return `${parseInt(m[2], 10)}月${parseInt(m[3], 10)}日`;
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
  const [amounts, setAmounts] = useState<AmountItem[]>([]);
  const [units, setUnits]     = useState<UnitItem[]>([]);
  const [dailies, setDailies] = useState<DailyItem[]>([]);
  const [pastBilled, setPastBilled] = useState<number>(0);
  const [pastPaid,   setPastPaid]   = useState<number>(0);

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
      const offList = (offRes.data ?? []) as OfficeLite[];
      setOffices(offList);

      const companyOffices = offList.map((o) => o.office_number);
      if (companyOffices.length === 0) return;

      const fetchAll = async <T,>(table: string) => {
        const out: T[] = [];
        let from = 0;
        while (true) {
          const { data } = await supabase.from(table).select("*")
            .eq("billing_month", month)
            .eq("client_number", clientNumber)
            .in("office_number", companyOffices)
            .range(from, from + 999);
          if (!data || data.length === 0) break;
          out.push(...(data as T[]));
          if (data.length < 1000) break;
          from += 1000;
        }
        return out;
      };
      setAmounts(await fetchAll<AmountItem>("billing_amount_items"));
      setUnits(await fetchAll<UnitItem>("billing_unit_items"));
      setDailies(await fetchAll<DailyItem>("billing_daily_items"));

      // 繰越: 過去月の請求合計と過去入金の差
      const pastAmounts: AmountItem[] = [];
      let from = 0;
      while (true) {
        const { data } = await supabase.from("billing_amount_items")
          .select("amount, billing_month")
          .lt("billing_month", month)
          .eq("client_number", clientNumber)
          .in("office_number", companyOffices)
          .range(from, from + 999);
        if (!data || data.length === 0) break;
        pastAmounts.push(...(data as AmountItem[]));
        if (data.length < 1000) break;
        from += 1000;
      }
      setPastBilled(pastAmounts.reduce((s, r) => s + (r.amount ?? 0), 0));

      const { data: payData } = await supabase.from("payments")
        .select("amount, billing_month")
        .eq("company_id", companyId)
        .eq("client_number", clientNumber)
        .lt("billing_month", month);
      setPastPaid((payData ?? []).reduce((s, p) => s + (p as Payment).amount, 0));
    })();
  }, [companyId, month, clientNumber]);

  // 事業所 × 区分 でグルーピング
  type GroupKey = string; // `${office_number}|${segment}`
  type Group = {
    office: OfficeLite | undefined;
    officeName: string;
    segment: BillingSegment;
    amounts: AmountItem[];
    units: UnitItem[];
    dailies: DailyItem[];
  };
  const groups = useMemo((): Group[] => {
    const m = new Map<GroupKey, Group>();
    const get = (officeNum: string, seg: BillingSegment) => {
      const key = `${officeNum}|${seg}`;
      if (!m.has(key)) {
        const off = offices.find((o) => o.office_number === officeNum);
        m.set(key, {
          office: off,
          officeName: (off?.short_name || off?.name) ?? officeNum,
          segment: seg,
          amounts: [], units: [], dailies: [],
        });
      }
      return m.get(key)!;
    };
    for (const a of amounts) get(a.office_number, a.segment as BillingSegment).amounts.push(a);
    for (const u of units)   get(u.office_number, u.segment as BillingSegment).units.push(u);
    for (const d of dailies) get(d.office_number, d.segment as BillingSegment).dailies.push(d);
    const arr = [...m.values()];
    const segOrder: Record<BillingSegment, number> = { 介護: 0, 障害: 1, 自費: 2 };
    arr.sort((a, b) => {
      const so = segOrder[a.segment] - segOrder[b.segment];
      if (so !== 0) return so;
      return a.officeName.localeCompare(b.officeName, "ja");
    });
    return arr;
  }, [amounts, units, dailies, offices]);

  const currentTotal = useMemo(
    () => amounts.reduce((s, r) => s + (r.amount ?? 0), 0),
    [amounts]
  );
  const carryover = Math.max(0, pastBilled - pastPaid);
  const totalDue  = currentTotal + carryover;

  if (!companyId || !month || !clientNumber) {
    return <p className="p-6 text-sm text-muted-foreground">パラメータ不足（?company=&month=&client=）</p>;
  }

  const today = new Date();
  const issueDate = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
  const sealOn = client?.seal_required ?? false;
  const withdrawalDue = client?.withdrawal_day
    ? `${month.slice(0, 4)}年${parseInt(month.slice(4, 6), 10) + 1}月${client.withdrawal_day}日`
    : "";

  return (
    <div className="invoice-root print:bg-white">
      <style jsx global>{`
        @media print {
          @page { size: A4; margin: 10mm; }
          body { background: white !important; }
          .no-print { display: none !important; }
          aside { display: none !important; }
          main { overflow: visible !important; }
          .invoice-root { max-width: unset !important; padding: 0 !important; }
          .invoice-sheet { box-shadow: none !important; border: none !important; padding: 0 !important; }
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

      <div className="invoice-sheet max-w-[210mm] mx-auto bg-white border p-6 text-[11px] leading-5">
        {/* 右上: 発行日 + ご請求書在中 */}
        <div className="flex justify-end items-start gap-3 mb-1">
          <span className="text-[10px] border border-black px-2 py-0.5">ご請求書・領収書在中</span>
          <span className="text-xs">{issueDate}</span>
        </div>

        <h1 className="text-xl font-bold text-center mb-3">ご利用料金のご案内</h1>

        {/* 宛名 + 差出人 */}
        <div className="flex justify-between items-start mb-3 gap-4">
          <div className="flex-1">
            {client?.address && <p className="text-[10px]">〒 {client.address}</p>}
            <p className="text-base font-bold mt-1">{client?.name ?? "—"}　様</p>
            <p className="text-[10px] text-muted-foreground">({clientNumber})</p>
          </div>
          <div className="text-[10px] text-right">
            {company?.zipcode && <p>〒{company.zipcode}</p>}
            {company?.address && <p>{company.address}</p>}
            <p className="font-medium text-xs">{company?.formal_name || company?.name}</p>
            {company?.registration_number && <p>登録番号：{company.registration_number}</p>}
            {company?.tel && <p>TEL：{company.tel}</p>}
            <div className="mt-1 h-12 flex items-center justify-end">
              {sealOn && company?.seal_image_url ? (
                <img src={company.seal_image_url} alt="印" className="h-12 w-12 object-contain" />
              ) : (
                <span className="text-[10px] text-muted-foreground">※押印は省略させていただきます。</span>
              )}
            </div>
          </div>
        </div>

        {/* 挨拶文 */}
        <p className="text-[10px] whitespace-pre-wrap mb-3">
          {company?.invoice_greeting ?? "拝啓　毎々格別のお引立に預かり厚く御礼申し上げます。\nさて、ご利用分の請求書をお送りさせていただきましたので、ご査収の程よろしくお願いいたします。また、下記振替日にご指定口座より自動振替となりますので、お手数ですが前日までにお口座にご入金をお願いいたします。\n敬具"}
        </p>

        {/* 振替情報 */}
        {client?.payment_method === "withdrawal" && (
          <table className="w-full border-collapse mb-3 text-[10px]">
            <thead>
              <tr className="border-y">
                <th className="border-r px-1 py-1 font-medium bg-muted/20 w-20">振替日</th>
                <th className="border-r px-1 py-1 font-medium bg-muted/20 w-24">金融機関</th>
                <th className="border-r px-1 py-1 font-medium bg-muted/20 w-16">支店名</th>
                <th className="border-r px-1 py-1 font-medium bg-muted/20">種目・口座番号</th>
                <th className="border-r px-1 py-1 font-medium bg-muted/20">口座名義人</th>
                <th className="px-1 py-1 font-medium bg-muted/20 w-28">お引落予定金額</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b">
                <td className="border-r px-1 py-1 text-center">{withdrawalDue || "—"}</td>
                <td className="border-r px-1 py-1 text-center">{client.bank_name ?? "—"}</td>
                <td className="border-r px-1 py-1 text-center">{client.bank_branch ?? "—"}</td>
                <td className="border-r px-1 py-1 text-center">{client.bank_account_type ?? ""} {client.bank_account_number ?? ""}</td>
                <td className="border-r px-1 py-1 text-center">{client.bank_account_holder ?? "—"}</td>
                <td className="px-1 py-1 text-right font-bold">￥{yen(totalDue)}</td>
              </tr>
            </tbody>
          </table>
        )}

        {/* 引落金額内訳 + 過誤・相殺の注記エリア（右） */}
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div className="border rounded">
            <div className="bg-muted/20 px-2 py-0.5 text-[10px] font-medium">引落金額内訳</div>
            <div className="px-2 py-1 text-[10px] space-y-0.5">
              {currentTotal > 0 && (
                <p>{client?.name ?? "—"}様　{fmtMonth(month)}利用　{yen(currentTotal)}円</p>
              )}
              {carryover > 0 && (
                <p className="text-red-700">{client?.name ?? "—"}様　前月までの未払い分　{yen(carryover)}円</p>
              )}
              <p className="font-bold border-t pt-0.5 mt-0.5">お引落予定金額　￥{yen(totalDue)}</p>
            </div>
          </div>
          {/* 過誤・相殺の注記欄（空のまま。運用でメモがあれば別途。） */}
          <div className="border rounded">
            <div className="bg-muted/20 px-2 py-0.5 text-[10px] font-medium">過誤・相殺等</div>
            <div className="px-2 py-1 text-[10px] text-muted-foreground min-h-[40px]">
              {/* 過誤・相殺発生時の文言はここに表示 */}
            </div>
          </div>
        </div>

        {/* 各事業所×区分のセクション */}
        {groups.map((g, gi) => (
          <InvoiceGroup key={gi} group={g} client={client} companyInquiryTel={company?.inquiry_tel ?? null} />
        ))}

        {/* 合計欄 */}
        <div className="border-t-2 border-black pt-2 flex justify-end text-[11px]">
          <div className="w-72">
            <div className="flex justify-between py-0.5">
              <span>当月ご利用料金合計</span>
              <span>{yen(currentTotal)}円</span>
            </div>
            {carryover > 0 && (
              <div className="flex justify-between py-0.5 text-red-700">
                <span>前月までの繰越残高</span>
                <span>{yen(carryover)}円</span>
              </div>
            )}
            <div className="flex justify-between py-1 border-t font-bold text-sm">
              <span>ご請求金額</span>
              <span>￥{yen(totalDue)}</span>
            </div>
          </div>
        </div>

        {company?.inquiry_tel && (
          <p className="text-[10px] text-muted-foreground mt-4 text-center">お問い合わせ先　{company.inquiry_tel}</p>
        )}
      </div>
    </div>
  );
}

// ─── 事業所 × 区分 のセクション ────────────────────────

function InvoiceGroup({ group, client, companyInquiryTel }: {
  group: {
    office: OfficeLite | undefined;
    officeName: string;
    segment: BillingSegment;
    amounts: AmountItem[];
    units: UnitItem[];
    dailies: DailyItem[];
  };
  client: Client | null;
  companyInquiryTel: string | null;
}) {
  const { officeName, segment, amounts, units, dailies, office } = group;
  const periodStart = amounts[0]?.period_start ?? null;
  const periodEnd   = amounts[0]?.period_end ?? null;
  const periodLabel = periodStart && periodEnd
    ? `期間：${fmtDate(periodStart)}〜${fmtDate(periodEnd)}`
    : amounts[0]?.billing_month
      ? `期間：${amounts[0].billing_month.slice(0,4)}年${parseInt(amounts[0].billing_month.slice(4,6),10)}月`
      : "";

  // 単位数テーブル（介護のみ。障害も出せるが主に介護で使用）
  const unitSubtotal = units.reduce((s, u) => s + (u.unit_count ?? 0) * (u.repetition ?? 1), 0);

  // 金額内訳: service_item ごとに集計（同じ利用料項目が複数行の場合は合算）
  type AmountGrouped = {
    service_item: string;
    unit_price: number | null;
    quantity: number | null;
    amount: number;
  };
  const amountGroups: AmountGrouped[] = useMemoGroup(() => {
    const map = new Map<string, AmountGrouped>();
    for (const a of amounts) {
      const key = a.service_item || "(不明)";
      if (!map.has(key)) map.set(key, { service_item: key, unit_price: a.unit_price, quantity: 0, amount: 0 });
      const g = map.get(key)!;
      g.quantity = (g.quantity ?? 0) + (a.quantity ?? 0);
      g.amount += a.amount ?? 0;
    }
    return [...map.values()];
  }, amounts);

  const amountSubtotal = amounts.reduce((s, a) => s + (a.amount ?? 0), 0);

  // ミニ表: 医療費控除 / 減免額 / 軽減額 / 消費税
  const miniTable = {
    medical_deduction: amounts.reduce((s, a) => s + (a.medical_deduction ?? 0), 0),
    reduction:         amounts.reduce((s, a) => s + (a.reduction_amount ?? 0), 0),
    mitigation:        0, // 軽減額（専用列なし、減免と統合でも可）
    tax:               amounts.reduce((s, a) => s + (a.tax_amount ?? 0), 0),
  };
  const showMini = miniTable.medical_deduction > 0 || miniTable.reduction > 0 || miniTable.tax > 0;

  // カレンダー: day × service_name でマトリクス化
  const calendar = useMemoGroup(() => {
    if (dailies.length === 0) return null;
    const svcSet = new Set<string>();
    const cellMap = new Map<string, number>(); // key: `${day}|${svc}` → qty
    for (const d of dailies) {
      const svc = d.service_name || "(未設定)";
      svcSet.add(svc);
      const k = `${d.day}|${svc}`;
      cellMap.set(k, (cellMap.get(k) ?? 0) + d.quantity);
    }
    const services = [...svcSet].sort();
    return { services, cellMap };
  }, dailies);

  if (amounts.length === 0 && units.length === 0 && dailies.length === 0) return null;

  return (
    <section className="mb-4 border-t pt-2">
      <p className="text-[10px] font-semibold mb-1">
        {companyInquiryTel && <span className="mr-2">お問い合わせ先 {companyInquiryTel}</span>}
        {officeName}　<span className="font-normal">【{segment}】</span>
        　【ご利用内訳　{client?.name ?? ""}様　{periodLabel}】
        {client?.care_plan_provider && <span className="ml-2 text-muted-foreground">居宅介護支援事業者名：{client.care_plan_provider}</span>}
      </p>

      {/* 単位数テーブル（主に介護）*/}
      {units.length > 0 && (
        <table className="w-full border-collapse text-[10px] mb-1">
          <thead>
            <tr className="bg-muted/20 border-y">
              <th className="border-r px-1 py-0.5 text-left">内訳</th>
              <th className="border-r px-1 py-0.5 text-left w-24">備考</th>
              <th className="border-r px-1 py-0.5 text-center w-10">控除</th>
              <th className="border-r px-1 py-0.5 text-right w-16">単位数</th>
              <th className="border-r px-1 py-0.5 text-right w-12">回数</th>
              <th className="px-1 py-0.5 text-right w-16">単位</th>
            </tr>
          </thead>
          <tbody>
            {units.map((u) => (
              <tr key={u.id} className="border-b">
                <td className="border-r px-1 py-0.5">{u.service_name}</td>
                <td className="border-r px-1 py-0.5 text-muted-foreground"></td>
                <td className="border-r px-1 py-0.5 text-center">＊</td>
                <td className="border-r px-1 py-0.5 text-right">{u.unit_count != null ? yen(u.unit_count) : ""}</td>
                <td className="border-r px-1 py-0.5 text-right">{u.repetition ?? ""}</td>
                <td className="px-1 py-0.5 text-right">
                  {u.unit_count != null && u.repetition != null
                    ? yen(u.unit_count * u.repetition)
                    : u.unit_count != null ? yen(u.unit_count) : ""}
                </td>
              </tr>
            ))}
            <tr className="font-bold bg-muted/10">
              <td colSpan={5} className="border-r px-1 py-0.5 text-right">合計単位数</td>
              <td className="px-1 py-0.5 text-right">{yen(unitSubtotal)}</td>
            </tr>
          </tbody>
        </table>
      )}

      {/* 金額内訳テーブル */}
      {amountGroups.length > 0 && (
        <table className="w-full border-collapse text-[10px] mb-1">
          <thead>
            <tr className="bg-muted/20 border-y">
              <th className="border-r px-1 py-0.5 text-left">内訳</th>
              <th className="border-r px-1 py-0.5 text-left w-24">備考</th>
              <th className="border-r px-1 py-0.5 text-center w-10">控除</th>
              <th className="border-r px-1 py-0.5 text-right w-16">単価</th>
              <th className="border-r px-1 py-0.5 text-right w-12">時間</th>
              <th className="border-r px-1 py-0.5 text-right w-12">回数</th>
              <th className="px-1 py-0.5 text-right w-20">金額</th>
            </tr>
          </thead>
          <tbody>
            {amountGroups.map((a, i) => (
              <tr key={i} className="border-b">
                <td className="border-r px-1 py-0.5">{a.service_item}</td>
                <td className="border-r px-1 py-0.5 text-muted-foreground"></td>
                <td className="border-r px-1 py-0.5 text-center">＊</td>
                <td className="border-r px-1 py-0.5 text-right">{a.unit_price != null ? yen(a.unit_price) : ""}</td>
                <td className="border-r px-1 py-0.5 text-right"></td>
                <td className="border-r px-1 py-0.5 text-right">{a.quantity != null && a.quantity > 0 ? yen(a.quantity) : ""}</td>
                <td className="px-1 py-0.5 text-right">{yen(a.amount)}</td>
              </tr>
            ))}
            <tr className="font-bold bg-muted/10">
              <td colSpan={6} className="border-r px-1 py-0.5 text-right">利用者負担額 本人</td>
              <td className="px-1 py-0.5 text-right">{yen(amountSubtotal)}</td>
            </tr>
          </tbody>
        </table>
      )}

      {/* ミニ表: 医療費控除 / 減免額 / 軽減額 / 消費税 */}
      {showMini && (
        <table className="w-full border-collapse text-[10px] mb-2">
          <thead>
            <tr className="bg-muted/20 border-y">
              <th className="border-r px-1 py-0.5 text-center w-1/4">医療費控除対象額</th>
              <th className="border-r px-1 py-0.5 text-center w-1/4">減免額</th>
              <th className="border-r px-1 py-0.5 text-center w-1/4">軽減額</th>
              <th className="px-1 py-0.5 text-center w-1/4">内消費税</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b">
              <td className="border-r px-1 py-0.5 text-right">{yen(miniTable.medical_deduction)}円</td>
              <td className="border-r px-1 py-0.5 text-right">{yen(miniTable.reduction)}円</td>
              <td className="border-r px-1 py-0.5 text-right">{yen(miniTable.mitigation)}円</td>
              <td className="px-1 py-0.5 text-right">{yen(miniTable.tax)}円</td>
            </tr>
          </tbody>
        </table>
      )}

      {/* カレンダー */}
      {calendar && (
        <table className="w-full border-collapse text-[9px] mb-2">
          <thead>
            <tr className="bg-muted/20 border-y">
              <th className="border-r px-1 py-0.5 text-left w-32">サービス内容</th>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <th key={d} className="border-r px-0 py-0.5 text-center">{d}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {calendar.services.map((svc) => (
              <tr key={svc} className="border-b">
                <td className="border-r px-1 py-0.5 truncate">{svc}</td>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => {
                  const q = calendar.cellMap.get(`${d}|${svc}`);
                  return (
                    <td key={d} className="border-r px-0 py-0.5 text-center font-mono">
                      {q ? (Number.isInteger(q) ? q : q.toFixed(1)) : ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// React hook が使えるように useMemo のラッパー
function useMemoGroup<T>(factory: () => T, deps: unknown): T {
  return useMemo(factory, [deps]); // eslint-disable-line react-hooks/exhaustive-deps
}
