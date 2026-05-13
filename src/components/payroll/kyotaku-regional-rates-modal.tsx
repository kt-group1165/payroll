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
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import { Trash2, AlertTriangle } from "lucide-react";

type Props = {
  open: boolean;
  onClose: () => void;
  tenantId: string;
  /** records.insurer_name の distinct (dashboard から渡される) */
  insurerNames: string[];
  onSaved?: () => void;
};

type RateRow = {
  id: string | null; // null = まだ DB に保存されていない暫定 row
  insurer_name: string;
  rate: number;
  /** records に出現するが master に未登録 (確認しないと反映されない警告) */
  isPendingFromRecords: boolean;
};

const DEFAULT_RATE = 10.0;

/**
 * 居宅介護支援 地域加算 (保険者 → 円/単位) master CRUD modal
 *
 * 仕様: apps/居宅給与計算/SPEC.md §2.4 (地域区分 sheet)
 * DB:   payroll_kyotaku_regional_rates (apps/payroll-app/migrations/payroll_kyotaku_v1.sql)
 *
 * - open 時に該当 tenant の全 row を fetch
 * - records に出現する insurer_name のうち master に未登録のものは
 *   default 10.0 の暫定 row として表示 (警告色)
 * - 「保存」で upsert (onConflict: tenant_id,insurer_name)
 * - 「削除」で DB から削除 (id がある row のみ)
 */
export function KyotakuRegionalRatesModal({
  open,
  onClose,
  tenantId,
  insurerNames,
  onSaved,
}: Props) {
  const [rows, setRows] = useState<RateRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("payroll_kyotaku_regional_rates")
      .select("id, insurer_name, rate")
      .eq("tenant_id", tenantId)
      .order("insurer_name", { ascending: true });

    if (error) {
      toast.error(`地域加算読込エラー: ${error.message}`);
      setRows([]);
      setLoading(false);
      return;
    }

    const dbRows: RateRow[] = (data ?? []).map((r) => ({
      id: r.id as string,
      insurer_name: r.insurer_name as string,
      rate: Number(r.rate ?? DEFAULT_RATE),
      isPendingFromRecords: false,
    }));

    // records に出てくる保険者のうち master に未登録のものを暫定 row として merge
    const existing = new Set(dbRows.map((r) => r.insurer_name));
    const pending: RateRow[] = insurerNames
      .filter((n) => n && !existing.has(n))
      .map((n) => ({
        id: null,
        insurer_name: n,
        rate: DEFAULT_RATE,
        isPendingFromRecords: true,
      }));

    setRows(
      [...dbRows, ...pending].sort((a, b) =>
        a.insurer_name.localeCompare(b.insurer_name, "ja"),
      ),
    );
    setLoading(false);
  }, [tenantId, insurerNames]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- open 切替時の async fetch (HANDOVER §2 参照) */
    if (open) {
      void load();
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, load]);

  const pendingCount = useMemo(
    () => rows.filter((r) => r.isPendingFromRecords).length,
    [rows],
  );

  const updateRow = useCallback(
    (index: number, patch: Partial<RateRow>) => {
      setRows((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], ...patch };
        return next;
      });
    },
    [],
  );

  const handleDelete = useCallback(
    async (index: number) => {
      const target = rows[index];
      if (!target) return;
      if (!confirm(`${target.insurer_name} の地域加算を削除しますか？`)) return;

      if (target.id) {
        const { error } = await supabase
          .from("payroll_kyotaku_regional_rates")
          .delete()
          .eq("id", target.id);
        if (error) {
          toast.error(`削除エラー: ${error.message}`);
          return;
        }
      }
      setRows((prev) => prev.filter((_, i) => i !== index));
      toast.success(`${target.insurer_name} の地域加算を削除しました`);
    },
    [rows],
  );

  const handleSave = useCallback(async () => {
    // バリデーション
    for (const r of rows) {
      if (!r.insurer_name.trim()) {
        toast.error("保険者名が空の行があります");
        return;
      }
      if (!Number.isFinite(r.rate) || r.rate <= 0) {
        toast.error(`${r.insurer_name}: 単価は 0 より大きい数値で入力してください`);
        return;
      }
    }

    setSaving(true);
    // 保存対象: 既存 DB row + ユーザが触った pending row
    // (pending のままで rate がデフォルトの 10.0 でも、確認 = 保存と扱う)
    const payload = rows.map((r) => ({
      tenant_id: tenantId,
      insurer_name: r.insurer_name,
      rate: Number(r.rate),
      updated_at: new Date().toISOString(),
    }));

    if (payload.length === 0) {
      setSaving(false);
      toast.success("地域加算を保存しました");
      onSaved?.();
      onClose();
      return;
    }

    const { error } = await supabase
      .from("payroll_kyotaku_regional_rates")
      .upsert(payload, { onConflict: "tenant_id,insurer_name" });

    setSaving(false);

    if (error) {
      toast.error(`保存エラー: ${error.message}`);
      return;
    }
    toast.success(`${payload.length} 件の地域加算を保存しました`);
    onSaved?.();
    onClose();
  }, [rows, tenantId, onClose, onSaved]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>設定: 地域加算 (保険者別 1 単位の円)</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {pendingCount > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-200">
              <AlertTriangle className="size-4 shrink-0" />
              <p>
                {pendingCount} 件の保険者が records に出現していますが、まだ
                master に登録されていません。確認のうえ「保存」してください
                (保存しないと既定値 10.0 が反映されません)。
              </p>
            </div>
          )}

          {loading ? (
            <p className="text-sm text-muted-foreground">読込中…</p>
          ) : rows.length === 0 ? (
            <p className="rounded border border-dashed p-4 text-center text-sm text-muted-foreground">
              地域加算がまだ登録されていません。records に保険者が出現すると
              自動で候補が表示されます。
            </p>
          ) : (
            <div className="space-y-2">
              <div className="grid grid-cols-[1fr_140px_40px] gap-2 px-2 text-xs text-muted-foreground">
                <span>保険者名</span>
                <span>単価 (円/単位)</span>
                <span className="text-right">操作</span>
              </div>
              {rows.map((row, index) => (
                <div
                  key={`${row.insurer_name}-${row.id ?? "pending"}`}
                  className={
                    "grid grid-cols-[1fr_140px_40px] items-center gap-2 rounded-lg border p-2 " +
                    (row.isPendingFromRecords
                      ? "border-amber-300 bg-amber-50/40 dark:border-amber-700/40 dark:bg-amber-950/20"
                      : "")
                  }
                >
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium">{row.insurer_name}</span>
                    {row.isPendingFromRecords && (
                      <span className="text-xs text-amber-700 dark:text-amber-300">
                        (未確認)
                      </span>
                    )}
                  </div>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={row.rate}
                    onChange={(e) =>
                      updateRow(index, { rate: Number(e.target.value) })
                    }
                  />
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
              ))}
            </div>
          )}

          <div className="rounded border bg-muted/30 p-2 text-xs text-muted-foreground">
            <Label className="text-xs">参考</Label>
            <p className="mt-1">
              既定値 10.0 円/単位 (地域加算なし)。1 級地 11.40 / 2 級地 11.12 等、
              所定の地域区分に従い保険者ごとに設定してください。
            </p>
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
