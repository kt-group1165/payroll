"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

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

type ServiceTypeMapping = {
  service_code: string;
  category_id: string;
};

type CategoryHourlyRate = {
  category_id: string;
  office_id: string;
  hourly_rate: number;
};

type Office = {
  id: string;
  office_number: string;
  name: string;
};

type ServiceCategory = {
  id: string;
  name: string;
};

// 職員ごとの給与計算結果
type EmployeePayroll = {
  employee_number: string;
  employee_name: string;
  records: DetailRow[];
  totalMinutes: number;
  totalPay: number;
  unmappedCount: number; // 時給未設定件数
};

type DetailRow = {
  id: string;
  service_date: string;
  calc_duration: string;
  minutes: number;
  service_code: string;
  category_name: string;
  hourly_rate: number | null;
  pay: number | null;
};

// ─── ユーティリティ ──────────────────────────────────────────

/** 算定時間文字列を分に変換。"1:30" → 90、"30" → 30 */
function parseDurationMinutes(str: string): number {
  if (!str) return 0;
  str = str.trim();
  if (str.includes(":")) {
    const parts = str.split(":");
    const h = parseInt(parts[0] ?? "0", 10) || 0;
    const m = parseInt(parts[1] ?? "0", 10) || 0;
    return h * 60 + m;
  }
  return parseInt(str, 10) || 0;
}

