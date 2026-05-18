"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { OFFICE_MASTER_JOIN, flattenOfficeMaster } from "@/types/database";
import { Button } from "@/components/ui/button";
import {
  calcDailyListWithWeekly,
  calcMonthlySummary,
  formatHM,
  type AttendanceRecord,
} from "@/lib/payroll/attendance-calc";

/**
 * 居宅介護支援 総括表セクション
 *
 * 表示するもの (Phase 1):
 *   - 事業所 + 月 selector
 *   - その事業所 / 月のケアマネ全員について 出勤簿集計を一覧表示:
 *     - 出勤日数 (実労働>0 の日数)
 *     - 実労働時間 / 残業 (日次+週次) / 深夜 / 法休勤務 / 欠勤
 *     - 有給 (全=1.0 / 半=0.5 で合算)
 *     - 出張距離 (km)
 *   - 給与計算 (本人給/手当/合計) は Phase 2 で統合予定 — 現状は 0 表示
 *
 * データソース: live (DB 都度集計)。snapshot化は将来検討。
 */

// =====================================================================
// 型
// =====================================================================

type KyotakuOffice = {
  id: string;
  office_number: string;
  short_name: string;
  name: string;
  work_week_start: number;
};

type EmployeeRow = {
  id: string;
  employee_number: string | null;
  name: string;
  role_type: string | null;
  /** 本人給 (月給) */
  kyotaku_honnin_kyu: number | null;
  /** 職能給 */
  kyotaku_shokuno_kyu: number | null;
  /** 固定残業手当 */
  kyotaku_kotei_zangyo: number | null;
  /** 資格手当 */
  kyotaku_shikaku_teate: number | null;
  /** 勤続手当 (kotei) */
  kyotaku_kotei: number | null;
  /** 特定処遇改善 */
  kyotaku_tokutei_shogu: number | null;
};

type AttendanceDbRow = {
  employee_id: string;
  work_date: string;
  start_time: string | null;
  end_time: string | null;
  break_minutes: number;
  is_legal_holiday: boolean;
  paid_leave_type: "full" | "half" | null;
  is_paid_leave?: boolean | null; // legacy fallback
  business_km: number | string | null;
  substitute_for_date: string | null;
};

type SummaryRow = {
  employee_id: string;
  employee_number: string;
  name: string;
  role_type: string;
  // 出勤簿集計
  workDays: number;
  workMin: number;
  dailyOvertimeMin: number;
  weeklyOvertimeMin: number;
  midnightMin: number;
  holidayWorkMin: number;
  absenceMin: number;
  paidLeaveDays: number;
  businessKmTotal: number;
  // 給与 (基本給 + 手当)
  honnin: number;
  shokuno: number;
  kotei_zangyo: number;
  shikaku: number;
  kotei: number;
  tokutei: number;
  /** 給与合計 (= honnin + shokuno + kotei_zangyo + shikaku + kotei + tokutei) */
  total: number;
};

// =====================================================================
// 補助関数
// =====================================================================

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

