"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MonthInputButton } from "@/components/ui/month-input-button";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Employee, Office } from "@/types/database";
import {
  OFFICE_INPUT_GROUPS,
  OFFICE_INPUT_ITEMS,
  formatNumber,
  inputModeOf,
  itemsForOfficeType,
  minutesToHHMM,
  workedMinutesOf,
  type OfficeInputEntry,
  type OfficeInputItem,
  type OfficeInputRow,
} from "@/lib/office-input/types";
import {
  deleteEntries,
  deleteEntry,
  getEntriesByEmployeesMonth,
  insertEntries,
  listEmployeesByOffice,
  upsertEntry,
} from "@/lib/office-input/queries";
import { ItemPanel } from "./category-section";

/** "YYYY-MM" の今月 */
function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** localKey の採番 (= React の key 専用。DB には出さない) */
let localKeySeq = 0;
function nextLocalKey(): string {
  localKeySeq += 1;
  return `lk-${localKeySeq}`;
}

function withLocalKey(entry: OfficeInputEntry): OfficeInputRow {
  return { ...entry, localKey: nextLocalKey() };
}

/** 項目ごとの集計 (= 入力漏れに気づくための数字) */
type ItemSummary = {
  /** 行数 */
  count: number;
  /** 入力のある職員数 */
  employees: number;
  /** 合計の表示文字列 (空なら合計の概念が無い) */
  totalLabel: string;
};

