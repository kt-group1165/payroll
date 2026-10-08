"use client";

/**
 * 有給の付与の提案 (2026-10-08 user「有給管理画面、任せる」)。
 *
 * Box の 00_<法人>_有給データ.xlsm の式 (lib/payroll/paid-leave-grant-rules.ts) で、
 * 当方の給与計算の結果 (payroll_calc_results) から 付与日数・日当・繰越 を出し、選んだ人だけ 付与として登録する。
 *   4/1 一斉: 前年 4 月〜3 月の 12 か月 / 初回 (入社 + 6 か月): 入社月から 6 か月
 * ★ 提案であって 自動では登録しない。Excel の「手修正の傾向」(途中で支払形態が変わった人・居宅の時給者 など) は
 *   規則にせず 警告に出す。給与計算の結果が無い月は 数えられないので 警告に出す
 */
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { careOvertimePay, yochoAllowance, type MonthlyPayroll } from "@/lib/payroll/payroll-calc";
import { normEmp } from "@/lib/office-input/to-form-records";
import {
  ANNUAL_WORK_DAYS_2026, annualDaysGroupOf, baseGrantDays, calcGrant, carryOverDays, firstGrantDate, grantAmountOf,
  grantKindOf, jobCategoryOfOfficeType, monthWorkDays, type GrantKind,
} from "@/lib/payroll/paid-leave-grant-rules";
import { fmtDays } from "@/lib/payroll/paid-leave-ledger";

type Emp = { id: string; employee_number: string; name: string; hire_date: string | null; salary_type: string | null; employment_status: string | null; resignation_date: string | null };
type Grant = { employee_id: string; grant_date: string; carry_days: number | null; grant_days: number | null; prev_rate: number | null; cur_rate: number | null };
type Proposal = {
  emp: Emp; kind: GrantKind; grantDate: string; months: string[]; monthsWithData: number;
  workDays: number; amount: number; annualDays: number; baseDays: number;
  rate: number | null; grantDays: number; dailyRate: number | null;
  carry: number | null; prevRate: number | null; existing: Grant | null; warnings: string[];
};

const ym = (d: string) => d.slice(0, 7).replace("-", "");
const addMonths = (ymStr: string, n: number) => {
  const v = Number(ymStr.slice(0, 4)) * 12 + Number(ymStr.slice(4)) - 1 + n;
  return `${Math.floor(v / 12)}${String((v % 12) + 1).padStart(2, "0")}`;
};

