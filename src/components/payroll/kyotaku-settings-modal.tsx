"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import { Trash2, Plus } from "lucide-react";

type Props = {
  open: boolean;
  onClose: () => void;
  tenantId: string;
  officeNumber: string;
  /** dashboard から渡される (records に存在するケアマネ一覧) */
  staffNames: string[];
  onSaved?: () => void;
};

type SettingRow = {
  id: string | null; // null = まだ DB に保存されていない新規 row
  staff_name: string;
  base_salary: number;
  kaigo_rate: number;
  shien_rate: number;
};

const DEFAULT_BASE_SALARY = 250000;

/**
 * 居宅介護支援 ケアマネ別給与設定 modal
 *
 * 仕様: apps/居宅給与計算/SPEC.md §2.2 (給与設定 sheet)
 * DB:   payroll_kyotaku_settings (apps/payroll-app/migrations/payroll_kyotaku_v1.sql)
 *
 * - open 時に該当 office の全 row を fetch
 * - inline 編集 (基本給 / 要介護単価 / 要支援単価)
 * - 「+ ケアマネ追加」: staffNames のうち未登録の名前から select
 * - 「保存」で upsert (onConflict: office_number,staff_name)
 * - 「削除」で DB から削除 (id がある row のみ)
 */
export function KyotakuSettingsModal({
  open,
  onClose,
  tenantId,
  officeNumber,
  staffNames,
  onSaved,
}: Props) {
  const [rows, setRows] = useState<SettingRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingAddStaff, setPendingAddStaff] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("payroll_kyotaku_settings")
      .select("id, staff_name, base_salary, kaigo_rate, shien_rate")
      .eq("office_number", officeNumber)
      .order("staff_name", { ascending: true });

    if (error) {
      toast.error(`設定読込エラー: ${error.message}`);
      setRows([]);
      setLoading(false);
      return;
    }

    setRows(
      (data ?? []).map((r) => ({
        id: r.id as string,
        staff_name: r.staff_name as string,
        base_salary: Number(r.base_salary ?? DEFAULT_BASE_SALARY),
        kaigo_rate: Number(r.kaigo_rate ?? 0),
        shien_rate: Number(r.shien_rate ?? 0),
      })),
    );
    setLoading(false);
  }, [officeNumber]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- open 切替時の async fetch (HANDOVER §2 参照) */
    if (open) {
      void load();
      setPendingAddStaff("");
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, load]);

  /** records に居るが settings に居ないケアマネ一覧 (追加候補) */
  const addCandidates = useMemo(() => {
    const existing = new Set(rows.map((r) => r.staff_name));
    return staffNames.filter((n) => n && !existing.has(n));
  }, [rows, staffNames]);

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

  const handleAddStaff = useCallback(() => {
    if (!pendingAddStaff) {
      toast.error("追加するケアマネを選択してください");
      return;
    }
    if (rows.some((r) => r.staff_name === pendingAddStaff)) {
      toast.error("既に追加されています");
      return;
    }
    setRows((prev) => [
      ...prev,
      {
        id: null,
        staff_name: pendingAddStaff,
        base_salary: DEFAULT_BASE_SALARY,
        kaigo_rate: 0,
        shien_rate: 0,
      },
    ]);
    setPendingAddStaff("");
  }, [pendingAddStaff, rows]);

  const handleDelete = useCallback(
    async (index: number) => {
      const target = rows[index];
      if (!target) return;
      if (!confirm(`${target.staff_name} の給与設定を削除しますか？`)) return;

      if (target.id) {
        const { error } = await supabase
          .from("payroll_kyotaku_settings")
          .delete()
          .eq("id", target.id);
        if (error) {
          toast.error(`削除エラー: ${error.message}`);
          return;
        }
      }
      setRows((prev) => prev.filter((_, i) => i !== index));
      toast.success(`${target.staff_name} の設定を削除しました`);
    },
    [rows],
  );

  const handleSave = useCallback(async () => {
    // バリデーション
    for (const r of rows) {
      if (!r.staff_name.trim()) {
        toast.error("ケアマネ名が空の行があります");
        return;
      }
      if (!Number.isFinite(r.base_salary) || r.base_salary < 0) {
        toast.error(`${r.staff_name}: 基本給は 0 以上の整数で入力してください`);
        return;
      }
      if (!Number.isFinite(r.kaigo_rate) || r.kaigo_rate < 0) {
        toast.error(`${r.staff_name}: 要介護単価は 0 以上の整数で入力してください`);
        return;
      }
      if (!Number.isFinite(r.shien_rate) || r.shien_rate < 0) {
        toast.error(`${r.staff_name}: 要支援単価は 0 以上の整数で入力してください`);
        return;
      }
    }

    setSaving(true);
    const payload = rows.map((r) => ({
      tenant_id: tenantId,
      office_number: officeNumber,
      staff_name: r.staff_name,
      base_salary: Math.trunc(r.base_salary),
      kaigo_rate: Math.trunc(r.kaigo_rate),
      shien_rate: Math.trunc(r.shien_rate),
      updated_at: new Date().toISOString(),
    }));

    if (payload.length === 0) {
      setSaving(false);
      toast.success("設定を保存しました");
      onSaved?.();
      onClose();
      return;
    }

    const { error } = await supabase
      .from("payroll_kyotaku_settings")
      .upsert(payload, { onConflict: "office_number,staff_name" });

    setSaving(false);

    if (error) {
      toast.error(`保存エラー: ${error.message}`);
      return;
    }
    toast.success(`${payload.length} 件の設定を保存しました`);
    onSaved?.();
    onClose();
  }, [rows, tenantId, officeNumber, onClose, onSaved]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>設定: ケアマネ別給与</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {loading ? (
            <p className="text-sm text-muted-foreground">読込中…</p>
          ) : rows.length === 0 ? (
            <p className="rounded border border-dashed p-4 text-center text-sm text-muted-foreground">
              ケアマネ設定がまだ登録されていません。
              <br />
              下の「+ ケアマネ追加」から追加してください。
            </p>
          ) : (
            rows.map((row, index) => (
              <div
                key={`${row.staff_name}-${row.id ?? "new"}`}
                className="rounded-lg border p-3 space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium text-sm">
                    {row.staff_name}
                    {row.id === null && (
                      <span className="ml-2 text-xs text-amber-600">(未保存)</span>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => void handleDelete(index)}
                    aria-label="削除"
                  >
                    <Trash2 className="text-destructive" />
                  </Button>
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <div className="space-y-1">
                    <Label className="text-xs">基本給 (円)</Label>
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      value={row.base_salary}
                      onChange={(e) =>
                        updateRow(index, {
                          base_salary: Number(e.target.value),
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">要介護単価 (円/件)</Label>
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      value={row.kaigo_rate}
                      onChange={(e) =>
                        updateRow(index, {
                          kaigo_rate: Number(e.target.value),
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">要支援単価 (円/件)</Label>
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      value={row.shien_rate}
                      onChange={(e) =>
                        updateRow(index, {
                          shien_rate: Number(e.target.value),
                        })
                      }
                    />
                  </div>
                </div>
              </div>
            ))
          )}

          <div className="rounded-lg border border-dashed p-3 space-y-2">
            <Label className="text-xs text-muted-foreground">
              + ケアマネ追加 (records に出現するケアマネのうち未登録の方)
            </Label>
            {addCandidates.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                追加可能なケアマネはいません。
              </p>
            ) : (
              <div className="flex items-center gap-2">
                <Select
                  value={pendingAddStaff || "__none__"}
                  onValueChange={(v) =>
                    setPendingAddStaff(!v || v === "__none__" ? "" : v)
                  }
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="ケアマネを選択">
                      {(v: string) =>
                        !v || v === "__none__" ? "ケアマネを選択" : v
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">ケアマネを選択</SelectItem>
                    {addCandidates.map((n) => (
                      <SelectItem key={n} value={n}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleAddStaff}
                  disabled={!pendingAddStaff}
                >
                  <Plus />
                  追加
                </Button>
              </div>
            )}
          </div>
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