export function OfficeInputContent({ offices }: { offices: Office[] }) {
  const [officeId, setOfficeId] = useState<string>(offices[0]?.id ?? "");
  const [billingMonth, setBillingMonth] = useState<string>(currentMonth());

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeesLoading, setEmployeesLoading] = useState(false);

  const [selectedItemName, setSelectedItemName] = useState<string>(
    OFFICE_INPUT_ITEMS[0].name,
  );
  /** 事業所種別に紐づかない項目も出すか (= 種別の登録漏れで入力できなくしない) */
  const [showAllItems, setShowAllItems] = useState(false);

  const [entriesLoading, setEntriesLoading] = useState(false);
  /**
   * DB から読み直すたびに増やす世代番号。
   * 入力欄は「開いた時点の値」を local state に持つ (= 保存の往復で打鍵中の値を
   * 上書きしないため) ので、読み直したときだけ ItemPanel を作り直して同期させる。
   */
  const [dataVersion, setDataVersion] = useState(0);

  // 行の state。
  // ⚠ 保存処理は非同期に連続で走るので、React の state 更新を待たずに
  //    「今の行」を読めるよう ref にも同じ配列を同期で持つ。
  //    (= 続けて打鍵したときに 2 回 INSERT して行が二重になるのを防ぐ)
  const rowsRef = useRef<OfficeInputRow[]>([]);
  const [rows, setRowsState] = useState<OfficeInputRow[]>([]);
  const applyRows = useCallback(
    (updater: (prev: OfficeInputRow[]) => OfficeInputRow[]) => {
      const next = updater(rowsRef.current);
      rowsRef.current = next;
      setRowsState(next);
    },
    [],
  );

  /** 同じ対象への保存を直列化するキュー (key ごと) */
  const queueRef = useRef<Map<string, Promise<void>>>(new Map());
  const runQueued = useCallback((key: string, task: () => Promise<void>) => {
    const prev = queueRef.current.get(key) ?? Promise.resolve();
    const next = prev
      .then(() => task())
      .catch((e: unknown) => {
        // error を握りつぶさない。必ず toast に出す
        console.error("office-input save failed:", key, e);
        toast.error(e instanceof Error ? e.message : "保存に失敗しました");
      });
    queueRef.current.set(key, next);
  }, []);

  const selectedOffice = useMemo(
    () => offices.find((o) => o.id === officeId) ?? null,
    [offices, officeId],
  );

  // ─── 事業所変更時: スタッフ一覧 load ─────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (!officeId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEmployees([]);
      return;
    }
    setEmployeesLoading(true);
    listEmployeesByOffice(officeId)
      .then((list) => {
        if (cancelled) return;
        setEmployees(list);
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

  // ─── スタッフ or 月変更時: その事業所の全エントリを load ──────
  //     項目ごとに全職員を並べるので、1 人ぶんではなく事業所ぶんまとめて読む。
  const employeeIdsKey = useMemo(
    () => employees.map((e) => e.id).join(","),
    [employees],
  );
  useEffect(() => {
    let cancelled = false;
    const ids = employeeIdsKey === "" ? [] : employeeIdsKey.split(",");
    if (ids.length === 0) {
      rowsRef.current = [];
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRowsState([]);
      return;
    }
    setEntriesLoading(true);
    getEntriesByEmployeesMonth(ids, billingMonth)
      .then((list) => {
        if (cancelled) return;
        const next = list.map(withLocalKey);
        rowsRef.current = next;
        setRowsState(next);
        setDataVersion((v) => v + 1);
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
  }, [employeeIdsKey, billingMonth]);

  // ─── 表示する項目 ────────────────────────────────────────
  const visibleItems = useMemo(
    () =>
      showAllItems
        ? OFFICE_INPUT_ITEMS
        : itemsForOfficeType(selectedOffice?.office_type),
    [showAllItems, selectedOffice],
  );

  // 事業所を切り替えて選択中の項目が消えたら先頭に戻す
  useEffect(() => {
    if (visibleItems.length === 0) return;
    if (visibleItems.some((it) => it.name === selectedItemName)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedItemName(visibleItems[0].name);
  }, [visibleItems, selectedItemName]);

  const selectedItem = useMemo(
    () =>
      visibleItems.find((it) => it.name === selectedItemName) ??
      visibleItems[0] ??
      null,
    [visibleItems, selectedItemName],
  );

  // ─── 項目ごとの集計 ──────────────────────────────────────
  const summaries = useMemo(() => {
    const map = new Map<string, ItemSummary>();
    for (const item of OFFICE_INPUT_ITEMS) {
      const target = rows.filter((r) => r.item_name === item.name);
      const empIds = new Set(target.map((r) => r.employee_id));
      let totalLabel = "";
      if (item.category === "時間項目") {
        const min = target.reduce((s, r) => s + (r.time_minutes ?? 0), 0);
        totalLabel = min > 0 ? minutesToHHMM(min) : "";
      } else if (item.category === "日時項目") {
        const min = target.reduce((s, r) => s + (workedMinutesOf(r) ?? 0), 0);
        totalLabel = min > 0 ? minutesToHHMM(min) : "";
      } else if (item.category === "日付項目") {
        totalLabel = target.length > 0 ? `${target.length}日` : "";
      } else {
        const sum = target.reduce((s, r) => s + (r.numeric_value ?? 0), 0);
        totalLabel = sum !== 0 ? `${formatNumber(sum)}${item.unit ?? ""}` : "";
      }
      map.set(item.name, {
        count: target.length,
        employees: empIds.size,
        totalLabel,
      });
    }
    return map;
  }, [rows]);

  const filledItemCount = useMemo(
    () => visibleItems.filter((it) => (summaries.get(it.name)?.count ?? 0) > 0).length,
    [visibleItems, summaries],
  );

  const selectedRows = useMemo(
    () => (selectedItem ? rows.filter((r) => r.item_name === selectedItem.name) : []),
    [rows, selectedItem],
  );

  // ─── scalar (数値項目 / 時間項目): 1 人 1 値 ─────────────────
  const handleSetScalar = useCallback(
    (item: OfficeInputItem, employeeId: string, value: number | null) => {
      runQueued(`${item.name}|${employeeId}`, async () => {
        const existing = rowsRef.current.find(
          (r) => r.item_name === item.name && r.employee_id === employeeId,
        );

        // 空にしたら行ごと削除する (= 0 と「未入力」を区別する)
        if (value === null) {
          if (!existing) return;
          await deleteEntry(existing.id);
          applyRows((prev) => prev.filter((r) => r.localKey !== existing.localKey));
          return;
        }

        const isTime = item.category === "時間項目";
        const saved = await upsertEntry({
          id: existing?.id,
          employee_id: employeeId,
          billing_month: billingMonth,
          category: item.category,
          item_name: item.name,
          numeric_value: isTime ? null : value,
          time_minutes: isTime ? Math.round(value) : null,
        });

        const localKey = existing?.localKey ?? nextLocalKey();
        applyRows((prev) => {
          const idx = prev.findIndex((r) => r.localKey === localKey);
          const row: OfficeInputRow = { ...saved, localKey };
          if (idx < 0) return [...prev, row];
          const next = [...prev];
          next[idx] = row;
          return next;
        });
      });
    },
    [billingMonth, applyRows, runQueued],
  );

  // ─── dateList (日付項目): 日付の集合を差分で反映 ──────────────
  const handleSetDates = useCallback(
    (item: OfficeInputItem, employeeId: string, dates: string[]) => {
      runQueued(`${item.name}|${employeeId}`, async () => {
        const existing = rowsRef.current.filter(
          (r) => r.item_name === item.name && r.employee_id === employeeId,
        );
        const have = new Set(
          existing.map((r) => r.date_value).filter((d): d is string => !!d),
        );
        const want = new Set(dates);

        const toRemove = existing.filter(
          (r) => !r.date_value || !want.has(r.date_value),
        );
        const toAdd = dates.filter((d) => !have.has(d));
        if (toRemove.length === 0 && toAdd.length === 0) return;

        if (toRemove.length > 0) {
          await deleteEntries(toRemove.map((r) => r.id));
          const removed = new Set(toRemove.map((r) => r.localKey));
          applyRows((prev) => prev.filter((r) => !removed.has(r.localKey)));
        }
        if (toAdd.length > 0) {
          const saved = await insertEntries(
            toAdd.map((d) => ({
              employee_id: employeeId,
              billing_month: billingMonth,
              category: item.category,
              item_name: item.name,
              date_value: d,
            })),
          );
          applyRows((prev) => [...prev, ...saved.map(withLocalKey)]);
        }
      });
    },
    [billingMonth, applyRows, runQueued],
  );

  // ─── rows (日時項目 / 育児手当): 明細行 ──────────────────────
  const handleAddRow = useCallback(
    (item: OfficeInputItem, employeeId: string) => {
      const now = new Date().toISOString();
      const localKey = nextLocalKey();
      applyRows((prev) => [
        ...prev,
        {
          localKey,
          id: `draft-${localKey}`,
          tenant_id: "kt-group",
          employee_id: employeeId,
          billing_month: billingMonth,
          category: item.category,
          item_name: item.name,
          numeric_value: null,
          time_minutes: null,
          date_value: null,
          start_time: null,
          end_time: null,
          break_minutes: null,
          child_name: null,
          reference_month: null,
          notes: null,
          created_at: now,
          updated_at: now,
        },
      ]);
    },
    [billingMonth, applyRows],
  );

  /** 入力中の値を state に反映 (= 保存は行コンポーネントの debounce が呼ぶ) */
  const handleUpdateLocal = useCallback(
    (localKey: string, patch: Partial<OfficeInputEntry>) => {
      applyRows((prev) =>
        prev.map((r) => (r.localKey === localKey ? { ...r, ...patch } : r)),
      );
    },
    [applyRows],
  );

  const handleSaveRow = useCallback(
    (localKey: string) => {
      runQueued(localKey, async () => {
        const row = rowsRef.current.find((r) => r.localKey === localKey);
        if (!row) return;
        const isDraft = row.id.startsWith("draft-");
        const saved = await upsertEntry({
          id: isDraft ? undefined : row.id,
          employee_id: row.employee_id,
          billing_month: row.billing_month,
          category: row.category,
          item_name: row.item_name,
          numeric_value: row.numeric_value,
          time_minutes: row.time_minutes,
          date_value: row.date_value,
          start_time: row.start_time,
          end_time: row.end_time,
          break_minutes: row.break_minutes,
          child_name: row.child_name,
          reference_month: row.reference_month,
          notes: row.notes,
        });
        // localKey は保つ (= 入力中の欄から focus を飛ばさない)
        applyRows((prev) =>
          prev.map((r) => (r.localKey === localKey ? { ...saved, localKey } : r)),
        );
      });
    },
    [applyRows, runQueued],
  );

  const handleDeleteRow = useCallback(
    (localKey: string) => {
      runQueued(localKey, async () => {
        const row = rowsRef.current.find((r) => r.localKey === localKey);
        if (!row) return;
        if (!row.id.startsWith("draft-")) {
          await deleteEntry(row.id);
        }
        applyRows((prev) => prev.filter((r) => r.localKey !== localKey));
      });
    },
    [applyRows, runQueued],
  );

  return (
    <div className="flex flex-col h-full">
      {/* ─── ヘッダー ─── */}
      <div className="flex items-center gap-4 p-4 border-b bg-background">
        <h2 className="text-xl font-bold shrink-0">事業所書式入力</h2>

        <div className="flex items-center gap-2">
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

        <div className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
          <span>
            入力のある項目{" "}
            <span className="font-bold text-foreground">{filledItemCount}</span>
            {" / "}
            {visibleItems.length}
          </span>
          <span>
            対象スタッフ{" "}
            <span className="font-bold text-foreground">{employees.length}</span>人
          </span>
          {entriesLoading && <span>読み込み中…</span>}
        </div>
      </div>

      {/* ─── 本体 ─── */}
      <div className="flex flex-1 min-h-0">
        {/* 左パネル: 項目一覧 (= データ型ではなく事業所の人が知っている言葉で並べる) */}
        <aside className="w-72 shrink-0 border-r bg-muted/20 flex flex-col">
          <div className="px-3 py-2 border-b flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              入力項目
            </span>
            <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={showAllItems}
                onChange={(e) => setShowAllItems(e.target.checked)}
                className="size-3"
              />
              全項目
            </label>
          </div>
          <div className="flex-1 overflow-y-auto">
            {OFFICE_INPUT_GROUPS.map((group) => {
              const items = visibleItems.filter((it) => it.group === group);
              if (items.length === 0) return null;
              return (
                <div key={group}>
                  <div className="px-3 py-1 bg-muted/60 text-[11px] font-medium text-muted-foreground sticky top-0">
                    {group}
                  </div>
                  <ul>
                    {items.map((item) => {
                      const s = summaries.get(item.name);
                      const isActive = item.name === selectedItemName;
                      const filled = (s?.count ?? 0) > 0;
                      return (
                        <li key={item.name}>
                          <button
                            type="button"
                            onClick={() => setSelectedItemName(item.name)}
                            title={item.hint ?? item.name}
                            className={cn(
                              "w-full flex items-center gap-2 px-3 py-1.5 text-sm border-b text-left transition-colors",
                              isActive
                                ? "bg-primary text-primary-foreground"
                                : "hover:bg-muted/60",
                            )}
                          >
                            <span
                              className={cn(
                                "truncate",
                                !isActive && !filled && "text-muted-foreground",
                              )}
                            >
                              {item.name}
                            </span>
                            <span
                              className={cn(
                                "ml-auto shrink-0 text-xs tabular-nums",
                                isActive
                                  ? "text-primary-foreground/80"
                                  : filled
                                    ? "text-foreground"
                                    : "text-muted-foreground/60",
                              )}
                            >
                              {filled
                                ? `${s?.employees}人${s?.totalLabel ? ` / ${s.totalLabel}` : ""}`
                                : "—"}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </aside>

        {/* 右パネル: 選択中の項目の入力面。
            main 自体は縦スクロールさせず、表の本体だけを ItemPanel 側でスクロールさせて
            ヘッダー・絞り込み・表ヘッダーが常に見えるようにする */}
        <main className="flex-1 min-w-0 overflow-hidden flex flex-col">
          {employeesLoading ? (
            <div className="p-4 text-sm text-muted-foreground">読み込み中…</div>
          ) : !selectedItem ? (
            <div className="p-4 text-sm text-muted-foreground">
              この事業所で入力できる項目がありません。「全項目」にチェックすると
              すべての項目を表示します。
            </div>
          ) : employees.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              {officeId
                ? "在職中のスタッフがいません"
                : "事業所を選択してください"}
            </div>
          ) : (
            <ItemPanel
              key={`${selectedItem.name}|${officeId}|${billingMonth}|${dataVersion}`}
              item={selectedItem}
              mode={inputModeOf(selectedItem.category)}
              billingMonth={billingMonth}
              employees={employees}
              rows={selectedRows}
              onSetScalar={handleSetScalar}
              onSetDates={handleSetDates}
              onAddRow={handleAddRow}
              onUpdateLocal={handleUpdateLocal}
              onSaveRow={handleSaveRow}
              onDeleteRow={handleDeleteRow}
            />
          )}
        </main>
      </div>
    </div>
  );
}
