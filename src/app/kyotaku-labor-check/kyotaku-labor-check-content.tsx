"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MonthInputButton } from "@/components/ui/month-input-button";
import { formatHM } from "@/lib/payroll/attendance-calc";
import { useKyotakuLaborCheck } from "@/lib/swr/use-kyotaku-labor-check";

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function fmtMonthLabel(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  return `${m[1]}年${m[2]}月`;
}

function shiftMonth(ym: string, delta: number): string {
  const [yStr, mStr] = ym.split("-");
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return ym;
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function hm(min: number): string {
  return min > 0 ? formatHM(min) : "—";
}

export function KyotakuLaborCheckContent() {
  const [month, setMonth] = useState<string>(() => currentMonth());
  const { rows, isLoading, error } = useKyotakuLaborCheck(month);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-2xl font-bold">
          労働時間チェック{" "}
          <span className="text-base font-normal text-muted-foreground">
            (居宅介護支援)
          </span>
        </h2>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">対象月</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMonth((m) => shiftMonth(m, -1))}
            >
              ← 前月
            </Button>
            <MonthInputButton value={month} onChange={(next) => setMonth(next)} />
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMonth((m) => shiftMonth(m, 1))}
            >
              次月 →
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMonth(currentMonth())}
            >
              今月
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-md border border-destructive bg-destructive/5 px-3 py-2 text-sm text-destructive">
          取得に失敗: {error.message}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            要確認 ({rows.length} 名){" "}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {fmtMonthLabel(month)}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading && rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">集計中...</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {fmtMonthLabel(month)} の出勤簿に問題はありません。
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs whitespace-nowrap">
                <thead className="bg-muted/20 border-b">
                  <tr>
                    <th className="px-3 py-2 font-medium text-left">事業所</th>
                    <th className="px-3 py-2 font-medium text-left">担当ケアマネ</th>
                    <th className="px-3 py-2 font-medium text-right">実労働</th>
                    <th className="px-3 py-2 font-medium text-right">日次残業</th>
                    <th className="px-3 py-2 font-medium text-right">週次残業</th>
                    <th className="px-3 py-2 font-medium text-right">欠勤</th>
                    <th className="px-3 py-2 font-medium text-right" title="実残業代 / 固定残業代">残業代 vs 固定</th>
                    <th className="px-3 py-2 font-medium text-center w-24"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={`${r.office_id}|${r.employee_id}`}
                      className="border-b last:border-b-0"
                    >
                      <td className="px-3 py-1.5">{r.office_short_name}</td>
                      <td className="px-3 py-1.5">{r.employee_name}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {hm(r.workMin)}
                      </td>
                      <td
                        className={`px-3 py-1.5 text-right tabular-nums ${
                          r.hasDailyOvertime ? "text-amber-700 font-semibold" : ""
                        }`}
                      >
                        {hm(r.dailyOvertimeMin)}
                      </td>
                      <td
                        className={`px-3 py-1.5 text-right tabular-nums ${
                          r.hasWeeklyOvertime ? "text-amber-700 font-semibold" : ""
                        }`}
                      >
                        {hm(r.weeklyOvertimeMin)}
                      </td>
                      <td
                        className={`px-3 py-1.5 text-right tabular-nums ${
                          r.hasAbsence ? "text-rose-600 font-semibold" : ""
                        }`}
                      >
                        {hm(r.absenceMin)}
                      </td>
                      <td
                        className={`px-3 py-1.5 text-right tabular-nums ${
                          r.hasFixedOvertimeExceeded
                            ? "text-amber-700 font-semibold"
                            : ""
                        }`}
                        title={
                          r.fixedOvertimePay > 0
                            ? `実残業代 ¥${r.overtimePay.toLocaleString()} / 固定残業代 ¥${r.fixedOvertimePay.toLocaleString()}`
                            : "固定残業代 未設定"
                        }
                      >
                        {r.fixedOvertimePay > 0
                          ? `¥${r.overtimePay.toLocaleString()} / ¥${r.fixedOvertimePay.toLocaleString()}`
                          : "—"}
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        <Link
                          href={`/kyotaku-attendance?office=${r.office_id}&employee=${r.employee_id}&month=${month}`}
                          className="inline-flex items-center justify-center rounded-md border border-input bg-background px-2.5 py-1 text-xs font-medium hover:bg-muted/40"
                        >
                          出勤簿を開く →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-muted-foreground">
                ※ 出勤簿に記録がある (= start_time 入力済) 職員のみ集計対象。<br />
                <strong>行表示の条件</strong> (どれか 1 つでも該当で表示):
                <span className="text-rose-600 font-semibold mx-1">欠勤あり</span> /{" "}
                <span className="text-amber-700 font-semibold mx-1">残業代が固定残業代を超過</span><br />
                <span className="text-muted-foreground">
                  欠勤 = 所定労働日 (平日 / 祝日 / 会社休日 を除く) に
                  実労働が足りない時間 (有給 8h・半有給 4h 換算後、週 40h 補填後)。<br />
                  残業代 = 通常残業代(1.25倍) + 深夜割増(0.25倍) + 法休割増(0.35倍) の円換算合計。<br />
                  日次/週次残業の数値は参考表示のみ (発生自体は正常な労働として警告しない)。
                </span>
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
