"use client";

/**
 * 事業所書式入力の「項目 1 つぶん」の入力面。
 *
 * ⚠ ファイル名は経緯で category-section.tsx のままだが、中身は
 *    データ型 (= category) 単位ではなく **項目 (= item_name) 単位** の panel。
 *
 * 項目の性質で 3 つに出し分ける (= `inputModeOf`)。
 *
 *   scalar   数値項目 / 時間項目   1 人 1 値。全職員を 1 枚の表に並べて一気に入力
 *   dateList 日付項目 (有給など)   1 人が月に何日も持つ。日付をまとめて 1 欄で入力
 *   rows     日時項目 / 育児手当   1 人が複数明細を持つ。明細表 + 「行を追加」
 *
 * 保存は入力停止後 800ms の自動保存 (= 従来どおり)。欄から外れたときは即保存。
 * エラーは呼出元 (office-input-content) が toast に出す。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Employee } from "@/types/database";
import {
  formatDayList,
  formatNumber,
  minutesToHHMM,
  parseDayList,
  parseHHMM,
  workedMinutesOf,
  type OfficeInputEntry,
  type OfficeInputItem,
  type OfficeInputMode,
  type OfficeInputRow,
} from "@/lib/office-input/types";

const SAVE_DEBOUNCE_MS = 800;

type PanelProps = {
  item: OfficeInputItem;
  mode: OfficeInputMode;
  billingMonth: string;
  employees: Employee[];
  /** この項目の行だけ */
  rows: OfficeInputRow[];
  onSetScalar: (item: OfficeInputItem, employeeId: string, value: number | null) => void;
  onSetDates: (item: OfficeInputItem, employeeId: string, dates: string[]) => void;
  onAddRow: (item: OfficeInputItem, employeeId: string) => void;
  onUpdateLocal: (localKey: string, patch: Partial<OfficeInputEntry>) => void;
  onSaveRow: (localKey: string) => void;
  onDeleteRow: (localKey: string) => void;
};

export function ItemPanel(props: PanelProps) {
  const { item, mode, employees, rows } = props;

  // 入力のある職員数と合計 (= 入力漏れに気づくための数字)
  const filledEmployees = useMemo(
    () => new Set(rows.map((r) => r.employee_id)).size,
    [rows],
  );
  const totalLabel = useMemo(() => {
    if (item.category === "時間項目") {
      return minutesToHHMM(rows.reduce((s, r) => s + (r.time_minutes ?? 0), 0));
    }
    if (item.category === "日時項目") {
      return minutesToHHMM(rows.reduce((s, r) => s + (workedMinutesOf(r) ?? 0), 0));
    }
    if (item.category === "日付項目") {
      return `${rows.length}日`;
    }
    const sum = rows.reduce((s, r) => s + (r.numeric_value ?? 0), 0);
    return `${formatNumber(sum)}${item.unit ?? ""}`;
  }, [rows, item]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* ─── 項目ヘッダー ─── */}
      <div className="px-4 py-3 border-b bg-background">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h3 className="text-lg font-bold">{item.name}</h3>
          {item.hint && (
            <span className="text-xs text-muted-foreground">{item.hint}</span>
          )}
          <span className="ml-auto text-sm">
            <span className="text-muted-foreground">入力済 </span>
            <span className="font-bold tabular-nums">{filledEmployees}</span>
            <span className="text-muted-foreground"> / {employees.length}人</span>
            <span className="text-muted-foreground"> ・ 合計 </span>
            <span className="font-bold tabular-nums">{totalLabel}</span>
          </span>
        </div>
      </div>

      {mode === "scalar" && <ScalarTable {...props} />}
      {mode === "dateList" && <DateListTable {...props} />}
      {mode === "rows" && <EntryRowsTable {...props} />}
    </div>
  );
}

// ─── 共通: 職員の絞り込みツールバー ──────────────────────────

