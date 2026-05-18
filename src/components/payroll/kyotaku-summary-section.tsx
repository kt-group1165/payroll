"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  calcDailyListWithWeekly,
  calcMonthlySummary,
  extendedMonthRange,
  formatHM,
  type AttendanceRecord,
} from "@/lib/payroll/attendance-calc";
import {
  calcSalary,
  type CalcConfig,
  type EmployeeSetting,
  type KyotakuAttendanceRecord,
  type KyotakuRecord,
  type RegionalRate,
  type ServiceUnit,
  type YobouRecord,
} from "@/lib/payroll/kyotaku-calc";

/**
 * 居宅介護支援 総括表セクション
 *
 * Props で officeId + month + weekStart を受け取り、対応する出勤簿集計を表示する。
 * 事業所/月 selector は親 page に統一されているのでこの section 内には持たない。
 *
 * 表示:
 *   - ケアマネ全員について出勤簿集計 (日数・時間・出張km)
 *   - 給与: kyotaku-calc.calcSalary で計算した本人給/職能給/固定残業/資格/勤続/特定処遇
 *     + プラン/加算/調整①②/出張手当 + 支給合計を表示
 *
 * データソース: live (DB 都度集計)。
 */

// =====================================================================
// 型
// =====================================================================

type Props = {
  /** 選択中の office id (payroll_offices.id)。空文字なら "事業所未選択" 表示 */
  officeId: string;
  /** 対象月 YYYY-MM */
  month: string;
  /** 週起算曜日 (0=日, ..., 6=土)。office.work_week_start を親から渡す */
  weekStart: number;
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
  /** 介護費 単価 (円/単位)。プラン手当の base 計算用 */
  kyotaku_kaigo_rate: number | null;
  /** 予防支援費 単価 (円/単位) */
  kyotaku_shien_rate: number | null;
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
  // プラン/加算/調整 (kyotaku-calc.calcSalary 由来)
  plan: number;
  kazan: number;
  chosei1: number;
  chosei2: number;
  business_trip_teate: number;
  /** 給与合計 (= 基本給 + 各種手当 + プラン + 加算 + 調整 + 出張手当) */
  total: number;
};

// =====================================================================
// 補助関数
// =====================================================================

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

