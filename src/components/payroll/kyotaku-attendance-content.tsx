"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { OFFICE_MASTER_JOIN, flattenOfficeMaster } from "@/types/database";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import {
  calcDailyListWithWeekly,
  calcMonthlySummary,
  formatHM,
  type AttendanceRecord,
} from "@/lib/payroll/attendance-calc";
import {
  exportKyotakuAttendanceCsv,
  parseKyotakuAttendanceCsv,
  type KyotakuAttendanceCsvRow,
} from "@/lib/csv/kyotaku-attendance-parser";

/**
 * 居宅介護支援ケアマネ 出勤簿入力画面
 *
 * 仕様:
 *   - 事業所 dropdown (office_type='居宅介護支援' 全件)
 *   - スタッフ dropdown (選択 office の payroll_employees)
 *   - 月選択 (前月/次月 + default 当月)
 *   - 月の全日 (1〜末日) row 表示。曜日も計算。
 *   - 出勤/退勤: type="time" / 休憩: 分 / 法定休日 / 有給 / 備考
 *   - 実労働 / 残業 / 深夜: calcDaily 結果を display only
 *   - 合計行: calcMonthlySummary
 *   - 保存: 変更行のみ upsert (UNIQUE: employee_id, work_date)
 *   - DB 未 apply 段階 (table 無い) は error 握り潰し → 空 array fallback
 */

// =====================================================================
// 型定義
// =====================================================================

type KyotakuOffice = {
  id: string;
  office_number: string;
  short_name: string;
  name: string;
  /** 1週間の起算曜日 (0=日, 1=月, ..., 6=土)。法定休日 auto-detect と週次残業の週境界に使用 */
  work_week_start: number;
};

type EmployeeRow = {
  id: string;
  name: string;
  office_id: string;
};

/** DB row (payroll_kyotaku_attendance_records) */
type AttendanceRow = {
  id?: string;
  tenant_id: string;
  office_id: string;
  employee_id: string;
  work_date: string;       // YYYY-MM-DD
  start_time: string | null;  // HH:mm:ss or null
  end_time: string | null;
  break_minutes: number;
  is_legal_holiday: boolean;
  is_paid_leave: boolean;
  note: string | null;
  /** 出張距離 (km)。NULL/0 は出張なし */
  business_km: number | null;
};

/** UI 上の 1 行 state (HH:mm 形式で保持) */
type RowState = {
  work_date: string;
  dow: number;
  start_time: string;       // "HH:mm" or ""
  end_time: string;         // "HH:mm" or ""
  break_minutes: number;
  is_legal_holiday: boolean;
  is_paid_leave: boolean;
  note: string;
  /** 出張距離 (km)、空 = NULL。文字列で保持して step=0.1 の入力を素直に通す */
  business_km: string;
  dirty: boolean;
  existing_id: string | null;
};

const TENANT_ID = "kt-group";
const WEEK_DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const DOW_COLOR: Record<number, string> = {
  0: "text-red-600",
  6: "text-blue-600",
};

// =====================================================================
// 補助関数
// =====================================================================

/** 当月 YYYY-MM */
function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** YYYY-MM の前月/次月 (delta = -1 or +1) */
function shiftMonth(ym: string, delta: number): string {
  const [yStr, mStr] = ym.split("-");
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return ym;
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** YYYY-MM → [{ date: YYYY-MM-DD, dow: 0-6 }] の月の全日 list (UTC で計算) */
function monthDates(ym: string): { date: string; dow: number }[] {
  const [yStr, mStr] = ym.split("-");
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return [];
  const out: { date: string; dow: number }[] = [];
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  for (let d = 1; d <= lastDay; d++) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    out.push({
      date: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
      dow: dt.getUTCDay(),
    });
  }
  return out;
}

/** YYYY-MM → "YYYY年MM月" */
function fmtMonthLabel(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  return `${m[1]}年${m[2]}月`;
}

