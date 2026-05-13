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
  honnin_kyu: number | null;
  shokuno_kyu: number | null;
  kotei_zangyo: number | null;
  shikaku_teate: number | null;
  kotei: number | null;
  tokutei_shogu: number | null;
  kaigo_rate: number | null;
  shien_rate: number | null;
};

// 列定義: 入力 keys ＋ ラベル。リセット時に全 8 列 NULL に戻す対象でもある。
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
  placeholder: string;
}> = [
  { key: "honnin_kyu", label: "本人給 (円)", placeholder: "0" },
  { key: "shokuno_kyu", label: "職能給 (円)", placeholder: "0" },
  { key: "kotei_zangyo", label: "固定残業手当 (円)", placeholder: "0" },
  { key: "shikaku_teate", label: "資格手当 (円)", placeholder: "0" },
  { key: "kotei", label: "勤続手当 (円)", placeholder: "0" },
  { key: "tokutei_shogu", label: "特定処遇改善 (円)", placeholder: "0" },
  { key: "kaigo_rate", label: "要介護単価 (円/件)", placeholder: "0" },
  { key: "shien_rate", label: "要支援単価 (円/件)", placeholder: "0" },
];

/**
 * 居宅介護支援 ケアマネ別給与設定 modal (6 列分解版)
 *
 * DB: payroll_employees の kyotaku_honnin_kyu / kyotaku_shokuno_kyu /
 *     kyotaku_kotei_zangyo / kyotaku_shikaku_teate / kyotaku_kotei /
 *     kyotaku_tokutei_shogu / kyotaku_kaigo_rate / kyotaku_shien_rate
 *
 * 仕様: 集計.py の「給与設定」sheet を 8 列に拡張。
 *   - base (プラン手当比較) = honnin + shokuno + kotei_zangyo
 *   - shikaku / kotei / tokutei は total に独立加算
 *   - 全 8 列 NULL の場合は base = DEFAULT_BASE_SALARY=250000 (旧仕様互換)
 *
 * 旧 kyotaku_base_salary は DB に残置 (rollback 用) するが UI では参照しない。
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
      .select(
        "id, name, kyotaku_honnin_kyu, kyotaku_shokuno_kyu, kyotaku_kotei_zangyo, kyotaku_shikaku_teate, kyotaku_kotei, kyotaku_tokutei_shogu, kyotaku_kaigo_rate, kyotaku_shien_rate",
      )
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
      kyotaku_honnin_kyu: number | null;
      kyotaku_shokuno_kyu: number | null;
      kyotaku_kotei_zangyo: number | null;
      kyotaku_shikaku_teate: number | null;
      kyotaku_kotei: number | null;
      kyotaku_tokutei_shogu: number | null;
      kyotaku_kaigo_rate: number | null;
      kyotaku_shien_rate: number | null;
    };
    const list = (data ?? []) as EmployeeRow[];

    const all: SettingRow[] = list
      .filter((e) => e.name)
      .map((e) => ({
        employee_id: e.id,
        staff_name: e.name,
        honnin_kyu: e.kyotaku_honnin_kyu,
        shokuno_kyu: e.kyotaku_shokuno_kyu,
        kotei_zangyo: e.kyotaku_kotei_zangyo,
        shikaku_teate: e.kyotaku_shikaku_teate,
        kotei: e.kyotaku_kotei,
        tokutei_shogu: e.kyotaku_tokutei_shogu,
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

  const parseIntOrNull = (s: string): number | null => {
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };

  const isRowUnset = (r: SettingRow): boolean =>
    INPUT_COLS.every((c) => r[c.key] === null);

  const handleReset = useCallback((index: number) => {
    setRows((prev) => {
      const next = [...prev];
      const reset: SettingRow = {
        ...next[index],
        honnin_kyu: null,
        shokuno_kyu: null,
        kotei_zangyo: null,
        shikaku_teate: null,
        kotei: null,
        tokutei_shogu: null,
        kaigo_rate: null,
        shien_rate: null,
      };
      next[index] = reset;
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    // バリデーション: 全 8 列、非 NULL なら 0 以上の整数
    for (const r of rows) {
      for (const c of INPUT_COLS) {
        const v = r[c.key];
        if (v !== null && (!Number.isFinite(v) || v < 0)) {
          toast.error(
            `${r.staff_name}: ${c.label} は 0 以上の整数で入力してください`,
          );
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
      return INPUT_COLS.some((c) => o[c.key] !== r[c.key]);
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
          kyotaku_honnin_kyu: r.honnin_kyu,
          kyotaku_shokuno_kyu: r.shokuno_kyu,
          kyotaku_kotei_zangyo: r.kotei_zangyo,
          kyotaku_shikaku_teate: r.shikaku_teate,
          kyotaku_kotei: r.kotei,
          kyotaku_tokutei_shogu: r.tokutei_shogu,
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>設定: ケアマネ別給与 (6 列分解)</DialogTitle>
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
                    <TableHead className="min-w-32 whitespace-nowrap">
                      ケアマネ名
                    </TableHead>
                    {INPUT_COLS.map((c) => (
                      <TableHead
                        key={c.key}
                        className="min-w-28 whitespace-nowrap"
                      >
                        {c.label}
                      </TableHead>
                    ))}
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row, index) => {
                    const isUnset = isRowUnset(row);
                    return (
                      <TableRow key={row.employee_id}>
                        <TableCell className="font-medium whitespace-nowrap">
                          {row.staff_name}
                          {isUnset && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              (未設定)
                            </span>
                          )}
                        </TableCell>
                        {INPUT_COLS.map((c) => (
                          <TableCell key={c.key}>
                            <Input
                              type="number"
                              min={0}
                              step={1}
                              value={row[c.key] ?? ""}
                              placeholder={c.placeholder}
                              onChange={(e) =>
                                updateRow(index, {
                                  [c.key]: parseIntOrNull(e.target.value),
                                })
                              }
                            />
                          </TableCell>
                        ))}
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
