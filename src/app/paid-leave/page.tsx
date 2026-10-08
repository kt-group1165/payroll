"use client";

/**
 * /paid-leave 有給管理 (2026-10-08 user「有給の管理表を作りたい」「任せる」)。
 *
 * Box 03_有給/<法人>/<年度>/<事業所>.xlsm の「有給管理簿」シートと 個人シートを 画面にしたもの。
 *   一覧 (1 行 = 職員 × 付与): 付与日 / 消化期限 / 年 5 日の義務 / 有給日数 / 消化 / 残 / 前年度・今年度の残と日当 / 4 月〜3 月
 *   行を開くと 個人台帳: 使用日ごとの日数・残日数と 管理者・所属長の確認欄 (payroll_paid_leave_confirmations)
 *
 * 使った日数は 給与計算 (payroll/page.tsx 有給の付与ごとの日当) と同じ数え方:
 *   有給管理簿の月ごとの日数 (payroll_monthly_inputs paid_leave_days) が その月にあれば それ
 *   (★ 最新の付与日より前の月は 管理簿の値を信用しない。payroll_paid_leave_ledger_range)、
 *   無ければ 事業所書式 (ファイル取込 + 画面の入力を月ごとに合流) の 有給・半有給。
 * 付与 (繰越・付与日数・日当) は payroll_paid_leave_grants。この画面では見るだけ。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { usePayrollOffices } from "@/lib/swr/use-payroll-offices";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { officeFormPaidLeaveDays, type OfficeFormRecord } from "@/lib/payroll/payroll-calc";
import { getEntriesByEmployeesMonthRange } from "@/lib/office-input/queries";
import { mergeOfficeFormSources, normEmp, officeInputEntryToFormRecord, processingToBillingMonth } from "@/lib/office-input/to-form-records";
import { splitItemDates } from "@/lib/office-input/from-form-records";
import {
  addMonthsMinusOneDay, allocatePaidLeave, fiscalMonths, fiscalYearOf, fmtDays, grantYearMonths, obligationDays,
} from "@/lib/payroll/paid-leave-ledger";

type Emp = { id: string; employee_number: string; name: string; salary_type: string | null; role_type: string | null; employment_status: string | null };
type Grant = { employee_id: string; grant_date: string; carry_days: number | null; grant_days: number | null; prev_rate: number | null; cur_rate: number | null; source: string | null };
/** 使った日 1 つ (日付が分からない分は date = null) */
type UseDay = { date: string | null; days: number; month: string; source: "書式" | "画面" };
type MonthUse = { days: number; source: "管理簿" | "書式" | "" };
type Row = {
  key: string; emp: Emp; grant: Grant; window: string[];
  months: Map<string, MonthUse>; used: number; uses: UseDay[];
};

const PAGE = 1000;
const todayJst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const ymNow = () => todayJst().slice(0, 7).replace("-", "");
const yen = (v: number | null | undefined) => (v == null ? "—" : `${Number(v).toLocaleString()}円`);

