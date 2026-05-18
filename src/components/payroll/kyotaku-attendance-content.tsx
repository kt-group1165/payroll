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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MonthInputButton } from "@/components/ui/month-input-button";
import { toast } from "sonner";
import {
  calcDailyListWithWeekly,
  calcMonthlySummary,
  extendedMonthRange,
  formatHM,
  minutesBetween,
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
  is_paid_leave: boolean;  // legacy: paid_leave_type IS NOT NULL と同義。save 時に同期
  paid_leave_type: "full" | "half" | null;
  note: string | null;
  /** 出張距離 (km)。NULL/0 は出張なし */
  business_km: number | null;
  /** 振替元日付 (YYYY-MM-DD)。NULL = 振替ではない通常の出勤 */
  substitute_for_date: string | null;
};

/** UI 上の 1 行 state (HH:mm 形式で保持) */
type RowState = {
  work_date: string;
  dow: number;
  start_time: string;       // "HH:mm" or ""
  end_time: string;         // "HH:mm" or ""
  break_minutes: number;
  is_legal_holiday: boolean;
  /** 有給種別: null=なし / "full"=全 / "half"=半 */
  paid_leave_type: "full" | "half" | null;
  note: string;
  /** 出張距離 (km)、空 = NULL。文字列で保持して step=0.1 の入力を素直に通す */
  business_km: string;
  /** 振替元日付 ("YYYY-MM-DD" or "")。空 = 振替ではない通常の出勤 */
  substitute_for_date: string;
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
    paid_leave_type: row.paid_leave_type,
    substitute_for_date: row.substitute_for_date || null,
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
  /**
   * 月跨ぎ週の正しい週次残業計算のため、当月の前後の週に該当する隣接月の record を
   * 別途保持する (rows = 当月分のみ、UI 表示は当月のみ)。
   */
  const [neighborRecords, setNeighborRecords] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 振替 date picker modal: 編集対象 row index と一時 date state
  const [substituteModalIdx, setSubstituteModalIdx] = useState<number | null>(null);
  const [substituteModalDate, setSubstituteModalDate] = useState<string>("");

  // CSV 取込用の hidden input ref
  const csvInputRef = useRef<HTMLInputElement>(null);

  // ---------------- 未保存変更の離脱警告 ----------------
  // dirty な row が 1 件でもあれば、tab close / refresh / 別 URL 入力 / sidebar link click で警告
  const hasUnsavedChanges = useMemo(() => rows.some((r) => r.dirty), [rows]);

  /** 同 page 内 (事業所/スタッフ/月) 切替時、未保存なら confirm。OK なら遷移を許可 */
  const confirmIfDirty = useCallback((): boolean => {
    if (!hasUnsavedChanges) return true;
    return window.confirm(
      "保存されていない変更があります。切り替えるとデータが失われます。よろしいですか？",
    );
  }, [hasUnsavedChanges]);
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const message = "保存されていない変更があります。離れるとデータが失われます。よろしいですか？";
    // (1) ブラウザレベルのナビゲーション (refresh / close / 外部 URL 入力)
    const handleBeforeUnload = (e: BeforeUnloadEvent): string => {
      e.preventDefault();
      // 仕様上 returnValue を文字列にセットすると標準ダイアログが表示される
      // (現代ブラウザは内容を独自メッセージに置き換える)
      e.returnValue = message;
      return message;
    };
    // (2) 同 SPA 内の anchor (<a> / Next Link) クリック intercept
    // capture phase で Next の onClick より先に発火し、拒否なら preventDefault で遷移を止める
    const handleAnchorClick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const anchor = target.closest("a") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href) return;
      // ハッシュ内 link / 新規 tab はスキップ
      if (href.startsWith("#")) return;
      if (anchor.target === "_blank") return;
      // 同 origin かつ現在 URL と異なる場合のみ確認 (= 真のナビゲーション)
      try {
        const dest = new URL(href, window.location.href);
        if (dest.origin === window.location.origin && dest.href !== window.location.href) {
          if (!window.confirm(message)) {
            e.preventDefault();
            e.stopPropagation();
          }
        }
      } catch {
        // 不正な URL は無視
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("click", handleAnchorClick, true);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("click", handleAnchorClick, true);
    };
  }, [hasUnsavedChanges]);

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

  // 選択中 office の週起算曜日 (loadRows + 計算 両方で使用)
  const selectedOfficeWeekStart = useMemo(() => {
    const o = offices.find((x) => x.id === selectedOfficeId);
    return o?.work_week_start ?? 0;
  }, [offices, selectedOfficeId]);

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
      paid_leave_type: null,
      note: "",
      business_km: "",
      substitute_for_date: "",
      dirty: false,
      existing_id: null,
    }));

    if (!selectedEmployeeId || dates.length === 0) {
      setRows(baseRows);
      setNeighborRecords([]);
      return;
    }

    setLoading(true);
    setErr(null);
    try {
      const monthStart = dates[0].date;
      const monthEnd = dates[dates.length - 1].date;
      // 月跨ぎ週の週次残業計算のため拡張範囲で fetch
      const { start: extStart, end: extEnd } = extendedMonthRange(month, selectedOfficeWeekStart);
      const { data, error } = await supabase
        .from("payroll_kyotaku_attendance_records")
        .select("*")
        .eq("employee_id", selectedEmployeeId)
        .gte("work_date", extStart || monthStart)
        .lte("work_date", extEnd || monthEnd);
      // table 未 apply 時は error 握り潰し → 空 fallback
      if (error) {
        setRows(baseRows);
        setNeighborRecords([]);
        return;
      }
      const allRows = (data ?? []) as AttendanceRow[];
      // 当月分のみ byDate に、隣接月分は neighborRecords に分ける
      const byDate = new Map<string, AttendanceRow>();
      const neighbors: AttendanceRecord[] = [];
      for (const r of allRows) {
        if (r.work_date >= monthStart && r.work_date <= monthEnd) {
          byDate.set(r.work_date, r);
        } else {
          // 隣接月の records は calc 用に AttendanceRecord 形式に変換 (UI 表示しない)
          const paidLeaveType: "full" | "half" | null =
            r.paid_leave_type === "full" || r.paid_leave_type === "half"
              ? r.paid_leave_type
              : r.is_paid_leave
                ? "full"
                : null;
          neighbors.push({
            work_date: r.work_date,
            start_time: toUiTime(r.start_time) || null,
            end_time: toUiTime(r.end_time) || null,
            break_minutes: r.break_minutes ?? 0,
            is_legal_holiday: !!r.is_legal_holiday,
            paid_leave_type: paidLeaveType,
            substitute_for_date: r.substitute_for_date ?? null,
          });
        }
      }
      setNeighborRecords(neighbors);
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
        // paid_leave_type が NULL かつ is_paid_leave=true なら legacy (backfill 前) として "full" 扱い
        const paidLeaveType: "full" | "half" | null =
          ex.paid_leave_type === "full" || ex.paid_leave_type === "half"
            ? ex.paid_leave_type
            : ex.is_paid_leave
              ? "full"
              : null;
        return {
          ...br,
          start_time: toUiTime(ex.start_time),
          end_time: toUiTime(ex.end_time),
          break_minutes: ex.break_minutes ?? 0,
          is_legal_holiday: !!ex.is_legal_holiday,
          paid_leave_type: paidLeaveType,
          note: ex.note ?? "",
          business_km: businessKmStr,
          substitute_for_date: ex.substitute_for_date ?? "",
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
      setNeighborRecords([]);
    } finally {
      setLoading(false);
    }
  }, [selectedEmployeeId, dates, month, selectedOfficeWeekStart]);

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

  /**
   * 出勤/退勤を変更したときの patch を組み立てる helper。
   * 「両方の時刻が初めて揃った瞬間」だけ休憩のデフォルトを適用:
   *   - 拘束時間 (gross) >= 6h → break_minutes = 60 (1時間休憩前提)
   *   - 拘束時間 < 6h           → break_minutes = 0
   * 既に片方が入力済の状態で他方を変更しても休憩には触れない (= 手動設定を尊重)
   */
  const buildTimePatch = (
    row: RowState,
    field: "start_time" | "end_time",
    newValue: string,
  ): Partial<RowState> => {
    const patch: Partial<RowState> = { [field]: newValue };
    const oldValue = row[field];
    const newStart = field === "start_time" ? newValue : row.start_time;
    const newEnd = field === "end_time" ? newValue : row.end_time;
    // 初回 (両方の時刻が揃った瞬間) かつ 当該 field が空 → 空 だけでなく、
    // 「変更前 field が空文字」かつ「両方の新値が non-empty」のときだけ default 休憩を適用
    if (!oldValue && newValue && newStart && newEnd) {
      const grossMin = minutesBetween(newStart, newEnd);
      patch.break_minutes = grossMin >= 6 * 60 ? 60 : 0;
    }
    return patch;
  };

  // ---------------- 振替 modal handler ----------------
  /** 振替 checkbox toggle handler: ON で modal を開く / OFF で日付をクリア */
  const handleSubstituteToggle = (idx: number, checked: boolean): void => {
    if (checked) {
      // ON: 既存の値を modal の初期値に
      setSubstituteModalDate(rows[idx]?.substitute_for_date ?? "");
      setSubstituteModalIdx(idx);
    } else {
      // OFF: 振替 date を消す
      updateRow(idx, { substitute_for_date: "" });
    }
  };
  /** modal で日付確定 */
  const handleSubstituteConfirm = (): void => {
    if (substituteModalIdx === null) return;
    if (!substituteModalDate) {
      toast.error("日付を選択してください");
      return;
    }
    updateRow(substituteModalIdx, { substitute_for_date: substituteModalDate });
    setSubstituteModalIdx(null);
    setSubstituteModalDate("");
  };
  /** modal cancel: 既存の値が無ければ checkbox も結果的に off に戻る */
  const handleSubstituteCancel = (): void => {
    setSubstituteModalIdx(null);
    setSubstituteModalDate("");
  };

  // ---------------- 表示用 計算済 list ----------------
  // 週次残業按分 + 法定休日 auto-detect (労基 §35) には事業所の週起算曜日が必要。
  // 月跨ぎ週も完全計算するため、当月の rows と隣接月の neighborRecords を結合して
  // calcDailyListWithWeekly に渡す。出力は当月 row の work_date で引き直して使う。
  const combinedRecords = useMemo<AttendanceRecord[]>(() => {
    const main = rows.map(toAttendanceRecord);
    return [...neighborRecords, ...main].sort((a, b) =>
      a.work_date.localeCompare(b.work_date),
    );
  }, [rows, neighborRecords]);

  const allDailyCalcs = useMemo(
    () => calcDailyListWithWeekly(combinedRecords, selectedOfficeWeekStart),
    [combinedRecords, selectedOfficeWeekStart],
  );

  // 当月分の row index → daily calc を date 引きで対応付け
  const dailyCalcByDate = useMemo(() => {
    const m = new Map<string, (typeof allDailyCalcs)[number]>();
    for (let i = 0; i < combinedRecords.length; i++) {
      m.set(combinedRecords[i].work_date, allDailyCalcs[i]);
    }
    return m;
  }, [combinedRecords, allDailyCalcs]);

  /** rows と同じ順 = 当月日数分の DailyCalc 配列 (UI 行表示で index で参照) */
  const dailyCalcs = useMemo(
    () =>
      rows.map(
        (r) =>
          dailyCalcByDate.get(r.work_date) ?? {
            work_date: r.work_date,
            work_minutes: 0,
            daily_overtime: 0,
            weekly_overtime: 0,
            midnight_overtime: 0,
            holiday_work: 0,
            absence_minutes: 0,
            scheduled_minutes: 0,
          },
      ),
    [rows, dailyCalcByDate],
  );

  const monthSummary = useMemo(
    () =>
      calcMonthlySummary(combinedRecords, selectedOfficeWeekStart, month),
    [combinedRecords, selectedOfficeWeekStart, month],
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
          // legacy is_paid_leave は paid_leave_type IS NOT NULL と同義に保つ
          is_paid_leave: r.paid_leave_type !== null,
          paid_leave_type: r.paid_leave_type,
          note: r.note.trim() ? r.note : null,
          business_km: businessKm,
          substitute_for_date: r.substitute_for_date || null,
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

  // ---------------- 削除 (選択スタッフの当月分を全削除) ----------------
  const handleDelete = async (): Promise<void> => {
    if (!selectedOfficeId || !selectedEmployeeId) {
      toast.error("事業所とスタッフを選択してください");
      return;
    }
    if (dates.length === 0) return;
    const empName = employees.find((e) => e.id === selectedEmployeeId)?.name ?? "(未選択)";
    const monthLabel = fmtMonthLabel(month);
    if (
      !window.confirm(
        `${empName} さんの ${monthLabel} の出勤簿データを削除します。\nこの操作は取り消せません。よろしいですか？`,
      )
    ) {
      return;
    }
    setDeleting(true);
    try {
      const monthStart = dates[0].date;
      const monthEnd = dates[dates.length - 1].date;
      const { error, count } = await supabase
        .from("payroll_kyotaku_attendance_records")
        .delete({ count: "exact" })
        .eq("employee_id", selectedEmployeeId)
        .gte("work_date", monthStart)
        .lte("work_date", monthEnd);
      if (error) throw error;
      toast.success(`${count ?? 0} 件 削除しました`);
      // 削除後は再 loadRows() で空 baseRows に戻す
      await loadRows();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`削除に失敗: ${msg}`);
    } finally {
      setDeleting(false);
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
        paid_leave_type: r.paid_leave_type,
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
            paid_leave_type: hit.paid_leave_type,
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
                onChange={(e) => {
                  if (!confirmIfDirty()) return;
                  setSelectedOfficeId(e.target.value);
                }}
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
                onChange={(e) => {
                  if (!confirmIfDirty()) return;
                  setSelectedEmployeeId(e.target.value);
                }}
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
                  onClick={() => {
                    if (!confirmIfDirty()) return;
                    setMonth((m) => shiftMonth(m, -1));
                  }}
                >
                  ← 前月
                </Button>
                <MonthInputButton
                  value={month}
                  onChange={(next) => {
                    if (!confirmIfDirty()) return;
                    setMonth(next);
                  }}
                  formatLabel={fmtMonthLabel}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (!confirmIfDirty()) return;
                    setMonth((m) => shiftMonth(m, 1));
                  }}
                >
                  次月 →
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (!confirmIfDirty()) return;
                    setMonth(currentMonth());
                  }}
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
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={handleDelete}
              disabled={deleting || saving || !selectedEmployeeId}
              className="text-destructive border-destructive/40 hover:bg-destructive/10"
              title="選択スタッフ・対象月の出勤簿データを DB から削除します"
            >
              {deleting ? "削除中..." : "削除"}
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || deleting || !selectedEmployeeId || rows.every((r) => !r.dirty)}
            >
              {saving ? "保存中..." : "保存"}
            </Button>
          </div>
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
                    <TableHead className="w-28 text-center" title="振替出勤 (チェックすると振替元日付を選択するモーダルが開きます)">振替</TableHead>
                    <TableHead className="w-20 text-right" title="法定休日出勤時間 (週内に休み無し時の最終日を自動判定)">法休勤務</TableHead>
                    <TableHead className="w-14 text-center">有給</TableHead>
                    <TableHead className="w-20 text-right" title="所定労働時間 - 実労働 (土日祝/全有給は 0、半有給日は所定 4h で判定)">欠勤</TableHead>
                    <TableHead className="w-24 text-right">出張距離(km)</TableHead>
                    <TableHead>備考</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row, idx) => {
                    const day = parseInt(row.work_date.slice(8, 10), 10);
                    const calc = dailyCalcs[idx];
                    const dowColor = DOW_COLOR[row.dow] ?? "";
                    // 休み判定: 実労働 0 分 (= 出勤/退勤 未入力 or 同時刻)
                    // 表示: dirty (未保存) は amber 優先、それ以外で休みなら明確に gray-out
                    const isRest = calc.work_minutes === 0;
                    const rowClass = row.dirty
                      ? "bg-amber-50"
                      : isRest
                        ? "bg-slate-200/80 text-slate-500"
                        : "";
                    return (
                      <TableRow key={row.work_date} className={rowClass}>
                        <TableCell className="text-center">{day}</TableCell>
                        <TableCell className={`text-center ${dowColor}`}>
                          {WEEK_DAY_LABELS[row.dow]}
                        </TableCell>
                        <TableCell>
                          <Input
                            type="time"
                            value={row.start_time}
                            onChange={(e) =>
                              updateRow(idx, buildTimePatch(row, "start_time", e.target.value))
                            }
                            className="h-8"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="time"
                            value={row.end_time}
                            onChange={(e) =>
                              updateRow(idx, buildTimePatch(row, "end_time", e.target.value))
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
                          {/* 振替: checkbox ON で modal → 日付選択 → 表示 */}
                          <div className="flex flex-col items-center gap-0.5">
                            <input
                              type="checkbox"
                              checked={!!row.substitute_for_date}
                              onChange={(e) =>
                                handleSubstituteToggle(idx, e.target.checked)
                              }
                              title={
                                row.substitute_for_date
                                  ? `${row.substitute_for_date} の振替`
                                  : "チェックで振替元日付を選択"
                              }
                            />
                            {row.substitute_for_date && (
                              <button
                                type="button"
                                onClick={() => handleSubstituteToggle(idx, true)}
                                className="text-[10px] leading-tight text-blue-700 underline-offset-2 hover:underline"
                                title="クリックで日付を変更"
                              >
                                {row.substitute_for_date.slice(5).replace("-", "/")}
                                <span className="ml-0.5 text-muted-foreground">の振替</span>
                              </button>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {(() => {
                            // 法休勤務: auto-detect (週内に休み無し = 最終日) で自動算出。
                            // 振替出勤の場合は 法休 ではなく通常の労働時間扱い (auto-detect でも除外したいが、
                            // 現状は calc 側で auto-detect しているので一旦そのまま表示する)
                            if (calc.holiday_work <= 0) return "—";
                            return (
                              <span
                                title="週内に休み無し → 労基§35 により最終日を法定休日扱い (自動判定)"
                              >
                                {formatHM(calc.holiday_work)}
                                <span className="ml-0.5 text-[10px] text-orange-600 align-top">自動</span>
                              </span>
                            );
                          })()}
                        </TableCell>
                        <TableCell className="text-center">
                          <select
                            className="h-8 rounded-md border bg-background px-1 text-xs"
                            value={row.paid_leave_type ?? ""}
                            onChange={(e) => {
                              const v = e.target.value;
                              updateRow(idx, {
                                paid_leave_type:
                                  v === "full" ? "full" : v === "half" ? "half" : null,
                              });
                            }}
                            title="有給種別 (なし / 全 / 半)"
                          >
                            <option value="">—</option>
                            <option value="full">全</option>
                            <option value="half">半</option>
                          </select>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {calc.absence_minutes > 0 ? (
                            <span
                              className="text-rose-600 font-medium"
                              title={`所定 ${formatHM(calc.scheduled_minutes)} - 実労働 ${formatHM(calc.work_minutes)}`}
                            >
                              {formatHM(calc.absence_minutes)}
                            </span>
                          ) : (
                            "—"
                          )}
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
                    {monthSummary.total_paid_leave_days.toFixed(1).replace(/\.0$/, "")}日
                  </span>
                </span>
                <span>
                  欠勤{" "}
                  <span
                    className={`font-semibold tabular-nums ${monthSummary.total_absence > 0 ? "text-rose-600" : ""}`}
                  >
                    {formatHM(monthSummary.total_absence)}
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

      {/* 振替元日付 選択 modal */}
      <Dialog
        open={substituteModalIdx !== null}
        onOpenChange={(open) => {
          if (!open) handleSubstituteCancel();
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>振替元日付の選択</DialogTitle>
            <DialogDescription>
              {substituteModalIdx !== null && rows[substituteModalIdx]
                ? `${rows[substituteModalIdx].work_date} (${WEEK_DAY_LABELS[rows[substituteModalIdx].dow]}) はいつの振り替えですか？`
                : "いつの振り替えですか？"}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <label className="text-xs text-muted-foreground block mb-1">
              振替元の日付
            </label>
            <Input
              type="date"
              value={substituteModalDate}
              onChange={(e) => setSubstituteModalDate(e.target.value)}
              autoFocus
            />
            <p className="text-xs text-muted-foreground mt-2">
              ※ 例: 1月5日(日) の休日を 1月12日(日) に振替えて 1月5日 に出勤した場合、
              この日 (出勤日) に「1月12日」を入力します。
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleSubstituteCancel}>
              キャンセル
            </Button>
            <Button onClick={handleSubstituteConfirm} disabled={!substituteModalDate}>
              確定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