/** 分 → "H時間MM分" */
function formatMinutes(min: number): string {
  if (min === 0) return "0分";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}分`;
  if (m === 0) return `${h}時間`;
  return `${h}時間${m}分`;
}

/** 円フォーマット */
function formatYen(n: number): string {
  return n.toLocaleString("ja-JP") + "円";
}

// ─── メインコンポーネント ─────────────────────────────────────

export default function PayrollPage() {
  const [months, setMonths] = useState<string[]>([]);
  const [selectedMonth, setSelectedMonth] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<EmployeePayroll[]>([]);
  const [expandedEmployee, setExpandedEmployee] = useState<string | null>(null);
  const [error, setError] = useState<string>("");

  // 処理月リストを取得
  useEffect(() => {
    supabase
      .from("service_records")
      .select("processing_month")
      .then(({ data }) => {
        if (!data) return;
        const unique = [...new Set(data.map((r: { processing_month: string }) => r.processing_month))].sort().reverse();
        setMonths(unique);
        if (unique.length > 0) setSelectedMonth(unique[0]);
      });
  }, []);

  // 給与計算実行
  async function calculate() {
    if (!selectedMonth) return;
    setLoading(true);
    setError("");
    setResults([]);
    setExpandedEmployee(null);

    try {
      // 1. サービス実績を取得
      const { data: records, error: e1 } = await supabase
        .from("service_records")
        .select("id,employee_number,employee_name,service_date,calc_duration,service_code,office_number")
        .eq("processing_month", selectedMonth);
      if (e1) throw e1;
      if (!records || records.length === 0) {
        setError("対象月のサービス実績データがありません。");
        return;
      }

      // 2. サービスマッピング全件取得
      const { data: mappings, error: e2 } = await supabase
        .from("service_type_mappings")
        .select("service_code,category_id");
      if (e2) throw e2;
      const mappingMap = new Map<string, string>(); // service_code → category_id
      (mappings as ServiceTypeMapping[] ?? []).forEach((m) => mappingMap.set(m.service_code, m.category_id));

      // 3. サービス類型名取得
      const { data: categories, error: e3 } = await supabase
        .from("service_categories")
        .select("id,name");
      if (e3) throw e3;
      const categoryMap = new Map<string, string>(); // id → name
      (categories as ServiceCategory[] ?? []).forEach((c) => categoryMap.set(c.id, c.name));

      // 4. 事業所一覧取得
      const { data: offices, error: e4 } = await supabase
        .from("offices")
        .select("id,office_number,name");
      if (e4) throw e4;
      const officeMap = new Map<string, string>(); // office_number → office_id
      (offices as Office[] ?? []).forEach((o) => officeMap.set(o.office_number, o.id));

      // 5. 時給設定全件取得
      const { data: rates, error: e5 } = await supabase
        .from("category_hourly_rates")
        .select("category_id,office_id,hourly_rate");
      if (e5) throw e5;
      const rateMap = new Map<string, number>(); // `${office_id}:${category_id}` → hourly_rate
      (rates as CategoryHourlyRate[] ?? []).forEach((r) => {
        rateMap.set(`${r.office_id}:${r.category_id}`, r.hourly_rate);
      });

      // 6. 職員ごとに集計
      const empMap = new Map<string, EmployeePayroll>();
      for (const rec of records as ServiceRecord[]) {
        const key = rec.employee_number;
        if (!empMap.has(key)) {
          empMap.set(key, {
            employee_number: rec.employee_number,
            employee_name: rec.employee_name,
            records: [],
            totalMinutes: 0,
            totalPay: 0,
            unmappedCount: 0,
          });
        }
        const emp = empMap.get(key)!;

        const minutes = parseDurationMinutes(rec.calc_duration);
        const categoryId = mappingMap.get(rec.service_code) ?? null;
        const categoryName = categoryId ? (categoryMap.get(categoryId) ?? "不明") : "未マッピング";
        const officeId = officeMap.get(rec.office_number) ?? null;
        const hourly_rate =
          categoryId && officeId ? (rateMap.get(`${officeId}:${categoryId}`) ?? null) : null;
        const pay = hourly_rate !== null ? Math.round((minutes / 60) * hourly_rate) : null;

        const detail: DetailRow = {
          id: rec.id,
          service_date: rec.service_date,
          calc_duration: rec.calc_duration,
          minutes,
          service_code: rec.service_code,
          category_name: categoryName,
          hourly_rate,
          pay,
        };

        emp.records.push(detail);
        emp.totalMinutes += minutes;
        if (pay !== null) emp.totalPay += pay;
        else emp.unmappedCount++;
      }

      // 7. 職員名でソート
      const sorted = [...empMap.values()].sort((a, b) =>
        a.employee_name.localeCompare(b.employee_name, "ja")
      );
      setResults(sorted);
    } catch (e) {
      setError(`計算エラー: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  const grandTotalPay = results.reduce((s, e) => s + e.totalPay, 0);
  const grandTotalMinutes = results.reduce((s, e) => s + e.totalMinutes, 0);

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">給与計算</h2>

      {/* 月選択 */}
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
                {months.length === 0 && (
                  <option value="">（データなし）</option>
                )}
                {months.map((m) => (
                  <option key={m} value={m}>
                    {formatProcessingMonth(m)}
                  </option>
                ))}
              </select>
            </div>
            <Button onClick={calculate} disabled={!selectedMonth || loading}>
              {loading ? "計算中…" : "給与計算を実行"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* エラー */}
      {error && (
        <div className="mb-4 p-3 bg-destructive/10 text-destructive rounded text-sm">{error}</div>
      )}

      {/* 結果 */}
      {results.length > 0 && (
        <>
          {/* サマリー */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">対象職員数</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{results.length}名</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">合計算定時間</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatMinutes(grandTotalMinutes)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">給与合計</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatYen(grandTotalPay)}</p>
              </CardContent>
            </Card>
          </div>

          {/* 職員一覧テーブル */}
          <Card>
            <CardHeader>
              <CardTitle>{formatProcessingMonth(selectedMonth)} 給与計算結果</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-4 py-3 font-medium">職員番号</th>
                    <th className="text-left px-4 py-3 font-medium">職員名</th>
                    <th className="text-right px-4 py-3 font-medium">件数</th>
                    <th className="text-right px-4 py-3 font-medium">合計算定時間</th>
                    <th className="text-right px-4 py-3 font-medium">給与合計</th>
                    <th className="text-center px-4 py-3 font-medium">注記</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((emp) => (
                    <>
                      <tr
                        key={emp.employee_number}
                        className="border-b hover:bg-muted/30 cursor-pointer"
                        onClick={() =>
                          setExpandedEmployee(
                            expandedEmployee === emp.employee_number
                              ? null
                              : emp.employee_number
                          )
                        }
                      >
                        <td className="px-4 py-3 font-mono text-xs">{emp.employee_number}</td>
                        <td className="px-4 py-3 font-medium">{emp.employee_name}</td>
                        <td className="px-4 py-3 text-right">{emp.records.length}件</td>
                        <td className="px-4 py-3 text-right">{formatMinutes(emp.totalMinutes)}</td>
                        <td className="px-4 py-3 text-right font-bold">{formatYen(emp.totalPay)}</td>
                        <td className="px-4 py-3 text-center">
                          {emp.unmappedCount > 0 && (
                            <span className="text-xs px-2 py-0.5 bg-yellow-100 text-yellow-800 rounded-full">
                              未設定{emp.unmappedCount}件
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center text-muted-foreground text-xs">
                          {expandedEmployee === emp.employee_number ? "▲" : "▼"}
                        </td>
                      </tr>

                      {/* 明細展開 */}
                      {expandedEmployee === emp.employee_number && (
                        <tr key={`${emp.employee_number}-detail`} className="bg-muted/10">
                          <td colSpan={7} className="px-6 py-3">
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
                                {emp.records
                                  .slice()
                                  .sort((a, b) => a.service_date.localeCompare(b.service_date))
                                  .map((d) => (
                                    <tr key={d.id} className="border-b border-border/30">
                                      <td className="py-1">{formatDate(d.service_date)}</td>
                                      <td className="py-1 font-mono">{d.service_code}</td>
                                      <td className="py-1">
                                        <span
                                          className={
                                            d.category_name === "未マッピング"
                                              ? "text-yellow-600"
                                              : ""
                                          }
                                        >
                                          {d.category_name}
                                        </span>
                                      </td>
                                      <td className="py-1 text-right">{formatMinutes(d.minutes)}</td>
                                      <td className="py-1 text-right">
                                        {d.hourly_rate !== null
                                          ? d.hourly_rate.toLocaleString("ja-JP") + "円"
                                          : "—"}
                                      </td>
                                      <td className="py-1 text-right font-medium">
                                        {d.pay !== null ? formatYen(d.pay) : "—"}
                                      </td>
                                    </tr>
                                  ))}
                              </tbody>
                              <tfoot>
                                <tr className="font-bold">
                                  <td colSpan={3} className="py-2">合計</td>
                                  <td className="py-2 text-right">{formatMinutes(emp.totalMinutes)}</td>
                                  <td className="py-2"></td>
                                  <td className="py-2 text-right">{formatYen(emp.totalPay)}</td>
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

      {/* 初期案内 */}
      {results.length === 0 && !loading && !error && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground text-sm">
              処理月を選択して「給与計算を実行」をクリックしてください。
            </p>
            <ul className="mt-3 text-sm text-muted-foreground space-y-1 list-disc list-inside">
              <li>サービス実績CSV（MEISAI）が取り込まれていることを確認してください</li>
              <li>サービスマスタでサービスコードの類型マッピングと時給設定を行ってください</li>
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── ヘルパー関数 ─────────────────────────────────────────────

/** "202503" → "2025年3月" */
function formatProcessingMonth(m: string): string {
  if (!m || m.length < 6) return m;
  const year = m.slice(0, 4);
  const month = parseInt(m.slice(4, 6), 10);
  return `${year}年${month}月`;
}

/** "20250315" → "3/15" */
function formatDate(d: string): string {
  if (!d || d.length < 8) return d;
  const month = parseInt(d.slice(4, 6), 10);
  const day = parseInt(d.slice(6, 8), 10);
  return `${month}/${day}`;
}
