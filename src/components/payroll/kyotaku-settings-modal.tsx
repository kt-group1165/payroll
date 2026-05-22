"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import {
  getActiveKyotakuSalary,
  type KyotakuSalary,
} from "@/lib/payroll/kyotaku-salary-history";

type Props = {
  open: boolean;
  onClose: () => void;
  tenantId: string;
  officeNumber: string;
  /** dashboard から渡される (records に存在するケアマネ一覧)。employees に未登録なら警告表示。 */
  staffNames: string[];
  onSaved?: () => void;
};

type EmployeeIdentity = {
  employee_id: string;
  staff_name: string;
};

/** 編集行: 各ケアマネで「いま入力中の」値 + 適用開始月。
 *  値は最新 active row の snapshot を default に持ち、INSERT 時はその差分を新 row として保存。 */
type EditRow = {
  employee_id: string;
  staff_name: string;
  /** 適用開始月 (YYYY-MM-DD、通常 YYYY-MM-01) */
  effective_from: string;
  /** 入力値 (NULL 不可: 履歴 row は NOT NULL DEFAULT 0)。
   *  UI は空文字を許容するため number | null で保持し、保存時に NULL → 0 に正規化。 */
  honnin_kyu: number | null;
  shokuno_kyu: number | null;
  kotei_zangyo: number | null;
  shikaku_teate: number | null;
  kotei: number | null;
  tokutei_shogu: number | null;
  kaigo_rate: number | null;
  shien_rate: number | null;
  /** プラン手当の支給サイクル (default 'monthly') */
  plan_payment_cycle: "monthly" | "semi_annual";
};

// 列定義: 入力 keys ＋ ラベル ＋ 短縮ラベル (1 行 table view 用)。
const INPUT_COLS: ReadonlyArray<{
  key:
    | "honnin_kyu"
    | "shokuno_kyu"
    | "kotei_zangyo"
    | "shikaku_teate"
    | "kotei"
    | "tokutei_shogu"
    | "kaigo_rate"
    | "shien_rate";
  label: string;
  short: string;
  placeholder: string;
}> = [
  { key: "honnin_kyu", label: "本人給 (円)", short: "本人給", placeholder: "0" },
  { key: "shokuno_kyu", label: "職能給 (円)", short: "職能給", placeholder: "0" },
  { key: "kotei_zangyo", label: "固定残業手当 (円)", short: "固残", placeholder: "0" },
  { key: "shikaku_teate", label: "資格手当 (円)", short: "資格", placeholder: "0" },
  { key: "kotei", label: "勤続手当 (円)", short: "勤続", placeholder: "0" },
  { key: "tokutei_shogu", label: "特定処遇改善 (円)", short: "特処", placeholder: "0" },
  { key: "kaigo_rate", label: "要介護単価 (円/件)", short: "介護", placeholder: "0" },
  { key: "shien_rate", label: "要支援単価 (円/件)", short: "支援", placeholder: "0" },
];

/** YYYY-MM-DD (DATE) → "YYYY/MM/DD" 表示 */
function fmtDate(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return d;
  return `${m[1]}/${m[2]}/${m[3]}`;
}