export default function PaidLeavePage() {
  const { offices, isLoading: officesLoading } = usePayrollOffices();
  const [officeId, setOfficeId] = useState("");
  const [fy, setFy] = useState(() => fiscalYearOf(todayJst()));
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmed, setConfirmed] = useState<Map<string, { by: string | null; at: string }>>(new Map());
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [userEmail, setUserEmail] = useState<string | null>(null);

  const office = offices.find((o) => o.id === officeId) ?? null;
  const effOfficeId = officeId || offices[0]?.id || "";
  const effOffice = office ?? offices[0] ?? null;

  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => setUserEmail(data.user?.email ?? null));
  }, []);

  const load = useCallback(async () => {
    if (!effOffice) return;
    setLoading(true);
    try {
      const fyStart = `${fy}-04-01`, fyEnd = `${fy + 1}-03-31`;
      // 職員 (その事業所。退職者も 付与があれば出す)
      const { data: empData, error: empErr } = await supabase.from("payroll_employees")
        .select("id,employee_number,name,salary_type,role_type,employment_status").eq("office_id", effOffice.id);
      if (empErr) throw new Error(`職員の取得に失敗: ${empErr.message}`);
      const emps = (empData ?? []) as Emp[];
      const empById = new Map(emps.map((e) => [e.id, e]));
      // 付与
      const grants: Grant[] = [];
      for (let i = 0; i < emps.length; i += 150) {
        const { data, error } = await supabase.from("payroll_paid_leave_grants")
          .select("employee_id,grant_date,carry_days,grant_days,prev_rate,cur_rate,source").in("employee_id", emps.slice(i, i + 150).map((e) => e.id));
        if (error) throw new Error(`有給の付与の取得に失敗: ${error.message}`);
        grants.push(...((data ?? []) as Grant[]));
      }
      // 年度に重なる付与 (付与日から 1 年が 年度にかかるもの) = 一覧の行
      const target = grants.filter((g) => g.grant_date <= fyEnd && addMonthsMinusOneDay(g.grant_date, 12) >= fyStart);
      if (target.length === 0) { setRows([]); return; }
      const latestGrantMonth = new Map<string, string>();
      for (const g of grants) {
        const m = g.grant_date.slice(0, 7).replace("-", "");
        if ((latestGrantMonth.get(g.employee_id) ?? "") < m) latestGrantMonth.set(g.employee_id, m);
      }
      const fromM = target.map((g) => g.grant_date.slice(0, 7).replace("-", "")).sort()[0];
      const lastM = target.map((g) => grantYearMonths(g.grant_date)[11]).sort().at(-1)!;
      const toM = lastM < ymNow() ? lastM : ymNow();

      // 有給管理簿の月ごとの日数
      const ledger = new Map<string, Map<string, number>>(); // normEmp → month → days
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase.from("payroll_monthly_inputs")
          .select("employee_number,processing_month,numeric_value")
          .eq("office_number", effOffice.office_number).eq("item_key", "paid_leave_days")
          .gte("processing_month", fromM).lte("processing_month", toM).order("id").range(from, from + PAGE - 1);
        if (error) throw new Error(`有給管理簿の日数の取得に失敗: ${error.message}`);
        for (const r of (data ?? []) as { employee_number: string; processing_month: string; numeric_value: number | null }[]) {
          const k = normEmp(r.employee_number);
          if (!ledger.has(k)) ledger.set(k, new Map());
          ledger.get(k)!.set(r.processing_month, Number(r.numeric_value ?? 0));
        }
        if (!data || data.length < PAGE) break;
      }
      // 事業所書式 (ファイル) の 有給・半有給
      const csv: (OfficeFormRecord & { processing_month: string })[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase.from("payroll_office_form_records")
          .select("employee_number,processing_month,record_type,item_name,item_date,numeric_value,start_time,end_time,year_month,child_name,amount")
          .eq("office_number", effOffice.office_number).gte("processing_month", fromM).lte("processing_month", toM)
          .like("item_name", "%有給%").order("id").range(from, from + PAGE - 1);
        if (error) throw new Error(`事業所書式の有給の取得に失敗: ${error.message}`);
        csv.push(...((data ?? []) as (OfficeFormRecord & { processing_month: string })[]));
        if (!data || data.length < PAGE) break;
      }
      // 画面の入力 (事業所書式入力)
      const web = (await getEntriesByEmployeesMonthRange(emps.map((e) => e.id), processingToBillingMonth(fromM), processingToBillingMonth(toM)))
        .filter((x) => x.item_name.includes("有給"));
      const webByMonth = new Map<string, (OfficeFormRecord & { processing_month: string; _web: true })[]>();
      for (const x of web) {
        const e = empById.get(x.employee_id);
        if (!e) continue;
        const pm = x.billing_month.replace("-", "");
        const rec = { ...officeInputEntryToFormRecord(x, e.employee_number), processing_month: pm, _web: true as const };
        webByMonth.set(pm, [...(webByMonth.get(pm) ?? []), rec]);
      }
      const csvByMonth = new Map<string, (OfficeFormRecord & { processing_month: string })[]>();
      for (const r of csv) csvByMonth.set(r.processing_month, [...(csvByMonth.get(r.processing_month) ?? []), r]);
      // 月ごとに合流 (給与計算と同じ: 画面の入力がある (職員 × 項目) は 画面が勝つ)
      const formByEmpMonth = new Map<string, (OfficeFormRecord & { _web?: true })[]>(); // normEmp|month
      for (const pm of new Set([...csvByMonth.keys(), ...webByMonth.keys()])) {
        const merged = mergeOfficeFormSources(csvByMonth.get(pm) ?? [], webByMonth.get(pm) ?? []).records as (OfficeFormRecord & { _web?: true })[];
        for (const r of merged) {
          const k = `${normEmp(r.employee_number)}|${pm}`;
          formByEmpMonth.set(k, [...(formByEmpMonth.get(k) ?? []), r]);
        }
      }

      const out: Row[] = [];
      for (const g of target) {
        const emp = empById.get(g.employee_id);
        if (!emp) continue;
        const num = normEmp(emp.employee_number);
        const window = grantYearMonths(g.grant_date);
        const ledgerFrom = latestGrantMonth.get(emp.id) ?? "";
        const months = new Map<string, MonthUse>();
        const uses: UseDay[] = [];
        let used = 0;
        for (const m of window) {
          if (m > toM) { months.set(m, { days: 0, source: "" }); continue; }
          const recs = formByEmpMonth.get(`${num}|${m}`) ?? [];
          const led = ledger.get(num)?.get(m);
          const useLedger = led !== undefined && m >= ledgerFrom;
          const d = useLedger ? led! : officeFormPaidLeaveDays(recs);
          months.set(m, { days: d, source: useLedger ? "管理簿" : d > 0 ? "書式" : "" });
          used += d;
          // 使った日の一覧 (確認欄用)。書式の日付から作る。管理簿の月は 日付が無いので 月の合計だけ
          if (!useLedger) {
            for (const r of recs) {
              const half = r.item_name.includes("半有給");
              const ds = splitItemDates(r.item_date, processingToBillingMonth(m));
              const src = r._web ? "画面" : "書式";
              if (ds && ds.length > 0) for (const dt of ds) uses.push({ date: dt, days: half ? 0.5 : 1, month: m, source: src });
              else if (r.record_type === "km" && Number(r.numeric_value ?? 0) > 0) uses.push({ date: null, days: Number(r.numeric_value) * (half ? 0.5 : 1), month: m, source: src });
              else uses.push({ date: null, days: half ? 0.5 : 1, month: m, source: src });
            }
          }
        }
        uses.sort((a, b) => (a.date ?? a.month).localeCompare(b.date ?? b.month));
        out.push({ key: `${emp.id}|${g.grant_date}`, emp, grant: g, window, months, used, uses });
      }
      out.sort((a, b) => a.emp.employee_number.localeCompare(b.emp.employee_number, "ja", { numeric: true }) || a.grant.grant_date.localeCompare(b.grant.grant_date));
      setRows(out);

      // 確認欄
      const ids = [...new Set(out.map((r) => r.emp.id))];
      const conf = new Map<string, { by: string | null; at: string }>();
      let cErr: string | null = null;
      for (let i = 0; i < ids.length; i += 150) {
        const { data, error } = await supabase.from("payroll_paid_leave_confirmations")
          .select("employee_id,use_date,confirmed_by,confirmed_at").in("employee_id", ids.slice(i, i + 150));
        if (error) { cErr = error.message; break; }
        for (const c of (data ?? []) as { employee_id: string; use_date: string; confirmed_by: string | null; confirmed_at: string }[]) {
          conf.set(`${c.employee_id}|${c.use_date}`, { by: c.confirmed_by, at: c.confirmed_at });
        }
      }
      setConfirmed(conf);
      setConfirmError(cErr);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "読み込みに失敗しました");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [effOffice, fy]);

  useEffect(() => {
    // 事業所・年度が変わったら読み直す (外部 = DB の読み込み)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const toggleConfirm = async (empId: string, date: string, on: boolean) => {
    const key = `${empId}|${date}`;
    if (on) {
      const { error } = await supabase.from("payroll_paid_leave_confirmations")
        .upsert({ employee_id: empId, use_date: date, confirmed_by: userEmail }, { onConflict: "employee_id,use_date" });
      if (error) { toast.error(`確認の保存に失敗: ${error.message}`); return; }
      setConfirmed((m) => new Map(m).set(key, { by: userEmail, at: new Date().toISOString() }));
    } else {
      const { error } = await supabase.from("payroll_paid_leave_confirmations").delete().eq("employee_id", empId).eq("use_date", date);
      if (error) { toast.error(`確認の取り消しに失敗: ${error.message}`); return; }
      setConfirmed((m) => { const n = new Map(m); n.delete(key); return n; });
    }
  };

  const months = useMemo(() => fiscalMonths(fy), [fy]);
  const today = todayJst();
  const shown = rows.filter((r) => !filter || r.emp.name.includes(filter) || r.emp.employee_number.includes(filter));

  const exportCsv = () => {
    const head = ["社員番号", "氏名", "支払形態", "付与日", "消化期限", "年5日の義務", "年5日の残り", "前年度繰越", "今年度付与", "有給日数", "消化日数", "残日数", "前年度の残", "前年度日当", "今年度の残", "今年度日当", ...months.map((m) => `${Number(m.slice(4))}月`)];
    const lines = [head];
    for (const r of shown) {
      const carry = Number(r.grant.carry_days ?? 0), gd = r.grant.grant_days;
      const a = allocatePaidLeave(carry, Number(gd ?? 0), r.used);
      const ob = obligationDays(gd);
      lines.push([r.emp.employee_number, r.emp.name, r.emp.salary_type ?? "", r.grant.grant_date, addMonthsMinusOneDay(r.grant.grant_date, 12),
        ob == null ? "" : String(ob), ob == null ? "" : fmtDays(Math.max(0, ob - r.used)), fmtDays(carry), gd == null ? "" : fmtDays(gd),
        gd == null ? "" : fmtDays(carry + gd), fmtDays(r.used), gd == null ? "" : fmtDays(a.remaining), fmtDays(a.carryLeft),
        String(r.grant.prev_rate ?? ""), gd == null ? "" : fmtDays(a.grantLeft), String(r.grant.cur_rate ?? ""),
        ...months.map((m) => (r.months.has(m) && r.months.get(m)!.days > 0 ? fmtDays(r.months.get(m)!.days) : ""))]);
    }
    const csv = lines.map((l) => l.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" }));
    const a = document.createElement("a");
    a.href = url; a.download = `有給管理簿_${effOffice?.short_name || effOffice?.name || ""}_${fy}年度.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <h2 className="text-2xl font-bold mb-1">有給管理</h2>
      <p className="text-sm text-muted-foreground mb-4">
        Box の「有給管理簿」と同じ形の一覧です。行を押すと 使った日ごとの台帳と 管理者・所属長の確認欄が開きます。
        使った日数は 給与計算と同じ数え方 (有給管理簿の月の日数 → 無ければ 事業所書式の有給・半有給)。付与 (繰越・日当) は見るだけです。
      </p>

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <label className="text-xs text-muted-foreground">事業所
          <select className="block h-9 mt-0.5 rounded-md border bg-background px-2 text-sm min-w-56" value={effOfficeId}
            onChange={(e) => { setOfficeId(e.target.value); setOpen(null); }} disabled={officesLoading}>
            {offices.map((o) => <option key={o.id} value={o.id}>{o.short_name || o.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">年度 (4月〜3月)
          <select className="block h-9 mt-0.5 rounded-md border bg-background px-2 text-sm" value={fy} onChange={(e) => { setFy(Number(e.target.value)); setOpen(null); }}>
            {Array.from({ length: 4 }, (_, i) => fiscalYearOf(todayJst()) - 2 + i).map((y) => <option key={y} value={y}>{y}年度</option>)}
          </select>
        </label>
        <Input className="h-9 w-56" placeholder="氏名・社員番号で絞り込み" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="text-sm text-muted-foreground">{shown.length}件</span>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" onClick={() => void load()} disabled={loading}>{loading ? "読み込み中…" : "読み直す"}</Button>
          <Button variant="outline" onClick={exportCsv} disabled={shown.length === 0}>📥 CSV出力</Button>
        </div>
      </div>
      {confirmError && <p className="mb-3 text-sm text-amber-700">確認欄を読めませんでした: {confirmError}</p>}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full whitespace-nowrap text-xs">
          <thead>
            <tr className="bg-muted/50 border-b text-muted-foreground">
              <th className="px-2 py-1" colSpan={3} />
              <th className="px-2 py-1 border-l" colSpan={4}>付与・消化期限 / 年5日</th>
              <th className="px-2 py-1 border-l" colSpan={3}>日数</th>
              <th className="px-2 py-1 border-l" colSpan={2}>前年度 (繰越)</th>
              <th className="px-2 py-1 border-l" colSpan={3}>今年度</th>
              <th className="px-2 py-1 border-l" colSpan={12}>使った日数</th>
              <th className="px-2 py-1 border-l">確認</th>
            </tr>
            <tr className="bg-muted/50 border-b">
              <th className="px-2 py-1.5 text-left">社員番号</th>
              <th className="px-2 py-1.5 text-left">氏名</th>
              <th className="px-2 py-1.5 text-left">支払形態</th>
              <th className="px-2 py-1.5 text-left border-l">付与日</th>
              <th className="px-2 py-1.5 text-left">消化期限</th>
              <th className="px-2 py-1.5 text-right" title="年 5 日の取得義務 (付与日数 10 日以上の人)">義務</th>
              <th className="px-2 py-1.5 text-right" title="消化期限までに あと何日取らせる必要があるか">残り</th>
              <th className="px-2 py-1.5 text-right border-l" title="前年度繰越 + 今年度付与">有給日数</th>
              <th className="px-2 py-1.5 text-right">消化</th>
              <th className="px-2 py-1.5 text-right">残</th>
              <th className="px-2 py-1.5 text-right border-l" title="繰越から先に使う">残</th>
              <th className="px-2 py-1.5 text-right">日当</th>
              <th className="px-2 py-1.5 text-right border-l">付与</th>
              <th className="px-2 py-1.5 text-right">残</th>
              <th className="px-2 py-1.5 text-right">日当</th>
              {months.map((m, i) => <th key={m} className={"px-1.5 py-1.5 text-right" + (i === 0 ? " border-l" : "")}>{Number(m.slice(4))}月</th>)}
              <th className="px-2 py-1.5 text-center border-l">済/日</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && <tr><td colSpan={28} className="px-3 py-8 text-center text-muted-foreground">読み込み中…</td></tr>}
            {!loading && shown.length === 0 && <tr><td colSpan={28} className="px-3 py-8 text-center text-muted-foreground">この年度に付与のある職員がいません</td></tr>}
            {shown.map((r) => {
              const carry = Number(r.grant.carry_days ?? 0), gd = r.grant.grant_days;
              const a = allocatePaidLeave(carry, Number(gd ?? 0), r.used);
              const ob = obligationDays(gd);
              const expiry = addMonthsMinusOneDay(r.grant.grant_date, 12);
              const obLeft = ob == null ? null : Math.max(0, ob - r.used);
              const soon = obLeft != null && obLeft > 0 && expiry >= today && expiry <= addMonthsMinusOneDay(today, 4);
              const late = obLeft != null && obLeft > 0 && expiry < today;
              const dated = r.uses.filter((u) => u.date);
              const nConf = dated.filter((u) => confirmed.has(`${r.emp.id}|${u.date}`)).length;
              const retired = r.emp.employment_status === "退職者";
              return (
                <FragmentRow key={r.key} open={open === r.key}
                  main={
                    <tr className={"border-b cursor-pointer hover:bg-muted/30" + (open === r.key ? " bg-muted/40" : "") + (retired ? " opacity-60" : "")}
                      onClick={() => setOpen(open === r.key ? null : r.key)}>
                      <td className="px-2 py-1.5 font-mono">{r.emp.employee_number}</td>
                      <td className="px-2 py-1.5 font-medium">{r.emp.name}{retired && <span className="ml-1 text-[10px] text-muted-foreground">退職</span>}</td>
                      <td className="px-2 py-1.5">{r.emp.salary_type ?? "—"}</td>
                      <td className="px-2 py-1.5 border-l font-mono">{r.grant.grant_date}</td>
                      <td className="px-2 py-1.5 font-mono">{expiry}</td>
                      <td className="px-2 py-1.5 text-right">{ob == null ? <span className="text-muted-foreground/60" title="付与日数が入っていないので判定できない">?</span> : ob}</td>
                      <td className={"px-2 py-1.5 text-right font-semibold" + (late ? " text-red-600" : soon ? " text-amber-700" : "")}
                        title={late ? "消化期限を過ぎても 5 日取れていません" : soon ? "消化期限まで 4 か月を切っています" : ""}>
                        {obLeft == null ? "" : fmtDays(obLeft)}
                      </td>
                      <td className="px-2 py-1.5 text-right border-l">{gd == null ? <span className="text-muted-foreground/60" title="今年度の付与日数が入っていません">?</span> : fmtDays(carry + gd)}</td>
                      <td className="px-2 py-1.5 text-right">{fmtDays(r.used)}</td>
                      <td className={"px-2 py-1.5 text-right font-semibold" + (a.over > 0 ? " text-red-600" : "")} title={a.over > 0 ? `持っている日数を ${fmtDays(a.over)} 日超えています` : ""}>
                        {gd == null ? "?" : fmtDays(a.remaining)}
                      </td>
                      <td className="px-2 py-1.5 text-right border-l">{fmtDays(a.carryLeft)}<span className="text-muted-foreground">/{fmtDays(carry)}</span></td>
                      <td className="px-2 py-1.5 text-right">{yen(r.grant.prev_rate)}</td>
                      <td className="px-2 py-1.5 text-right border-l">{gd == null ? "?" : fmtDays(gd)}</td>
                      <td className="px-2 py-1.5 text-right">{gd == null ? "?" : fmtDays(a.grantLeft)}</td>
                      <td className="px-2 py-1.5 text-right">{yen(r.grant.cur_rate)}</td>
                      {months.map((m, i) => {
                        const mu = r.months.get(m);
                        return (
                          <td key={m} className={"px-1.5 py-1.5 text-right tabular-nums" + (i === 0 ? " border-l" : "") + (!mu ? " bg-muted/30" : "")}
                            title={!mu ? "この付与の 1 年の外" : mu.source ? `${mu.source}から` : ""}>
                            {mu && mu.days > 0 ? <span className={mu.source === "管理簿" ? "text-violet-800" : ""}>{fmtDays(mu.days)}</span> : ""}
                          </td>
                        );
                      })}
                      <td className={"px-2 py-1.5 text-center border-l" + (dated.length > 0 && nConf < dated.length ? " text-amber-700" : "")}>
                        {dated.length === 0 ? "—" : `${nConf}/${dated.length}`}
                      </td>
                    </tr>
                  }
                  detail={
                    <tr className="border-b bg-muted/10">
                      <td colSpan={28} className="px-4 py-3">
                        <PersonLedger row={r} confirmed={confirmed} canConfirm={!confirmError}
                          onToggle={(date, on) => void toggleConfirm(r.emp.id, date, on)} />
                      </td>
                    </tr>
                  }
                />
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        月の数字: 黒 = 事業所書式 (ファイル取込・画面の入力) / <span className="text-violet-800">紫 = 有給管理簿</span>。灰色の月 = その付与の 1 年の外。
        「?」= 付与日数が入っていない (年度の途中で付与された人など)。年 5 日の「残り」は 赤 = 消化期限を過ぎた / 黄 = 期限まで 4 か月以内。
      </p>
    </div>
  );
}

function FragmentRow({ main, detail, open }: { main: React.ReactNode; detail: React.ReactNode; open: boolean }) {
  return <>{main}{open && detail}</>;
}

/** 個人台帳: 使った日ごとの日数・残り と 確認欄 (Box の個人シートの 使用年月日・使用日数・残日数・確認欄) */
function PersonLedger({ row, confirmed, canConfirm, onToggle }: {
  row: Row; confirmed: Map<string, { by: string | null; at: string }>; canConfirm: boolean;
  onToggle: (date: string, on: boolean) => void;
}) {
  const carry = Number(row.grant.carry_days ?? 0), gd = row.grant.grant_days;
  const total = carry + Number(gd ?? 0);
  // 管理簿の月は 日付が無いので 月の合計を 1 行で出す
  const lines: { label: string; days: number; date: string | null; source: string }[] = [];
  const ledgerMonths = [...row.months].filter(([, v]) => v.source === "管理簿" && v.days > 0);
  for (const [m, v] of ledgerMonths) lines.push({ label: `${m.slice(0, 4)}年${Number(m.slice(4))}月 (日付なし)`, days: v.days, date: null, source: "有給管理簿" });
  for (const u of row.uses) lines.push({ label: u.date ? u.date.replace(/-/g, "/") : `${u.month.slice(0, 4)}年${Number(u.month.slice(4))}月 (日付なし)`, days: u.days, date: u.date, source: u.source === "画面" ? "事業所書式入力 (画面)" : "事業所書式 (ファイル)" });
  lines.sort((a, b) => a.label.localeCompare(b.label));
  let rest = total;
  return (
    <div className="max-w-3xl">
      <p className="mb-2 text-xs text-muted-foreground">
        <b className="text-foreground">{row.emp.name}</b> の台帳 — 付与日 {row.grant.grant_date} / 前年度繰越 {fmtDays(carry)} 日 + 今年度付与 {gd == null ? "?" : fmtDays(gd)} 日
        {row.grant.source && <span className="ml-2">(付与の出どころ: {row.grant.source})</span>}
      </p>
      {lines.length === 0 ? <p className="text-sm text-muted-foreground">この付与の 1 年に 使った日はありません。</p> : (
        <table className="text-xs">
          <thead>
            <tr className="border-b text-muted-foreground">
              <th className="px-2 py-1 text-left">使用年月日</th>
              <th className="px-2 py-1 text-right">使用日数</th>
              <th className="px-2 py-1 text-right">残日数</th>
              <th className="px-2 py-1 text-left">出どころ</th>
              <th className="px-2 py-1 text-left">管理者・所属長 確認</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              rest -= l.days;
              const c = l.date ? confirmed.get(`${row.emp.id}|${l.date}`) : undefined;
              return (
                <tr key={i} className="border-b last:border-0">
                  <td className="px-2 py-1 font-mono">{l.label}</td>
                  <td className="px-2 py-1 text-right">{fmtDays(l.days)}</td>
                  <td className={"px-2 py-1 text-right" + (gd != null && rest < 0 ? " text-red-600 font-semibold" : "")}>{gd == null ? "?" : fmtDays(rest)}</td>
                  <td className="px-2 py-1 text-muted-foreground">{l.source}</td>
                  <td className="px-2 py-1">
                    {l.date ? (
                      <label className="inline-flex items-center gap-1.5">
                        <input type="checkbox" className="h-4 w-4" disabled={!canConfirm} checked={!!c} onChange={(e) => onToggle(l.date!, e.target.checked)} />
                        {c ? <span className="text-muted-foreground">確認済 {c.at.slice(0, 10)}{c.by ? ` ${c.by.split("@")[0]}` : ""}</span> : <span className="text-amber-700">未確認</span>}
                      </label>
                    ) : <span className="text-muted-foreground/60" title="日付が無いので 日ごとの確認ができません">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