function monthRange(ym: string): { start: string; end: string } {
  const [yStr, mStr] = ym.split("-");
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    start: `${y}-${String(m).padStart(2, "0")}-01`,
    end: `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
  };
}

function toUiTime(s: string | null): string | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{1,2})/.exec(s);
  if (!m) return null;
  return `${String(parseInt(m[1], 10)).padStart(2, "0")}:${String(parseInt(m[2], 10)).padStart(2, "0")}`;
}

function dbToAttendanceRecord(r: AttendanceDbRow): AttendanceRecord {
  const paidLeaveType: "full" | "half" | null =
    r.paid_leave_type === "full" || r.paid_leave_type === "half"
      ? r.paid_leave_type
      : r.is_paid_leave
        ? "full"
        : null;
  return {
    work_date: r.work_date,
    start_time: toUiTime(r.start_time),
    end_time: toUiTime(r.end_time),
    break_minutes: r.break_minutes ?? 0,
    is_legal_holiday: !!r.is_legal_holiday,
    paid_leave_type: paidLeaveType,
    substitute_for_date: r.substitute_for_date ?? null,
  };
}

function yen(n: number): string {
  return n > 0 ? `${n.toLocaleString("ja-JP")}円` : "—";
}

function num(n: number): string {
  return n > 0 ? n.toLocaleString("ja-JP") : "—";
}

function hm(n: number): string {
  return n > 0 ? formatHM(n) : "—";
}

// =====================================================================
// Component
// =====================================================================

export function KyotakuSummarySection() {
  const [offices, setOffices] = useState<KyotakuOffice[]>([]);
  const [officeLoading, setOfficeLoading] = useState(true);
  const [selectedOfficeId, setSelectedOfficeId] = useState<string>("");
  const [month, setMonth] = useState<string>(() => currentMonth());
  const [rows, setRows] = useState<SummaryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // offices 初期 fetch
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setOfficeLoading(true);
      try {
        const { data, error } = await supabase
          .from("payroll_offices")
          .select(`id, office_number, short_name, office_type, work_week_start, ${OFFICE_MASTER_JOIN}`)
          .eq("office_type", "居宅介護支援");
        if (cancelled) return;
        if (error) throw error;
        const flat = flattenOfficeMaster(data as never) as unknown as KyotakuOffice[];
        flat.sort((a, b) => a.office_number.localeCompare(b.office_number));
        setOffices(flat);
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          setErr(`事業所一覧の取得に失敗: ${msg}`);
        }
      } finally {
        if (!cancelled) setOfficeLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedOffice = useMemo(
    () => offices.find((o) => o.id === selectedOfficeId) ?? null,
    [offices, selectedOfficeId],
  );

  const loadSummary = useCallback(async () => {
    if (!selectedOfficeId) {
      setRows([]);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      // 1) office の employee 一覧
      const { data: empData, error: empErr } = await supabase
        .from("payroll_employees")
        .select(
          "id, employee_number, name, role_type, kyotaku_honnin_kyu, kyotaku_shokuno_kyu, kyotaku_kotei_zangyo, kyotaku_shikaku_teate, kyotaku_kotei, kyotaku_tokutei_shogu",
        )
        .eq("office_id", selectedOfficeId)
        .order("name");
      if (empErr) throw empErr;
      const employees = (empData ?? []) as EmployeeRow[];
      if (employees.length === 0) {
        setRows([]);
        return;
      }
      const empIds = employees.map((e) => e.id);

      // 2) 当月の出勤簿 record
      const { start, end } = monthRange(month);
      const { data: attData, error: attErr } = await supabase
        .from("payroll_kyotaku_attendance_records")
        .select(
          "employee_id, work_date, start_time, end_time, break_minutes, is_legal_holiday, paid_leave_type, is_paid_leave, business_km, substitute_for_date",
        )
        .in("employee_id", empIds)
        .gte("work_date", start)
        .lte("work_date", end);
      if (attErr) throw attErr;
      const attRows = (attData ?? []) as AttendanceDbRow[];

      // 3) employee_id → record list でグルーピング
      const byEmp = new Map<string, AttendanceDbRow[]>();
      for (const r of attRows) {
        if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, []);
        byEmp.get(r.employee_id)!.push(r);
      }

      // 4) 各 employee で集計
      const weekStart = selectedOffice?.work_week_start ?? 0;
      const result: SummaryRow[] = employees.map((emp) => {
        const empRows = byEmp.get(emp.id) ?? [];
        const records = empRows.map(dbToAttendanceRecord);
        const dailies = calcDailyListWithWeekly(records, weekStart);
        const summary = calcMonthlySummary(records, weekStart);
        // 出勤日数 = 実労働 > 0 な日
        const workDays = dailies.filter((d) => d.work_minutes > 0).length;
        // 出張km 月合計
        let businessKmTotal = 0;
        for (const r of empRows) {
          const km = r.business_km;
          if (km === null || km === undefined || km === "") continue;
          const n = typeof km === "string" ? parseFloat(km) : km;
          if (Number.isFinite(n) && n > 0) businessKmTotal += n;
        }
        businessKmTotal = Math.round(businessKmTotal * 10) / 10;

        const honnin = emp.kyotaku_honnin_kyu ?? 0;
        const shokuno = emp.kyotaku_shokuno_kyu ?? 0;
        const kotei_zangyo = emp.kyotaku_kotei_zangyo ?? 0;
        const shikaku = emp.kyotaku_shikaku_teate ?? 0;
        const kotei = emp.kyotaku_kotei ?? 0;
        const tokutei = emp.kyotaku_tokutei_shogu ?? 0;
        const total = honnin + shokuno + kotei_zangyo + shikaku + kotei + tokutei;

        return {
          employee_id: emp.id,
          employee_number: emp.employee_number ?? "",
          name: emp.name,
          role_type: emp.role_type ?? "",
          workDays,
          workMin: summary.total_work,
          dailyOvertimeMin: summary.total_daily_overtime,
          weeklyOvertimeMin: summary.total_weekly_overtime,
          midnightMin: summary.total_midnight,
          holidayWorkMin: summary.total_holiday,
          absenceMin: summary.total_absence,
          paidLeaveDays: summary.total_paid_leave_days,
          businessKmTotal,
          honnin,
          shokuno,
          kotei_zangyo,
          shikaku,
          kotei,
          tokutei,
          total,
        };
      });
      setRows(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(`集計の取得に失敗: ${msg}`);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [selectedOfficeId, month, selectedOffice]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- office/month 切替の async fetch */
    void loadSummary();
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [loadSummary]);

  // 合計
  const grandTotal = useMemo(() => rows.reduce((s, r) => s + r.total, 0), [rows]);

  return (
    <div className="border rounded-md overflow-hidden mb-6">
      <div className="bg-muted/40 px-3 py-2 text-sm font-medium flex items-center justify-between flex-wrap gap-2">
        <span>居宅介護支援 ({rows.length}名)</span>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            className="rounded-md border bg-background px-2 py-1 text-xs min-w-[200px]"
            value={selectedOfficeId}
            onChange={(e) => setSelectedOfficeId(e.target.value)}
            disabled={officeLoading}
          >
            <option value="">{officeLoading ? "読み込み中..." : "事業所を選択"}</option>
            {offices.map((o) => (
              <option key={o.id} value={o.id}>
                {o.short_name || o.name || o.office_number}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" onClick={() => setMonth((m) => shiftMonth(m, -1))}>
            ← 前月
          </Button>
          <span className="text-sm font-medium min-w-[6em] text-center">{fmtMonthLabel(month)}</span>
          <Button variant="outline" size="sm" onClick={() => setMonth((m) => shiftMonth(m, 1))}>
            次月 →
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setMonth(currentMonth())}>
            今月
          </Button>
        </div>
      </div>

      {err && (
        <div className="px-3 py-2 text-sm text-destructive bg-destructive/5 border-b">
          {err}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs whitespace-nowrap">
          <thead className="bg-muted/20 border-b">
            <tr>
              <th className="px-3 py-2 font-medium text-left">社員番号</th>
              <th className="px-3 py-2 font-medium text-left">氏名</th>
              <th className="px-3 py-2 font-medium text-left">役職</th>
              <th className="px-3 py-2 font-medium text-right">出勤日数</th>
              <th className="px-3 py-2 font-medium text-right">実労働</th>
              <th className="px-3 py-2 font-medium text-right">日次残業</th>
              <th className="px-3 py-2 font-medium text-right">週次残業</th>
              <th className="px-3 py-2 font-medium text-right">深夜</th>
              <th className="px-3 py-2 font-medium text-right">法休勤務</th>
              <th className="px-3 py-2 font-medium text-right">欠勤</th>
              <th className="px-3 py-2 font-medium text-right">有給</th>
              <th className="px-3 py-2 font-medium text-right">出張km</th>
              <th className="px-3 py-2 font-medium text-right">本人給</th>
              <th className="px-3 py-2 font-medium text-right">職能給</th>
              <th className="px-3 py-2 font-medium text-right">固定残業</th>
              <th className="px-3 py-2 font-medium text-right">資格手当</th>
              <th className="px-3 py-2 font-medium text-right">勤続手当</th>
              <th className="px-3 py-2 font-medium text-right">特定処遇</th>
              <th className="px-3 py-2 font-medium text-right">支給合計</th>
            </tr>
          </thead>
          <tbody>
            {!selectedOfficeId ? (
              <tr>
                <td colSpan={19} className="text-center text-muted-foreground py-4">
                  事業所を選択してください
                </td>
              </tr>
            ) : loading ? (
              <tr>
                <td colSpan={19} className="text-center text-muted-foreground py-4">
                  読み込み中...
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={19} className="text-center text-muted-foreground py-4">
                  データなし
                </td>
              </tr>
            ) : (
              <>
                {rows.map((r) => (
                  <tr key={r.employee_id} className="border-b last:border-b-0">
                    <td className="px-3 py-1.5 font-mono text-xs">{r.employee_number}</td>
                    <td className="px-3 py-1.5">{r.name}</td>
                    <td className="px-3 py-1.5">{r.role_type}</td>
                    <td className="px-3 py-1.5 text-right">{num(r.workDays)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{hm(r.workMin)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{hm(r.dailyOvertimeMin)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{hm(r.weeklyOvertimeMin)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{hm(r.midnightMin)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{hm(r.holidayWorkMin)}</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${r.absenceMin > 0 ? "text-rose-600" : ""}`}>{hm(r.absenceMin)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {r.paidLeaveDays > 0
                        ? `${r.paidLeaveDays.toFixed(1).replace(/\.0$/, "")}日`
                        : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {r.businessKmTotal > 0 ? `${r.businessKmTotal.toFixed(1)}km` : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right">{yen(r.honnin)}</td>
                    <td className="px-3 py-1.5 text-right">{yen(r.shokuno)}</td>
                    <td className="px-3 py-1.5 text-right">{yen(r.kotei_zangyo)}</td>
                    <td className="px-3 py-1.5 text-right">{yen(r.shikaku)}</td>
                    <td className="px-3 py-1.5 text-right">{yen(r.kotei)}</td>
                    <td className="px-3 py-1.5 text-right">{yen(r.tokutei)}</td>
                    <td className="px-3 py-1.5 text-right font-bold">{r.total.toLocaleString("ja-JP")}円</td>
                  </tr>
                ))}
                <tr className="border-t bg-muted/10 font-semibold">
                  <td colSpan={18} className="px-3 py-1.5 text-right">合計</td>
                  <td className="px-3 py-1.5 text-right">{grandTotal.toLocaleString("ja-JP")}円</td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-2 text-xs text-muted-foreground border-t">
        ※ 給与額は payroll_employees の本人給/職能給/固定残業/資格手当/勤続手当/特定処遇改善の合計です。
        プラン手当・加算手当・出張手当などの計算は給与計算ページから別途確認してください。
      </div>
    </div>
  );
}