/** DB の time 列 ("HH:mm:ss") を UI 用 "HH:mm" に */
function toUiTime(s: string | null): string {
  if (!s) return "";
  // "HH:mm" / "HH:mm:ss" 両対応
  const m = /^(\d{1,2}):(\d{1,2})/.exec(s);
  if (!m) return "";
  return `${String(parseInt(m[1], 10)).padStart(2, "0")}:${String(parseInt(m[2], 10)).padStart(2, "0")}`;
}

/** UI "HH:mm" → DB "HH:mm:00" (空文字は null) */
function toDbTime(s: string): string | null {
  const trim = s.trim();
  if (!trim) return null;
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(trim);
  if (!m) return null;
  return `${String(parseInt(m[1], 10)).padStart(2, "0")}:${String(parseInt(m[2], 10)).padStart(2, "0")}:00`;
}

/** UI row → calc lib 用 AttendanceRecord */
function toAttendanceRecord(row: RowState): AttendanceRecord {
  return {
    work_date: row.work_date,
    start_time: row.start_time || null,
    end_time: row.end_time || null,
    break_minutes: row.break_minutes,
    is_legal_holiday: row.is_legal_holiday,
    is_paid_leave: row.is_paid_leave,
  };
}

// =====================================================================
// Main Component
// =====================================================================

