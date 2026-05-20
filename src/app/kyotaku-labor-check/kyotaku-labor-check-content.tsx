"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatHM } from "@/lib/payroll/attendance-calc";
import { useKyotakuLaborCheck } from "@/lib/swr/use-kyotaku-labor-check";

function fmtMonthLabel(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  return `${m[1]}年${m[2]}月`;
}

function hm(min: number): string {
  return min > 0 ? formatHM(min) : "—";
}

export function KyotakuLaborCheckContent() {
  const { rows, isLoading, error } = useKyotakuLaborCheck();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-2xl font-bold">
          労働時間チェック{" "}
          <span className="text-base font-normal text-muted-foreground">
            (居宅介護支援 / 全期間)
          </span>
        </h2>
      </div>

      {error && (
        <div className="rounded-md border border-destructive bg-destructive/5 px-3 py-2 text-sm text-destructive">
          取得に失敗: {error.message}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            要確認 ({rows.length} 件)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading && rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">集計中...</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              全期間の出勤簿に問題はありません。
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs whitespace-nowrap">
                <thead className="bg-muted/20 border-b">
                  <tr>
                    <th className="px-3 py-2 font-medium text-left">対象月</th>
                    <th className="px-3 py-2 font-medium text-left">事業所</th>
                    <th className="px-3 py-2 font-medium text-left">担当ケアマネ</th>
                    <th className="px-3 py-2 font-medium text-right">実労働</th>
                    <th className="px-3 py-2 font-medium text-right">欠勤</th>
                    <th className="px-3 py-2 font-medium text-right" title="実残業代 / 固定残業代">残業代 vs 固定</th>
                    <th className="px-3 py-2 font-medium text-center w-24"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={`${r.month}|${r.office_id}|${r.employee_id}`}
                      className="border-b last:border-b-0"
                    >
                      <td className="px-3 py-1.5 font-medium">
                        {fmtMonthLabel(r.month)}
                      </td>
                      <td className="px-3 py-1.5">{r.office_short_name}</td>
                      <td className="px-3 py-1.5">{r.employee_name}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {hm(r.workMin)}
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
                          href={`/kyotaku-attendance?office=${r.office_id}&employee=${r.employee_id}&month=${r.month}`}
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
                ※ 出勤簿に記録がある (= start_time 入力済) 職員 × 月 のみ集計対象。<br />
                <strong>行表示の条件</strong> (どれか 1 つでも該当で表示):
                <span className="text-rose-600 font-semibold mx-1">欠勤あり</span> /{" "}
                <span className="text-amber-700 font-semibold mx-1">残業代が固定残業代を超過</span><br />
                <span className="text-muted-foreground">
                  欠勤 = 所定労働日 (平日 / 祝日 / 会社休日 を除く) に実労働が足りない時間。
                  ただしその週の <strong>有給込み・残業込みの効果労働時間が 40h 確保</strong> されていれば 0 扱い (= 一覧に出ない)。<br />
                  残業代 = 通常残業代(1.25倍) + 深夜割増(0.25倍) + 法休割増(0.35倍) の円換算合計。
                  固定残業代 = 居宅ケアマネ給与設定の「固定残業手当」。
                </span>
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
