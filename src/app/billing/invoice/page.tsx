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

function fmtMonthLabel(m: string) {
  return `${parseInt(m.slice(4, 6), 10)}月`;
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
  const [units, setUnits] = useState<UnitItem[]>([]);
  const [dailies, setDailies] = useState<DailyItem[]>([]);
  const [pastBilled, setPastBilled] = useState<number>(0);
  const [pastPaid, setPastPaid] = useState<number>(0);

  useEffect(() => {
    if (!companyId || !month || !clientNumber) return;
    (async () => {
      const [coRes, offRes, cliListRes] = await Promise.all([
        supabase.from("companies").select("*").eq("id", companyId).maybeSingle(),
        supabase.from("offices").select("id, office_number, name, short_name, company_id").eq("company_id", companyId),
        supabase.from("clients").select("*").eq("client_number", clientNumber),
      ]);
      if (coRes.data) setCompany(coRes.data as Company);
      const offList = (offRes.data ?? []) as OfficeLite[];
      setOffices(offList);
      const officeIds = new Set(offList.map((o) => o.id));
      const matched = ((cliListRes.data ?? []) as Client[]).find((c) => officeIds.has(c.office_id));
      if (matched) setClient(matched);

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
  type Group = {
    office: OfficeLite | undefined;
    officeName: string;
    segment: BillingSegment;
    amounts: AmountItem[];
    units: UnitItem[];
    dailies: DailyItem[];
  };
  const groups = useMemo((): Group[] => {
    const m = new Map<string, Group>();
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
    for (const u of units) get(u.office_number, u.segment as BillingSegment).units.push(u);
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
  const totalDue = currentTotal + carryover;

  // 引落金額内訳: 事業所×区分×月
  type BreakdownRow = { officeName: string; segment: BillingSegment; monthLabel: string; amount: number };
  const breakdownRows = useMemo((): BreakdownRow[] => {
    const m = new Map<string, BreakdownRow>();
    for (const a of amounts) {
      const off = offices.find((o) => o.office_number === a.office_number);
      const officeName = (off?.short_name || off?.name) ?? a.office_number;
      const key = `${a.office_number}|${a.segment}|${a.billing_month}`;
      if (!m.has(key)) {
        m.set(key, {
          officeName,
          segment: a.segment as BillingSegment,
          monthLabel: fmtMonthLabel(a.billing_month),
          amount: 0,
        });
      }
      m.get(key)!.amount += a.amount ?? 0;
    }
    return [...m.values()].sort((x, y) => x.officeName.localeCompare(y.officeName, "ja"));
  }, [amounts, offices]);

  const hasSegment = (seg: BillingSegment) =>
    amounts.some((a) => a.segment === seg) ||
    units.some((u) => u.segment === seg) ||
    dailies.some((d) => d.segment === seg);

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
          @page { size: A4; margin: 8mm; }
          body { background: white !important; }
          .no-print { display: none !important; }
          aside { display: none !important; }
          main { overflow: visible !important; }
          .invoice-root { max-width: unset !important; padding: 0 !important; }
          .invoice-sheet { box-shadow: none !important; border: none !important; padding: 0 !important; }
        }
      `}</style>

      <div className="no-print mb-4 flex gap-2">
        <button
          onClick={() => window.print()}
          className="border rounded px-4 py-2 text-sm bg-primary text-primary-foreground hover:opacity-90"
        >
          🖨️ 印刷
        </button>
        <button onClick={() => window.close()} className="border rounded px-4 py-2 text-sm hover:bg-muted">閉じる</button>
      </div>

      <div className="invoice-sheet max-w-[210mm] mx-auto bg-white border p-4 text-[10px] leading-[14px]">
        {/* ─── 上部ヘッダ: 3列レイアウト（左: 宛名, 中央: 在中マーク, 右: 発行日+区分+差出人） ─── */}
        <div className="grid grid-cols-[1fr_auto_1fr] gap-4 items-start mb-2">
          {/* 左: タイトル + 宛名 */}
          <div>
            <div className="inline-block border border-black px-3 py-0.5 text-lg font-bold">
              ご利用料金のご案内
            </div>
            <div className="mt-3">
              {client?.address && <p>〒 {client.address}</p>}
              <p className="text-base font-bold mt-0.5">{client?.name ?? "—"}　様　<span className="text-[9px] font-normal">({clientNumber})</span></p>
            </div>
          </div>

          {/* 中央: ご請求書・領収書在中 */}
          <div className="self-center">
            <div className="border border-black px-3 py-1 text-[11px] whitespace-nowrap">
              ご請求書・領収書在中
            </div>
          </div>

          {/* 右: 発行日 + 区分 + 差出人 */}
          <div className="text-right">
            <div className="flex items-start justify-end gap-2 mb-1">
              <span>{issueDate}</span>
              <div className="border border-black px-1 py-0.5 text-[9px] inline-flex flex-col items-start gap-0.5 leading-[12px]">
                <span>{hasSegment("介護") ? "☑" : "☐"}介護</span>
                <span>{hasSegment("障害") ? "☑" : "☐"}障害</span>
                <span>{hasSegment("自費") ? "☑" : "☐"}事業所書式(自費)</span>
              </div>
            </div>
            <div className="text-[10px] leading-[13px]">
              {company?.zipcode && <p>〒{company.zipcode}</p>}
              {company?.address && <p>{company.address}</p>}
              <p className="font-medium text-[11px] mt-0.5">{company?.formal_name || company?.name}</p>
              {company?.registration_number && <p>登録番号：{company.registration_number}</p>}
              {company?.tel && <p>TEL：{company.tel}</p>}
            </div>
          </div>
        </div>

        {/* ─── 挨拶文 + 押印 ─── */}
        <div className="grid grid-cols-[1fr_auto] gap-4 items-start mb-2">
          <p className="text-[10px] whitespace-pre-wrap">
            {company?.invoice_greeting ?? "拝啓　毎々格別のお引立に預かり厚く御礼申し上げます。\nさて、ご利用分の請求書をお送りさせていただきましたので、ご査収の程よろしくお願いいたします。また、下記振替日にご指定口座より自動振替となりますので、お手数ですが前日までにお口座にご入金をお願いいたします。　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　　敬具"}
          </p>
          <div className="text-right min-w-[140px]">
            {sealOn && company?.seal_image_url ? (
              <img src={company.seal_image_url} alt="印" className="h-16 w-16 object-contain ml-auto" />
            ) : (
              <span className="text-[10px]">※押印は省略させていただきます。</span>
            )}
          </div>
        </div>

        {/* ─── 振替情報テーブル（全幅） ─── */}
        {client?.payment_method === "withdrawal" && (
          <table className="w-full border-collapse mb-2 text-[10px]">
            <thead>
              <tr>
                <th className="border border-black px-1 py-0.5 bg-muted/20 w-20">振替日</th>
                <th className="border border-black px-1 py-0.5 bg-muted/20 w-24">金融機関</th>
                <th className="border border-black px-1 py-0.5 bg-muted/20 w-16">支店名</th>
                <th className="border border-black px-1 py-0.5 bg-muted/20">種目・口座番号</th>
                <th className="border border-black px-1 py-0.5 bg-muted/20">口座名義人</th>
                <th className="border border-black px-1 py-0.5 bg-muted/20 w-28">お引落予定金額</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="border border-black px-1 py-1 text-center">{withdrawalDue || "—"}</td>
                <td className="border border-black px-1 py-1 text-center">{client.bank_name ?? "—"}</td>
                <td className="border border-black px-1 py-1 text-center">{client.bank_branch ?? "—"}</td>
                <td className="border border-black px-1 py-1 text-center">{client.bank_account_type ?? ""} {client.bank_account_number ?? ""}</td>
                <td className="border border-black px-1 py-1 text-center">{client.bank_account_holder ?? "—"}</td>
                <td className="border border-black px-1 py-1 text-right font-bold">￥{yen(totalDue)}</td>
              </tr>
            </tbody>
          </table>
        )}

        {/* ─── 引落金額内訳 + 過誤・相殺注記（2カラム） ─── */}
        <table className="w-full border-collapse mb-3 text-[10px]">
          <tbody>
            <tr>
              <td className="border border-black align-top w-1/2 p-1">
                <p className="font-medium mb-1">引落金額内訳</p>
                {breakdownRows.map((r, i) => (
                  <p key={i} className="text-[10px]">
                    {client?.name ?? "—"}様　{r.officeName}　{r.monthLabel}利用【{r.segment}】　{yen(r.amount)}円
                  </p>
                ))}
              </td>
              <td className="border border-black align-top w-1/2 p-1">
                {/* 過誤・相殺注記エリア（運用で記入） */}
                {carryover > 0 && (
                  <p className="text-red-700">
                    {client?.name ?? "—"}様　前月までの未払い分　{yen(carryover)}円
                  </p>
                )}
              </td>
            </tr>
          </tbody>
        </table>

        {/* ─── 各事業所×区分のセクション ─── */}
        {groups.map((g, gi) => (
          <InvoiceGroup key={gi} group={g} client={client} companyInquiryTel={company?.inquiry_tel ?? null} companyFormalName={company?.formal_name ?? null} />
        ))}

        {/* ─── カレンダー（全セクションをまとめて末尾に3列配置） ─── */}
        {groups.some((g) => g.dailies.length > 0) && (
          <div className="mt-3">
            <p className="text-[10px] text-blue-700 text-center mb-1">カレンダーの表示</p>
            <div className="grid grid-cols-3 gap-2">
              {(["介護", "障害", "自費"] as BillingSegment[]).map((seg) => {
                const segGroups = groups.filter((g) => g.segment === seg && g.dailies.length > 0);
                if (segGroups.length === 0) return <div key={seg} />;
                return segGroups.map((g, i) => (
                  <MiniCalendar
                    key={`${seg}-${i}`}
                    title={g.officeName}
                    segment={seg}
                    billingMonth={month}
                    dailies={g.dailies}
                  />
                ));
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── セクション（事業所 × 区分） ────────────────────────

function InvoiceGroup({ group, client, companyInquiryTel, companyFormalName }: {
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
  companyFormalName: string | null;
}) {
  const { officeName, segment, amounts, units } = group;
  const periodStart = amounts[0]?.period_start ?? null;
  const periodEnd = amounts[0]?.period_end ?? null;
  const periodLabel = periodStart && periodEnd
    ? `${fmtDate(periodStart)}〜${fmtDate(periodEnd)}`
    : amounts[0]?.billing_month
      ? `${amounts[0].billing_month.slice(0, 4)}年${parseInt(amounts[0].billing_month.slice(4, 6), 10)}月`
      : "";

  const unitSubtotal = units.reduce(
    (s, u) => s + ((u.unit_count ?? 0) * (u.repetition ?? 1)),
    0
  );

  type AmountGrouped = { service_item: string; unit_price: number | null; quantity: number | null; amount: number };
  const amountGroups: AmountGrouped[] = useMemo(() => {
    const map = new Map<string, AmountGrouped>();
    for (const a of amounts) {
      const key = a.service_item || "(不明)";
      if (!map.has(key)) map.set(key, { service_item: key, unit_price: a.unit_price, quantity: 0, amount: 0 });
      const g = map.get(key)!;
      g.quantity = (g.quantity ?? 0) + (a.quantity ?? 0);
      g.amount += a.amount ?? 0;
    }
    return [...map.values()];
  }, [amounts]);

  const amountSubtotal = amounts.reduce((s, a) => s + (a.amount ?? 0), 0);
  const miniTable = {
    medical_deduction: amounts.reduce((s, a) => s + (a.medical_deduction ?? 0), 0),
    reduction: amounts.reduce((s, a) => s + (a.reduction_amount ?? 0), 0),
    mitigation: 0,
    tax: amounts.reduce((s, a) => s + (a.tax_amount ?? 0), 0),
  };

  if (amounts.length === 0 && units.length === 0) return null;

  const isSelfPay = segment === "自費";
  const sectionBg = isSelfPay ? "bg-muted/10" : "";

  return (
    <section className={`mb-3 ${sectionBg}`}>
      {/* お問い合わせ先 (黄色ハイライト) */}
      {companyInquiryTel && (
        <p className="bg-yellow-200/70 text-[10px] px-1 font-medium">お問い合わせ先 {companyInquiryTel}</p>
      )}

      {/* セクション見出し */}
      <p className="text-[10px] mb-1 mt-0.5">
        <span className="font-semibold">{officeName}</span>
        <span className="mx-1 text-red-700">{companyFormalName ?? ""}</span>
        【ご利用内訳　{client?.name ?? ""}様　期間：{periodLabel}】
        {client?.care_plan_provider && <span className="ml-2">居宅介護支援事業者名：{client.care_plan_provider}</span>}
      </p>

      {/* 単位数テーブル */}
      {units.length > 0 && (
        <table className="w-full border-collapse text-[10px] mb-1">
          <thead>
            <tr>
              <th className="border border-black px-1 py-0.5 text-left">内訳</th>
              <th className="border border-black px-1 py-0.5 text-left w-28">備考</th>
              <th className="border border-black px-1 py-0.5 text-center w-10">控除</th>
              <th className="border border-black px-1 py-0.5 text-right w-16">単位数</th>
              <th className="border border-black px-1 py-0.5 text-right w-12">回数</th>
              <th className="border border-black px-1 py-0.5 text-right w-20">単位</th>
            </tr>
          </thead>
          <tbody>
            {units.map((u) => (
              <tr key={u.id}>
                <td className="border border-black px-1 py-0.5">{u.service_name}</td>
                <td className="border border-black px-1 py-0.5"></td>
                <td className="border border-black px-1 py-0.5 text-center">＊</td>
                <td className="border border-black px-1 py-0.5 text-right">{u.unit_count != null ? yen(u.unit_count) : ""}</td>
                <td className="border border-black px-1 py-0.5 text-right">{u.repetition ?? ""}</td>
                <td className="border border-black px-1 py-0.5 text-right">
                  {u.unit_count != null && u.repetition != null
                    ? `${yen(u.unit_count * u.repetition)}単位`
                    : u.unit_count != null ? `${yen(u.unit_count)}単位` : ""}
                </td>
              </tr>
            ))}
            <tr>
              <td className="border border-black px-1 py-0.5"></td>
              <td className="border border-black px-1 py-0.5"></td>
              <td className="border border-black px-1 py-0.5"></td>
              <td className="border border-black px-1 py-0.5 text-right font-medium">合計単位数</td>
              <td className="border border-black px-1 py-0.5"></td>
              <td className="border border-black px-1 py-0.5 text-right">{yen(unitSubtotal)}単位</td>
            </tr>
          </tbody>
        </table>
      )}

      {/* 金額テーブル */}
      {amountGroups.length > 0 && (
        <table className="w-full border-collapse text-[10px] mb-1">
          <thead>
            <tr>
              <th className="border border-black px-1 py-0.5 text-left">内訳</th>
              <th className="border border-black px-1 py-0.5 text-left w-28">備考</th>
              <th className="border border-black px-1 py-0.5 text-center w-10">控除</th>
              <th className="border border-black px-1 py-0.5 text-right w-16">単価</th>
              <th className="border border-black px-1 py-0.5 text-right w-12">時間</th>
              <th className="border border-black px-1 py-0.5 text-right w-12">回数</th>
              <th className="border border-black px-1 py-0.5 text-right w-20">金額</th>
            </tr>
          </thead>
          <tbody>
            {amountGroups.map((a, i) => (
              <tr key={i}>
                <td className="border border-black px-1 py-0.5">{a.service_item}</td>
                <td className="border border-black px-1 py-0.5"></td>
                <td className="border border-black px-1 py-0.5 text-center">＊</td>
                <td className="border border-black px-1 py-0.5 text-right">{a.unit_price != null ? yen(a.unit_price) : ""}</td>
                <td className="border border-black px-1 py-0.5 text-right"></td>
                <td className="border border-black px-1 py-0.5 text-right">{a.quantity != null && a.quantity > 0 ? yen(a.quantity) : ""}</td>
                <td className="border border-black px-1 py-0.5 text-right">{yen(a.amount)}</td>
              </tr>
            ))}
            {/* 利用者負担 本人 行 */}
            <tr>
              <td className="border border-black px-1 py-0.5 font-medium">利用者負担　本人</td>
              <td className="border border-black px-1 py-0.5"></td>
              <td className="border border-black px-1 py-0.5"></td>
              <td className="border border-black px-1 py-0.5"></td>
              <td className="border border-black px-1 py-0.5"></td>
              <td className="border border-black px-1 py-0.5 text-right font-medium">{isSelfPay ? "自費負担額" : "利用者負担額"}</td>
              <td className="border border-black px-1 py-0.5 text-right font-bold">¥{yen(amountSubtotal)}</td>
            </tr>
          </tbody>
        </table>
      )}

      {/* 4マスのミニ表（右寄せ、小さめ） */}
      <div className="flex justify-start gap-2 mt-1 mb-1">
        {!isSelfPay && (
          <MiniBox label={segment === "障害" ? "上限金額" : "医療費控除対象額"} value={miniTable.medical_deduction} />
        )}
        <MiniBox label="減免額" value={miniTable.reduction} />
        <MiniBox label="軽減額" value={miniTable.mitigation} />
        <MiniBox label={segment === "自費" ? "消費税" : "消費税→内消費税"} value={miniTable.tax} />
      </div>

      {/* 自費セクション: 利用者負担額 / 自費負担額 */}
      {isSelfPay && (
        <div className="flex justify-end mt-1 mb-1">
          <table className="border-collapse text-[10px]">
            <tbody>
              <tr>
                <td className="border border-black px-2 py-0.5 w-32">利用者負担額</td>
                <td className="border border-black px-2 py-0.5 text-right w-24">¥0</td>
              </tr>
              <tr>
                <td className="border border-black px-2 py-0.5 w-32 font-medium">自費負担額</td>
                <td className="border border-black px-2 py-0.5 text-right font-bold w-24">¥{yen(amountSubtotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function MiniBox({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-[9px] leading-[12px]">
      <div className="border border-black px-1 text-center bg-muted/20 whitespace-nowrap">{label}</div>
      <div className="border border-black border-t-0 px-1 py-0.5 text-right min-w-[70px]">¥{yen(value)}</div>
    </div>
  );
}

function MiniCalendar({ title, segment, billingMonth, dailies }: {
  title: string;
  segment: BillingSegment;
  billingMonth: string;
  dailies: DailyItem[];
}) {
  const year = parseInt(billingMonth.slice(0, 4), 10);
  const month = parseInt(billingMonth.slice(4, 6), 10);
  const firstDay = new Date(year, month - 1, 1).getDay(); // 0=日
  const daysInMonth = new Date(year, month, 0).getDate();
  const usedDays = new Set(dailies.map((d) => d.day));

  const weeks: (number | null)[][] = [];
  let cur: (number | null)[] = new Array(firstDay).fill(null);
  for (let d = 1; d <= daysInMonth; d++) {
    cur.push(d);
    if (cur.length === 7) {
      weeks.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) {
    while (cur.length < 7) cur.push(null);
    weeks.push(cur);
  }

  const segColor =
    segment === "介護" ? "border-orange-400" :
    segment === "障害" ? "border-purple-400" :
    "border-green-400";

  return (
    <div className={`border-2 ${segColor} text-[8px]`}>
      <div className="bg-muted/30 px-1 py-0.5 text-center font-medium">{title}</div>
      <div className="text-center font-bold text-[9px]">ご利用日</div>
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {["日", "月", "火", "水", "木", "金", "土"].map((w, i) => (
              <th key={w} className={`px-0 py-0.5 text-center ${i === 0 ? "text-red-600" : i === 6 ? "text-blue-600" : ""}`}>
                {w}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, wi) => (
            <tr key={wi}>
              {week.map((d, di) => (
                <td key={di} className="px-0 py-0.5 text-center">
                  {d == null ? "" : usedDays.has(d)
                    ? <span className={`inline-block rounded-full border ${di === 0 ? "border-red-600 text-red-600" : di === 6 ? "border-blue-600 text-blue-600" : "border-black"} w-4 h-4 leading-[14px]`}>{d}</span>
                    : <span className="text-muted-foreground">{d}</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[8px] text-center text-muted-foreground pt-0.5">
        {segment}
      </p>
    </div>
  );
}
