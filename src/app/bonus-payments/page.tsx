"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { OFFICE_MASTER_JOIN, flattenOfficeMaster } from "@/types/database";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BONUS_PAID_KEY } from "@/lib/payroll/monthly-inputs";

/**
 * /bonus-payments 報奨金の支給 (2026-09-22 user)
 *
 * 報奨金の金額は 職員ごとに 給与設定の「報奨金」(bonus_amount) に持つ (変更しない限り続く)。
 * この画面では その月に 支給する / しない を決める。保存先 payroll_monthly_inputs (item_key = bonus_paid, 1 = 支給)。
 * 給与計算は計算のたびにここを読む (給与計算の画面では変えられない)。
 * 並べるのは 報奨金の金額が設定されている月給者だけ (= 2026-03〜08 に総括表で報奨金が出ていた人、user 2026-09-22)。
 * 事業所ごとではなく 訪問介護の全事業所を 1 つの一覧で出す (user 2026-09-22)。
 * 支給の記録のキーは 事業所番号 + 職員番号 (職員番号は事業所をまたぐと重複する)。
 *
 * ★ 金額もこの画面から変えられる (user 2026-09-26)。ただし bonus_amount は
 *   payroll_salary_settings の列で **effective_from で履歴化されている**ので、
 *   ★ 上書きせず「対象月の 1 日から有効な行」を足す (/salary と同じ方式)。
 *   ⚠ 新しい行を作るときは **元の行の全項目をコピー**してから報奨金だけ差し替える。
 *     コピーを怠ると 基本給などが 0 の行ができて その月以降の給与が壊れる。
 *   ⚠ 対象月に有効な行が無い職員は 金額を変えられない (土台が無いので部分的な行を作らない)。
 *   ⚠ 新しく報奨金を付ける人 (今まで 0 円で一覧に出てこない人) はこの画面では足せない。
 *     先に /salary で設定する。
 */