function useEmployeeFilter(employees: Employee[], hasValue: (empId: string) => boolean) {
  const [query, setQuery] = useState("");
  const [onlyEmpty, setOnlyEmpty] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim();
    return employees.filter((e) => {
      if (onlyEmpty && hasValue(e.id)) return false;
      if (q === "") return true;
      return (
        e.name.includes(q) ||
        e.employee_number.includes(q) ||
        (e.job_type ?? "").includes(q)
      );
    });
  }, [employees, query, onlyEmpty, hasValue]);

  const toolbar = (
    <div className="flex items-center gap-3 px-4 py-2 border-b bg-muted/20">
      <Input
        type="search"
        placeholder="氏名・社員番号で絞り込み"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="h-8 w-64"
      />
      <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
        <input
          type="checkbox"
          checked={onlyEmpty}
          onChange={(e) => setOnlyEmpty(e.target.checked)}
          className="size-3"
        />
        未入力のみ
      </label>
      <span className="ml-auto text-xs text-muted-foreground tabular-nums">
        {filtered.length}人表示
      </span>
    </div>
  );

  return { filtered, toolbar };
}

/** 全モード共通の職員セル (= 社員番号・氏名・職種を 1 行で揃える) */
function EmployeeCells({ employee }: { employee: Employee }) {
  return (
    <>
      <td className="px-3 py-1 text-xs text-muted-foreground tabular-nums whitespace-nowrap">
        {employee.employee_number}
      </td>
      <td className="px-3 py-1 text-sm truncate max-w-[14rem]">{employee.name}</td>
      <td className="px-3 py-1 text-xs text-muted-foreground truncate max-w-[10rem]">
        {employee.job_type}
      </td>
    </>
  );
}

// ─── scalar: 数値項目 / 時間項目 ────────────────────────────

function ScalarTable({ item, employees, rows, onSetScalar }: PanelProps) {
  const byEmployee = useMemo(() => {
    const m = new Map<string, OfficeInputRow>();
    for (const r of rows) {
      if (!m.has(r.employee_id)) m.set(r.employee_id, r);
    }
    return m;
  }, [rows]);

  const hasValue = useCallback(
    (empId: string) => byEmployee.has(empId),
    [byEmployee],
  );
  const { filtered, toolbar } = useEmployeeFilter(employees, hasValue);

  const isTime = item.category === "時間項目";

  return (
    <>
      {toolbar}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <table className="w-full border-collapse">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-left font-medium w-24">社員番号</th>
              <th className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-left font-medium">氏名</th>
              <th className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-left font-medium w-40">職種</th>
              <th className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-left font-medium w-52">
                {isTime ? "時間 (HH:MM)" : `値${item.unit ? ` (${item.unit})` : ""}`}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((emp) => (
              <ScalarRow
                key={emp.id}
                employee={emp}
                item={item}
                row={byEmployee.get(emp.id) ?? null}
                onSetScalar={onSetScalar}
              />
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="p-4 text-sm text-muted-foreground">
            条件に合うスタッフがいません。
          </div>
        )}
      </div>
    </>
  );
}

/**
 * scalar の 1 行。
 *
 * 入力欄の値は **local state** に持つ。保存の往復で戻ってきた値で打鍵中の欄を
 * 上書きしないため。月・事業所を読み直したときは呼出元が panel ごと作り直す
 * (= key に dataVersion を含める) ので、初期値がずれることはない。
 */