export function GrantProposalButton({ officeId, officeNumber, officeType, fy, prevUsedByEmp, onSaved }: {
  officeId: string; officeNumber: string; officeType: string; fy: number;
  /** 今の年度の付与 (前年度になる付与) の 消化日数。employee_id|付与日 → 日数 (繰越の見込みに使う) */
  prevUsedByEmp: Map<string, number>;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"april" | "first">("april");
  const [firstMonth, setFirstMonth] = useState(() => {
    const t = new Date(Date.now() + 9 * 3600 * 1000);
    return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
  });
  const [rows, setRows] = useState<Proposal[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [info, setInfo] = useState("");

  const compute = async () => {
    setLoading(true); setRows([]); setSelected(new Set()); setInfo("");
    try {
      const { data: offRow, error: offErr } = await supabase.from("payroll_offices").select("company_id").eq("id", officeId).maybeSingle();
      if (offErr) throw new Error(`事業所の取得に失敗: ${offErr.message}`);
      let companyName = "";
      const companyId = (offRow as { company_id: string | null } | null)?.company_id;
      if (companyId) {
        const { data: co, error } = await supabase.from("payroll_companies").select("master:companies!master_company_id(name)").eq("id", companyId).maybeSingle();
        if (error) throw new Error(`法人の取得に失敗: ${error.message}`);
        companyName = (co as { master: { name: string | null } | null } | null)?.master?.name ?? "";
      }
      const isMutsumi = companyName.normalize("NFKC").includes("ムツミ");
      const annualDays = ANNUAL_WORK_DAYS_2026[annualDaysGroupOf(companyName)][jobCategoryOfOfficeType(officeType)];

      const { data: empData, error: empErr } = await supabase.from("payroll_employees")
        .select("id,employee_number,name,hire_date,salary_type,employment_status,resignation_date").eq("office_id", officeId);
      if (empErr) throw new Error(`職員の取得に失敗: ${empErr.message}`);
      const emps = (empData ?? []) as Emp[];

      // 対象者と 付与日・期間
      type Target = { emp: Emp; grantDate: string; months: string[]; kind: GrantKind };
      const targets: Target[] = [];
      if (mode === "april") {
        const grantDate = `${fy + 1}-04-01`;
        const months = Array.from({ length: 12 }, (_, i) => addMonths(`${fy}04`, i));
        for (const e of emps) {
          if (!e.hire_date || e.hire_date > grantDate) continue;
          if (e.employment_status === "退職者" && (e.resignation_date ?? "") < grantDate) continue;
          const kind = grantKindOf(e.hire_date, grantDate);
          if (kind === "初回") continue; // 前年 10/1 以降の入社は 入社 + 6 か月 で別に付与
          targets.push({ emp: e, grantDate, months, kind });
        }
      } else {
        for (const e of emps) {
          if (!e.hire_date) continue;
          const gd = firstGrantDate(e.hire_date);
          if (gd.slice(0, 7) !== firstMonth) continue;
          if (e.employment_status === "退職者" && (e.resignation_date ?? "") < gd) continue;
          targets.push({ emp: e, grantDate: gd, months: Array.from({ length: 6 }, (_, i) => addMonths(ym(e.hire_date!), i)), kind: "初回" });
        }
      }
      if (targets.length === 0) { setInfo("対象の職員がいません"); return; }

      // 給与計算の結果 (月ごとに最新)
      const allMonths = [...new Set(targets.flatMap((t) => t.months))].sort();
      const byMonth = new Map<string, { calculated_at: string; hourly?: Record<string, unknown>[]; monthly?: Record<string, unknown>[] }>();
      for (let i = 0; i < allMonths.length; i += 6) {
        const { data, error } = await supabase.from("payroll_calc_results").select("processing_month,payload")
          .eq("office_number", officeNumber).in("processing_month", allMonths.slice(i, i + 6));
        if (error) throw new Error(`給与計算の結果の取得に失敗: ${error.message}`);
        for (const r of (data ?? []) as { processing_month: string; payload: { calculated_at: string; hourly?: Record<string, unknown>[]; monthly?: Record<string, unknown>[] } }[]) {
          const cur = byMonth.get(r.processing_month);
          if (!cur || r.payload.calculated_at > cur.calculated_at) byMonth.set(r.processing_month, r.payload);
        }
      }
      const inputOf = (num: string, m: string): { days: number; amount: number | null; type: "月給" | "時給" } | null => {
        const p = byMonth.get(m);
        if (!p) return null;
        const h = (p.hourly ?? []).find((x) => normEmp(String(x.employee_number)) === num);
        if (h) return { days: monthWorkDays((h.summary ?? {}) as never), amount: grantAmountOf("時給", h as never, 0, 0, officeType, isMutsumi), type: "時給" };
        const mo = (p.monthly ?? []).find((x) => normEmp(String(x.employee_number)) === num);
        if (mo) {
          const mp = mo as unknown as MonthlyPayroll;
          const adj = careOvertimePay(mp) + Number(mo.office_worker_care_pay ?? 0) + yochoAllowance(mp) + Number(mo.tokubi_allowance ?? 0);
          const fixed = Number((mo.settings as { fixed_overtime_pay?: number } | undefined)?.fixed_overtime_pay ?? 0);
          return { days: monthWorkDays((mo.summary ?? {}) as never), amount: grantAmountOf("月給", mo as never, adj, fixed, officeType, isMutsumi), type: "月給" };
        }
        return { days: 0, amount: null, type: "時給" }; // 計算はあるが その人が居ない月 = 稼働 0
      };

      // 付与
      const grants: Grant[] = [];
      for (let i = 0; i < targets.length; i += 150) {
        const { data, error } = await supabase.from("payroll_paid_leave_grants")
          .select("employee_id,grant_date,carry_days,grant_days,prev_rate,cur_rate").in("employee_id", targets.slice(i, i + 150).map((t) => t.emp.id));
        if (error) throw new Error(`付与の取得に失敗: ${error.message}`);
        grants.push(...((data ?? []) as Grant[]));
      }

      const out: Proposal[] = [];
      for (const t of targets) {
        const num = normEmp(t.emp.employee_number);
        const warnings: string[] = [];
        let workDays = 0, amount = 0, monthsWithData = 0;
        const types = new Set<string>();
        for (const m of t.months) {
          const v = inputOf(num, m);
          if (!v) continue;
          monthsWithData++;
          workDays += v.days;
          amount += v.amount ?? 0;
          if (v.days > 0) types.add(v.type);
        }
        const missing = t.months.length - monthsWithData;
        if (missing > 0) warnings.push(`給与計算の結果が無い月 ${missing} か月 (数えていない)`);
        const salaryType: "月給" | "時給" = t.emp.salary_type === "月給" ? "月給" : "時給";
        if (types.size > 1) warnings.push("期間の途中で 時給 ↔ 月給 が変わっている (Excel では手で直していることがある)");
        if (officeType === "居宅介護支援") warnings.push("居宅は 金額が空 = 日当 0 (Excel の式どおり。手で入れている人がいる)");
        const baseDays = baseGrantDays(t.emp.hire_date!, t.grantDate);
        const r = calcGrant({ kind: t.kind, salaryType, baseDays, annualDays, workDaysTotal: workDays, monthsWithData, amountTotal: amount });
        if (r.grantDays > 0 && (r.dailyRate ?? 0) === 0) warnings.push("日当が 0 (金額が空の月だけ)");
        // 前年度の付与 (= 付与日より前で最新) から 繰越の見込み
        const prev = grants.filter((g) => g.employee_id === t.emp.id && g.grant_date < t.grantDate).sort((a, b) => b.grant_date.localeCompare(a.grant_date))[0] ?? null;
        let carry: number | null = null;
        if (prev) {
          const used = prevUsedByEmp.get(`${t.emp.id}|${prev.grant_date}`);
          if (used == null || prev.grant_days == null) warnings.push("前年度の付与の 消化日数か付与日数が分からず 繰越を出せない");
          else carry = carryOverDays(Number(prev.grant_days), Number(prev.carry_days ?? 0), used);
        }
        const existing = grants.find((g) => g.employee_id === t.emp.id && g.grant_date === t.grantDate) ?? null;
        out.push({ emp: t.emp, kind: t.kind, grantDate: t.grantDate, months: t.months, monthsWithData, workDays, amount, annualDays, baseDays,
          rate: r.rate, grantDays: r.grantDays, dailyRate: r.dailyRate, carry, prevRate: prev?.cur_rate ?? null, existing, warnings });
      }
      out.sort((a, b) => a.emp.employee_number.localeCompare(b.emp.employee_number, "ja", { numeric: true }));
      setRows(out);
      setSelected(new Set(out.filter((p) => !p.existing && p.grantDays > 0 && p.warnings.length === 0).map((p) => p.emp.id)));
      setInfo(`${companyName || "法人不明"} / ${jobCategoryOfOfficeType(officeType)} / 年間稼働日数 ${annualDays} 日`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "提案の計算に失敗しました");
    } finally {
      setLoading(false);
    }
  };

  const register = async () => {
    const targets = rows.filter((p) => selected.has(p.emp.id));
    if (targets.length === 0) return;
    const overwrite = targets.filter((p) => p.existing).length;
    if (!confirm(`${targets.length} 人の付与を登録します${overwrite ? ` (うち ${overwrite} 人は 同じ付与日の付与を上書き)` : ""}。\n日当・繰越は有給休暇手当に効きます。よいですか？`)) return;
    setSaving(true);
    const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const payload = targets.map((p) => ({
      employee_id: p.emp.id, grant_date: p.grantDate, carry_days: p.carry ?? 0, grant_days: p.grantDays,
      prev_rate: p.prevRate, cur_rate: p.dailyRate, source: `画面の提案 ${today}`,
    }));
    const { error } = await supabase.from("payroll_paid_leave_grants").upsert(payload, { onConflict: "employee_id,grant_date" });
    setSaving(false);
    if (error) { toast.error(`付与の登録に失敗: ${error.message}`); return; }
    toast.success(`${targets.length} 人の付与を登録しました`);
    setOpen(false);
    onSaved();
  };

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>付与の提案</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-7xl w-[97vw] max-h-[92vh] overflow-y-auto">
          <div className="min-w-0">
            <DialogHeader><DialogTitle className="text-base">有給の付与の提案</DialogTitle></DialogHeader>
            <p className="mt-1 text-xs text-muted-foreground">
              Box の有給データと同じ式で、給与計算の結果から 付与日数・日当・繰越を出します。登録するのは チェックした人だけです (警告のある人・もう付与がある人は 最初はチェックしていません)。
              稼働日数 = 出勤日数 + 有給 + 特休 / 日当 = 期間の金額 ÷ 稼働日数 (時給者 = 総支給 − 通勤費 − 出張費、月給者 = 調整手当)。
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="text-xs text-muted-foreground">付与の種類
                <select className="block h-9 mt-0.5 rounded-md border bg-background px-2 text-sm" value={mode} onChange={(e) => setMode(e.target.value as "april" | "first")}>
                  <option value="april">{fy + 1}年4月1日の一斉付与 ({fy}年4月〜{fy + 1}年3月で計算)</option>
                  <option value="first">初回 (入社 + 6 か月) の付与</option>
                </select>
              </label>
              {mode === "first" && (
                <label className="text-xs text-muted-foreground">付与する月
                  <input type="month" className="block h-9 mt-0.5 rounded-md border bg-background px-2 text-sm" value={firstMonth} onChange={(e) => setFirstMonth(e.target.value)} />
                </label>
              )}
              <Button onClick={() => void compute()} disabled={loading}>{loading ? "計算中…" : "提案を出す"}</Button>
              {info && <span className="text-xs text-muted-foreground">{info}</span>}
              <Button className="ml-auto" onClick={() => void register()} disabled={saving || selected.size === 0}>{saving ? "登録中…" : `チェックした ${selected.size} 人を登録`}</Button>
            </div>

            {rows.length > 0 && (
              <div className="mt-3 overflow-x-auto rounded-md border">
                <table className="w-full whitespace-nowrap text-xs">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="px-2 py-1.5" />
                      <th className="px-2 py-1.5 text-left">社員番号</th>
                      <th className="px-2 py-1.5 text-left">氏名</th>
                      <th className="px-2 py-1.5 text-left">形態</th>
                      <th className="px-2 py-1.5 text-left">入社日</th>
                      <th className="px-2 py-1.5 text-left">種類</th>
                      <th className="px-2 py-1.5 text-left">付与日</th>
                      <th className="px-2 py-1.5 text-right" title="給与計算の結果がある月 / 期間の月">月</th>
                      <th className="px-2 py-1.5 text-right">稼働日数</th>
                      <th className="px-2 py-1.5 text-right">稼働率</th>
                      <th className="px-2 py-1.5 text-right">基準</th>
                      <th className="px-2 py-1.5 text-right font-semibold">付与日数</th>
                      <th className="px-2 py-1.5 text-right">金額の合計</th>
                      <th className="px-2 py-1.5 text-right font-semibold">日当</th>
                      <th className="px-2 py-1.5 text-right" title="前年度の付与から: MIN(前年度付与, 前年度繰越 + 前年度付与 − 消化)">繰越 (見込み)</th>
                      <th className="px-2 py-1.5 text-left">今ある付与</th>
                      <th className="px-2 py-1.5 text-left">警告</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => (
                      <tr key={p.emp.id} className={"border-b" + (p.warnings.length ? " bg-amber-50/60 dark:bg-amber-900/10" : "")}>
                        <td className="px-2 py-1"><input type="checkbox" className="h-4 w-4" checked={selected.has(p.emp.id)} onChange={() => toggle(p.emp.id)} /></td>
                        <td className="px-2 py-1 font-mono">{p.emp.employee_number}</td>
                        <td className="px-2 py-1">{p.emp.name}</td>
                        <td className="px-2 py-1">{p.emp.salary_type ?? "—"}</td>
                        <td className="px-2 py-1 font-mono">{p.emp.hire_date}</td>
                        <td className="px-2 py-1">{p.kind}</td>
                        <td className="px-2 py-1 font-mono">{p.grantDate}</td>
                        <td className="px-2 py-1 text-right">{p.monthsWithData}/{p.months.length}</td>
                        <td className="px-2 py-1 text-right">{fmtDays(p.workDays)}<span className="text-muted-foreground"> /{p.annualDays}</span></td>
                        <td className="px-2 py-1 text-right">{p.rate == null ? "—" : p.rate.toFixed(3)}</td>
                        <td className="px-2 py-1 text-right">{p.baseDays}</td>
                        <td className="px-2 py-1 text-right font-semibold">{p.grantDays}</td>
                        <td className="px-2 py-1 text-right">{p.amount.toLocaleString()}</td>
                        <td className="px-2 py-1 text-right font-semibold">{p.dailyRate == null ? "—" : `${p.dailyRate.toLocaleString()}円`}</td>
                        <td className="px-2 py-1 text-right">{p.carry == null ? "—" : fmtDays(p.carry)}</td>
                        <td className="px-2 py-1">{p.existing ? <span className={p.existing.grant_days !== p.grantDays || p.existing.cur_rate !== p.dailyRate ? "text-red-600" : "text-green-700"}>{p.existing.grant_days ?? "?"}日 / {p.existing.cur_rate?.toLocaleString() ?? "—"}円</span> : <span className="text-muted-foreground">なし</span>}</td>
                        <td className="px-2 py-1 text-amber-800">{p.warnings.join(" / ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
