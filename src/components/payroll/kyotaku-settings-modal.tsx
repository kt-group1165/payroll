"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { RotateCcw } from "lucide-react";

type Props = {
  open: boolean;
  onClose: () => void;
  tenantId: string;
  officeNumber: string;
  /** dashboard から渡される (records に存在するケアマネ一覧)。employees に未登録なら警告表示。 */
  staffNames: string[];
  onSaved?: () => void;
};

type SettingRow = {
  employee_id: string;
  staff_name: string;
  /** 入力値 (空文字 NULL 化、null = 未設定で fallback) */
  base_salary: number | null;
  kaigo_rate: number | null;
  shien_rate: number | null;
};

const DEFAULT_BASE_SALARY = 250000;

/**
 * 居宅介護支援 ケアマネ別給与設定 modal
 *
 * 仕様: apps/居宅給与計算/SPEC.md §2.2 (給与設定 sheet)
 * DB:   payroll_employees の kyotaku_base_salary / kyotaku_kaigo_rate / kyotaku_shien_rate
 *
 * - open 時に該当 office の payroll_employees row を全件 fetch
 * - 全員を 1 テーブルで表示、inline 編集
 * - 「リセット」: 該当 row の 3 列を NULL (未設定) に戻す
 * - 「保存」: 変更があった row のみ update
 */
