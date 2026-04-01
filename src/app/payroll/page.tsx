"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// ─── 型定義 ──────────────────────────────────────────────────

type ServiceRecord = {
  id: string;
  employee_number: string;
  employee_name: string;
  service_date: string;
  calc_duration: string;
  service_code: string;
  office_number: string;
};

type ServiceTypeMapping = { service_code: string; category_id: string };
type CategoryHourlyRate  = { category_id: string; office_id: string; hourly_rate: number };
type Office              = { id: string; office_number: string; name: string };
type ServiceCategory     = { id: string; name: string };

type Employee = {
  id: string;
  employee_number: string;
  name: string;
  role_type: string;
  salary_type: string;   // "月給" | "時給"
  employment_status: string;
};

type SalarySettings = {
  employee_id: string;
  base_personal_salary: number;
  skill_salary: number;
  position_allowance: number;
  qualification_allowance: number;
  tenure_allowance: number;
  treatment_improvement: number;
  specific_treatment_improvement: number;
  treatment_subsidy: number;
  fixed_overtime_pay: number;
  special_bonus: number;
  bonus_amount: number;
  travel_unit_price: number;
};

// 時給者：職員ごとの計算結果
type HourlyPayroll = {
  employee_number: string;
  employee_name: string;
  role_type: string;
  records: HourlyDetailRow[];
  totalMinutes: number;
  totalPay: number;
  unmappedCount: number;
};

type HourlyDetailRow = {
  id: string;
  service_date: string;
  minutes: number;
  service_code: string;
  category_name: string;
  hourly_rate: number | null;
  pay: number | null;
};

// 月給者：職員ごとの計算結果（変動入力付き）
type MonthlyPayroll = {
  employee_id: string;
  employee_number: string;
  employee_name: string;
  role_type: string;
  settings: SalarySettings | null;
  // 月次入力（変動）
  bonus_paid: boolean;         // 報奨金 支給/不支給
  travel_km: number;           // 移動距離(km)
  business_trip_fee: number;   // 出張費
};

// ─── ユーティリティ ──────────────────────────────────────────

function parseDurationMinutes(str: string): number {
  if (!str) return 0;
  str = str.trim();
  if (str.includes(":")) {
    const [h, m] = str.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  }
  return parseInt(str, 10) || 0;
}

function formatMinutes(min: number): string {
  if (min === 0) return "0分";
  const h = Math.floor(min / 60), m = min % 60;
  if (h === 0) return `${m}分`;
  if (m === 0) return `${h}時間`;
  return `${h}時間${m}分`;
}

const yen = (n: number) => n.toLocaleString("ja-JP") + "円";

function formatProcessingMonth(m: string): string {
  if (!m || m.length < 6) return m;
  return `${m.slice(0, 4)}年${parseInt(m.slice(4, 6), 10)}月`;
}

function formatDate(d: string): string {
  if (!d || d.length < 8) return d;
  return `${parseInt(d.slice(4, 6), 10)}/${parseInt(d.slice(6, 8), 10)}`;
}

function fixedTotal(s: SalarySettings): number {
  return (
    s.base_personal_salary + s.skill_salary +
    s.position_allowance + s.qualification_allowance + s.tenure_allowance +
    s.treatment_improvement + s.specific_treatment_improvement + s.treatment_subsidy +
    s.fixed_overtime_pay + s.special_bonus
  );
}

function monthlyGrandTotal(p: MonthlyPayroll): number {
  if (!p.settings) return 0;
  return (
    fixedTotal(p.settings) +
    (p.bonus_paid ? p.settings.bonus_amount : 0) +
    Math.round(p.travel_km * (p.settings.travel_unit_price || 0)) +
    p.business_trip_fee
  );
}

