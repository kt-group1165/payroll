"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import type { Employee, Office } from "@/types/database";

// ─── 型定義 ──────────────────────────────────────────────────

type SalarySettings = {
  id?: string;
  employee_id: string;
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
  bonus_amount: number;
  travel_unit_price: number;
  care_overtime_threshold_hours: number;
  care_overtime_unit_price: number;
  yocho_unit_price: number;
  note: string;
};

// CSV ヘッダー（社員番号・名前は参照用）
const CSV_HEADERS = [
  "社員番号", "名前",
  "本人給", "職能給", "役職手当", "資格手当", "勤続手当",
  "処遇改善手当", "特定処遇改善手当", "処遇改善補助金手当",
  "固定残業代", "特別報奨金",
  "報奨金（条件付き）", "移動費単価(円/km)",
  "介護超過閾値(時間)", "介護超過単価(円/時間)",
  "夜朝手当単価(円/時間)",
  "備考",
] as const;

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
  care_overtime_threshold_hours: 0,
  care_overtime_unit_price: 0,
  yocho_unit_price: 0,
  note: "",
});

// ─── ユーティリティ ──────────────────────────────────────────

const yen = (n: number) => (n > 0 ? n.toLocaleString("ja-JP") + "円" : "—");

function fixedTotal(s: SalarySettings): number {
  return (
    s.base_personal_salary + s.skill_salary +
    s.position_allowance + s.qualification_allowance + s.tenure_allowance +
    s.treatment_improvement + s.specific_treatment_improvement + s.treatment_subsidy +
    s.fixed_overtime_pay + s.special_bonus
  );
}

function downloadCsv(filename: string, rows: string[][]): void {
  const escape = (v: string) =>
    v.includes(",") || v.includes('"') || v.includes("\n")
      ? `"${v.replace(/"/g, '""')}"`
      : v;
  const csv = rows.map((r) => r.map(escape).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else { inQ = !inQ; } }
    else if (ch === "," && !inQ) { result.push(cur); cur = ""; }
    else { cur += ch; }
  }
  result.push(cur);
  return result;
}

function parseCsvText(text: string): string[][] {
  return text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim()).map(parseCsvLine);
}

// ─── インポートプレビュー型 ───────────────────────────────────

type ImportRow = {
  employee_number: string;
  name: string;
  settings: Omit<SalarySettings, "id" | "employee_id">;
  employee_id?: string;
  error?: string;
};

// ─── 入力コンポーネント ───────────────────────────────────────

