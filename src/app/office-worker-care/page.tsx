"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { OFFICE_MASTER_JOIN, flattenOfficeMaster } from "@/types/database";
import { sortOfficesByDisplayOrder } from "@/lib/office-order";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { getOfficeWorkerCarePay, setOfficeWorkerCarePay, OFFICE_WORKER_CARE_PAY_KEY } from "@/lib/app-settings";
import { currentMonthJst } from "@/lib/payroll/office-price-revision";
import { SettingHistoryButton, useOfficeNames } from "@/components/payroll/setting-history";

/**
 * /office-worker-care 事務員の訪問分 (介護) (2026-09-22 user「事務員については介護分を出すか出さないかのステータス」)
 *
 * 月給の事務員が訪問もしたとき、その訪問を「介護」として払うかを 事務員ごとに決める。
 * 払う人は 訪問を時給者と同じ計算 (同行は割増なし) + 土日祝手当 で出す。保存先 payroll_app_settings office_worker_care_pay。
 * ★ 2026-10-06: 「何月分から」で保存する (履歴 payroll_app_setting_history)。前の月は今までのまま。
 */

type OfficeRow = { id: string; office_number: string; name: string; office_type: string };
type EmpRow = { id: string; employee_number: string; name: string; salary_type: string; role_type: string; employment_status: string; is_office_worker: boolean | null };

const norm = (n: string) => String(n).replace(/^0+/, "");

export default function OfficeWorkerCarePage() {
  const [offices, setOffices] = useState<OfficeRow[]>([]);
  const [officeId, setOfficeId] = useState("");
  const [emps, setEmps] = useState<EmpRow[]>([]);
  const [byOffice, setByOffice] = useState<Record<string, string[]>>({});
  const [on, setOn] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  // 何月分から (この月に有効な設定を出し、保存すると この月から効く)
  const [month, setMonth] = useState(currentMonthJst());
  const officeNames = useOfficeNames();

  useEffect(() => {
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    (async () => {
      const [offRes, setRes] = await Promise.all([
        supabase.from("payroll_offices").select(`id,office_number,office_type,sort_order, ${OFFICE_MASTER_JOIN}`),
        getOfficeWorkerCarePay(supabase, `${month}-01`),
      ]);
      if (offRes.error) { toast.error(`事業所の取得に失敗: ${offRes.error.message}`); return; }
      if (setRes.error) { toast.error(`設定の取得に失敗: ${setRes.error}`); return; }
      // 事業所一覧 (/offices) と同じ順 (2026-10-08 user)
      const list = sortOfficesByDisplayOrder(
        (flattenOfficeMaster(offRes.data as never) as unknown as OfficeRow[])
          .filter((o) => o.office_type === "訪問介護"),
      );
      setOffices(list);
      setByOffice(setRes.byOffice);
      setOfficeId((prev) => prev || list[0]?.id || "");
    })();
  }, [month]);

  const office = useMemo(() => offices.find((o) => o.id === officeId), [offices, officeId]);

  useEffect(() => {
    if (!office) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.from("payroll_employees")
        .select("id,employee_number,name,salary_type,role_type,employment_status,is_office_worker")
        .eq("office_id", office.id).neq("employment_status", "退職者");
      if (cancelled) return;
      if (error) { toast.error(`職員の取得に失敗: ${error.message}`); return; }
      const saved = new Set((byOffice[office.office_number] ?? []).map(norm));
      // 月給の事務員。事務員でなくても 既に「払う」になっている人は出す (外し忘れに気づけるように)
      const list = ((data ?? []) as EmpRow[])
        .filter((e) => (e.salary_type === "月給" && (e.role_type === "事務員" || e.is_office_worker)) || saved.has(norm(e.employee_number)))
        .sort((a, b) => a.name.localeCompare(b.name, "ja"));
      setEmps(list);
      setOn(saved);
    })();
    return () => { cancelled = true; };
  }, [office, byOffice]);

  const saved = new Set(office ? (byOffice[office.office_number] ?? []).map(norm) : []);
  const dirty = emps.filter((e) => on.has(norm(e.employee_number)) !== saved.has(norm(e.employee_number))).length;

  const save = async () => {
    if (!office) return;
    setSaving(true);
    const next = { ...byOffice, [office.office_number]: [...on].sort() };
    if (next[office.office_number].length === 0) delete next[office.office_number];
    const ymText = `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`;
    if (!confirm(`${ymText}分の給与から この設定にします。前の月は 今までの設定のまま計算されます。よいですか？`)) { setSaving(false); return; }
    const err = await setOfficeWorkerCarePay(supabase, next, `${month}-01`);
    setSaving(false);
    if (err) { toast.error(`保存に失敗: ${err}`); return; }
    setByOffice(next);
    toast.success("保存しました。給与計算をやり直すと反映されます");
  };

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-2xl font-bold mb-1">事務員の訪問分 (介護)</h1>
      <p className="text-sm text-muted-foreground mb-4">
        月給の事務員が訪問もしたときに、その訪問を「介護」として払うかを決めます。選んだ月の給与から効き、次に変えるまで続きます (前の月は変わりません)。
        払う人は、訪問を時給者と同じ計算 (同行は割増なし) + 土日祝手当 で出します。給与計算をやり直すと反映されます。
      </p>
      <Card className="mb-4">
        <CardContent className="pt-4 flex flex-wrap gap-4 items-end">
          <label className="text-sm">事業所
            <select className="block h-9 rounded-md border bg-background px-2 text-sm mt-1" value={officeId} onChange={(e) => setOfficeId(e.target.value)}>
              {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <label className="text-sm">何月分から
            <input type="month" className="block h-9 rounded-md border bg-background px-2 text-sm mt-1" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          </label>
          <Button onClick={save} disabled={saving || dirty === 0}>{saving ? "保存中…" : `保存${dirty ? ` (${dirty})` : ""}`}</Button>
          <SettingHistoryButton settingKey={OFFICE_WORKER_CARE_PAY_KEY} title="事務員の訪問分を払う" officeNames={officeNames} />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-3 py-2 w-24">職員番号</th>
                <th className="text-left px-3 py-2">氏名</th>
                <th className="text-left px-3 py-2 w-32">給与形態・役職</th>
                <th className="text-center px-3 py-2 w-32">訪問分を払う</th>
              </tr>
            </thead>
            <tbody>
              {emps.map((e) => {
                const k = norm(e.employee_number);
                return (
                  <tr key={e.id} className={`border-t ${on.has(k) !== saved.has(k) ? "bg-amber-50" : ""}`}>
                    <td className="px-3 py-1.5">{e.employee_number}</td>
                    <td className="px-3 py-1.5 truncate">{e.name}</td>
                    <td className="px-3 py-1.5 text-muted-foreground truncate">{e.salary_type} / {e.role_type}</td>
                    <td className="px-3 py-1.5 text-center">
                      <input type="checkbox" className="h-4 w-4" checked={on.has(k)} aria-label={`${e.name} の訪問分を払う`}
                        onChange={(ev) => setOn((p) => { const n = new Set(p); if (ev.target.checked) n.add(k); else n.delete(k); return n; })} />
                    </td>
                  </tr>
                );
              })}
              {emps.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">月給の事務員はいません</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
