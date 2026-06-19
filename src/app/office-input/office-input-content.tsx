"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MonthInputButton } from "@/components/ui/month-input-button";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Employee, Office } from "@/types/database";
import {
  ITEM_OPTIONS,
  OFFICE_INPUT_CATEGORIES,
  type OfficeInputCategory,
  type OfficeInputEntry,
} from "@/lib/office-input/types";
import {
  deleteEntry,
  getEntriesByEmployeeMonth,
  listEmployeesByOffice,
  upsertEntry,
} from "@/lib/office-input/queries";
import { CategorySection } from "./category-section";

/** "YYYY-MM" の今月 */
function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function OfficeInputContent({ offices }: { offices: Office[] }) {
  const [officeId, setOfficeId] = useState<string>(offices[0]?.id ?? "");
  const [billingMonth, setBillingMonth] = useState<string>(currentMonth());

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeesLoading, setEmployeesLoading] = useState(false);

  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(
    null,
  );

  const [entries, setEntries] = useState<OfficeInputEntry[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(false);

  // ─── 事業所変更時: スタッフ一覧 load ─────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (!officeId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEmployees([]);
      setSelectedEmployeeId(null);
      return;
    }
    setEmployeesLoading(true);
    listEmployeesByOffice(officeId)
      .then((rows) => {
        if (cancelled) return;
        setEmployees(rows);
        // 選択中スタッフが新リストに居なければ先頭を選択
        setSelectedEmployeeId((prev) => {
          if (prev && rows.some((e) => e.id === prev)) return prev;
          return rows[0]?.id ?? null;
        });
      })
      .catch((e) => {
        if (cancelled) return;
        toast.error(e instanceof Error ? e.message : "スタッフ取得に失敗しました");
      })
      .finally(() => {
        if (!cancelled) setEmployeesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [officeId]);

  // ─── スタッフ or 月変更時: エントリ load ──────────────────────
  useEffect(() => {
    let cancelled = false;
    if (!selectedEmployeeId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEntries([]);
      return;
    }
    setEntriesLoading(true);
    getEntriesByEmployeeMonth(selectedEmployeeId, billingMonth)
      .then((rows) => {
        if (cancelled) return;
        setEntries(rows);
      })
      .catch((e) => {
        if (cancelled) return;
        toast.error(e instanceof Error ? e.message : "エントリ取得に失敗しました");
      })
      .finally(() => {
        if (!cancelled) setEntriesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedEmployeeId, billingMonth]);

  // ─── カテゴリごとに entries を分割 ─────────────────────────
  const entriesByCategory = useMemo(() => {
    const map: Record<OfficeInputCategory, OfficeInputEntry[]> = {
      数値項目: [],
      時間項目: [],
      日付項目: [],
      日時項目: [],
      育児手当: [],
    };
    for (const e of entries) {
      map[e.category].push(e);
    }
    return map;
  }, [entries]);

  // ─── upsert (= 自動保存 or 明示保存) ───────────────────────
  const handleSaveEntry = useCallback(
    async (entry: OfficeInputEntry) => {
      try {
        const isDraft = entry.id.startsWith("draft-");
        const saved = await upsertEntry({
          id: isDraft ? undefined : entry.id,
          employee_id: entry.employee_id,
          billing_month: entry.billing_month,
          category: entry.category,
          item_name: entry.item_name,
          numeric_value: entry.numeric_value,
          time_minutes: entry.time_minutes,
          date_value: entry.date_value,
          start_time: entry.start_time,
          end_time: entry.end_time,
          break_minutes: entry.break_minutes,
          child_name: entry.child_name,
          reference_month: entry.reference_month,
          notes: entry.notes,
        });
        // local state を更新 (= id が新規割り当てされた場合に正しく差し替える)
        setEntries((prev) => {
          const idx = prev.findIndex((p) => p.id === entry.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = saved;
            return next;
          }
          return [...prev, saved];
        });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "保存に失敗しました");
      }
    },
    [],
  );

  // ─── 新規行追加 (local state のみ、保存はユーザー入力後) ─────
  const handleAddRow = useCallback(
    (category: OfficeInputCategory) => {
      if (!selectedEmployeeId) {
        toast.error("スタッフを選択してください");
        return;
      }
      const defaultItem = ITEM_OPTIONS[category][0] ?? "";
      const draft: OfficeInputEntry = {
        id: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        tenant_id: "kt-group",
        employee_id: selectedEmployeeId,
        billing_month: billingMonth,
        category,
        item_name: defaultItem,
        numeric_value: null,
        time_minutes: null,
        date_value: null,
        start_time: null,
        end_time: null,
        break_minutes: null,
        child_name: null,
        reference_month: null,
        notes: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      setEntries((prev) => [...prev, draft]);
    },
    [selectedEmployeeId, billingMonth],
  );

  // ─── 削除 ──────────────────────────────────────────────
  const handleDeleteEntry = useCallback(async (entryId: string) => {
    // draft (= 未保存) はそのまま local state から除去
    if (entryId.startsWith("draft-")) {
      setEntries((prev) => prev.filter((e) => e.id !== entryId));
      return;
    }
    try {
      await deleteEntry(entryId);
      setEntries((prev) => prev.filter((e) => e.id !== entryId));
      toast.success("削除しました");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "削除に失敗しました");
    }
  }, []);

  // ─── ローカル更新 (= 入力中の値を state に反映) ────────────
  const handleUpdateLocal = useCallback(
    (entryId: string, patch: Partial<OfficeInputEntry>) => {
      setEntries((prev) =>
        prev.map((e) => (e.id === entryId ? { ...e, ...patch } : e)),
      );
    },
    [],
  );

  const selectedEmployee = useMemo(
    () => employees.find((e) => e.id === selectedEmployeeId) ?? null,
    [employees, selectedEmployeeId],
  );

  return (
    <div className="flex flex-col h-full">
      {/* ─── ヘッダー ─── */}
      <div className="flex items-center gap-4 p-4 border-b bg-background">
        <h2 className="text-xl font-bold">事業所書式入力</h2>

        <div className="flex items-center gap-2 ml-4">
          <label className="text-sm text-muted-foreground">事業所</label>
          <select
            value={officeId}
            onChange={(e) => setOfficeId(e.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm min-w-[200px]"
          >
            {offices.length === 0 ? (
              <option value="">事業所が登録されていません</option>
            ) : (
              offices.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))
            )}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-sm text-muted-foreground">対象月</label>
          <MonthInputButton value={billingMonth} onChange={setBillingMonth} />
        </div>
      </div>

      {/* ─── 本体 ─── */}
      <div className="flex flex-1 min-h-0">
        {/* 左パネル: スタッフ一覧 */}
        <aside className="w-64 border-r bg-muted/20 flex flex-col">
          <div className="px-3 py-2 border-b text-xs uppercase tracking-wider text-muted-foreground">
            スタッフ ({employees.length}人)
          </div>
          <div className="flex-1 overflow-y-auto">
            {employeesLoading ? (
              <div className="p-4 text-sm text-muted-foreground">読み込み中…</div>
            ) : employees.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">
                {officeId
                  ? "在職中のスタッフがいません"
                  : "事業所を選択してください"}
              </div>
            ) : (
              <ul>
                {employees.map((emp) => {
                  const isActive = emp.id === selectedEmployeeId;
                  return (
                    <li key={emp.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedEmployeeId(emp.id)}
                        className={cn(
                          "w-full text-left px-3 py-2 text-sm border-b transition-colors",
                          isActive
                            ? "bg-primary text-primary-foreground"
                            : "hover:bg-muted/60",
                        )}
                      >
                        <div className="font-medium">{emp.name}</div>
                        <div
                          className={cn(
                            "text-xs",
                            isActive
                              ? "text-primary-foreground/80"
                              : "text-muted-foreground",
                          )}
                        >
                          {emp.employee_number} / {emp.job_type}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        {/* 右パネル: 入力フォーム */}
        <main className="flex-1 overflow-y-auto p-4">
          {!selectedEmployee ? (
            <div className="text-sm text-muted-foreground">
              左のリストからスタッフを選択してください
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-lg font-bold">{selectedEmployee.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {selectedEmployee.employee_number} ・{" "}
                    {selectedEmployee.job_type} ・ {billingMonth}
                  </div>
                </div>
                {entriesLoading && (
                  <div className="text-xs text-muted-foreground">読み込み中…</div>
                )}
              </div>

              {OFFICE_INPUT_CATEGORIES.map((category) => (
                <CategorySection
                  key={category}
                  category={category}
                  entries={entriesByCategory[category]}
                  onAddRow={() => handleAddRow(category)}
                  onUpdateLocal={handleUpdateLocal}
                  onSaveEntry={handleSaveEntry}
                  onDeleteEntry={handleDeleteEntry}
                />
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
