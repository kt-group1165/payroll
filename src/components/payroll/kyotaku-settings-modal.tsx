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
  /** dashboard から渡される (records に存在するケアマネ一覧)。表示候補生成にも使うが
   *  追加候補は「payroll_employees に登録済みで kyotaku_* がまだ NULL の name」を採用する。 */
  staffNames: string[];
  onSaved?: () => void;
};

type SettingRow = {
  /** payroll_employees.id (必須: NULL になることはない、未保存 row は別配列管理) */
  employee_id: string;
  staff_name: string;
  /** NULL のときは DEFAULT_BASE_SALARY を表示するが、保存時は入力値をそのまま書く */
  base_salary: number;
  kaigo_rate: number;
  shien_rate: number;
  /** 「設定済み」(= 3 列のいずれかが non-NULL) のフラグ。delete で全列 NULL に戻すと false */
  configured: boolean;
};

const DEFAULT_BASE_SALARY = 250000;

/**
 * 居宅介護支援 ケアマネ別給与設定 modal
 *
 * 仕様: apps/居宅給与計算/SPEC.md §2.2 (給与設定 sheet)
 * DB:   payroll_employees の kyotaku_base_salary / kyotaku_kaigo_rate / kyotaku_shien_rate
 *       (2026-05-13 に payroll_kyotaku_settings から集約)
 *
 * - open 時に該当 office の payroll_employees row を fetch
 * - inline 編集 (基本給 / 要介護単価 / 要支援単価)
 * - 「+ ケアマネ追加」: 同 office の employees で 3 列がまだ NULL のものを候補に
 * - 「保存」: 各 row を payroll_employees.update で書き込み (id ベース)
 * - 「削除」: 列値を NULL に戻す (row 自体は削除しない、他用途で使われ得るため)
 */
