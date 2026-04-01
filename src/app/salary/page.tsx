"use client";

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import type { Employee, Office } from "@/types/database";

// ─── 型定義 ──────────────────────────────────────────────────

type SalarySettings = {
  id?: string;
  employee_id: string;
  // 固定
  base_personal_salary: number;
  skill_salary: number;
  position_allowance: number;
  qualification_allowance: number;
  tenure_allowance: number;
  treatment_improvement: number;
  specific_treatment_improvement: number;
  treatment_subsidy: number;
  fixed_overtime_pay: number;
  special_bonus: number;
  // 条件付き
  bonus_amount: number;
  // 変動単価
  travel_unit_price: number;
  note: string;
};

const emptySettings = (employeeId: string): SalarySettings => ({
  employee_id: employeeId,
  base_personal_salary: 0,
  skill_salary: 0,
  position_allowance: 0,
  qualification_allowance: 0,
  tenure_allowance: 0,
  treatment_improvement: 0,
  specific_treatment_improvement: 0,
  treatment_subsidy: 0,
  fixed_overtime_pay: 0,
  special_bonus: 0,
  bonus_amount: 0,
  travel_unit_price: 0,
  note: "",
});

// ─── ユーティリティ ──────────────────────────────────────────

const yen = (n: number) =>
  n > 0 ? n.toLocaleString("ja-JP") + "円" : "—";

function fixedTotal(s: SalarySettings): number {
  return (
    s.base_personal_salary +
    s.skill_salary +
    s.position_allowance +
    s.qualification_allowance +
    s.tenure_allowance +
    s.treatment_improvement +
    s.specific_treatment_improvement +
    s.treatment_subsidy +
    s.fixed_overtime_pay +
    s.special_bonus
  );
}

// ─── 入力コンポーネント ───────────────────────────────────────

function YenInput({
  label,
  value,
  onChange,
  sublabel,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  sublabel?: string;
}) {
  return (
    <div className="grid grid-cols-[1fr_160px] items-center gap-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {sublabel && <p className="text-xs text-muted-foreground">{sublabel}</p>}
      </div>
      <div className="relative">
        <Input
          type="number"
          min={0}
          step={1}
          value={value || ""}
          placeholder="0"
          onChange={(e) => onChange(parseInt(e.target.value, 10) || 0)}
          className="pr-8 text-right"
        />
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
          円
        </span>
      </div>
    </div>
  );
}

function Subtotal({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between text-sm font-semibold pt-2 border-t mt-1">
      <span>{label}</span>
      <span>{value.toLocaleString("ja-JP")}円</span>
    </div>
  );
}

// ─── メインコンポーネント ─────────────────────────────────────

