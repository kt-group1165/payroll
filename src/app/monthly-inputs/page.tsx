"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { OFFICE_MASTER_JOIN, flattenOfficeMaster } from "@/types/database";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MONTHLY_INPUT_ITEMS } from "@/lib/payroll/monthly-inputs";

/**
 * /monthly-inputs 月ごとの手入力 (2026-09-18)
 *
 * 総括表で本社が手入力している数字のうち、実績・出勤簿・事業所書式に元が無いものを入れる。
 * 保存先 payroll_monthly_inputs (取込では消さない)。給与計算は計算のたびにここを読む。
 */

type OfficeRow = { id: string; office_number: string; name: string; office_type: string };
type EmpRow = { id: string; employee_number: string; name: string; salary_type: string; role_type: string; employment_status: string };
type InputRow = { employee_number: string; item_key: string; numeric_value: number | null };

function monthOptions(): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = -1; i < 12; i++) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

export default function MonthlyInputsPage() {
  const [offices, setOffices] = useState<OfficeRow[]>([]);
  const [officeId, setOfficeId] = useState("");
  const [month, setMonth] = useState(monthOptions()[1]);
  const [emps, setEmps] = useState<EmpRow[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from("payroll_offices").select(`id,office_number,office_type, ${OFFICE_MASTER_JOIN}`);
      if (error) { toast.error(`事業所の取得に失敗: ${error.message}`); return; }
      const rows = (flattenOfficeMaster(data as never) as unknown as OfficeRow[])
        .filter((o) => o.office_type === "訪問介護")
        .sort((a, b) => a.name.localeCompare(b.name, "ja"));
      setOffices(rows);
      setOfficeId((prev) => prev || rows[0]?.id || "");
    })();
  }, []);

  const office = useMemo(() => offices.find((o) => o.id === officeId), [offices, officeId]);

  useEffect(() => {
    if (!office) return;
    let cancelled = false;
    (async () => {
      const [empRes, inRes] = await Promise.all([
        supabase.from("payroll_employees").select("id,employee_number,name,salary_type,role_type,employment_status")
          .eq("office_id", office.id).neq("employment_status", "退職者"),
        supabase.from("payroll_monthly_inputs").select("employee_number,item_key,numeric_value")
          .eq("office_number", office.office_number).eq("processing_month", month),
      ]);
      if (cancelled) return;
      if (empRes.error) { toast.error(`職員の取得に失敗: ${empRes.error.message}`); return; }
      if (inRes.error) { toast.error(`手入力の取得に失敗: ${inRes.error.message}`); return; }
      const list = ((empRes.data ?? []) as EmpRow[]).sort((a, b) =>
        (a.salary_type === "月給" ? 0 : 1) - (b.salary_type === "月給" ? 0 : 1) || a.name.localeCompare(b.name, "ja"));
      const v: Record<string, string> = {};
      for (const r of (inRes.data ?? []) as InputRow[]) v[`${r.employee_number}|${r.item_key}`] = r.numeric_value == null ? "" : String(r.numeric_value);
      setEmps(list);
      setValues(v);
      setSaved(v);
    })();
    return () => { cancelled = true; };
  }, [office, month]);

  const dirtyKeys = Object.keys({ ...values, ...saved }).filter((k) => (values[k] ?? "") !== (saved[k] ?? ""));

  const save = async () => {
    if (!office || dirtyKeys.length === 0) return;
    setSaving(true);
    const upserts = dirtyKeys.filter((k) => (values[k] ?? "") !== "").map((k) => {
      const [employee_number, item_key] = k.split("|");
      return { office_number: office.office_number, employee_number, processing_month: month, item_key,
        numeric_value: Number(values[k]), updated_at: new Date().toISOString() };
    });
    const deletes = dirtyKeys.filter((k) => (values[k] ?? "") === "");
    if (upserts.some((u) => !Number.isFinite(u.numeric_value) || u.numeric_value < 0)) {
      toast.error("数字 (0 以上) を入れてください");
      setSaving(false);
      return;
    }
    if (upserts.length > 0) {
      const { error } = await supabase.from("payroll_monthly_inputs")
        .upsert(upserts, { onConflict: "office_number,employee_number,processing_month,item_key" });
      if (error) { toast.error(`保存に失敗: ${error.message}`); setSaving(false); return; }
    }
    for (const k of deletes) {
      const [employee_number, item_key] = k.split("|");
      const { error } = await supabase.from("payroll_monthly_inputs").delete()
        .eq("office_number", office.office_number).eq("employee_number", employee_number)
        .eq("processing_month", month).eq("item_key", item_key);
      if (error) { toast.error(`削除に失敗: ${error.message}`); setSaving(false); return; }
    }
    setSaved(values);
    setSaving(false);
    toast.success(`保存しました (${dirtyKeys.length} 件)。給与計算をやり直すと反映されます`);
  };

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-2xl font-bold mb-1">月ごとの手入力</h1>
      <p className="text-sm text-muted-foreground mb-4">
        実績・出勤簿・事業所書式に元が無い数字を、月ごと・職員ごとに入れます。給与計算をやり直しても消えません。
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
          <Button onClick={save} disabled={saving || dirtyKeys.length === 0}>
            {saving ? "保存中…" : `保存${dirtyKeys.length ? ` (${dirtyKeys.length})` : ""}`}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{MONTHLY_INPUT_ITEMS.map((i) => `${i.label}: ${i.help}`).join(" / ")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-3 py-2">職員番号</th>
                <th className="text-left px-3 py-2">氏名</th>
                <th className="text-left px-3 py-2">給与形態・役職</th>
                {MONTHLY_INPUT_ITEMS.map((i) => <th key={i.key} className="text-right px-3 py-2">{i.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {emps.map((e) => (
                <tr key={e.id} className="border-t">
                  <td className="px-3 py-1.5">{e.employee_number}</td>
                  <td className="px-3 py-1.5">{e.name}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{e.salary_type} / {e.role_type}</td>
                  {MONTHLY_INPUT_ITEMS.map((i) => {
                    const k = `${e.employee_number}|${i.key}`;
                    const dirty = (values[k] ?? "") !== (saved[k] ?? "");
                    return (
                      <td key={i.key} className="px-3 py-1.5 text-right">
                        <div className="relative inline-block">
                          <Input
                            type="number" min={0} step={1}
                            className={`w-24 pr-7 text-right ${dirty ? "border-amber-500" : ""}`}
                            value={values[k] ?? ""}
                            onChange={(ev) => setValues((p) => ({ ...p, [k]: ev.target.value }))}
                          />
                          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{i.unit}</span>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {emps.length === 0 && (
                <tr><td colSpan={3 + MONTHLY_INPUT_ITEMS.length} className="px-3 py-6 text-center text-muted-foreground">職員がいません</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