function YenInput({
  label, value, onChange, sublabel,
}: {
  label: string; value: number; onChange: (v: number) => void; sublabel?: string;
}) {
  return (
    <div className="grid grid-cols-[1fr_160px] items-center gap-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {sublabel && <p className="text-xs text-muted-foreground">{sublabel}</p>}
      </div>
      <div className="relative">
        <Input
          type="number" min={0} step={1}
          value={value || ""} placeholder="0"
          onChange={(e) => onChange(parseInt(e.target.value, 10) || 0)}
          className="pr-8 text-right"
        />
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">円</span>
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

// ─── メインコンポーネント ─────────────────────────────────────

export default function SalaryPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [offices, setOffices] = useState<Office[]>([]);
  const [allSettings, setAllSettings] = useState<SalarySettings[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [settings, setSettings] = useState<SalarySettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const importRef = useRef<HTMLInputElement>(null);
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  const fetchAll = useCallback(async () => {
    const [empRes, offRes, salRes] = await Promise.all([
      supabase.from("employees").select("*").order("employee_number"),
      supabase.from("offices").select("*"),
      supabase.from("salary_settings").select("*"),
    ]);
    if (empRes.data) setEmployees(empRes.data as Employee[]);
    if (offRes.data) setOffices(offRes.data as Office[]);
    if (salRes.data) setAllSettings(salRes.data as SalarySettings[]);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const loadSettings = useCallback(async (empId: string) => {
    if (!empId) { setSettings(null); return; }
    setLoading(true);
    const { data } = await supabase
      .from("salary_settings").select("*").eq("employee_id", empId).maybeSingle();
    setSettings((data as SalarySettings | null) ?? emptySettings(empId));
    setLoading(false);
  }, []);

  useEffect(() => { loadSettings(selectedId); }, [selectedId, loadSettings]);

  const upd = <K extends keyof SalarySettings>(key: K, val: SalarySettings[K]) =>
    setSettings((prev) => prev ? { ...prev, [key]: val } : prev);

  // ─── 保存 ───────────────────────────────────────────────────

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
    else { toast.success("給与設定を保存しました"); loadSettings(selectedId); fetchAll(); }
    setSaving(false);
  };

  // ─── CSV エクスポート（全員分） ────────────────────────────

  function handleExport() {
    const empMap = new Map(employees.map((e) => [e.id, e]));
    const settingsMap = new Map(allSettings.map((s) => [s.employee_id, s]));

    const rows: string[][] = [CSV_HEADERS.slice()];

    // 在職者のみ出力（退職者は除く）
    const targets = employees.filter(
      (e) => !e.employment_status || e.employment_status === "在職者"
    );

    for (const emp of targets) {
      const s = settingsMap.get(emp.id) ?? emptySettings(emp.id);
      rows.push([
        emp.employee_number,
        emp.name,
        String(s.base_personal_salary),
        String(s.skill_salary),
        String(s.position_allowance),
        String(s.qualification_allowance),
        String(s.tenure_allowance),
        String(s.treatment_improvement),
        String(s.specific_treatment_improvement),
        String(s.treatment_subsidy),
        String(s.fixed_overtime_pay),
        String(s.special_bonus),
        String(s.bonus_amount),
        String(s.travel_unit_price),
        String(s.care_overtime_threshold_hours),
        String(s.care_overtime_unit_price),
        String(s.yocho_unit_price),
        s.note,
      ]);
    }

    downloadCsv("給与設定.csv", rows);
    toast.success(`${targets.length}件をエクスポートしました`);
  }

  // ─── CSV インポート ──────────────────────────────────────────

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const rows = parseCsvText(text);
      if (rows.length < 2) { toast.error("データ行がありません"); return; }

      const headers = rows[0].map((h) => h.trim());
      const idx = (name: string) => headers.indexOf(name);
      const empByNum = new Map(employees.map((e) => [e.employee_number, e]));
      const toInt = (s: string) => parseInt(s.trim(), 10) || 0;

      const parsed: ImportRow[] = [];
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const get = (name: string) => (r[idx(name)] ?? "").trim();
        const empNum = get("社員番号");
        const name = get("名前");
        if (!empNum) continue;

        const emp = empByNum.get(empNum);
        parsed.push({
          employee_number: empNum,
          name: name || emp?.name || "",
          employee_id: emp?.id,
          settings: {
            base_personal_salary: toInt(get("本人給")),
            skill_salary: toInt(get("職能給")),
            position_allowance: toInt(get("役職手当")),
            qualification_allowance: toInt(get("資格手当")),
            tenure_allowance: toInt(get("勤続手当")),
            treatment_improvement: toInt(get("処遇改善手当")),
            specific_treatment_improvement: toInt(get("特定処遇改善手当")),
            treatment_subsidy: toInt(get("処遇改善補助金手当")),
            fixed_overtime_pay: toInt(get("固定残業代")),
            special_bonus: toInt(get("特別報奨金")),
            bonus_amount: toInt(get("報奨金（条件付き）")),
            travel_unit_price: toInt(get("移動費単価(円/km)")),
            care_overtime_threshold_hours: toInt(get("介護超過閾値(時間)")),
            care_overtime_unit_price: toInt(get("介護超過単価(円/時間)")),
            yocho_unit_price: toInt(get("夜朝手当単価(円/時間)")),
            note: get("備考"),
          },
          error: emp ? undefined : `社員番号「${empNum}」が職員マスタに未登録`,
        });
      }

      setImportRows(parsed);
      setImportOpen(true);
      if (importRef.current) importRef.current.value = "";
    };
    reader.readAsText(file, "utf-8");
  }

  async function handleImportConfirm() {
    const valid = importRows.filter((r) => !r.error && r.employee_id);
    if (valid.length === 0) { toast.error("インポートできる行がありません"); return; }

    setImporting(true);
    const settingsMap = new Map(allSettings.map((s) => [s.employee_id, s.id]));
    let success = 0, fail = 0;

    for (const row of valid) {
      const payload = { employee_id: row.employee_id!, ...row.settings };
      const existingId = settingsMap.get(row.employee_id!);
      let error;
      if (existingId) {
        ({ error } = await supabase.from("salary_settings").update(payload).eq("id", existingId));
      } else {
        ({ error } = await supabase.from("salary_settings").insert(payload));
      }
      if (error) fail++;
      else success++;
    }

    setImporting(false);
    setImportOpen(false);
    setImportRows([]);
    fetchAll();
    if (selectedId) loadSettings(selectedId);

    if (fail === 0) toast.success(`${success}件をインポートしました`);
    else toast.warning(`${success}件成功、${fail}件失敗`);
  }

  // ─── 描画 ─────────────────────────────────────────────────────

  const emp = employees.find((e) => e.id === selectedId);
  const office = offices.find((o) => o.id === emp?.office_id);
  const activeEmployees = employees.filter(
    (e) => !e.employment_status || e.employment_status === "在職者"
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">給与設定</h2>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleExport} disabled={employees.length === 0}>
            📥 CSV出力
          </Button>
          <Button variant="outline" onClick={() => importRef.current?.click()}>
            📤 CSV取り込み
          </Button>
          <input ref={importRef} type="file" accept=".csv" className="hidden" onChange={handleImportFile} />
        </div>
      </div>

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
              {activeEmployees.map((e) => {
                const hasSetting = allSettings.some((s) => s.employee_id === e.id);
                return (
                  <option key={e.id} value={e.id}>
                    {e.employee_number}　{e.name}　({e.role_type} / {e.salary_type})
                    {hasSetting ? "" : "　※未設定"}
                  </option>
                );
              })}
            </select>
            {emp && <span className="text-sm text-muted-foreground">{office?.name}</span>}
          </div>
        </CardContent>
      </Card>

      {selectedId && loading && (
        <p className="text-center py-10 text-muted-foreground">読み込み中…</p>
      )}

      {selectedId && !loading && settings && (
        <>
          {/* 合計バー */}
          <div className="mb-5 p-4 rounded-lg bg-primary/5 flex items-center justify-between gap-4">
            <div>
              <p className="text-xs text-muted-foreground">固定支給合計（月額）</p>
              <p className="text-2xl font-bold">{fixedTotal(settings).toLocaleString("ja-JP")}円</p>
            </div>
            <div className="text-right text-xs text-muted-foreground space-y-0.5">
              <p>報奨金（条件付き）{settings.bonus_amount > 0 ? yen(settings.bonus_amount) : "未設定"}</p>
              <p>移動費単価　{settings.travel_unit_price > 0 ? `${settings.travel_unit_price}円/km` : "未設定"}</p>
            </div>
            <Button onClick={handleSave} disabled={saving} className="shrink-0">
              {saving ? "保存中…" : "💾 保存"}
            </Button>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            {/* 基本給 */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">基本給</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <YenInput label="本人給" value={settings.base_personal_salary} onChange={(v) => upd("base_personal_salary", v)} />
                <YenInput label="職能給" value={settings.skill_salary} onChange={(v) => upd("skill_salary", v)} />
                <Subtotal label="基本給計" value={settings.base_personal_salary + settings.skill_salary} />
              </CardContent>
            </Card>

            {/* 手当 */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">手当</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <YenInput label="役職手当" value={settings.position_allowance} onChange={(v) => upd("position_allowance", v)} />
                <YenInput label="資格手当" value={settings.qualification_allowance} onChange={(v) => upd("qualification_allowance", v)} />
                <YenInput label="勤続手当" value={settings.tenure_allowance} onChange={(v) => upd("tenure_allowance", v)} />
                <Subtotal label="手当計" value={settings.position_allowance + settings.qualification_allowance + settings.tenure_allowance} />
              </CardContent>
            </Card>

            {/* 処遇改善 */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">処遇改善関連</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <YenInput label="処遇改善手当" value={settings.treatment_improvement} onChange={(v) => upd("treatment_improvement", v)} />
                <YenInput label="特定処遇改善手当" value={settings.specific_treatment_improvement} onChange={(v) => upd("specific_treatment_improvement", v)} />
                <YenInput label="処遇改善補助金手当" value={settings.treatment_subsidy} onChange={(v) => upd("treatment_subsidy", v)} />
                <Subtotal label="処遇改善計" value={settings.treatment_improvement + settings.specific_treatment_improvement + settings.treatment_subsidy} />
              </CardContent>
            </Card>

            {/* 残業・報奨金 */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">残業 / 報奨金</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <YenInput label="固定残業代" value={settings.fixed_overtime_pay} onChange={(v) => upd("fixed_overtime_pay", v)} sublabel="毎月固定" />
                <YenInput label="特別報奨金" value={settings.special_bonus} onChange={(v) => upd("special_bonus", v)} sublabel="毎月固定" />
                <Subtotal label="計" value={settings.fixed_overtime_pay + settings.special_bonus} />
              </CardContent>
            </Card>

            {/* 条件付き */}
            <Card className="border-dashed">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">条件付き支給</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <YenInput label="報奨金" value={settings.bonus_amount} onChange={(v) => upd("bonus_amount", v)} sublabel="給与計算時に支給 / 不支給を選択" />
                <p className="text-xs text-muted-foreground">※ 給与計算画面で月ごとに支給するか選択できます</p>
              </CardContent>
            </Card>

            {/* 変動単価 */}
            <Card className="border-dashed">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">変動費（単価）</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-[1fr_160px] items-center gap-3">
                  <div>
                    <p className="text-sm font-medium">移動費単価</p>
                    <p className="text-xs text-muted-foreground">移動距離(km) × 単価 = 支給額</p>
                  </div>
                  <div className="relative">
                    <Input
                      type="number" min={0}
                      value={settings.travel_unit_price || ""} placeholder="0"
                      onChange={(e) => upd("travel_unit_price", parseInt(e.target.value, 10) || 0)}
                      className="pr-14 text-right"
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">円/km</span>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">※ 出張費・実移動距離は給与計算時に月次入力</p>
              </CardContent>
            </Card>

            {/* 介護超過手当（社員のみ） */}
            <Card className="border-dashed md:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">介護超過手当（社員のみ）</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-[1fr_160px] items-center gap-3">
                  <div>
                    <p className="text-sm font-medium">超過判定 閾値</p>
                    <p className="text-xs text-muted-foreground">月間サービス時間がこの時間を超えたとき支給。0 = 無効</p>
                  </div>
                  <div className="relative">
                    <Input
                      type="number" min={0} step={1}
                      value={settings.care_overtime_threshold_hours || ""} placeholder="0"
                      onChange={(e) => upd("care_overtime_threshold_hours", parseInt(e.target.value, 10) || 0)}
                      className="pr-12 text-right"
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">時間</span>
                  </div>
                </div>
                <div className="grid grid-cols-[1fr_160px] items-center gap-3">
                  <div>
                    <p className="text-sm font-medium">超過単価</p>
                    <p className="text-xs text-muted-foreground">超過時間 × 単価 = 介護超過手当</p>
                  </div>
                  <div className="relative">
                    <Input
                      type="number" min={0} step={1}
                      value={settings.care_overtime_unit_price || ""} placeholder="0"
                      onChange={(e) => upd("care_overtime_unit_price", parseInt(e.target.value, 10) || 0)}
                      className="pr-16 text-right"
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">円/時間</span>
                  </div>
                </div>
                {settings.care_overtime_threshold_hours > 0 && settings.care_overtime_unit_price > 0 && (
                  <p className="text-xs text-blue-600 bg-blue-50 rounded px-3 py-1.5">
                    月間サービス時間が {settings.care_overtime_threshold_hours} 時間を超えた分 × {settings.care_overtime_unit_price.toLocaleString()}円/時間 を支給
                  </p>
                )}
                <p className="text-xs text-muted-foreground">※ 給与計算画面で訪問時間が閾値を超えると自動計算されます（社員のみ）</p>
              </CardContent>
            </Card>

            {/* 夜朝手当 */}
            <Card className="border-dashed md:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">夜朝手当</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-[1fr_160px] items-center gap-3">
                  <div>
                    <p className="text-sm font-medium">夜朝手当単価</p>
                    <p className="text-xs text-muted-foreground">夜朝時間 × 単価 = 夜朝手当（夜朝時間は給与計算時に入力）</p>
                  </div>
                  <div className="relative">
                    <Input
                      type="number" min={0} step={1}
                      value={settings.yocho_unit_price || ""} placeholder="0"
                      onChange={(e) => upd("yocho_unit_price", parseInt(e.target.value, 10) || 0)}
                      className="pr-16 text-right"
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">円/時間</span>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">※ 夜朝時間の自動計算方法は後日実装予定。現在は給与計算画面で月次手動入力。</p>
              </CardContent>
            </Card>

            {/* 備考 */}
            <Card className="md:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">備考</CardTitle>
              </CardHeader>
              <CardContent>
                <textarea
                  className="w-full border rounded px-3 py-2 text-sm bg-background resize-none"
                  rows={2} placeholder="特記事項があれば入力"
                  value={settings.note}
                  onChange={(e) => upd("note", e.target.value)}
                />
              </CardContent>
            </Card>
          </div>

          {/* サマリー */}
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
              {settings.care_overtime_threshold_hours > 0 && (
                <div className="mt-1 flex justify-between text-sm text-muted-foreground">
                  <span>介護超過手当</span>
                  <span>{settings.care_overtime_threshold_hours}時間超 × {settings.care_overtime_unit_price.toLocaleString("ja-JP")}円/時間</span>
                </div>
              )}
              {settings.yocho_unit_price > 0 && (
                <div className="mt-1 flex justify-between text-sm text-muted-foreground">
                  <span>夜朝手当単価</span>
                  <span>{settings.yocho_unit_price.toLocaleString("ja-JP")}円/時間</span>
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

      {/* インポートプレビュー */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>給与設定 CSV取り込み確認</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground mb-3">
            {importRows.length}件を読み込みました。エラーのある行はスキップされます。
          </p>
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-muted/50">
                <th className="border px-2 py-1 text-left">社員番号</th>
                <th className="border px-2 py-1 text-left">名前</th>
                <th className="border px-2 py-1 text-right">本人給</th>
                <th className="border px-2 py-1 text-right">職能給</th>
                <th className="border px-2 py-1 text-right">処遇改善</th>
                <th className="border px-2 py-1 text-right">合計</th>
                <th className="border px-2 py-1 text-left">状態</th>
              </tr>
            </thead>
            <tbody>
              {importRows.map((r, i) => {
                const total =
                  r.settings.base_personal_salary + r.settings.skill_salary +
                  r.settings.position_allowance + r.settings.qualification_allowance +
                  r.settings.tenure_allowance + r.settings.treatment_improvement +
                  r.settings.specific_treatment_improvement + r.settings.treatment_subsidy +
                  r.settings.fixed_overtime_pay + r.settings.special_bonus;
                return (
                  <tr key={i} className={r.error ? "bg-red-50" : ""}>
                    <td className="border px-2 py-1 font-mono">{r.employee_number}</td>
                    <td className="border px-2 py-1">{r.name}</td>
                    <td className="border px-2 py-1 text-right">{r.settings.base_personal_salary.toLocaleString()}</td>
                    <td className="border px-2 py-1 text-right">{r.settings.skill_salary.toLocaleString()}</td>
                    <td className="border px-2 py-1 text-right">
                      {(r.settings.treatment_improvement + r.settings.specific_treatment_improvement + r.settings.treatment_subsidy).toLocaleString()}
                    </td>
                    <td className="border px-2 py-1 text-right font-medium">{total.toLocaleString()}</td>
                    <td className="border px-2 py-1">
                      {r.error
                        ? <span className="text-red-600">⚠ {r.error}</span>
                        : <span className="text-green-600">✓ OK</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" onClick={() => setImportOpen(false)}>キャンセル</Button>
            <Button onClick={handleImportConfirm} disabled={importing}>
              {importing ? "取り込み中…" : `取り込み実行（${importRows.filter((r) => !r.error).length}件）`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