export default function SalaryPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [offices, setOffices] = useState<Office[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [settings, setSettings] = useState<SalarySettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      supabase.from("employees").select("*").order("employee_number"),
      supabase.from("offices").select("*"),
    ]).then(([e, o]) => {
      if (e.data) setEmployees(e.data as Employee[]);
      if (o.data) setOffices(o.data as Office[]);
    });
  }, []);

  const loadSettings = useCallback(async (empId: string) => {
    if (!empId) { setSettings(null); return; }
    setLoading(true);
    const { data } = await supabase
      .from("salary_settings")
      .select("*")
      .eq("employee_id", empId)
      .maybeSingle();
    setSettings((data as SalarySettings | null) ?? emptySettings(empId));
    setLoading(false);
  }, []);

  useEffect(() => { loadSettings(selectedId); }, [selectedId, loadSettings]);

  const upd = <K extends keyof SalarySettings>(key: K, val: SalarySettings[K]) =>
    setSettings((prev) => prev ? { ...prev, [key]: val } : prev);

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    const { id, ...payload } = settings;
    let error;
    if (id) {
      ({ error } = await supabase.from("salary_settings").update(payload).eq("id", id));
    } else {
      ({ error } = await supabase.from("salary_settings").insert(payload));
    }
    if (error) toast.error(`保存エラー: ${error.message}`);
    else { toast.success("給与設定を保存しました"); loadSettings(selectedId); }
    setSaving(false);
  };

  const emp = employees.find((e) => e.id === selectedId);
  const office = offices.find((o) => o.id === emp?.office_id);

  const activeEmployees = employees.filter(
    (e) => !e.employment_status || e.employment_status === "在職者"
  );

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">給与設定</h2>

      {/* 職員選択 */}
      <Card className="mb-6">
        <CardContent className="pt-5 pb-4">
          <div className="flex items-center gap-3 flex-wrap">
            <Label className="whitespace-nowrap font-medium">職員</Label>
            <select
              className="border rounded px-3 py-1.5 text-sm bg-background flex-1 max-w-md"
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
            >
              <option value="">— 選択してください —</option>
              {activeEmployees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.employee_number}　{e.name}　({e.role_type} / {e.salary_type})
                </option>
              ))}
            </select>
            {emp && (
              <span className="text-sm text-muted-foreground">{office?.name}</span>
            )}
          </div>
        </CardContent>
      </Card>

      {selectedId && loading && (
        <p className="text-center py-10 text-muted-foreground">読み込み中…</p>
      )}

      {selectedId && !loading && settings && (
        <>
          {/* 固定合計バー */}
          <div className="mb-5 p-4 rounded-lg bg-primary/5 flex items-center justify-between gap-4">
            <div>
              <p className="text-xs text-muted-foreground">固定支給合計（月額）</p>
              <p className="text-2xl font-bold">
                {fixedTotal(settings).toLocaleString("ja-JP")}円
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground mb-1">
                ＋報奨金（条件付き）{settings.bonus_amount > 0 ? yen(settings.bonus_amount) : "未設定"}
              </p>
              <p className="text-xs text-muted-foreground">
                移動費単価　{settings.travel_unit_price > 0 ? `${settings.travel_unit_price}円/km` : "未設定"}
              </p>
            </div>
            <Button onClick={handleSave} disabled={saving} className="shrink-0">
              {saving ? "保存中…" : "💾 保存"}
            </Button>
          </div>

          <div className="grid md:grid-cols-2 gap-4">

            {/* 基本給系 */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  基本給
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <YenInput label="本人給" value={settings.base_personal_salary}
                  onChange={(v) => upd("base_personal_salary", v)} />
                <YenInput label="職能給" value={settings.skill_salary}
                  onChange={(v) => upd("skill_salary", v)} />
                <Subtotal
                  label="基本給計"
                  value={settings.base_personal_salary + settings.skill_salary}
                />
              </CardContent>
            </Card>

            {/* 手当系 */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  手当
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <YenInput label="役職手当" value={settings.position_allowance}
                  onChange={(v) => upd("position_allowance", v)} />
                <YenInput label="資格手当" value={settings.qualification_allowance}
                  onChange={(v) => upd("qualification_allowance", v)} />
                <YenInput label="勤続手当" value={settings.tenure_allowance}
                  onChange={(v) => upd("tenure_allowance", v)} />
                <Subtotal
                  label="手当計"
                  value={
                    settings.position_allowance +
                    settings.qualification_allowance +
                    settings.tenure_allowance
                  }
                />
              </CardContent>
            </Card>

            {/* 処遇改善系 */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  処遇改善関連
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <YenInput label="処遇改善手当" value={settings.treatment_improvement}
                  onChange={(v) => upd("treatment_improvement", v)} />
                <YenInput label="特定処遇改善手当" value={settings.specific_treatment_improvement}
                  onChange={(v) => upd("specific_treatment_improvement", v)} />
                <YenInput label="処遇改善補助金手当" value={settings.treatment_subsidy}
                  onChange={(v) => upd("treatment_subsidy", v)} />
                <Subtotal
                  label="処遇改善計"
                  value={
                    settings.treatment_improvement +
                    settings.specific_treatment_improvement +
                    settings.treatment_subsidy
                  }
                />
              </CardContent>
            </Card>

            {/* 残業・報奨金 */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  残業 / 報奨金
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <YenInput
                  label="固定残業代"
                  value={settings.fixed_overtime_pay}
                  onChange={(v) => upd("fixed_overtime_pay", v)}
                  sublabel="毎月固定で支給"
                />
                <YenInput
                  label="特別報奨金"
                  value={settings.special_bonus}
                  onChange={(v) => upd("special_bonus", v)}
                  sublabel="毎月固定で支給"
                />
                <Subtotal
                  label="残業・報奨金計"
                  value={settings.fixed_overtime_pay + settings.special_bonus}
                />
              </CardContent>
            </Card>

            {/* 条件付き支給 */}
            <Card className="border-dashed">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  条件付き支給
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <YenInput
                  label="報奨金"
                  value={settings.bonus_amount}
                  onChange={(v) => upd("bonus_amount", v)}
                  sublabel="毎月の給与計算時に支給 / 不支給を選択"
                />
                <p className="text-xs text-muted-foreground pt-1">
                  ※ 給与計算画面で月ごとに支給するか選択できます
                </p>
              </CardContent>
            </Card>

            {/* 変動費単価 */}
            <Card className="border-dashed">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  変動費（単価設定）
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-[1fr_160px] items-center gap-3">
                  <div>
                    <p className="text-sm font-medium">移動費単価</p>
                    <p className="text-xs text-muted-foreground">移動距離(km) × 単価 = 支給額</p>
                  </div>
                  <div className="relative">
                    <Input
                      type="number"
                      min={0}
                      value={settings.travel_unit_price || ""}
                      placeholder="0"
                      onChange={(e) => upd("travel_unit_price", parseInt(e.target.value, 10) || 0)}
                      className="pr-12 text-right"
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
                      円/km
                    </span>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  ※ 出張費・実移動距離は給与計算時に月次入力します
                </p>
              </CardContent>
            </Card>

            {/* 備考 */}
            <Card className="md:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  備考
                </CardTitle>
              </CardHeader>
              <CardContent>
                <textarea
                  className="w-full border rounded px-3 py-2 text-sm bg-background resize-none"
                  rows={2}
                  placeholder="特記事項があれば入力"
                  value={settings.note}
                  onChange={(e) => upd("note", e.target.value)}
                />
              </CardContent>
            </Card>
          </div>

          {/* 支給明細サマリー */}
          <Card className="mt-4">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">支給項目一覧</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-x-8 text-sm">
                <SummaryItem label="本人給" value={settings.base_personal_salary} />
                <SummaryItem label="職能給" value={settings.skill_salary} />
                <SummaryItem label="役職手当" value={settings.position_allowance} />
                <SummaryItem label="資格手当" value={settings.qualification_allowance} />
                <SummaryItem label="勤続手当" value={settings.tenure_allowance} />
                <SummaryItem label="処遇改善手当" value={settings.treatment_improvement} />
                <SummaryItem label="特定処遇改善手当" value={settings.specific_treatment_improvement} />
                <SummaryItem label="処遇改善補助金手当" value={settings.treatment_subsidy} />
                <SummaryItem label="固定残業代" value={settings.fixed_overtime_pay} />
                <SummaryItem label="特別報奨金" value={settings.special_bonus} />
              </div>
              <div className="mt-3 pt-3 border-t flex justify-between font-bold text-base">
                <span>固定支給合計</span>
                <span>{fixedTotal(settings).toLocaleString("ja-JP")}円</span>
              </div>
              {settings.bonus_amount > 0 && (
                <div className="mt-1 flex justify-between text-sm text-muted-foreground">
                  <span>報奨金（条件付き）</span>
                  <span>+{settings.bonus_amount.toLocaleString("ja-JP")}円</span>
                </div>
              )}
              {settings.travel_unit_price > 0 && (
                <div className="mt-1 flex justify-between text-sm text-muted-foreground">
                  <span>移動費単価</span>
                  <span>{settings.travel_unit_price.toLocaleString("ja-JP")}円/km</span>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="flex justify-end mt-4">
            <Button onClick={handleSave} disabled={saving} size="lg">
              {saving ? "保存中…" : "💾 保存する"}
            </Button>
          </div>
        </>
      )}

      {!selectedId && (
        <p className="text-center py-16 text-muted-foreground text-sm">
          職員を選択すると給与設定が表示されます
        </p>
      )}
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between py-1 border-b border-border/40">
      <span className="text-muted-foreground">{label}</span>
      <span className={value > 0 ? "font-medium" : "text-muted-foreground/50"}>
        {value > 0 ? value.toLocaleString("ja-JP") + "円" : "—"}
      </span>
    </div>
  );
}