type OfficeRow = { id: string; office_number: string; name: string; office_type: string };
type EmpRow = { id: string; employee_number: string; name: string; salary_type: string; role_type: string; employment_status: string; office_id: string };
type SettingRow = { employee_id: string; effective_from: string; bonus_amount: number | null };
type Row = { emp: EmpRow; office: OfficeRow; amount: number; key: string };

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
  const [month, setMonth] = useState(monthOptions()[1]);
  const [rows, setRows] = useState<Row[]>([]);
  const [paid, setPaid] = useState<Set<string>>(new Set());
  const [savedPaid, setSavedPaid] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // 報奨金の金額 (employee_id → 文字列)。履歴行を足す形で保存する
  const [amounts, setAmounts] = useState<Map<string, string>>(new Map());
  const [savedAmounts, setSavedAmounts] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from("payroll_offices").select(`id,office_number,office_type, ${OFFICE_MASTER_JOIN}`);
      if (error) { toast.error(`事業所の取得に失敗: ${error.message}`); return; }
      const list = (flattenOfficeMaster(data as never) as unknown as OfficeRow[])
        .filter((o) => o.office_type === "訪問介護")
        .sort((a, b) => a.name.localeCompare(b.name, "ja"));
      setOffices(list);
    })();
  }, []);

  const officeById = useMemo(() => new Map(offices.map((o) => [o.id, o])), [offices]);

  useEffect(() => {
    if (offices.length === 0) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const monthStart = `${month.slice(0, 4)}-${month.slice(4, 6)}-01`;
      const [empRes, flagRes] = await Promise.all([
        supabase.from("payroll_employees").select("id,employee_number,name,salary_type,role_type,employment_status,office_id")
          .in("office_id", offices.map((o) => o.id)).order("id").range(0, 4999),
        supabase.from("payroll_monthly_inputs").select("office_number,employee_number,numeric_value")
          .in("office_number", offices.map((o) => o.office_number)).eq("processing_month", month).eq("item_key", BONUS_PAID_KEY),
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
      const flagged = new Set(((flagRes.data ?? []) as { office_number: string; employee_number: string; numeric_value: number | null }[])
        .filter((r) => Number(r.numeric_value ?? 0) > 0).map((r) => `${r.office_number}|${r.employee_number}`));
      const list: Row[] = emps
        .filter((emp) => officeById.has(emp.office_id))
        .map((emp) => {
          const office = officeById.get(emp.office_id)!;
          return { emp, office, amount: amountOf.get(emp.id) ?? 0, key: `${office.office_number}|${emp.employee_number}` };
        })
        // 報奨金の金額がある人だけ。支給済みの記録がある人は 金額が 0 になっていても出す (外し忘れに気づけるように)
        .filter(({ amount, key }) => amount > 0 || flagged.has(key))
        .sort((a, b) => a.office.name.localeCompare(b.office.name, "ja") || a.emp.name.localeCompare(b.emp.name, "ja"));
      setRows(list);
      setPaid(new Set(flagged));
      setSavedPaid(new Set(flagged));
      const amt = new Map(list.map(({ emp, amount }) => [emp.id, String(amount)]));
      setAmounts(new Map(amt));
      setSavedAmounts(new Map(amt));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [offices, officeById, month]);

  const dirty = rows.filter(({ key }) => paid.has(key) !== savedPaid.has(key));
  // 金額を変えた人 (= 給与設定に履歴行を足す対象)
  const amountDirty = rows.filter(({ emp }) => (amounts.get(emp.id) ?? "") !== (savedAmounts.get(emp.id) ?? ""));
  const amountOfRow = (id: string, fallback: number) => {
    const raw = amounts.get(id);
    if (raw === undefined || raw === "") return fallback;
    const v = Number(raw);
    return Number.isFinite(v) ? v : fallback;
  };
  const paidRows = rows.filter(({ key }) => paid.has(key));
  const total = paidRows.reduce((s, r) => s + amountOfRow(r.emp.id, r.amount), 0);

  const save = async () => {
    if (dirty.length === 0 && amountDirty.length === 0) return;
    const monthStart = `${month.slice(0, 4)}-${month.slice(4, 6)}-01`;

    if (amountDirty.length > 0) {
      // ★ 給与設定に行を足す = お金に直結するので、何が起きるかを見せてから書く
      const lines = amountDirty
        .map(({ emp, amount }) => `  ${emp.name}: ${yen(amount)} → ${yen(amountOfRow(emp.id, amount))}`)
        .join("\n");
      const ok = window.confirm(
        `報奨金の金額を ${monthStart} から変えます (${amountDirty.length} 件)。\n\n${lines}\n\n` +
        `★ それより前の月は変わりません (その月から有効な行を足すだけです)。\nよろしいですか?`,
      );
      if (!ok) return;
    }
    setSaving(true);

    // ── 金額: payroll_salary_settings に「対象月から有効な行」を足す ──
    for (const { emp, amount } of amountDirty) {
      const next = amountOfRow(emp.id, amount);
      if (!Number.isFinite(next) || next < 0) { toast.error(`${emp.name}: 金額が不正です`); setSaving(false); return; }
      // ⚠ 全項目をコピーしてから報奨金だけ差し替える。部分的な行を作ると 基本給などが 0 になる
      const { data, error } = await supabase.from("payroll_salary_settings").select("*")
        .eq("employee_id", emp.id).lte("effective_from", monthStart)
        .order("effective_from", { ascending: false }).limit(1);
      if (error) { toast.error(`給与設定の取得に失敗 (${emp.name}): ${error.message}`); setSaving(false); return; }
      const base = (data ?? [])[0] as Record<string, unknown> | undefined;
      if (!base) {
        // ★ 土台が無い人は触らない。部分的な行を作ると その月以降の給与が壊れる
        toast.error(`${emp.name}: ${monthStart} 時点の給与設定がありません。先に 給与設定 で作ってください`);
        setSaving(false); return;
      }
      const { id: _id, created_at: _c, updated_at: _u, ...rest } = base;
      void _id; void _c; void _u;
      const { error: upErr } = await supabase.from("payroll_salary_settings")
        .upsert({ ...rest, effective_from: monthStart, bonus_amount: next }, { onConflict: "employee_id,effective_from" });
      if (upErr) {
        console.warn(`[bonus-payments] 報奨金の保存に失敗 (emp=${emp.id}, eff=${monthStart}):`, upErr.message);
        toast.error(`報奨金の保存に失敗 (${emp.name}): ${upErr.message}`); setSaving(false); return;
      }
    }

    // ── 支給する / しない ──
    const on = dirty.filter(({ key }) => paid.has(key));
    const off = dirty.filter(({ key }) => !paid.has(key));
    if (on.length > 0) {
      const { error } = await supabase.from("payroll_monthly_inputs").upsert(
        on.map(({ emp, office }) => ({ office_number: office.office_number, employee_number: emp.employee_number, processing_month: month,
          item_key: BONUS_PAID_KEY, numeric_value: 1, updated_at: new Date().toISOString() })),
        { onConflict: "office_number,employee_number,processing_month,item_key" });
      if (error) { toast.error(`保存に失敗: ${error.message}`); setSaving(false); return; }
    }
    for (const { emp, office } of off) {
      const { error } = await supabase.from("payroll_monthly_inputs").delete()
        .eq("office_number", office.office_number).eq("employee_number", emp.employee_number)
        .eq("processing_month", month).eq("item_key", BONUS_PAID_KEY);
      if (error) { toast.error(`保存に失敗 (${emp.name}): ${error.message}`); setSaving(false); return; }
    }
    setSavedPaid(new Set(paid));
    setSavedAmounts(new Map(amounts));
    setRows((prev) => prev.map((r) => ({ ...r, amount: amountOfRow(r.emp.id, r.amount) })));
    setSaving(false);
    toast.success(`保存しました (支給 ${dirty.length} 件 / 金額 ${amountDirty.length} 件)。給与計算をやり直すと反映されます`);
  };

  const toggle = (key: string, v: boolean) => setPaid((p) => { const n = new Set(p); if (v) n.add(key); else n.delete(key); return n; });

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-2xl font-bold mb-1">報奨金の支給</h1>
      <p className="text-sm text-muted-foreground mb-4">
        訪問介護の全事業所の、報奨金が設定されている職員です。その月に支給するかを決めます。
        金額は職員ごとの <Link href="/salary" className="underline">給与設定</Link> の「報奨金」で、変えない限り同じ額が続きます。
        <strong className="text-foreground">金額はこの画面でも直せます</strong>。直すと
        <strong className="text-foreground">選んだ処理月の 1 日から有効な行</strong>が足され、
        <strong className="text-foreground">それより前の月は変わりません</strong>。
        給与計算をやり直すと反映されます。
      </p>
      <Card className="mb-4">
        <CardContent className="pt-4 flex flex-wrap gap-4 items-end">
          <label className="text-sm">処理月
            <select className="block h-9 rounded-md border bg-background px-2 text-sm mt-1" value={month} onChange={(e) => setMonth(e.target.value)}>
              {monthOptions().map((m) => <option key={m} value={m}>{m.slice(0, 4)}年{Number(m.slice(4))}月</option>)}
            </select>
          </label>
          <Button onClick={save} disabled={saving || (dirty.length === 0 && amountDirty.length === 0)}>
            {saving ? "保存中…" : `保存${dirty.length + amountDirty.length ? ` (${dirty.length + amountDirty.length})` : ""}`}
          </Button>
          {amountDirty.length > 0 && (
            <p className="text-xs text-amber-700">
              ★ 金額を {amountDirty.length} 件 変えています。保存すると {month.slice(0, 4)}年{Number(month.slice(4))}月から有効な給与設定の行が足されます
            </p>
          )}
          <p className="text-sm ml-auto">支給する {paidRows.length} / {rows.length} 名 / 合計 <span className="font-medium">{yen(total)}</span></p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-3 py-2">事業所</th>
                <th className="text-left px-3 py-2 w-24">職員番号</th>
                <th className="text-left px-3 py-2">氏名</th>
                <th className="text-left px-3 py-2 w-28">役職・在籍</th>
                <th className="text-right px-3 py-2 w-36" title="この月の 1 日から有効な金額。直すと履歴の行が足され、前の月は変わりません">報奨金</th>
                <th className="text-center px-3 py-2 w-28">この月に支給</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ emp, office, amount, key }) => {
                const amtDirty = (amounts.get(emp.id) ?? "") !== (savedAmounts.get(emp.id) ?? "");
                return (
                  <tr key={emp.id} className={`border-t ${paid.has(key) !== savedPaid.has(key) || amtDirty ? "bg-amber-50" : ""}`}>
                    <td className="px-3 py-1.5 truncate max-w-56">{office.name}</td>
                    <td className="px-3 py-1.5">{emp.employee_number}</td>
                    <td className="px-3 py-1.5 truncate">{emp.name}</td>
                    <td className="px-3 py-1.5 text-muted-foreground truncate">{emp.role_type} / {emp.employment_status}</td>
                    <td className="px-3 py-1.5 text-right">
                      <div className="relative inline-block">
                        <Input
                          type="number" min={0} step={1000}
                          className={`w-28 pr-6 text-right ${amtDirty ? "border-amber-500" : ""}`}
                          value={amounts.get(emp.id) ?? ""}
                          aria-label={`${emp.name} の報奨金`}
                          onChange={(e) => setAmounts((m) => { const n = new Map(m); n.set(emp.id, e.target.value); return n; })}
                        />
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">円</span>
                      </div>
                      {amountOfRow(emp.id, amount) === 0 && <div className="text-[10px] text-red-600">金額が未設定</div>}
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      <input type="checkbox" className="h-4 w-4" checked={paid.has(key)}
                        onChange={(e) => toggle(key, e.target.checked)} aria-label={`${emp.name} に支給`} />
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
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