export function KyotakuAttendanceContent() {
  const [offices, setOffices] = useState<KyotakuOffice[]>([]);
  const [officeLoading, setOfficeLoading] = useState(true);
  const [selectedOfficeId, setSelectedOfficeId] = useState<string>("");

  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>("");

  const [month, setMonth] = useState<string>(() => currentMonth());

  const [rows, setRows] = useState<RowState[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // CSV 取込用の hidden input ref
  const csvInputRef = useRef<HTMLInputElement>(null);

  // ---------------- offices 初期 fetch ----------------
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

  // ---------------- employees (office 変更時) fetch ----------------
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- office 切替に応じた async fetch */
    if (!selectedOfficeId) {
      setEmployees([]);
      setSelectedEmployeeId("");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .from("payroll_employees")
          .select("id, name, office_id")
          .eq("office_id", selectedOfficeId)
          .order("name");
        if (cancelled) return;
        if (error) throw error;
        const list = (data ?? []) as EmployeeRow[];
        setEmployees(list);
        // 選択中 employee が新 office に居なければクリア
        if (!list.some((e) => e.id === selectedEmployeeId)) {
          setSelectedEmployeeId("");
        }
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          setErr(`職員一覧の取得に失敗: ${msg}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOfficeId]);

  // ---------------- 月 row build + DB 読み込み ----------------
  const dates = useMemo(() => monthDates(month), [month]);

  const loadRows = useCallback(async () => {
    // 月の全日空 row を必ず作る (DB 未登録でも入力可能)
    // is_legal_holiday は user の checkbox 操作 or calcDailyListWithWeekly の
    // 「週内に休みが 1 日も無い時 = 最終労働日が法定休日扱い」自動判定で決まる。
    const baseRows: RowState[] = dates.map(({ date, dow }) => ({
      work_date: date,
      dow,
      start_time: "",
      end_time: "",
      break_minutes: 0,
      is_legal_holiday: false,
      is_paid_leave: false,
      note: "",
      business_km: "",
      dirty: false,
      existing_id: null,
    }));

    if (!selectedEmployeeId || dates.length === 0) {
      setRows(baseRows);
      return;
    }

    setLoading(true);
    setErr(null);
    try {
      const monthStart = dates[0].date;
      const monthEnd = dates[dates.length - 1].date;
      const { data, error } = await supabase
        .from("payroll_kyotaku_attendance_records")
        .select("*")
        .eq("employee_id", selectedEmployeeId)
        .gte("work_date", monthStart)
        .lte("work_date", monthEnd);
      // table 未 apply 時は error 握り潰し → 空 fallback
      if (error) {
        setRows(baseRows);
        return;
      }
      const byDate = new Map<string, AttendanceRow>();
      for (const r of (data ?? []) as AttendanceRow[]) {
        byDate.set(r.work_date, r);
      }
      const merged = baseRows.map((br) => {
        const ex = byDate.get(br.work_date);
        if (!ex) return br;
        // business_km は NUMERIC なので number / 文字列 両対応で取得
        const rawKm = (ex as { business_km?: number | string | null }).business_km;
        let businessKmStr = "";
        if (rawKm !== null && rawKm !== undefined && rawKm !== "") {
          const n = typeof rawKm === "string" ? parseFloat(rawKm) : rawKm;
          if (Number.isFinite(n)) businessKmStr = String(n);
        }
        return {
          ...br,
          start_time: toUiTime(ex.start_time),
          end_time: toUiTime(ex.end_time),
          break_minutes: ex.break_minutes ?? 0,
          is_legal_holiday: !!ex.is_legal_holiday,
          is_paid_leave: !!ex.is_paid_leave,
          note: ex.note ?? "",
          business_km: businessKmStr,
          dirty: false,
          existing_id: ex.id ?? null,
        };
      });
      setRows(merged);
    } catch (e) {
      // 例外時も空 row で入力可能にする
      const msg = e instanceof Error ? e.message : String(e);
      setErr(`出勤データの取得に失敗: ${msg}`);
      setRows(baseRows);
    } finally {
      setLoading(false);
    }
  }, [selectedEmployeeId, dates]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- employee/month 切替の async fetch */
    void loadRows();
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [loadRows]);

  // ---------------- 行更新 helper ----------------
  const updateRow = (idx: number, patch: Partial<RowState>): void => {
    setRows((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch, dirty: true };
      return next;
    });
  };

  // ---------------- 表示用 計算済 list ----------------
  // 週次残業按分 + 法定休日 auto-detect (労基 §35) には事業所の週起算曜日が必要。
  // 未選択 / 未取得時は 0 (日曜起算) を default にする。
  const selectedOfficeWeekStart = useMemo(() => {
    const o = offices.find((x) => x.id === selectedOfficeId);
    return o?.work_week_start ?? 0;
  }, [offices, selectedOfficeId]);

  // 週次残業按分込みで日次残業 + 週次残業を行に表示できるよう calcDailyListWithWeekly を使用
  const dailyCalcs = useMemo(
    () => calcDailyListWithWeekly(rows.map(toAttendanceRecord), selectedOfficeWeekStart),
    [rows, selectedOfficeWeekStart],
  );
  const monthSummary = useMemo(
    () => calcMonthlySummary(rows.map(toAttendanceRecord), selectedOfficeWeekStart),
    [rows, selectedOfficeWeekStart],
  );
  /** 月合計 出張距離 (km、小数 1 桁) */
  const totalBusinessKm = useMemo(() => {
    let sum = 0;
    for (const r of rows) {
      const trimmed = r.business_km.trim();
      if (!trimmed) continue;
      const n = parseFloat(trimmed);
      if (Number.isFinite(n) && n > 0) sum += n;
    }
    return Math.round(sum * 10) / 10;
  }, [rows]);

  // ---------------- 保存 ----------------
  const handleSave = async () => {
    if (!selectedOfficeId || !selectedEmployeeId) {
      toast.error("事業所とスタッフを選択してください");
      return;
    }
    const dirtyRows = rows.filter((r) => r.dirty);
    if (dirtyRows.length === 0) {
      toast.info("変更はありません");
      return;
    }
    setSaving(true);
    try {
      const upsertRows: AttendanceRow[] = dirtyRows.map((r) => {
        // business_km は空 → NULL、数値 → 0 以上の number に丸めて保存 (NUMERIC(6,1))
        let businessKm: number | null = null;
        const trimmed = r.business_km.trim();
        if (trimmed) {
          const n = parseFloat(trimmed);
          if (Number.isFinite(n) && n >= 0) {
            businessKm = Math.round(n * 10) / 10;
          }
        }
        return {
          tenant_id: TENANT_ID,
          office_id: selectedOfficeId,
          employee_id: selectedEmployeeId,
          work_date: r.work_date,
          start_time: toDbTime(r.start_time),
          end_time: toDbTime(r.end_time),
          break_minutes: Math.max(0, Math.floor(r.break_minutes || 0)),
          is_legal_holiday: r.is_legal_holiday,
          is_paid_leave: r.is_paid_leave,
          note: r.note.trim() ? r.note : null,
          business_km: businessKm,
        };
      });
      const { error } = await supabase
        .from("payroll_kyotaku_attendance_records")
        .upsert(upsertRows, { onConflict: "employee_id,work_date" });
      if (error) throw error;
      toast.success(`${dirtyRows.length}件 保存しました`);
      // 再読み込み (existing_id / dirty=false を更新)
      await loadRows();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`保存に失敗: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  // ---------------- CSV 出力 ----------------
  const selectedEmployee = useMemo(
    () => employees.find((e) => e.id === selectedEmployeeId) ?? null,
    [employees, selectedEmployeeId],
  );

  const handleCsvExport = useCallback(() => {
    if (!selectedEmployee) {
      toast.error("事業所とスタッフを選択してください");
      return;
    }
    if (rows.length === 0) {
      toast.error("出力対象の行がありません");
      return;
    }
    try {
      const csvRows: KyotakuAttendanceCsvRow[] = rows.map((r) => ({
        work_date: r.work_date,
        start_time: r.start_time,
        end_time: r.end_time,
        break_minutes: r.break_minutes,
        is_legal_holiday: r.is_legal_holiday,
        is_paid_leave: r.is_paid_leave,
        note: r.note,
        business_km: r.business_km,
      }));
      exportKyotakuAttendanceCsv({
        rows: csvRows,
        staffName: selectedEmployee.name,
        month,
      });
      toast.success("CSV を出力しました");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`CSV 出力に失敗: ${msg}`);
    }
  }, [rows, selectedEmployee, month]);

  // ---------------- CSV 取込 ----------------
  const handleCsvImportClick = useCallback(() => {
    if (!selectedEmployee) {
      toast.error("事業所とスタッフを選択してください");
      return;
    }
    csvInputRef.current?.click();
  }, [selectedEmployee]);

  const handleCsvFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // input をリセットして同じ file 再選択を可能に
      if (csvInputRef.current) csvInputRef.current.value = "";
      if (!file) return;
      const result = await parseKyotakuAttendanceCsv(file, month);
      if (!result.success || result.rows.length === 0) {
        const head = result.errors.slice(0, 3).join(" / ");
        const rest =
          result.errors.length > 3
            ? ` (他 ${result.errors.length - 3} 件)`
            : "";
        toast.error(`CSV 取込に失敗: ${head || "データなし"}${rest}`);
        return;
      }
      // detectedMonth と表示中の月が一致するかも一応 check
      if (result.detectedMonth && result.detectedMonth !== month) {
        toast.error(
          `CSV の月 ${result.detectedMonth} が現在の対象月 ${month} と一致しません`,
        );
        return;
      }
      // CSV row を date 引きの map に
      const byDate = new Map(result.rows.map((r) => [r.work_date, r]));
      setRows((prev) =>
        prev.map((p) => {
          const hit = byDate.get(p.work_date);
          if (!hit) return p;
          return {
            ...p,
            start_time: hit.start_time,
            end_time: hit.end_time,
            break_minutes: hit.break_minutes,
            is_legal_holiday: hit.is_legal_holiday,
            is_paid_leave: hit.is_paid_leave,
            note: hit.note,
            business_km: hit.business_km,
            dirty: true,
          };
        }),
      );
      const warning =
        result.errors.length > 0
          ? ` (警告 ${result.errors.length} 件あり)`
          : "";
      toast.success(
        `${result.rows.length} 件 反映しました。保存ボタンで確定してください${warning}`,
      );
    },
    [month],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">出勤簿 <span className="text-base font-normal text-muted-foreground">(居宅介護支援)</span></h2>
      </div>

      {err && (
        <div className="rounded-md border border-destructive bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {err}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">対象選択</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">事業所</label>
              <select
                className="rounded-md border bg-background px-3 py-2 text-sm min-w-[240px]"
                value={selectedOfficeId}
                onChange={(e) => setSelectedOfficeId(e.target.value)}
                disabled={officeLoading}
              >
                <option value="">
                  {officeLoading ? "読み込み中..." : "事業所を選択"}
                </option>
                {offices.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.short_name || o.name || o.office_number}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">スタッフ</label>
              <select
                className="rounded-md border bg-background px-3 py-2 text-sm min-w-[200px]"
                value={selectedEmployeeId}
                onChange={(e) => setSelectedEmployeeId(e.target.value)}
                disabled={!selectedOfficeId || employees.length === 0}
              >
                <option value="">
                  {!selectedOfficeId
                    ? "事業所を先に選択"
                    : employees.length === 0
                      ? "職員なし"
                      : "スタッフを選択"}
                </option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">対象月</label>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setMonth((m) => shiftMonth(m, -1))}
                >
                  ← 前月
                </Button>
                <div className="text-sm font-medium min-w-[6em] text-center">
                  {fmtMonthLabel(month)}
                </div>
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
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">CSV</label>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCsvExport}
                  disabled={!selectedEmployeeId || rows.length === 0}
                  title="現在の出勤簿を CSV (Shift-JIS) でダウンロード"
                >
                  <Download className="mr-1 h-4 w-4" />
                  CSV 出力
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCsvImportClick}
                  disabled={!selectedEmployeeId}
                  title="編集済 CSV (Shift-JIS) を取込んで入力欄に反映"
                >
                  <Upload className="mr-1 h-4 w-4" />
                  CSV 取込
                </Button>
                <input
                  ref={csvInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={handleCsvFileSelected}
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">
            出勤簿
            {selectedEmployee && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {selectedEmployee.name} / {fmtMonthLabel(month)}
              </span>
            )}
          </CardTitle>
          <Button
            onClick={handleSave}
            disabled={saving || !selectedEmployeeId || rows.every((r) => !r.dirty)}
          >
            {saving ? "保存中..." : "保存"}
          </Button>
        </CardHeader>
        <CardContent>
          {loading && (
            <p className="text-sm text-muted-foreground mb-2">読み込み中...</p>
          )}
          {!selectedEmployeeId && !loading && (
            <p className="text-sm text-muted-foreground">
              事業所とスタッフを選択すると入力欄が表示されます。
            </p>
          )}
          {selectedEmployeeId && (
            <div className="overflow-x-auto">
              <Table className="text-sm">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10 text-center">日</TableHead>
                    <TableHead className="w-10 text-center">曜</TableHead>
                    <TableHead className="w-24">出勤</TableHead>
                    <TableHead className="w-24">退勤</TableHead>
                    <TableHead className="w-20 text-right">休憩</TableHead>
                    <TableHead className="w-20 text-right">実労働</TableHead>
                    <TableHead className="w-20 text-right">残業</TableHead>
                    <TableHead className="w-20 text-right">深夜</TableHead>
                    <TableHead className="w-16 text-center">法休</TableHead>
                    <TableHead className="w-20 text-right" title="法定休日出勤時間 (法休✓ 時のみ集計)">法休勤務</TableHead>
                    <TableHead className="w-14 text-center">有給</TableHead>
                    <TableHead className="w-24 text-right">出張距離(km)</TableHead>
                    <TableHead>備考</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row, idx) => {
                    const day = parseInt(row.work_date.slice(8, 10), 10);
                    const calc = dailyCalcs[idx];
                    const dowColor = DOW_COLOR[row.dow] ?? "";
                    return (
                      <TableRow
                        key={row.work_date}
                        className={row.dirty ? "bg-amber-50" : ""}
                      >
                        <TableCell className="text-center">{day}</TableCell>
                        <TableCell className={`text-center ${dowColor}`}>
                          {WEEK_DAY_LABELS[row.dow]}
                        </TableCell>
                        <TableCell>
                          <Input
                            type="time"
                            value={row.start_time}
                            onChange={(e) =>
                              updateRow(idx, { start_time: e.target.value })
                            }
                            className="h-8"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="time"
                            value={row.end_time}
                            onChange={(e) =>
                              updateRow(idx, { end_time: e.target.value })
                            }
                            className="h-8"
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <Input
                            type="time"
                            value={(() => {
                              const m = row.break_minutes || 0;
                              const h = Math.floor(m / 60);
                              const mm = m % 60;
                              return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
                            })()}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (!v) {
                                updateRow(idx, { break_minutes: 0 });
                                return;
                              }
                              const [h, mm] = v.split(":").map(Number);
                              const total = (h || 0) * 60 + (mm || 0);
                              updateRow(idx, { break_minutes: Math.max(0, total) });
                            }}
                            className="h-8"
                          />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {calc.work_minutes > 0 ? formatHM(calc.work_minutes) : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {(() => {
                            const d = calc.daily_overtime;
                            const w = calc.weekly_overtime;
                            const total = d + w;
                            if (total === 0) return "—";
                            // 日次/週次の内訳を tooltip で示し、表示は合計
                            const breakdown =
                              d > 0 && w > 0
                                ? `日次 ${formatHM(d)} + 週次 ${formatHM(w)}`
                                : d > 0
                                ? `日次残業`
                                : `週次残業 (週40h超過按分)`;
                            return (
                              <span title={breakdown}>
                                {formatHM(total)}
                                {w > 0 && (
                                  <span className="ml-0.5 text-[10px] text-purple-600 align-top">週</span>
                                )}
                              </span>
                            );
                          })()}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {calc.midnight_overtime > 0
                            ? formatHM(calc.midnight_overtime)
                            : "—"}
                        </TableCell>
                        <TableCell className="text-center">
                          <input
                            type="checkbox"
                            checked={row.is_legal_holiday}
                            onChange={(e) =>
                              updateRow(idx, { is_legal_holiday: e.target.checked })
                            }
                          />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {(() => {
                            // 法休勤務: manual ✓ or auto-detect (週内に休み無し = 最終日)。
                            // auto-detect の場合は ✓ off でも holiday_work が積まれているので
                            // 「(自動)」マークを付けて区別する。
                            if (calc.holiday_work <= 0) return "—";
                            const isAuto = !row.is_legal_holiday;
                            return (
                              <span
                                title={
                                  isAuto
                                    ? "週内に休み無し → 労基§35 により最終日を法定休日扱い (自動判定)"
                                    : "法定休日出勤 (チェック指定)"
                                }
                              >
                                {formatHM(calc.holiday_work)}
                                {isAuto && (
                                  <span className="ml-0.5 text-[10px] text-orange-600 align-top">自動</span>
                                )}
                              </span>
                            );
                          })()}
                        </TableCell>
                        <TableCell className="text-center">
                          <input
                            type="checkbox"
                            checked={row.is_paid_leave}
                            onChange={(e) =>
                              updateRow(idx, { is_paid_leave: e.target.checked })
                            }
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <Input
                            type="number"
                            min={0}
                            step={0.1}
                            value={row.business_km}
                            onChange={(e) =>
                              updateRow(idx, { business_km: e.target.value })
                            }
                            className="h-8 text-right"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="text"
                            value={row.note}
                            onChange={(e) =>
                              updateRow(idx, { note: e.target.value })
                            }
                            className="h-8"
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <div className="mt-3 flex flex-wrap gap-4 text-sm">
                <span>
                  実労働{" "}
                  <span className="font-semibold tabular-nums">
                    {formatHM(monthSummary.total_work)}
                  </span>
                </span>
                <span>
                  日次残業{" "}
                  <span className="font-semibold tabular-nums">
                    {formatHM(monthSummary.total_daily_overtime)}
                  </span>
                </span>
                <span>
                  週次残業{" "}
                  <span className="font-semibold tabular-nums">
                    {formatHM(monthSummary.total_weekly_overtime)}
                  </span>
                </span>
                <span>
                  深夜{" "}
                  <span className="font-semibold tabular-nums">
                    {formatHM(monthSummary.total_midnight)}
                  </span>
                </span>
                <span>
                  法定休日{" "}
                  <span className="font-semibold tabular-nums">
                    {formatHM(monthSummary.total_holiday)}
                  </span>
                </span>
                <span>
                  有給{" "}
                  <span className="font-semibold tabular-nums">
                    {monthSummary.total_paid_leave_days}日
                  </span>
                </span>
                <span>
                  総距離{" "}
                  <span className="font-semibold tabular-nums">
                    {totalBusinessKm.toFixed(1)} km
                  </span>
                </span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
