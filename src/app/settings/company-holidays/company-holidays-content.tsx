"use client";

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
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
import { useCompanyHolidays, type CompanyHoliday } from "@/lib/swr/use-company-holidays";

/**
 * 会社休日 設定画面の client content。
 *
 * 仕様:
 *   - 年フィルタ (default 当年)、年内のみ一覧表示
 *   - 行追加: date picker + name input (即時 INSERT)
 *   - 行削除: × ボタン (即時 DELETE)
 *   - 「デフォルトに戻す」: 当年 + 翌年の お盆 (8/13-15) + 年末年始 (12/30-1/3 から 1/1 除く) を UPSERT
 *   - 全操作は逐次保存。SWR mutate で再 fetch。
 *   - tenant_id は 'kt-group' 固定。
 */

const TENANT_ID = "kt-group";

// =====================================================================
// helper
// =====================================================================

function currentYear(): number {
  return new Date().getFullYear();
}

/** YYYY-MM-DD → "YYYY年MM月DD日 (曜)" */
function fmtDateJa(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  const dow = ["日", "月", "火", "水", "木", "金", "土"][dt.getUTCDay()];
  return `${y}年${String(mo).padStart(2, "0")}月${String(d).padStart(2, "0")}日 (${dow})`;
}

/** 当年 + 翌年のデフォルト休日 list (お盆 + 年末年始、1/1 除く) */
function buildDefaultHolidays(baseYear: number): { holiday_date: string; name: string }[] {
  const rows: { holiday_date: string; name: string }[] = [];
  for (const year of [baseYear, baseYear + 1]) {
    for (const d of [13, 14, 15]) {
      rows.push({
        holiday_date: `${year}-08-${String(d).padStart(2, "0")}`,
        name: "お盆",
      });
    }
    for (const d of [30, 31]) {
      rows.push({
        holiday_date: `${year}-12-${String(d).padStart(2, "0")}`,
        name: "年末年始",
      });
    }
    for (const d of [2, 3]) {
      rows.push({
        holiday_date: `${year}-01-${String(d).padStart(2, "0")}`,
        name: "年末年始",
      });
    }
  }
  return rows;
}

// =====================================================================
// Main Component
// =====================================================================

export function CompanyHolidaysContent() {
  const [yearFilter, setYearFilter] = useState<number>(currentYear());
  // 一覧は year フィルタ単位の cache key で fetch (UI 表示用)
  const {
    holidays,
    isLoading,
    error,
    mutate,
  } = useCompanyHolidays(yearFilter);

  // 新規追加行
  const [newDate, setNewDate] = useState<string>("");
  const [newName, setNewName] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  // 年フィルタ select options: 過去 1 年 〜 翌 2 年
  const yearOptions = useMemo(() => {
    const now = currentYear();
    return [now - 1, now, now + 1, now + 2];
  }, []);

  const sortedHolidays = useMemo(
    () => [...holidays].sort((a, b) => a.holiday_date.localeCompare(b.holiday_date)),
    [holidays],
  );

  const handleAdd = useCallback(async (): Promise<void> => {
    const date = newDate.trim();
    const name = newName.trim();
    if (!date) {
      toast.error("日付を入力してください");
      return;
    }
    if (!name) {
      toast.error("名称を入力してください");
      return;
    }
    setBusy(true);
    try {
      const { error: upErr } = await supabase
        .from("payroll_company_holidays")
        .upsert(
          {
            tenant_id: TENANT_ID,
            holiday_date: date,
            name,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "tenant_id,holiday_date" },
        );
      if (upErr) throw upErr;
      toast.success(`${date} ${name} を追加しました`);
      setNewDate("");
      setNewName("");
      // 「all」cache と year-filtered cache 両方を invalidate するため SWR の global mutate ではなく
      // 本 hook の mutate を呼ぶ + 表示中 year を一旦変えて再 fetch でも OK だが、
      // SWR は同じ key を共有する全 hook が再 fetch するので、本 hook の mutate で十分。
      mutate();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`追加に失敗: ${msg}`);
    } finally {
      setBusy(false);
    }
  }, [newDate, newName, mutate]);

  const handleDelete = useCallback(
    async (row: CompanyHoliday): Promise<void> => {
      if (!window.confirm(`${row.holiday_date} (${row.name}) を削除します。よろしいですか？`)) {
        return;
      }
      setBusy(true);
      try {
        const { error: delErr } = await supabase
          .from("payroll_company_holidays")
          .delete()
          .eq("id", row.id);
        if (delErr) throw delErr;
        toast.success("削除しました");
        mutate();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.error(`削除に失敗: ${msg}`);
      } finally {
        setBusy(false);
      }
    },
    [mutate],
  );

  const handleRestoreDefaults = useCallback(async (): Promise<void> => {
    const base = currentYear();
    const seed = buildDefaultHolidays(base);
    if (
      !window.confirm(
        `${base} 年・${base + 1} 年のデフォルト会社休日 (お盆 + 年末年始) を一括登録します。\n` +
          `既存の同日付があれば名称を上書きします。よろしいですか？`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const rows = seed.map((s) => ({
        tenant_id: TENANT_ID,
        holiday_date: s.holiday_date,
        name: s.name,
        updated_at: new Date().toISOString(),
      }));
      const { error: upErr } = await supabase
        .from("payroll_company_holidays")
        .upsert(rows, { onConflict: "tenant_id,holiday_date" });
      if (upErr) throw upErr;
      toast.success(`${rows.length} 件 反映しました`);
      mutate();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`デフォルト登録に失敗: ${msg}`);
    } finally {
      setBusy(false);
    }
  }, [mutate]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">
          会社休日
          <span className="ml-2 text-base font-normal text-muted-foreground">
            (お盆 / 年末年始 など、祝日以外の独自休業日)
          </span>
        </h2>
      </div>

      {error && (
        <div className="rounded-md border border-destructive bg-destructive/5 px-3 py-2 text-sm text-destructive">
          会社休日の取得に失敗: {error.message}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">追加</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">日付</label>
              <Input
                type="date"
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
                className="w-44"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">名称</label>
              <Input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="例: お盆 / 年末年始 / 創立記念日"
                className="w-64"
              />
            </div>
            <Button onClick={handleAdd} disabled={busy}>
              追加
            </Button>
            <Button
              variant="outline"
              onClick={handleRestoreDefaults}
              disabled={busy}
              title={`${currentYear()} 年・${currentYear() + 1} 年のお盆 (8/13-15) と年末年始 (12/30-1/3, 1/1 除く) を一括 UPSERT`}
            >
              デフォルトに戻す (当年 + 翌年)
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">
            一覧
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {yearFilter} 年 / {sortedHolidays.length} 件
            </span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground">年</label>
            <select
              className="rounded-md border bg-background px-3 py-2 text-sm"
              value={yearFilter}
              onChange={(e) => setYearFilter(parseInt(e.target.value, 10))}
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y} 年
                </option>
              ))}
            </select>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <p className="text-sm text-muted-foreground mb-2">読み込み中...</p>
          )}
          {!isLoading && sortedHolidays.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {yearFilter} 年の会社休日はまだ登録されていません。
            </p>
          )}
          {sortedHolidays.length > 0 && (
            <Table className="text-sm">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-64">日付</TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead className="w-20 text-center">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedHolidays.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="tabular-nums">
                      {fmtDateJa(row.holiday_date)}
                    </TableCell>
                    <TableCell>{row.name}</TableCell>
                    <TableCell className="text-center">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(row)}
                        disabled={busy}
                        title="削除"
                        className="text-destructive"
                      >
                        ×
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