export function KyotakuSummarySection({ officeId, month, weekStart }: Props) {
  const [rows, setRows] = useState<SummaryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ─── 集計 fetch (officeId / month が変わるたび) ───
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- office/month 切替の async fetch */
    if (!officeId) {
      setRows([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        // 1) office の employee 一覧 + 国保連 records + master 系 + 予防支援 + 出張単価
        // 国保連 records (plan/kazan/chosei の計算には service_month 全期間が必要)
        // service_units / regional_rates は tenant 共通
        // yobou_records は予防支援件数 (オプション)
        // office travel_unit_price は出張距離手当の単価
        const [empRes, recRes, unitRes, rateRes, yobouRes, officeRes] = await Promise.all([
          supabase
            .from("payroll_employees")
            .select(
              "id, employee_number, name, role_type, kyotaku_honnin_kyu, kyotaku_shokuno_kyu, kyotaku_kotei_zangyo, kyotaku_shikaku_teate, kyotaku_kotei, kyotaku_tokutei_shogu, kyotaku_kaigo_rate, kyotaku_shien_rate, office:payroll_offices!office_id(office_number)",
            )
            .eq("office_id", officeId)
            .order("name"),
          supabase
            .from("payroll_kyotaku_records")
            .select("*")
            .limit(10000),
          supabase.from("payroll_kyotaku_service_units").select("*"),
          supabase.from("payroll_kyotaku_regional_rates").select("*"),
          supabase
            .from("payroll_kyotaku_yobou_records")
            .select("*"),
          supabase
            .from("payroll_offices")
            .select("office_number, travel_unit_price")
            .eq("id", officeId)
            .single(),
        ]);
        if (cancelled) return;
        if (empRes.error) throw empRes.error;
        type RawEmployee = EmployeeRow & {
          office?: { office_number: string | null } | null;
        };
        const rawEmployees = (empRes.data ?? []) as unknown as RawEmployee[];
        const employees: EmployeeRow[] = rawEmployees;
        if (employees.length === 0) {
          setRows([]);
          return;
        }
        const empIds = employees.map((e) => e.id);
        const officeNumber =
          (officeRes.data as { office_number?: string | null } | null)?.office_number ?? "";
        const travelRate = (() => {
          const v = (officeRes.data as { travel_unit_price?: number | string | null } | null)?.travel_unit_price;
          if (v === null || v === undefined) return 0;
          const n = typeof v === "string" ? parseFloat(v) : v;
          return Number.isFinite(n) ? n : 0;
        })();

        // 2) 月跨ぎ週も含めて拡張範囲で出勤簿 fetch (週次残業を正しく計算)
        const { start: extStart, end: extEnd } = extendedMonthRange(month, weekStart);
        const { data: attData, error: attErr } = await supabase
          .from("payroll_kyotaku_attendance_records")
          .select(
            "employee_id, work_date, start_time, end_time, break_minutes, is_legal_holiday, paid_leave_type, is_paid_leave, business_km, substitute_for_date",
          )
          .in("employee_id", empIds)
          .gte("work_date", extStart)
          .lte("work_date", extEnd);
        if (cancelled) return;
        if (attErr) throw attErr;
        const attRows = (attData ?? []) as AttendanceDbRow[];

        // 3) employee_id → 出勤 record list でグルーピング
        const byEmp = new Map<string, AttendanceDbRow[]>();
        for (const r of attRows) {
          if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, []);
          byEmp.get(r.employee_id)!.push(r);
        }

        // 4) calcSalary 用 config を構築
        //    settings: EmployeeSetting[] (staff_name で引く)
        const settings: EmployeeSetting[] = employees.map((e) => ({
          staff_name: e.name,
          honnin_kyu: e.kyotaku_honnin_kyu,
          shokuno_kyu: e.kyotaku_shokuno_kyu,
          kotei_zangyo: e.kyotaku_kotei_zangyo,
          shikaku_teate: e.kyotaku_shikaku_teate,
          kotei: e.kyotaku_kotei,
          tokutei_shogu: e.kyotaku_tokutei_shogu,
          kaigo_rate: e.kyotaku_kaigo_rate,
          shien_rate: e.kyotaku_shien_rate,
        }));

        // kyotaku_records / yobou は当該 office に絞る (limit ガード)
        const allKyotakuRecords = ((recRes.data ?? []) as unknown[]).filter(
          (r) => (r as { office_number?: string }).office_number === officeNumber,
        ) as KyotakuRecord[];
        const allYobou = ((yobouRes.error ? [] : yobouRes.data) ?? []).filter(
          (r) => (r as { office_number?: string }).office_number === officeNumber,
        ) as YobouRecord[];

        // calcSalary に渡す attendance は staff_name 付き (= employee_id → name 解決済)
        // 当該 office の全 employee 分まとめて。
        const attendanceForCalc: KyotakuAttendanceRecord[] = [];
        for (const ar of attRows) {
          const emp = employees.find((e) => e.id === ar.employee_id);
          if (!emp) continue;
          const km =
            typeof ar.business_km === "string"
              ? parseFloat(ar.business_km)
              : ar.business_km;
          if (km === null || km === undefined || !Number.isFinite(km) || km <= 0) continue;
          attendanceForCalc.push({
            staff_name: emp.name,
            work_date: ar.work_date,
            business_km: km,
          });
        }

        const calcConfig: CalcConfig = {
          settings,
          units: (unitRes.data ?? []) as ServiceUnit[],
          rates: (rateRes.data ?? []) as RegionalRate[],
          yobouRecords: allYobou,
          attendanceRecords: attendanceForCalc,
          officeTravelUnitPrice: travelRate,
        };

        // 5) 各 employee で集計 (出勤簿 + 給与計算)
        const result: SummaryRow[] = employees.map((emp) => {
          const empAttRows = byEmp.get(emp.id) ?? [];
          const records = empAttRows.map(dbToAttendanceRecord);
          const dailies = calcDailyListWithWeekly(records, weekStart);
          const summary = calcMonthlySummary(records, weekStart, month);
          const workDays = dailies.filter(
            (d) => d.work_minutes > 0 && d.work_date.startsWith(month),
          ).length;
          let businessKmTotal = 0;
          for (const r of empAttRows) {
            if (!r.work_date.startsWith(month)) continue;
            const km = r.business_km;
            if (km === null || km === undefined || km === "") continue;
            const n = typeof km === "string" ? parseFloat(km) : km;
            if (Number.isFinite(n) && n > 0) businessKmTotal += n;
          }
          businessKmTotal = Math.round(businessKmTotal * 10) / 10;

          // 給与計算 (kyotaku-calc)
          const breakdown = calcSalary(allKyotakuRecords, emp.name, month, calcConfig);

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
            honnin: breakdown.honnin,
            shokuno: breakdown.shokuno,
            kotei_zangyo: breakdown.kotei_zangyo,
            shikaku: breakdown.shikaku,
            kotei: breakdown.kotei,
            tokutei: breakdown.tokutei,
            plan: breakdown.plan,
            kazan: breakdown.kazan,
            chosei1: breakdown.chosei1,
            chosei2: breakdown.chosei2,
            business_trip_teate: breakdown.business_trip_teate,
            total: breakdown.total,
          };
        });
        if (!cancelled) setRows(result);
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          setErr(`集計の取得に失敗: ${msg}`);
          setRows([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [officeId, month, weekStart]);

  // 合計
  const grandTotal = rows.reduce((s, r) => s + r.total, 0);

  return (
    <div className="border rounded-md overflow-hidden mb-6">
      <div className="bg-muted/40 px-3 py-2 text-sm font-medium">
        居宅介護支援 ({rows.length}名)
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
              <th className="px-3 py-2 font-medium text-right" title="プラン手当 (件数連動、T+1 払い)">プラン</th>
              <th className="px-3 py-2 font-medium text-right" title="加算手当 (件数連動、T+1 払い)">加算</th>
              <th className="px-3 py-2 font-medium text-right" title="調整手当① (late1 起源、T+2 払い)">調整①</th>
              <th className="px-3 py-2 font-medium text-right" title="調整手当② (late2 起源、T+3 払い)">調整②</th>
              <th className="px-3 py-2 font-medium text-right" title="出張距離手当 (= 出張km合計 × office.travel_unit_price)">出張手当</th>
              <th className="px-3 py-2 font-medium text-right">支給合計</th>
            </tr>
          </thead>
          <tbody>
            {!officeId ? (
              <tr>
                <td colSpan={24} className="text-center text-muted-foreground py-4">
                  事業所を選択してください
                </td>
              </tr>
            ) : loading ? (
              <tr>
                <td colSpan={24} className="text-center text-muted-foreground py-4">
                  読み込み中...
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={24} className="text-center text-muted-foreground py-4">
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
                    <td className="px-3 py-1.5 text-right">{yen(r.plan)}</td>
                    <td className="px-3 py-1.5 text-right">{yen(r.kazan)}</td>
                    <td className="px-3 py-1.5 text-right">{yen(r.chosei1)}</td>
                    <td className="px-3 py-1.5 text-right">{yen(r.chosei2)}</td>
                    <td className="px-3 py-1.5 text-right">{yen(r.business_trip_teate)}</td>
                    <td className="px-3 py-1.5 text-right font-bold">{r.total.toLocaleString("ja-JP")}円</td>
                  </tr>
                ))}
                <tr className="border-t bg-muted/10 font-semibold">
                  <td colSpan={23} className="px-3 py-1.5 text-right">合計</td>
                  <td className="px-3 py-1.5 text-right">{grandTotal.toLocaleString("ja-JP")}円</td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-2 text-xs text-muted-foreground border-t">
        ※ 支給合計 = 本人給 + 職能給 + 固定残業 + 資格 + 勤続 + 特定処遇
        + プラン + 加算 + 調整① + 調整② + 出張手当 (kyotaku-calc.calcSalary 由来)。
        対象月 = サービス提供月。プラン/加算/調整の確定は給与計算ページから。
      </div>
    </div>
  );
}