export function KyotakuSettingsModal({
  open,
  onClose,
  officeNumber,
  staffNames,
  onSaved,
}: Props) {
  const [rows, setRows] = useState<SettingRow[]>([]);
  const [originalRows, setOriginalRows] = useState<SettingRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: officeRow, error: oErr } = await supabase
      .from("payroll_offices")
      .select("id")
      .eq("office_number", officeNumber)
      .maybeSingle();
    if (oErr || !officeRow) {
      toast.error(`事業所解決エラー: ${oErr?.message ?? "office not found"}`);
      setRows([]);
      setOriginalRows([]);
      setLoading(false);
      return;
    }
    const officeId = (officeRow as { id: string }).id;

    const { data, error } = await supabase
      .from("payroll_employees")
      .select("id, name, kyotaku_base_salary, kyotaku_kaigo_rate, kyotaku_shien_rate")
      .eq("office_id", officeId)
      .order("name", { ascending: true });

    if (error) {
      toast.error(`設定読込エラー: ${error.message}`);
      setRows([]);
      setOriginalRows([]);
      setLoading(false);
      return;
    }

    type EmployeeRow = {
      id: string;
      name: string;
      kyotaku_base_salary: number | null;
      kyotaku_kaigo_rate: number | null;
      kyotaku_shien_rate: number | null;
    };
    const list = (data ?? []) as EmployeeRow[];

    const all: SettingRow[] = list
      .filter((e) => e.name)
      .map((e) => ({
        employee_id: e.id,
        staff_name: e.name,
        base_salary: e.kyotaku_base_salary,
        kaigo_rate: e.kyotaku_kaigo_rate,
        shien_rate: e.kyotaku_shien_rate,
      }));
    setRows(all);
    setOriginalRows(all.map((r) => ({ ...r })));
    setLoading(false);
  }, [officeNumber]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- open 切替時の async fetch (HANDOVER §2 参照) */
    if (open) {
      void load();
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, load]);

  const knownEmployeeNames = useMemo(
    () => new Set(rows.map((r) => r.staff_name)),
    [rows],
  );

  /** records には居るが payroll_employees に居ない名前 (本来は backfill 済みで無いはず) */
  const orphanStaffNames = useMemo(() => {
    if (!staffNames || staffNames.length === 0) return [] as string[];
    return staffNames.filter((n) => n && !knownEmployeeNames.has(n));
  }, [staffNames, knownEmployeeNames]);

  const updateRow = useCallback(
    (index: number, patch: Partial<SettingRow>) => {
      setRows((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], ...patch };
        return next;
      });
    },
    [],
  );

  const parseInt = (s: string): number | null => {
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };

  const handleReset = useCallback((index: number) => {
    setRows((prev) => {
      const next = [...prev];
      next[index] = {
        ...next[index],
        base_salary: null,
        kaigo_rate: null,
        shien_rate: null,
      };
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    // バリデーション
    for (const r of rows) {
      for (const [k, v] of [
        ["基本給", r.base_salary],
        ["要介護単価", r.kaigo_rate],
        ["要支援単価", r.shien_rate],
      ] as const) {
        if (v !== null && (!Number.isFinite(v) || v < 0)) {
          toast.error(`${r.staff_name}: ${k} は 0 以上の整数で入力してください`);
          return;
        }
      }
    }

    setSaving(true);

    // 変更行のみ抽出
    const origMap = new Map(originalRows.map((r) => [r.employee_id, r]));
    const changed = rows.filter((r) => {
      const o = origMap.get(r.employee_id);
      if (!o) return true;
      return (
        o.base_salary !== r.base_salary ||
        o.kaigo_rate !== r.kaigo_rate ||
        o.shien_rate !== r.shien_rate
      );
    });

    if (changed.length === 0) {
      setSaving(false);
      toast.success("変更はありません");
      onClose();
      return;
    }

    let fail = 0;
    let failMsg = "";
    for (const r of changed) {
      const { error } = await supabase
        .from("payroll_employees")
        .update({
          kyotaku_base_salary: r.base_salary,
          kyotaku_kaigo_rate: r.kaigo_rate,
          kyotaku_shien_rate: r.shien_rate,
        })
        .eq("id", r.employee_id);
      if (error) {
        fail += 1;
        failMsg = error.message;
      }
    }

    setSaving(false);
    if (fail > 0) {
      toast.error(`保存エラー: ${fail} 件失敗 (${failMsg})`);
      return;
    }
    toast.success(`${changed.length} 件の設定を保存しました`);
    onSaved?.();
    onClose();
  }, [rows, originalRows, onClose, onSaved]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>設定: ケアマネ別給与</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {loading ? (
            <p className="text-sm text-muted-foreground">読込中…</p>
          ) : rows.length === 0 ? (
            <p className="rounded border border-dashed p-4 text-center text-sm text-muted-foreground">
              この事業所には payroll_employees に登録されたケアマネがいません。
              <br />
              先に /employees から職員登録してください。
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table className="text-sm">
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-32">ケアマネ名</TableHead>
                    <TableHead className="min-w-32">基本給 (円)</TableHead>
                    <TableHead className="min-w-32">要介護単価 (円/件)</TableHead>
                    <TableHead className="min-w-32">要支援単価 (円/件)</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row, index) => {
                    const isUnset =
                      row.base_salary === null &&
                      row.kaigo_rate === null &&
                      row.shien_rate === null;
                    return (
                      <TableRow key={row.employee_id}>
                        <TableCell className="font-medium">
                          {row.staff_name}
                          {isUnset && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              (未設定)
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            min={0}
                            step={1}
                            value={row.base_salary ?? ""}
                            placeholder={String(DEFAULT_BASE_SALARY)}
                            onChange={(e) =>
                              updateRow(index, {
                                base_salary: parseInt(e.target.value),
                              })
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            min={0}
                            step={1}
                            value={row.kaigo_rate ?? ""}
                            placeholder="0"
                            onChange={(e) =>
                              updateRow(index, {
                                kaigo_rate: parseInt(e.target.value),
                              })
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            min={0}
                            step={1}
                            value={row.shien_rate ?? ""}
                            placeholder="0"
                            onChange={(e) =>
                              updateRow(index, {
                                shien_rate: parseInt(e.target.value),
                              })
                            }
                          />
                        </TableCell>
                        <TableCell>
                          {!isUnset && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => handleReset(index)}
                              aria-label="リセット (未設定に戻す)"
                              title="リセット (未設定に戻す)"
                            >
                              <RotateCcw className="text-muted-foreground" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
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
          <Button variant="outline" onClick={onClose} disabled={saving}>
            キャンセル
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving || loading}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