function ScalarRow({
  employee,
  item,
  row,
  onSetScalar,
}: {
  employee: Employee;
  item: OfficeInputItem;
  row: OfficeInputRow | null;
  onSetScalar: (item: OfficeInputItem, employeeId: string, value: number | null) => void;
}) {
  const isTime = item.category === "時間項目";

  const initial = isTime
    ? minutesToHHMM(row?.time_minutes ?? null)
    : row?.numeric_value === null || row?.numeric_value === undefined
      ? ""
      : String(row.numeric_value);

  const [text, setText] = useState(initial);
  const committedRef = useRef(initial);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commit = useCallback(
    (raw: string) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const trimmed = raw.trim();
      if (trimmed === committedRef.current.trim()) return;

      if (trimmed === "") {
        committedRef.current = "";
        onSetScalar(item, employee.id, null);
        return;
      }
      const value = isTime ? parseHHMM(trimmed) : Number(trimmed);
      if (value === undefined || Number.isNaN(value)) return; // 入力途中は保存しない
      committedRef.current = trimmed;
      onSetScalar(item, employee.id, item.integerOnly ? Math.round(value) : value);
    },
    [employee.id, item, isTime, onSetScalar],
  );

  // unmount 時に timer を止める (= 消えた行の保存を走らせない)
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleChange = (raw: string) => {
    setText(raw);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => commit(raw), SAVE_DEBOUNCE_MS);
  };

  const filled = text.trim() !== "";

  return (
    <tr className={cn("border-b", filled ? "bg-primary/5" : undefined)}>
      <EmployeeCells employee={employee} />
      <td className="px-3 py-1">
        <div className="flex items-center gap-1">
          <Input
            type={isTime ? "text" : "number"}
            inputMode={isTime ? "numeric" : "decimal"}
            step={isTime ? undefined : item.integerOnly ? 1 : "any"}
            placeholder={isTime ? "00:00" : "—"}
            value={text}
            onChange={(e) => handleChange(e.target.value)}
            onBlur={() => commit(text)}
            className="h-8 w-28"
          />
          {!isTime && item.unit && (
            <span className="text-xs text-muted-foreground">{item.unit}</span>
          )}
          {filled && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => {
                setText("");
                commit("");
              }}
            >
              クリア
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

// ─── dateList: 日付項目 (有給・欠勤など) ────────────────────

function DateListTable({
  item,
  billingMonth,
  employees,
  rows,
  onSetDates,
}: PanelProps) {
  const byEmployee = useMemo(() => {
    const m = new Map<string, OfficeInputRow[]>();
    for (const r of rows) {
      const list = m.get(r.employee_id);
      if (list) list.push(r);
      else m.set(r.employee_id, [r]);
    }
    return m;
  }, [rows]);

  const hasValue = useCallback(
    (empId: string) => (byEmployee.get(empId)?.length ?? 0) > 0,
    [byEmployee],
  );
  const { filtered, toolbar } = useEmployeeFilter(employees, hasValue);

  return (
    <>
      {toolbar}
      <div className="px-4 py-2 text-xs text-muted-foreground border-b">
        日を半角数字で並べて入力します (例: <code>3, 7, 18</code>)。
        <code className="ml-1">6/3</code> のような 月/日 でも入力できます。
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <table className="w-full border-collapse">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-left font-medium w-24">社員番号</th>
              <th className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-left font-medium">氏名</th>
              <th className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-left font-medium w-40">職種</th>
              <th className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-left font-medium">日付</th>
              <th className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-right font-medium w-16">日数</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((emp) => (
              <DateListRow
                key={emp.id}
                employee={emp}
                item={item}
                billingMonth={billingMonth}
                rows={byEmployee.get(emp.id) ?? []}
                onSetDates={onSetDates}
              />
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="p-4 text-sm text-muted-foreground">
            条件に合うスタッフがいません。
          </div>
        )}
      </div>
    </>
  );
}

function DateListRow({
  employee,
  item,
  billingMonth,
  rows,
  onSetDates,
}: {
  employee: Employee;
  item: OfficeInputItem;
  billingMonth: string;
  rows: OfficeInputRow[];
  onSetDates: (item: OfficeInputItem, employeeId: string, dates: string[]) => void;
}) {
  const initial = formatDayList(rows.map((r) => r.date_value));
  const [text, setText] = useState(initial);
  const [invalid, setInvalid] = useState(false);
  const committedRef = useRef(initial);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commit = useCallback(
    (raw: string) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (raw.trim() === committedRef.current.trim()) return;
      const parsed = parseDayList(raw, billingMonth);
      if (parsed === null) {
        setInvalid(true);
        return; // 読めない字が混ざっている間は保存しない
      }
      setInvalid(false);
      committedRef.current = raw.trim();
      onSetDates(item, employee.id, parsed);
    },
    [billingMonth, employee.id, item, onSetDates],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleChange = (raw: string) => {
    setText(raw);
    setInvalid(false);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => commit(raw), SAVE_DEBOUNCE_MS);
  };

  // 保存済みの日 (= 実際に DB にある行) を chip で出して打った内容と突き合わせられるようにする
  const savedDays = formatDayList(rows.map((r) => r.date_value));

  return (
    <tr className={cn("border-b", rows.length > 0 ? "bg-primary/5" : undefined)}>
      <EmployeeCells employee={employee} />
      <td className="px-3 py-1">
        <div className="flex items-center gap-2">
          <Input
            type="text"
            inputMode="numeric"
            placeholder="例: 3, 7, 18"
            value={text}
            onChange={(e) => handleChange(e.target.value)}
            onBlur={() => commit(text)}
            className={cn("h-8 w-64", invalid && "border-destructive")}
          />
          {invalid ? (
            <span className="text-xs text-destructive">
              日として読めない字があります
            </span>
          ) : (
            savedDays !== "" && (
              <span className="text-xs text-muted-foreground truncate">
                保存済: {savedDays}
              </span>
            )
          )}
        </div>
      </td>
      <td className="px-3 py-1 text-right text-sm tabular-nums">
        {rows.length > 0 ? rows.length : ""}
      </td>
    </tr>
  );
}