export function KyotakuSettingsModal({
  open,
  onClose,
  // tenantId は payroll_employees に列が無いため未使用だが、呼び出し側の
  // interface 互換のため Props 上には残す。
  officeNumber,
  staffNames,
  onSaved,
}: Props) {
  // 「設定済み」(編集可能 row): 3 列のいずれかが non-NULL の employees
  const [rows, setRows] = useState<SettingRow[]>([]);
  // 「未設定」(追加候補): 3 列全て NULL の employees。追加すると rows に移動する
  const [unconfigured, setUnconfigured] = useState<
    Array<{ employee_id: string; staff_name: string }>
  >([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingAddStaff, setPendingAddStaff] = useState<string>("");
  // 同 office の employees に居ない (= staffNames に出てくるが employees に未登録) 名前
  // を表示するため、employee 一覧を参照保持しておく
  const [knownEmployeeNames, setKnownEmployeeNames] = useState<Set<string>>(
    () => new Set(),
  );

  const load = useCallback(async () => {
    setLoading(true);
    // payroll_employees は office_id でしか引けないので、まず office_number → office_id を解決
    const { data: officeRow, error: oErr } = await supabase
      .from("payroll_offices")
      .select("id")
      .eq("office_number", officeNumber)
      .maybeSingle();
    if (oErr || !officeRow) {
      toast.error(`事業所解決エラー: ${oErr?.message ?? "office not found"}`);
      setRows([]);
      setUnconfigured([]);
      setLoading(false);
      return;
    }
    const officeId = (officeRow as { id: string }).id;

    const { data, error } = await supabase
      .from("payroll_employees")
      .select(
        "id, name, kyotaku_base_salary, kyotaku_kaigo_rate, kyotaku_shien_rate",
      )
      .eq("office_id", officeId)
      .order("name", { ascending: true });

    if (error) {
      toast.error(`設定読込エラー: ${error.message}`);
      setRows([]);
      setUnconfigured([]);
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

    const configured: SettingRow[] = [];
    const unconf: Array<{ employee_id: string; staff_name: string }> = [];
    const knownNames = new Set<string>();
    for (const e of list) {
      if (!e.name) continue;
      knownNames.add(e.name);
      const isConfigured =
        e.kyotaku_base_salary !== null ||
        e.kyotaku_kaigo_rate !== null ||
        e.kyotaku_shien_rate !== null;
      if (isConfigured) {
        configured.push({
          employee_id: e.id,
          staff_name: e.name,
          base_salary: Number(e.kyotaku_base_salary ?? DEFAULT_BASE_SALARY),
          kaigo_rate: Number(e.kyotaku_kaigo_rate ?? 0),
          shien_rate: Number(e.kyotaku_shien_rate ?? 0),
          configured: true,
        });
      } else {
        unconf.push({ employee_id: e.id, staff_name: e.name });
      }
    }
    setRows(configured);
    setUnconfigured(unconf);
    setKnownEmployeeNames(knownNames);
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

  /** 追加候補: 同 office の payroll_employees にあって、まだ kyotaku_* が NULL のもの */
  const addCandidates = useMemo(() => {
    const inRows = new Set(rows.map((r) => r.employee_id));
    return unconfigured.filter((u) => !inRows.has(u.employee_id));
  }, [rows, unconfigured]);

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

  const handleAddStaff = useCallback(() => {
    if (!pendingAddStaff) {
      toast.error("追加するケアマネを選択してください");
      return;
    }
    const target = unconfigured.find((u) => u.employee_id === pendingAddStaff);
    if (!target) {
      toast.error("候補が見つかりません");
      return;
    }
    if (rows.some((r) => r.employee_id === target.employee_id)) {
      toast.error("既に追加されています");
      return;
    }
    setRows((prev) => [
      ...prev,
      {
        employee_id: target.employee_id,
        staff_name: target.staff_name,
        base_salary: DEFAULT_BASE_SALARY,
        kaigo_rate: 0,
        shien_rate: 0,
        configured: false, // 保存後に configured になる
      },
    ]);
    setPendingAddStaff("");
  }, [pendingAddStaff, rows, unconfigured]);

  const handleDelete = useCallback(
    async (index: number) => {
      const target = rows[index];
      if (!target) return;
      if (
        !confirm(
          `${target.staff_name} の給与設定を削除しますか？\n(payroll_employees の row は残し、kyotaku_* 列を NULL に戻します)`,
        )
      )
        return;

      if (target.configured) {
        // 既に DB に書き込み済み: 列を NULL に戻す
        const { error } = await supabase
          .from("payroll_employees")
          .update({
            kyotaku_base_salary: null,
            kyotaku_kaigo_rate: null,
            kyotaku_shien_rate: null,
          })
          .eq("id", target.employee_id);
        if (error) {
          toast.error(`削除エラー: ${error.message}`);
          return;
        }
        // unconfigured に戻す
        setUnconfigured((prev) => [
          ...prev,
          { employee_id: target.employee_id, staff_name: target.staff_name },
        ]);
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

    if (rows.length === 0) {
      setSaving(false);
      toast.success("設定を保存しました");
      onSaved?.();
      onClose();
      return;
    }

    // payroll_employees を 1 行ずつ update (PostgREST upsert は id PK で動くが、
    // ここは「同 id の row が必ず存在する (未存在は handleAddStaff 段階で弾く)」前提)
    let fail = 0;
    let failMsg = "";
    for (const r of rows) {
      const { error } = await supabase
        .from("payroll_employees")
        .update({
          kyotaku_base_salary: Math.trunc(r.base_salary),
          kyotaku_kaigo_rate: Math.trunc(r.kaigo_rate),
          kyotaku_shien_rate: Math.trunc(r.shien_rate),
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
    toast.success(`${rows.length} 件の設定を保存しました`);
    onSaved?.();
    onClose();
  }, [rows, onClose, onSaved]);

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
                key={row.employee_id}
                className="rounded-lg border p-3 space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium text-sm">
                    {row.staff_name}
                    {!row.configured && (
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
              + ケアマネ追加 (payroll_employees 登録済み・kyotaku 設定未登録)
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
                      {(v: string) => {
                        if (!v || v === "__none__") return "ケアマネを選択";
                        const cand = addCandidates.find(
                          (c) => c.employee_id === v,
                        );
                        return cand?.staff_name ?? "ケアマネを選択";
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">ケアマネを選択</SelectItem>
                    {addCandidates.map((c) => (
                      <SelectItem key={c.employee_id} value={c.employee_id}>
                        {c.staff_name}
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
