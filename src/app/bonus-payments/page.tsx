"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { OFFICE_MASTER_JOIN, flattenOfficeMaster } from "@/types/database";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BONUS_PAID_KEY } from "@/lib/payroll/monthly-inputs";

/**
 * /bonus-payments 報奨金の支給 (2026-09-22 user)
 *
 * 報奨金の金額は 職員ごとに 給与設定の「報奨金」(bonus_amount) に持つ (変更しない限り続く)。
 * この画面では その月に 支給する / しない だけを決める。保存先 payroll_monthly_inputs (item_key = bonus_paid, 1 = 支給)。
 * 給与計算は計算のたびにここを読む (給与計算の画面では変えられない)。
 * 並べるのは 報奨金の金額が設定されている月給者だけ (= 2026-03〜08 に総括表で報奨金が出ていた人、user 2026-09-22)。
 */

type OfficeRow = { id: string; office_number: string; name: string; office_type: string };
type EmpRow = { id: string; employee_number: string; name: string; salary_type: string; role_type: string; employment_status: string };
type SettingRow = { employee_id: string; effective_from: string; bonus_amount: number | null };

function monthOptions(): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = -1; i < 12; i++) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

const yen = (n: number) => `${n.toLocaleString()}円`;

export default function BonusPaymentsPage() {
  const [offices, setOffices] = useState<OfficeRow[]>([]);
  const [officeId, setOfficeId] = useState("");
  const [month, setMonth] = useState(monthOptions()[1]);
  const [rows, setRows] = useState<{ emp: EmpRow; amount: number }[]>([]);
  const [paid, setPaid] = useState<Set<string>>(new Set());
  const [savedPaid, setSavedPaid] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from("payroll_offices").select(`id,office_number,office_type, ${OFFICE_MASTER_JOIN}`);
      if (error) { toast.error(`事業所の取得に失敗: ${error.message}`); return; }
      const list = (flattenOfficeMaster(data as never) as unknown as OfficeRow[])
        .filter((o) => o.office_type === "訪問介護")
        .sort((a, b) => a.name.localeCompare(b.name, "ja"));
      setOffices(list);
      setOfficeId((prev) => prev || list[0]?.id || "");
    })();
  }, []);

  const office = useMemo(() => offices.find((o) => o.id === officeId), [offices, officeId]);

  useEffect(() => {
    if (!office) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const monthStart = `${month.slice(0, 4)}-${month.slice(4, 6)}-01`;
      const [empRes, flagRes] = await Promise.all([
        supabase.from("payroll_employees").select("id,employee_number,name,salary_type,role_type,employment_status").eq("office_id", office.id),
        supabase.from("payroll_monthly_inputs").select("employee_number,numeric_value")
          .eq("office_number", office.office_number).eq("processing_month", month).eq("item_key", BONUS_PAID_KEY),
      ]);
      if (cancelled) return;
      if (empRes.error) { toast.error(`職員の取得に失敗: ${empRes.error.message}`); setLoading(false); return; }
      if (flagRes.error) { toast.error(`支給の記録の取得に失敗: ${flagRes.error.message}`); setLoading(false); return; }
      const emps = (empRes.data ?? []) as EmpRow[];
      const ids = emps.map((e) => e.id);
      const settings: SettingRow[] = [];
      for (let i = 0; i < ids.length; i += 150) {
        const { data, error } = await supabase.from("payroll_salary_settings").select("employee_id,effective_from,bonus_amount")
          .in("employee_id", ids.slice(i, i + 150)).lte("effective_from", monthStart);
        if (error) { toast.error(`給与設定の取得に失敗: ${error.message}`); setLoading(false); return; }
        settings.push(...((data ?? []) as SettingRow[]));
      }
      if (cancelled) return;
      // その月に有効な給与設定 (適用開始が月初以前の最新の行) の 報奨金額
      const amountOf = new Map<string, number>();
      const latestFrom = new Map<string, string>();
      for (const s of settings) {
        if ((latestFrom.get(s.employee_id) ?? "") <= s.effective_from) {
          latestFrom.set(s.employee_id, s.effective_from);
          amountOf.set(s.employee_id, Number(s.bonus_amount ?? 0));
        }
      }
      const flagged = new Set(((flagRes.data ?? []) as { employee_number: string; numeric_value: number | null }[])
        .filter((r) => Number(r.numeric_value ?? 0) > 0).map((r) => r.employee_number));
      const list = emps
        .map((emp) => ({ emp, amount: amountOf.get(emp.id) ?? 0 }))
        // 報奨金の金額がある人だけ。支給済みの記録がある人は 金額が 0 になっていても出す (外し忘れに気づけるように)
        .filter(({ emp, amount }) => amount > 0 || flagged.has(emp.employee_number))
        .sort((a, b) => a.emp.name.localeCompare(b.emp.name, "ja"));
      setRows(list);
      setPaid(new Set(flagged));
      setSavedPaid(new Set(flagged));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [office, month]);

  const dirty = rows.filter(({ emp }) => paid.has(emp.employee_number) !== savedPaid.has(emp.employee_number));
  const total = rows.filter(({ emp }) => paid.has(emp.employee_number)).reduce((s, r) => s + r.amount, 0);

  const save = async () => {
    if (!office || dirty.length === 0) return;
    setSaving(true);
    const on = dirty.filter(({ emp }) => paid.has(emp.employee_number));
    const off = dirty.filter(({ emp }) => !paid.has(emp.employee_number));
    if (on.length > 0) {
      const { error } = await supabase.from("payroll_monthly_inputs").upsert(
        on.map(({ emp }) => ({ office_number: office.office_number, employee_number: emp.employee_number, processing_month: month,
          item_key: BONUS_PAID_KEY, numeric_value: 1, updated_at: new Date().toISOString() })),
        { onConflict: "office_number,employee_number,processing_month,item_key" });
      if (error) { toast.error(`保存に失敗: ${error.message}`); setSaving(false); return; }
    }
    for (const { emp } of off) {
      const { error } = await supabase.from("payroll_monthly_inputs").delete()
        .eq("office_number", office.office_number).eq("employee_number", emp.employee_number)
        .eq("processing_month", month).eq("item_key", BONUS_PAID_KEY);
      if (error) { toast.error(`保存に失敗 (${emp.name}): ${error.message}`); setSaving(false); return; }
    }
    setSavedPaid(new Set(paid));
    setSaving(false);
    toast.success(`保存しました (${dirty.length} 件)。給与計算をやり直すと反映されます`);
  };

  const toggle = (num: string, v: boolean) => setPaid((p) => { const n = new Set(p); if (v) n.add(num); else n.delete(num); return n; });

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-2xl font-bold mb-1">報奨金の支給</h1>
      <p className="text-sm text-muted-foreground mb-4">
        その月に報奨金を支給するかを決めます。金額は職員ごとの <Link href="/salary" className="underline">給与設定</Link> の「報奨金」で、変えない限り同じ額が続きます。
        給与計算をやり直すと反映されます。
      </p>
      <Card className="mb-4">
        <CardContent className="pt-4 flex flex-wrap gap-4 items-end">
          <label className="text-sm">事業所
            <select className="block h-9 rounded-md border bg-background px-2 text-sm mt-1" value={officeId} onChange={(e) => setOfficeId(e.target.value)}>
              {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <label className="text-sm">処理月
            <select className="block h-9 rounded-md border bg-background px-2 text-sm mt-1" value={month} onChange={(e) => setMonth(e.target.value)}>
              {monthOptions().map((m) => <option key={m} value={m}>{m.slice(0, 4)}年{Number(m.slice(4))}月</option>)}
            </select>
          </label>
          <Button onClick={save} disabled={saving || dirty.length === 0}>
            {saving ? "保存中…" : `保存${dirty.length ? ` (${dirty.length})` : ""}`}
          </Button>
          <p className="text-sm ml-auto">支給する {rows.filter(({ emp }) => paid.has(emp.employee_number)).length} 名 / 合計 <span className="font-medium">{yen(total)}</span></p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-3 py-2 w-24">職員番号</th>
                <th className="text-left px-3 py-2">氏名</th>
                <th className="text-left px-3 py-2 w-28">役職・在籍</th>
                <th className="text-right px-3 py-2 w-32">報奨金</th>
                <th className="text-center px-3 py-2 w-28">この月に支給</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ emp, amount }) => {
                const isDirty = paid.has(emp.employee_number) !== savedPaid.has(emp.employee_number);
                return (
                  <tr key={emp.id} className={`border-t ${isDirty ? "bg-amber-50" : ""}`}>
                    <td className="px-3 py-1.5">{emp.employee_number}</td>
                    <td className="px-3 py-1.5 truncate">{emp.name}</td>
                    <td className="px-3 py-1.5 text-muted-foreground truncate">{emp.role_type} / {emp.employment_status}</td>
                    <td className="px-3 py-1.5 text-right">{amount > 0 ? yen(amount) : <span className="text-red-600">金額が未設定</span>}</td>
                    <td className="px-3 py-1.5 text-center">
                      <input type="checkbox" className="h-4 w-4" checked={paid.has(emp.employee_number)}
                        onChange={(e) => toggle(emp.employee_number, e.target.checked)} aria-label={`${emp.name} に支給`} />
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                  {loading ? "読み込み中…" : "報奨金が設定されている職員はいません"}
                </td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