// ─── rows: 日時項目 (研修・会議) / 育児手当 ──────────────────

function EntryRowsTable({
  item,
  employees,
  rows,
  onAddRow,
  onUpdateLocal,
  onSaveRow,
  onDeleteRow,
}: PanelProps) {
  const [addEmployeeId, setAddEmployeeId] = useState<string>(
    employees[0]?.id ?? "",
  );

  const employeeById = useMemo(() => {
    const m = new Map<string, Employee>();
    for (const e of employees) m.set(e.id, e);
    return m;
  }, [employees]);

  // 社員番号 → 日付 の順に並べる (= 表として読める順)
  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const an = employeeById.get(a.employee_id)?.employee_number ?? "";
      const bn = employeeById.get(b.employee_id)?.employee_number ?? "";
      if (an !== bn) return an.localeCompare(bn, "ja");
      return (a.date_value ?? "").localeCompare(b.date_value ?? "");
    });
  }, [rows, employeeById]);

  const isChildcare = item.category === "育児手当";

  return (
    <>
      <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/20">
        <label className="text-xs text-muted-foreground">スタッフ</label>
        <select
          value={addEmployeeId}
          onChange={(e) => setAddEmployeeId(e.target.value)}
          className="h-8 rounded-md border bg-background px-2 text-sm min-w-[14rem]"
        >
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.employee_number} {e.name}
            </option>
          ))}
        </select>
        <Button
          type="button"
          size="sm"
          className="h-8"
          onClick={() => {
            if (!addEmployeeId) return;
            onAddRow(item, addEmployeeId);
          }}
        >
          + {item.name}を追加
        </Button>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {rows.length}件
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            まだ入力がありません。上でスタッフを選んで「+ {item.name}を追加」してください。
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-left font-medium w-56">スタッフ</th>
                {isChildcare ? (
                  <>
                    <th className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-left font-medium w-40">お子さん名</th>
                    <th className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-left font-medium w-40">何月分</th>
                    <th className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-left font-medium w-32">金額 (円)</th>
                  </>
                ) : (
                  <>
                    <th className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-left font-medium w-40">日付</th>
                    <th className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-left font-medium w-28">開始</th>
                    <th className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-left font-medium w-28">終了</th>
                    <th className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-left font-medium w-28">休憩(分)</th>
                    <th className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-right font-medium w-20">実働</th>
                  </>
                )}
                <th className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-left font-medium">備考</th>
                <th className="sticky top-0 z-10 bg-muted px-3 py-1.5 w-12" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <EntryRow
                  key={row.localKey}
                  row={row}
                  employees={employees}
                  isChildcare={isChildcare}
                  onUpdateLocal={onUpdateLocal}
                  onSaveRow={onSaveRow}
                  onDeleteRow={onDeleteRow}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

/**
 * 明細 1 行。値は呼出元の state を直接編集し (= onUpdateLocal)、
 * 入力停止後 800ms で自動保存する。
 */