function downloadCsv(filename: string, rows: string[][]): void {
  const escape = (v: string) =>
    v.includes(",") || v.includes('"') || v.includes("\n")
      ? `"${v.replace(/"/g, '""')}"`
      : v;
  const csv = rows.map((r) => r.map(escape).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ─── メインコンポーネント ─────────────────────────────────────

export default function PayrollPage() {
  const [months, setMonths] = useState<string[]>([]);
  const [selectedMonth, setSelectedMonth] = useState("");
  const [tab, setTab] = useState<"hourly" | "monthly">("hourly");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // 時給者
  const [hourlyResults, setHourlyResults] = useState<HourlyPayroll[]>([]);
  const [expandedEmp, setExpandedEmp] = useState<string | null>(null);

  // 月給者
  const [monthlyResults, setMonthlyResults] = useState<MonthlyPayroll[]>([]);

  // 処理月リスト
  useEffect(() => {
    supabase.from("service_records").select("processing_month").then(({ data }) => {
      if (!data) return;
      const unique = [...new Set(data.map((r: { processing_month: string }) => r.processing_month))].sort().reverse();
      setMonths(unique);
      if (unique.length > 0) setSelectedMonth(unique[0]);
    });
  }, []);

  // ─── 給与計算実行 ─────────────────────────────────────────────

  async function calculate() {
    if (!selectedMonth) return;
    setLoading(true); setError("");
    setHourlyResults([]); setMonthlyResults([]); setExpandedEmp(null);

    try {
      // 共通マスタ取得
      const [recRes, mappingRes, catRes, officeRes, rateRes, empRes, salRes] = await Promise.all([
        supabase.from("service_records")
          .select("id,employee_number,employee_name,service_date,calc_duration,service_code,office_number")
          .eq("processing_month", selectedMonth),
        supabase.from("service_type_mappings").select("service_code,category_id"),
        supabase.from("service_categories").select("id,name"),
        supabase.from("offices").select("id,office_number,name"),
        supabase.from("category_hourly_rates").select("category_id,office_id,hourly_rate"),
        supabase.from("employees").select("id,employee_number,name,role_type,salary_type,employment_status"),
        supabase.from("salary_settings").select("*"),
      ]);

      const records    = (recRes.data ?? []) as ServiceRecord[];
      const mappingMap = new Map((mappingRes.data ?? []).map((m: ServiceTypeMapping) => [m.service_code, m.category_id]));
      const categoryMap= new Map((catRes.data ?? []).map((c: ServiceCategory) => [c.id, c.name]));
      const officeMap  = new Map((officeRes.data ?? []).map((o: Office) => [o.office_number, o.id]));
      const rateMap    = new Map((rateRes.data ?? []).map((r: CategoryHourlyRate) => [`${r.office_id}:${r.category_id}`, r.hourly_rate]));
      const employees  = (empRes.data ?? []) as Employee[];
      const salMap     = new Map((salRes.data ?? []).map((s: SalarySettings) => [s.employee_id, s]));

      // ── 時給者計算 ──────────────────────────────────────────
      const roleMap = new Map(employees.map((e) => [e.employee_number, { role: e.role_type, salary: e.salary_type }]));

      const hourlyEmpMap = new Map<string, HourlyPayroll>();
      for (const rec of records) {
        const key = rec.employee_number;
        if (!hourlyEmpMap.has(key)) {
          const info = roleMap.get(key);
          hourlyEmpMap.set(key, {
            employee_number: key,
            employee_name: rec.employee_name,
            role_type: info?.role ?? "",
            records: [],
            totalMinutes: 0,
            totalPay: 0,
            unmappedCount: 0,
          });
        }
        const emp = hourlyEmpMap.get(key)!;
        const minutes    = parseDurationMinutes(rec.calc_duration);
        const categoryId = mappingMap.get(rec.service_code) ?? null;
        const catName    = categoryId ? (categoryMap.get(categoryId) ?? "不明") : "未マッピング";
        const officeId   = officeMap.get(rec.office_number) ?? null;
        const hourlyRate = categoryId && officeId ? (rateMap.get(`${officeId}:${categoryId}`) ?? null) : null;
        const pay        = hourlyRate !== null ? Math.round((minutes / 60) * hourlyRate) : null;
        emp.records.push({ id: rec.id, service_date: rec.service_date, minutes, service_code: rec.service_code, category_name: catName, hourly_rate: hourlyRate, pay });
        emp.totalMinutes += minutes;
        if (pay !== null) emp.totalPay += pay; else emp.unmappedCount++;
      }
      setHourlyResults(
        [...hourlyEmpMap.values()].sort((a, b) => a.employee_name.localeCompare(b.employee_name, "ja"))
      );

      // ── 月給者計算 ──────────────────────────────────────────
      const monthlyEmps = employees.filter(
        (e) => e.salary_type === "月給" && (!e.employment_status || e.employment_status === "在職者")
      );
      setMonthlyResults(
        monthlyEmps.sort((a, b) => a.name.localeCompare(b.name, "ja")).map((e) => ({
          employee_id: e.id,
          employee_number: e.employee_number,
          employee_name: e.name,
          role_type: e.role_type,
          settings: salMap.get(e.id) ?? null,
          bonus_paid: false,
          travel_km: 0,
          business_trip_fee: 0,
        }))
      );
    } catch (e) {
      setError(`計算エラー: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  // 月給者：変動入力更新
  function updateMonthly(empId: string, patch: Partial<MonthlyPayroll>) {
    setMonthlyResults((prev) =>
      prev.map((p) => p.employee_id === empId ? { ...p, ...patch } : p)
    );
  }

  // ── CSV出力 ─────────────────────────────────────────────────

  function exportHourlyCsv() {
    const label = formatProcessingMonth(selectedMonth).replace(/\s/g, "");
    const rows: string[][] = [["職員番号", "職員名", "役職", "件数", "合計算定時間(分)", "合計算定時間", "給与合計(円)"]];
    for (const e of hourlyResults) {
      rows.push([e.employee_number, e.employee_name, e.role_type, String(e.records.length), String(e.totalMinutes), formatMinutes(e.totalMinutes), String(e.totalPay)]);
    }
    downloadCsv(`給与計算_${label}_時給者サマリー.csv`, rows);
  }

  function exportMonthlyCsv() {
    const label = formatProcessingMonth(selectedMonth).replace(/\s/g, "");
    const rows: string[][] = [["職員番号", "職員名", "役職", "本人給", "職能給", "役職手当", "資格手当", "勤続手当", "処遇改善手当", "特定処遇改善手当", "処遇改善補助金手当", "固定残業代", "特別報奨金", "報奨金", "移動費", "出張費", "合計(円)"]];
    for (const p of monthlyResults) {
      const s = p.settings;
      const travelFee = Math.round(p.travel_km * (s?.travel_unit_price ?? 0));
      rows.push([
        p.employee_number, p.employee_name, p.role_type,
        String(s?.base_personal_salary ?? 0),
        String(s?.skill_salary ?? 0),
        String(s?.position_allowance ?? 0),
        String(s?.qualification_allowance ?? 0),
        String(s?.tenure_allowance ?? 0),
        String(s?.treatment_improvement ?? 0),
        String(s?.specific_treatment_improvement ?? 0),
        String(s?.treatment_subsidy ?? 0),
        String(s?.fixed_overtime_pay ?? 0),
        String(s?.special_bonus ?? 0),
        String(p.bonus_paid ? (s?.bonus_amount ?? 0) : 0),
        String(travelFee),
        String(p.business_trip_fee),
        String(monthlyGrandTotal(p)),
      ]);
    }
    downloadCsv(`給与計算_${label}_月給者.csv`, rows);
  }

  // ─── 合計値 ──────────────────────────────────────────────────

  const hourlyGrandTotal   = hourlyResults.reduce((s, e) => s + e.totalPay, 0);
  const hourlyGrandMinutes = hourlyResults.reduce((s, e) => s + e.totalMinutes, 0);
  const monthlyGrandSum    = monthlyResults.reduce((s, p) => s + monthlyGrandTotal(p), 0);

  // ─── 描画 ─────────────────────────────────────────────────────

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">給与計算</h2>

      {/* 月選択・実行 */}
      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium whitespace-nowrap">処理月</label>
              <select
                className="border rounded px-3 py-1.5 text-sm bg-background"
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value)}
              >
                {months.length === 0 && <option value="">（データなし）</option>}
                {months.map((m) => (
                  <option key={m} value={m}>{formatProcessingMonth(m)}</option>
                ))}
              </select>
            </div>
            <Button onClick={calculate} disabled={!selectedMonth || loading}>
              {loading ? "計算中…" : "給与計算を実行"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="mb-4 p-3 bg-destructive/10 text-destructive rounded text-sm">{error}</div>
      )}

      {(hourlyResults.length > 0 || monthlyResults.length > 0) && (
        <>
          {/* タブ */}
          <div className="flex gap-1 mb-4 border-b">
            {(["hourly", "monthly"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                  tab === t ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {t === "hourly"
                  ? `⏱ 時給者（${hourlyResults.length}名）`
                  : `📅 月給者（${monthlyResults.length}名）`}
              </button>
            ))}
          </div>

          {/* ── 時給者タブ ───────────────────────────────────── */}
          {tab === "hourly" && (
            <>
              <div className="grid grid-cols-3 gap-4 mb-4">
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">対象職員数</CardTitle></CardHeader>
                  <CardContent><p className="text-2xl font-bold">{hourlyResults.length}名</p></CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">合計算定時間</CardTitle></CardHeader>
                  <CardContent><p className="text-2xl font-bold">{formatMinutes(hourlyGrandMinutes)}</p></CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">給与合計</CardTitle></CardHeader>
                  <CardContent><p className="text-2xl font-bold">{yen(hourlyGrandTotal)}</p></CardContent></Card>
              </div>

              <Card>
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle>{formatProcessingMonth(selectedMonth)} 時給者 給与計算結果</CardTitle>
                  <Button variant="outline" size="sm" onClick={exportHourlyCsv}>📥 CSV出力</Button>
                </CardHeader>
                <CardContent className="p-0">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="text-left px-4 py-3 font-medium">職員番号</th>
                        <th className="text-left px-4 py-3 font-medium">職員名</th>
                        <th className="text-left px-4 py-3 font-medium">役職</th>
                        <th className="text-right px-4 py-3 font-medium">件数</th>
                        <th className="text-right px-4 py-3 font-medium">合計算定時間</th>
                        <th className="text-right px-4 py-3 font-medium">給与合計</th>
                        <th className="text-center px-4 py-3 font-medium">注記</th>
                        <th className="px-4 py-3"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {hourlyResults.map((emp) => (
                        <>
                          <tr
                            key={emp.employee_number}
                            className="border-b hover:bg-muted/30 cursor-pointer"
                            onClick={() => setExpandedEmp(expandedEmp === emp.employee_number ? null : emp.employee_number)}
                          >
                            <td className="px-4 py-3 font-mono text-xs">{emp.employee_number}</td>
                            <td className="px-4 py-3 font-medium">{emp.employee_name}</td>
                            <td className="px-4 py-3"><RoleBadge role={emp.role_type} /></td>
                            <td className="px-4 py-3 text-right">{emp.records.length}件</td>
                            <td className="px-4 py-3 text-right">{formatMinutes(emp.totalMinutes)}</td>
                            <td className="px-4 py-3 text-right font-bold">{yen(emp.totalPay)}</td>
                            <td className="px-4 py-3 text-center">
                              {emp.unmappedCount > 0 && (
                                <span className="text-xs px-2 py-0.5 bg-yellow-100 text-yellow-800 rounded-full">未設定{emp.unmappedCount}件</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-center text-muted-foreground text-xs">
                              {expandedEmp === emp.employee_number ? "▲" : "▼"}
                            </td>
                          </tr>
                          {expandedEmp === emp.employee_number && (
                            <tr key={`${emp.employee_number}-d`} className="bg-muted/10">
                              <td colSpan={8} className="px-8 py-3">
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="border-b">
                                      <th className="text-left py-1 font-medium">日付</th>
                                      <th className="text-left py-1 font-medium">サービスコード</th>
                                      <th className="text-left py-1 font-medium">類型</th>
                                      <th className="text-right py-1 font-medium">算定時間</th>
                                      <th className="text-right py-1 font-medium">時給</th>
                                      <th className="text-right py-1 font-medium">金額</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {emp.records.slice().sort((a, b) => a.service_date.localeCompare(b.service_date)).map((d) => (
                                      <tr key={d.id} className="border-b border-border/30">
                                        <td className="py-1">{formatDate(d.service_date)}</td>
                                        <td className="py-1 font-mono">{d.service_code}</td>
                                        <td className="py-1">
                                          <span className={d.category_name === "未マッピング" ? "text-yellow-600" : ""}>{d.category_name}</span>
                                        </td>
                                        <td className="py-1 text-right">{formatMinutes(d.minutes)}</td>
                                        <td className="py-1 text-right">{d.hourly_rate !== null ? d.hourly_rate.toLocaleString() + "円" : "—"}</td>
                                        <td className="py-1 text-right font-medium">{d.pay !== null ? yen(d.pay) : "—"}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                  <tfoot>
                                    <tr className="font-bold">
                                      <td colSpan={3} className="py-2">合計</td>
                                      <td className="py-2 text-right">{formatMinutes(emp.totalMinutes)}</td>
                                      <td></td>
                                      <td className="py-2 text-right">{yen(emp.totalPay)}</td>
                                    </tr>
                                  </tfoot>
                                </table>
                              </td>
                            </tr>
                          )}
                        </>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </>
          )}

          {/* ── 月給者タブ ───────────────────────────────────── */}
          {tab === "monthly" && (
            <>
              <div className="grid grid-cols-2 gap-4 mb-4">
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">対象職員数</CardTitle></CardHeader>
                  <CardContent><p className="text-2xl font-bold">{monthlyResults.length}名</p></CardContent></Card>
                <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">給与合計</CardTitle></CardHeader>
                  <CardContent><p className="text-2xl font-bold">{yen(monthlyGrandSum)}</p></CardContent></Card>
              </div>

              <Card>
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle>{formatProcessingMonth(selectedMonth)} 月給者 給与計算</CardTitle>
                  <Button variant="outline" size="sm" onClick={exportMonthlyCsv}>📥 CSV出力</Button>
                </CardHeader>
                <CardContent className="p-0">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="text-left px-3 py-3 font-medium">職員</th>
                        <th className="text-left px-3 py-3 font-medium">役職</th>
                        <th className="text-right px-3 py-3 font-medium">固定支給計</th>
                        <th className="text-center px-3 py-3 font-medium">報奨金</th>
                        <th className="text-right px-3 py-3 font-medium">移動(km)</th>
                        <th className="text-right px-3 py-3 font-medium">出張費</th>
                        <th className="text-right px-3 py-3 font-medium font-bold">合計</th>
                        <th className="text-center px-3 py-3 font-medium">設定</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthlyResults.map((p) => {
                        const s = p.settings;
                        const fixed = s ? fixedTotal(s) : 0;
                        const travelFee = Math.round(p.travel_km * (s?.travel_unit_price ?? 0));
                        const total = monthlyGrandTotal(p);
                        return (
                          <tr key={p.employee_id} className="border-b hover:bg-muted/20">
                            <td className="px-3 py-2">
                              <div className="font-medium">{p.employee_name}</div>
                              <div className="text-xs font-mono text-muted-foreground">{p.employee_number}</div>
                            </td>
                            <td className="px-3 py-2"><RoleBadge role={p.role_type} /></td>
                            <td className="px-3 py-2 text-right">
                              {s ? yen(fixed) : <span className="text-xs text-yellow-600">⚠ 給与設定なし</span>}
                            </td>
                            {/* 報奨金 toggle */}
                            <td className="px-3 py-2 text-center">
                              {s && s.bonus_amount > 0 ? (
                                <label className="flex items-center justify-center gap-1 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={p.bonus_paid}
                                    onChange={(e) => updateMonthly(p.employee_id, { bonus_paid: e.target.checked })}
                                  />
                                  <span className="text-xs">{yen(s.bonus_amount)}</span>
                                </label>
                              ) : <span className="text-xs text-muted-foreground">—</span>}
                            </td>
                            {/* 移動距離 */}
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-1 justify-end">
                                <Input
                                  type="number" min={0} step={0.1}
                                  value={p.travel_km || ""}
                                  placeholder="0"
                                  onChange={(e) => updateMonthly(p.employee_id, { travel_km: parseFloat(e.target.value) || 0 })}
                                  className="w-20 text-right text-xs h-7 px-2"
                                />
                                {travelFee > 0 && (
                                  <span className="text-xs text-muted-foreground whitespace-nowrap">={yen(travelFee)}</span>
                                )}
                              </div>
                            </td>
                            {/* 出張費 */}
                            <td className="px-3 py-2">
                              <Input
                                type="number" min={0}
                                value={p.business_trip_fee || ""}
                                placeholder="0"
                                onChange={(e) => updateMonthly(p.employee_id, { business_trip_fee: parseInt(e.target.value) || 0 })}
                                className="w-24 text-right text-xs h-7 px-2"
                              />
                            </td>
                            {/* 合計 */}
                            <td className="px-3 py-2 text-right font-bold">{yen(total)}</td>
                            {/* 設定リンク */}
                            <td className="px-3 py-2 text-center">
                              {!s && (
                                <a href="/salary" className="text-xs text-primary underline">設定へ</a>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="bg-muted/30 font-bold">
                        <td colSpan={6} className="px-3 py-2">合計</td>
                        <td className="px-3 py-2 text-right text-base">{yen(monthlyGrandSum)}</td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                </CardContent>
              </Card>

              {/* 月給者 内訳カード（クリックで展開しない代わりに詳細表示） */}
              <div className="mt-4 grid md:grid-cols-2 gap-3">
                {monthlyResults.filter((p) => p.settings).map((p) => {
                  const s = p.settings!;
                  return (
                    <Card key={p.employee_id} className="text-sm">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm flex justify-between">
                          <span>{p.employee_name}</span>
                          <span className="font-bold">{yen(monthlyGrandTotal(p))}</span>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-0.5 text-xs">
                        <DetailLine label="本人給" v={s.base_personal_salary} />
                        <DetailLine label="職能給" v={s.skill_salary} />
                        <DetailLine label="役職手当" v={s.position_allowance} />
                        <DetailLine label="資格手当" v={s.qualification_allowance} />
                        <DetailLine label="勤続手当" v={s.tenure_allowance} />
                        <DetailLine label="処遇改善手当" v={s.treatment_improvement} />
                        <DetailLine label="特定処遇改善手当" v={s.specific_treatment_improvement} />
                        <DetailLine label="処遇改善補助金手当" v={s.treatment_subsidy} />
                        <DetailLine label="固定残業代" v={s.fixed_overtime_pay} />
                        <DetailLine label="特別報奨金" v={s.special_bonus} />
                        {p.bonus_paid && s.bonus_amount > 0 && <DetailLine label="報奨金" v={s.bonus_amount} />}
                        {p.travel_km > 0 && <DetailLine label={`移動費(${p.travel_km}km)`} v={Math.round(p.travel_km * s.travel_unit_price)} />}
                        {p.business_trip_fee > 0 && <DetailLine label="出張費" v={p.business_trip_fee} />}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}

      {hourlyResults.length === 0 && monthlyResults.length === 0 && !loading && !error && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground text-sm">処理月を選択して「給与計算を実行」をクリックしてください。</p>
            <ul className="mt-3 text-sm text-muted-foreground space-y-1 list-disc list-inside">
              <li>時給者：サービス実績CSV（MEISAI）の取り込みが必要です</li>
              <li>月給者：給与設定ページで各職員の給与設定が必要です</li>
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── バッジ・明細コンポーネント ───────────────────────────────

const ROLE_COLORS: Record<string, string> = {
  管理者: "bg-purple-100 text-purple-800",
  提責:   "bg-blue-100 text-blue-800",
  社員:   "bg-green-100 text-green-800",
  パート: "bg-orange-100 text-orange-800",
  事務員: "bg-gray-100 text-gray-700",
};
function RoleBadge({ role }: { role: string }) {
  const c = ROLE_COLORS[role] ?? "bg-gray-100 text-gray-700";
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${c}`}>{role}</span>;
}

function DetailLine({ label, v }: { label: string; v: number }) {
  if (!v) return null;
  return (
    <div className="flex justify-between py-0.5 border-b border-border/30">
      <span className="text-muted-foreground">{label}</span>
      <span>{v.toLocaleString("ja-JP")}円</span>
    </div>
  );
}