/** 当月 1 日 (YYYY-MM-01) を返す */
function currentMonthStart(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

/**
 * 居宅介護支援 ケアマネ別給与設定 modal (履歴対応版)
 *
 * DB:
 *   payroll_kyotaku_salary (履歴 table)
 *     UNIQUE (employee_id, effective_from)
 *     列: honnin_kyu / shokuno_kyu / kotei_zangyo / shikaku_teate / kotei /
 *         tokutei_shogu / kaigo_rate / shien_rate (全 INT NOT NULL DEFAULT 0)
 *     append-only: 編集時は新 row INSERT (UPDATE しない)
 *
 * 仕様:
 *   - 各ケアマネ行で「適用開始月」を指定 (default = 当月 1 日)
 *   - 保存 → payroll_kyotaku_salary に新 row INSERT (UNIQUE 違反は同月再保存と判定し UPDATE)
 *   - 「履歴」展開ボタン: 過去 row 一覧 + 個別削除
 *   - 過去設定の追加: 適用開始月を過去にして INSERT (backfill mode)
 *
 * 旧 payroll_employees.kyotaku_* 列は DB に残置 (互換) するが本 UI からは読み書きしない。
 * Reader は use-kyotaku-dashboard-data.ts / use-kyotaku-summary.ts / use-kyotaku-labor-check.ts /
 * kyotaku-attendance-content.tsx を参照。
 */
export function KyotakuSettingsModal({
  open,
  onClose,
  tenantId,
  officeNumber,
  staffNames,
  onSaved,
}: Props) {
  const [employees, setEmployees] = useState<EmployeeIdentity[]>([]);
  const [salaryRows, setSalaryRows] = useState<KyotakuSalary[]>([]);
  const [editByEmp, setEditByEmp] = useState<Map<string, EditRow>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null); // employee_id of currently-saving row
  const [deleting, setDeleting] = useState<string | null>(null); // salary row id

  const load = useCallback(async () => {
    setLoading(true);
    const { data: officeRow, error: oErr } = await supabase
      .from("payroll_offices")
      .select("id")
      .eq("office_number", officeNumber)
      .maybeSingle();
    if (oErr || !officeRow) {
      toast.error(`事業所解決エラー: ${oErr?.message ?? "office not found"}`);
      setEmployees([]);
      setSalaryRows([]);
      setLoading(false);
      return;
    }
    const officeId = (officeRow as { id: string }).id;

    // employees (identity only)
    const { data: empData, error: empErr } = await supabase
      .from("payroll_employees")
      .select("id, name")
      .eq("office_id", officeId)
      .order("name", { ascending: true });

    if (empErr) {
      toast.error(`職員読込エラー: ${empErr.message}`);
      setEmployees([]);
      setSalaryRows([]);
      setLoading(false);
      return;
    }
    type RawEmp = { id: string; name: string };
    const empList: EmployeeIdentity[] = (empData ?? [])
      .filter((r) => (r as RawEmp).name)
      .map((r) => ({
        employee_id: (r as RawEmp).id,
        staff_name: (r as RawEmp).name,
      }));
    const empIds = empList.map((e) => e.employee_id);

    // 給与履歴 (該当 office の全 employee 分)
    let rows: KyotakuSalary[] = [];
    if (empIds.length > 0) {
      const { data: salaryData, error: salaryErr } = await supabase
        .from("payroll_kyotaku_salary")
        .select(
          "id, tenant_id, employee_id, effective_from, honnin_kyu, shokuno_kyu, kotei_zangyo, shikaku_teate, kotei, tokutei_shogu, kaigo_rate, shien_rate, plan_payment_cycle",
        )
        .in("employee_id", empIds)
        .order("effective_from", { ascending: false });
      if (salaryErr) {
        // DB 未 apply 段階の error は許容 (空配列 fallback)
        console.warn(
          "[kyotaku-settings-modal] payroll_kyotaku_salary fetch failed:",
          salaryErr.message,
        );
      } else {
        rows = (salaryData ?? []) as unknown as KyotakuSalary[];
      }
    }

    setEmployees(empList);
    setSalaryRows(rows);
    setLoading(false);
  }, [officeNumber]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- open 切替時の async fetch (HANDOVER §2 参照) */
    if (open) {
      void load();
    } else {
      // close で edit/expanded をリセット (再 open 時に再 load)
      setEditByEmp(new Map());
      setExpanded(new Set());
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, load]);

  /** employee_id ごとの編集行を初期化 (未編集なら latest active row 値 + 当月 1 日 を default) */
  const getOrInitEdit = useCallback(
    (emp: EmployeeIdentity): EditRow => {
      const existing = editByEmp.get(emp.employee_id);
      if (existing) return existing;
      // 「今 (= 当月 1 日) で active な row」を初期表示
      const monthStart = currentMonthStart();
      const active = getActiveKyotakuSalary(
        salaryRows,
        emp.employee_id,
        monthStart,
      );
      return {
        employee_id: emp.employee_id,
        staff_name: emp.staff_name,
        effective_from: monthStart,
        honnin_kyu: active?.honnin_kyu ?? null,
        shokuno_kyu: active?.shokuno_kyu ?? null,
        kotei_zangyo: active?.kotei_zangyo ?? null,
        shikaku_teate: active?.shikaku_teate ?? null,
        kotei: active?.kotei ?? null,
        tokutei_shogu: active?.tokutei_shogu ?? null,
        kaigo_rate: active?.kaigo_rate ?? null,
        shien_rate: active?.shien_rate ?? null,
        plan_payment_cycle: active?.plan_payment_cycle ?? "monthly",
      };
    },
    [editByEmp, salaryRows],
  );

  const updateEdit = useCallback(
    (empId: string, patch: Partial<EditRow>, base?: EditRow) => {
      setEditByEmp((prev) => {
        const next = new Map(prev);
        const current = prev.get(empId) ?? base;
        if (!current) return prev;
        next.set(empId, { ...current, ...patch });
        return next;
      });
    },
    [],
  );

  /** 当月 active row があれば「最新は YYYY/MM/DD 始点で ¥… 」と表示 */
  const formatActiveLabel = useCallback(
    (empId: string): string => {
      const active = getActiveKyotakuSalary(
        salaryRows,
        empId,
        currentMonthStart(),
      );
      if (!active) return "未設定";
      const total =
        active.honnin_kyu +
        active.shokuno_kyu +
        active.kotei_zangyo +
        active.shikaku_teate +
        active.kotei +
        active.tokutei_shogu;
      return `${fmtDate(active.effective_from)}〜 / 月額計 ¥${total.toLocaleString("ja-JP")}`;
    },
    [salaryRows],
  );

  const parseIntOrNull = (s: string): number | null => {
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };

  /** 該当 employee の保存実行 (1 row INSERT、UNIQUE 違反は UPDATE で上書き) */
  const handleSaveRow = useCallback(
    async (emp: EmployeeIdentity) => {
      const e = editByEmp.get(emp.employee_id);
      if (!e) {
        toast.error("変更がありません");
        return;
      }
      // バリデーション
      if (!/^\d{4}-\d{2}-\d{2}$/.test(e.effective_from)) {
        toast.error("適用開始月の形式が不正です (YYYY-MM-DD)");
        return;
      }
      for (const c of INPUT_COLS) {
        const v = e[c.key];
        if (v !== null && (!Number.isFinite(v) || v < 0)) {
          toast.error(`${c.label} は 0 以上の整数で入力してください`);
          return;
        }
      }

      setSaving(emp.employee_id);
      try {
        const payload = {
          tenant_id: tenantId,
          employee_id: emp.employee_id,
          effective_from: e.effective_from,
          honnin_kyu: e.honnin_kyu ?? 0,
          shokuno_kyu: e.shokuno_kyu ?? 0,
          kotei_zangyo: e.kotei_zangyo ?? 0,
          shikaku_teate: e.shikaku_teate ?? 0,
          kotei: e.kotei ?? 0,
          tokutei_shogu: e.tokutei_shogu ?? 0,
          kaigo_rate: e.kaigo_rate ?? 0,
          shien_rate: e.shien_rate ?? 0,
          plan_payment_cycle: e.plan_payment_cycle,
        };
        // UNIQUE (employee_id, effective_from) があるので、同月再保存は upsert で UPDATE 扱い。
        const { error } = await supabase
          .from("payroll_kyotaku_salary")
          .upsert(payload, { onConflict: "employee_id,effective_from" });
        if (error) throw error;
        toast.success(`${emp.staff_name} の給与設定を保存しました`);
        // 編集状態を clear し、最新を再 load
        setEditByEmp((prev) => {
          const next = new Map(prev);
          next.delete(emp.employee_id);
          return next;
        });
        await load();
        onSaved?.();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`保存エラー: ${msg}`);
      } finally {
        setSaving(null);
      }
    },
    [editByEmp, tenantId, load, onSaved],
  );

  /** 履歴 row 削除 */
  const handleDeleteRow = useCallback(
    async (rowId: string, label: string) => {
      const ok = window.confirm(`${label} の履歴を削除しますか？`);
      if (!ok) return;
      setDeleting(rowId);
      try {
        const { error } = await supabase
          .from("payroll_kyotaku_salary")
          .delete()
          .eq("id", rowId);
        if (error) throw error;
        toast.success("履歴を削除しました");
        await load();
        onSaved?.();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`削除エラー: ${msg}`);
      } finally {
        setDeleting(null);
      }
    },
    [load, onSaved],
  );

  /** employee_id → 履歴 row 全部 (effective_from DESC) */
  const historyByEmp = useMemo(() => {
    const m = new Map<string, KyotakuSalary[]>();
    for (const r of salaryRows) {
      if (!m.has(r.employee_id)) m.set(r.employee_id, []);
      m.get(r.employee_id)!.push(r);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1));
    }
    return m;
  }, [salaryRows]);

  const knownEmployeeNames = useMemo(
    () => new Set(employees.map((e) => e.staff_name)),
    [employees],
  );

  /** records には居るが payroll_employees に居ない名前 (本来は backfill 済みで無いはず) */
  const orphanStaffNames = useMemo(() => {
    if (!staffNames || staffNames.length === 0) return [] as string[];
    return staffNames.filter((n) => n && !knownEmployeeNames.has(n));
  }, [staffNames, knownEmployeeNames]);

  const toggleExpand = useCallback((empId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(empId)) next.delete(empId);
      else next.add(empId);
      return next;
    });
  }, []);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>設定: ケアマネ別給与 (履歴対応)</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded border bg-muted/40 p-3 text-xs text-muted-foreground">
            給与設定は履歴 (
            <code className="font-mono">payroll_kyotaku_salary</code>)
            として保存されます。
            <ul className="mt-1 list-disc pl-5">
              <li>
                「適用開始月」以降の月で、その値が active になります (= 各月の給与計算で参照される)。
              </li>
              <li>
                同じ「適用開始月」で再保存すると上書き (= UPDATE) になります。
              </li>
              <li>
                過去の設定を追加 (backfill) するには適用開始月を過去日付に設定して保存してください。
              </li>
            </ul>
          </div>

          {loading ? (
            <p className="text-sm text-muted-foreground">読込中…</p>
          ) : employees.length === 0 ? (
            <p className="rounded border border-dashed p-4 text-center text-sm text-muted-foreground">
              この事業所には payroll_employees に登録されたケアマネがいません。
              <br />
              先に /employees から職員登録してください。
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium whitespace-nowrap">ケアマネ</th>
                    <th className="px-1 py-1.5 text-left font-medium whitespace-nowrap">開始月</th>
                    {INPUT_COLS.map((c) => (
                      <th
                        key={c.key}
                        className="px-1 py-1.5 text-right font-medium whitespace-nowrap"
                        title={c.label}
                      >
                        {c.short}
                      </th>
                    ))}
                    <th className="px-1 py-1.5 text-left font-medium whitespace-nowrap">支給方式</th>
                    <th className="px-1 py-1.5 font-medium" />
                    <th className="px-1 py-1.5 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {employees.map((emp) => {
                    const edit = getOrInitEdit(emp);
                    const isExpanded = expanded.has(emp.employee_id);
                    const history = historyByEmp.get(emp.employee_id) ?? [];
                    const isSaving = saving === emp.employee_id;
                    return (
                      <Fragment key={emp.employee_id}>
                        <tr className="border-t hover:bg-muted/10">
                          <td className="px-2 py-1 whitespace-nowrap">
                            <div className="flex flex-col leading-tight">
                              <span className="font-medium">{emp.staff_name}</span>
                              <span className="text-[10px] text-muted-foreground">
                                {formatActiveLabel(emp.employee_id)}
                              </span>
                            </div>
                          </td>
                          <td className="px-1 py-1">
                            <Input
                              type="date"
                              className="h-8 w-32 text-xs"
                              value={edit.effective_from}
                              onChange={(ev) =>
                                updateEdit(
                                  emp.employee_id,
                                  { effective_from: ev.target.value },
                                  edit,
                                )
                              }
                            />
                          </td>
                          {INPUT_COLS.map((c) => (
                            <td key={c.key} className="px-1 py-1">
                              <Input
                                type="number"
                                min={0}
                                step={1}
                                className="h-8 w-20 text-right tabular-nums text-xs"
                                value={edit[c.key] ?? ""}
                                placeholder={c.placeholder}
                                onChange={(ev) =>
                                  updateEdit(
                                    emp.employee_id,
                                    { [c.key]: parseIntOrNull(ev.target.value) },
                                    edit,
                                  )
                                }
                              />
                            </td>
                          ))}
                          <td className="px-1 py-1">
                            <select
                              className="h-8 w-24 rounded border bg-background px-1 text-xs"
                              value={edit.plan_payment_cycle}
                              onChange={(ev) =>
                                updateEdit(
                                  emp.employee_id,
                                  {
                                    plan_payment_cycle:
                                      ev.target.value === "semi_annual"
                                        ? "semi_annual"
                                        : "monthly",
                                  },
                                  edit,
                                )
                              }
                              title={
                                edit.plan_payment_cycle === "semi_annual"
                                  ? "半期締め (1-6→9月 / 7-12→3月)"
                                  : "毎月支給"
                              }
                            >
                              <option value="monthly">毎月</option>
                              <option value="semi_annual">半期締め</option>
                            </select>
                          </td>
                          <td className="px-1 py-1">
                            <Button
                              type="button"
                              size="sm"
                              className="h-8"
                              onClick={() => void handleSaveRow(emp)}
                              disabled={isSaving}
                            >
                              {isSaving ? "…" : "保存"}
                            </Button>
                          </td>
                          <td className="px-1 py-1">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => toggleExpand(emp.employee_id)}
                              aria-label={isExpanded ? "履歴を閉じる" : "履歴を見る"}
                              title={isExpanded ? "履歴を閉じる" : "履歴を見る"}
                            >
                              {isExpanded ? <ChevronDown /> : <ChevronRight />}
                            </Button>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td colSpan={INPUT_COLS.length + 5} className="border-t bg-muted/20 px-3 py-2">
                              <div className="text-[11px] font-medium text-muted-foreground mb-2">
                                過去の設定履歴 ({history.length} 件)
                              </div>
                              {history.length === 0 ? (
                                <p className="text-xs text-muted-foreground italic">
                                  履歴はまだありません。
                                </p>
                              ) : (
                                <div className="overflow-x-auto">
                                  <Table className="text-xs">
                                    <TableHeader>
                                      <TableRow>
                                        <TableHead className="whitespace-nowrap">適用開始月</TableHead>
                                        {INPUT_COLS.map((c) => (
                                          <TableHead
                                            key={c.key}
                                            className="whitespace-nowrap text-right"
                                          >
                                            {c.short}
                                          </TableHead>
                                        ))}
                                        <TableHead className="whitespace-nowrap">支給方式</TableHead>
                                        <TableHead className="w-10" />
                                      </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                      {history.map((r) => (
                                        <TableRow key={r.id}>
                                          <TableCell className="whitespace-nowrap">
                                            {fmtDate(r.effective_from)}
                                          </TableCell>
                                          {INPUT_COLS.map((c) => (
                                            <TableCell
                                              key={c.key}
                                              className="whitespace-nowrap text-right tabular-nums"
                                            >
                                              {r[c.key].toLocaleString("ja-JP")}
                                            </TableCell>
                                          ))}
                                          <TableCell className="whitespace-nowrap">
                                            {(r.plan_payment_cycle ?? "monthly") === "semi_annual"
                                              ? "半期締め"
                                              : "毎月"}
                                          </TableCell>
                                          <TableCell>
                                            <Button
                                              type="button"
                                              variant="ghost"
                                              size="icon-sm"
                                              onClick={() =>
                                                void handleDeleteRow(
                                                  r.id,
                                                  `${emp.staff_name} (${fmtDate(r.effective_from)}〜)`,
                                                )
                                              }
                                              disabled={deleting === r.id}
                                              aria-label="この履歴を削除"
                                              title="この履歴を削除"
                                            >
                                              <Trash2 className="text-destructive" />
                                            </Button>
                                          </TableCell>
                                        </TableRow>
                                      ))}
                                    </TableBody>
                                  </Table>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {orphanStaffNames.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-1 text-xs text-amber-900">
              <div className="font-medium">
                ⚠ records にあるが payroll_employees に未登録のケアマネ:
              </div>
              <ul className="list-disc pl-5">
                {orphanStaffNames.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
              <div className="text-amber-700">
                /employees から先に職員登録してください。
              </div>
            </div>
          )}
        </div>

        <div className="-mx-4 -mb-4 mt-2 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose}>
            閉じる
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