function EntryRow({
  row,
  employees,
  isChildcare,
  onUpdateLocal,
  onSaveRow,
  onDeleteRow,
}: {
  row: OfficeInputRow;
  employees: Employee[];
  isChildcare: boolean;
  onUpdateLocal: (localKey: string, patch: Partial<OfficeInputEntry>) => void;
  onSaveRow: (localKey: string) => void;
  onDeleteRow: (localKey: string) => void;
}) {
  const lastSavedRef = useRef<string>(serialize(row));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const current = serialize(row);
    if (current === lastSavedRef.current) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      lastSavedRef.current = current;
      onSaveRow(row.localKey);
    }, SAVE_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [row, onSaveRow]);

  const isDraft = row.id.startsWith("draft-");
  const worked = isChildcare ? null : workedMinutesOf(row);

  const patch = (p: Partial<OfficeInputEntry>) => onUpdateLocal(row.localKey, p);

  return (
    <tr className={cn("border-b", isDraft ? "bg-amber-50" : undefined)}>
      <td className="px-3 py-1">
        <select
          value={row.employee_id}
          onChange={(e) => patch({ employee_id: e.target.value })}
          className="h-8 w-full rounded-md border bg-background px-2 text-sm"
        >
          {employees.some((e) => e.id === row.employee_id) ? null : (
            <option value={row.employee_id}>(この事業所に居ないスタッフ)</option>
          )}
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.employee_number} {e.name}
            </option>
          ))}
        </select>
      </td>

      {isChildcare ? (
        <>
          <td className="px-3 py-1">
            <Input
              type="text"
              placeholder="お子さん名"
              value={row.child_name ?? ""}
              onChange={(e) => patch({ child_name: e.target.value || null })}
              className="h-8"
            />
          </td>
          <td className="px-3 py-1">
            <Input
              type="month"
              value={row.reference_month ?? ""}
              onChange={(e) => patch({ reference_month: e.target.value || null })}
              className="h-8"
              title="何月分の保育料か"
            />
          </td>
          <td className="px-3 py-1">
            <Input
              type="number"
              step={1}
              value={row.numeric_value ?? ""}
              onChange={(e) =>
                patch({
                  numeric_value:
                    e.target.value === "" ? null : Number(e.target.value),
                })
              }
              className="h-8"
            />
          </td>
        </>
      ) : (
        <>
          <td className="px-3 py-1">
            <Input
              type="date"
              value={row.date_value ?? ""}
              onChange={(e) => patch({ date_value: e.target.value || null })}
              className="h-8"
            />
          </td>
          <td className="px-3 py-1">
            <Input
              type="time"
              value={(row.start_time ?? "").slice(0, 5)}
              onChange={(e) => patch({ start_time: e.target.value || null })}
              className="h-8"
            />
          </td>
          <td className="px-3 py-1">
            <Input
              type="time"
              value={(row.end_time ?? "").slice(0, 5)}
              onChange={(e) => patch({ end_time: e.target.value || null })}
              className="h-8"
            />
          </td>
          <td className="px-3 py-1">
            <Input
              type="number"
              step={1}
              value={row.break_minutes ?? ""}
              onChange={(e) =>
                patch({
                  break_minutes:
                    e.target.value === "" ? null : Math.round(Number(e.target.value)),
                })
              }
              className="h-8"
            />
          </td>
          <td className="px-3 py-1 text-right text-sm tabular-nums">
            {worked === null ? "" : minutesToHHMM(worked)}
          </td>
        </>
      )}

      <td className="px-3 py-1">
        <Input
          type="text"
          placeholder="備考"
          value={row.notes ?? ""}
          onChange={(e) => patch({ notes: e.target.value || null })}
          className="h-8"
        />
      </td>
      <td className="px-3 py-1 text-right">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onDeleteRow(row.localKey)}
          aria-label="削除"
          className="h-7 px-2 text-destructive hover:bg-destructive/10"
        >
          削除
        </Button>
      </td>
    </tr>
  );
}

/**
 * 値の serialize。debounce 比較用 (= 入力中に同じ値が再 set されても保存しない)。
 */
function serialize(e: OfficeInputEntry): string {
  return JSON.stringify({
    emp: e.employee_id,
    item: e.item_name,
    n: e.numeric_value,
    t: e.time_minutes,
    d: e.date_value,
    s: (e.start_time ?? "").slice(0, 5),
    en: (e.end_time ?? "").slice(0, 5),
    b: e.break_minutes,
    c: e.child_name,
    r: e.reference_month,
    no: e.notes,
  });
}
