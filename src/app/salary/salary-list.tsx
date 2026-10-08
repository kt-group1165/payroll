"use client";

import { useState, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { HistoryButton, type HistoryColumn } from "@/components/payroll/history-table";
import { buildActiveOvertimeMap } from "@/lib/payroll/overtime-settings-history";
import { currentMonthJst, revisionMonthToDate } from "@/lib/payroll/office-price-revision";
import type { Employee, Office, JobType } from "@/types/database";
import { buildActiveSalaryMap } from "@/lib/payroll/salary-history";
import {
  type SalarySettings, emptySettings, fixedTotal, thisMonthStart, salaryEditHref,
} from "@/components/payroll/salary-editor";

// ─── 型定義 ──────────────────────────────────────────────────


// ─── 残業設定型 ──────────────────────────────────────────────

type OvertimeSetting = {
  id?: string;
  job_type: string;
  /** いつから有効か (履歴。同じ job_type に複数行ありうる) */
  effective_from?: string;
  scheduled_hours_per_month: number;
  include_base_personal_salary: boolean;
  include_skill_salary: boolean;
  include_position_allowance: boolean;
  include_qualification_allowance: boolean;
  include_tenure_allowance: boolean;
  include_treatment_improvement: boolean;
  include_specific_treatment: boolean;
  include_treatment_subsidy: boolean;
  include_fixed_overtime_pay: boolean;
  include_special_bonus: boolean;
};

const JOB_TYPES_FOR_OVERTIME: JobType[] = [
  "訪問介護", "訪問看護", "訪問入浴", "居宅介護支援", "福祉用具貸与", "薬局", "本社",
];

const emptyOvertimeSetting = (jobType: string): OvertimeSetting => ({
  job_type: jobType,
  scheduled_hours_per_month: 160,
  include_base_personal_salary: true,
  include_skill_salary: true,
  include_position_allowance: false,
  include_qualification_allowance: false,
  include_tenure_allowance: false,
  include_treatment_improvement: false,
  include_specific_treatment: false,
  include_treatment_subsidy: false,
  include_fixed_overtime_pay: false,
  include_special_bonus: false,
});

// CSV ヘッダー（事業所番号・社員番号・名前は参照用）
// 「事業所番号 × 社員番号」をキーに突合することで、同じ社員番号が別事業所で
// 別人に採番されているケースでも正しく突合できる。
const CSV_HEADERS = [
  "事業所番号", "社員番号", "名前",
  "本人給", "職能給", "役職手当", "資格手当", "勤続手当",
  "処遇改善手当", "特定処遇改善手当", "処遇改善補助金手当",
  "固定残業代", "特別報奨金",
  "報奨金（条件付き）", "移動費単価(円/km)",
  "介護超過閾値(時間)", "介護超過単価(円/時間)",
  "夜朝手当単価(円/時間)",
  "事務時給(円/時間)",
  "備考",
] as const;


// ─── ユーティリティ ──────────────────────────────────────────


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
  // effective_from は CSV には含めず、取込実行時に決定する (= 今月)
  settings: Omit<SalarySettings, "id" | "employee_id" | "effective_from">;
  employee_id?: string;
  error?: string;
};

// ─── 入力コンポーネント ───────────────────────────────────────

// ─── 残業設定パネル ────────────────────────────────────────────

const INCLUDE_FIELDS: { key: keyof OvertimeSetting; label: string }[] = [
  { key: "include_base_personal_salary",    label: "本人給" },
  { key: "include_skill_salary",            label: "職能給" },
  { key: "include_position_allowance",      label: "役職手当" },
  { key: "include_qualification_allowance", label: "資格手当" },
  { key: "include_tenure_allowance",        label: "勤続手当" },
  { key: "include_treatment_improvement",   label: "処遇改善手当" },
  { key: "include_specific_treatment",      label: "特定処遇改善手当" },
  { key: "include_treatment_subsidy",       label: "処遇補助金手当" },
  { key: "include_fixed_overtime_pay",      label: "固定残業代" },
  { key: "include_special_bonus",           label: "特別報奨金" },
];

/** 残業設定の履歴の表示列 (HistoryTable) */
const OVERTIME_HISTORY_COLUMNS: HistoryColumn<OvertimeSetting & { effective_from: string }>[] = [
  { key: "scheduled_hours_per_month", label: "月所定", format: (r) => `${r.scheduled_hours_per_month}h` },
  ...INCLUDE_FIELDS.map((f) => ({ key: f.key, label: f.label, format: (r: OvertimeSetting) => (r[f.key] ? "✓" : "—") })),
];

function OvertimeSettingsPanel({
  settings, onUpdate, onSave, saving, revisionMonth, onRevisionMonth, changedJobTypes,
}: {
  settings: Map<string, OvertimeSetting>;
  onUpdate: (jobType: string, patch: Partial<OvertimeSetting>) => void;
  onSave: () => void;
  saving: boolean;
  revisionMonth: string;
  onRevisionMonth: (m: string) => void;
  changedJobTypes: string[];
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        訪問種別ごとに月所定労働時間と残業単価の計算対象手当を設定します。<br />
        残業単価 = Σ（対象手当） ÷ 月所定労働時間 × 1.25
      </p>

      <div className="overflow-x-auto border rounded-md">
        <table className="w-full text-sm whitespace-nowrap">
          <thead>
            <tr className="bg-muted/50 border-b">
              <th className="text-left px-4 py-2 font-medium">訪問種別</th>
              <th className="text-right px-4 py-2 font-medium">月所定労働時間</th>
              {INCLUDE_FIELDS.map((f) => (
                <th key={f.key} className="text-center px-3 py-2 font-medium text-xs">{f.label}</th>
              ))}
              <th className="text-center px-3 py-2 font-medium text-xs">履歴</th>
            </tr>
          </thead>
          <tbody>
            {JOB_TYPES_FOR_OVERTIME.map((jt) => {
              const s = settings.get(jt) ?? emptyOvertimeSetting(jt);
              return (
                <tr key={jt} className={`border-b hover:bg-muted/20 ${changedJobTypes.includes(jt) ? "bg-amber-50 dark:bg-amber-900/20" : ""}`}>
                  <td className="px-4 py-2 font-medium">{jt}{changedJobTypes.includes(jt) && <span className="ml-1 text-xs text-amber-700">変更あり</span>}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <Input
                        type="number" min={0} step={1}
                        value={s.scheduled_hours_per_month || ""}
                        placeholder="160"
                        onChange={(e) => onUpdate(jt, { scheduled_hours_per_month: parseFloat(e.target.value) || 0 })}
                        className="w-20 text-right h-7 px-2 text-xs"
                      />
                      <span className="text-xs text-muted-foreground">h</span>
                    </div>
                  </td>
                  {INCLUDE_FIELDS.map((f) => (
                    <td key={f.key} className="text-center px-3 py-2">
                      <input
                        type="checkbox"
                        checked={!!s[f.key]}
                        onChange={(e) => onUpdate(jt, { [f.key]: e.target.checked })}
                        className="h-4 w-4"
                      />
                    </td>
                  ))}
                  <td className="text-center px-2 py-1">
                    <HistoryButton
                      title={`残業設定 (${jt})`}
                      columns={OVERTIME_HISTORY_COLUMNS}
                      load={async () => {
                        const { data, error } = await supabase.from("payroll_overtime_settings").select("*").eq("job_type", jt).order("effective_from");
                        if (error) throw new Error(error.message);
                        return (data ?? []) as (OvertimeSetting & { effective_from: string })[];
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="font-medium">改定月</span>
          <Input type="month" value={revisionMonth} onChange={(e) => onRevisionMonth(e.target.value)} className="h-8 w-40" />
        </label>
        <span className="text-xs text-muted-foreground">変えた設定は この月の給与から。前の月は今までの設定のまま</span>
        <Button onClick={onSave} disabled={saving || changedJobTypes.length === 0}>
          {saving ? "保存中…" : "💾 残業設定を保存"}
        </Button>
      </div>
    </div>
  );
}


// ─── メインコンポーネント ─────────────────────────────────────

type SortCol = "employee_number" | "name" | "office" | "salary_type" | "total";

export function SalaryList({
  initialEmployees,
  initialOffices,
  initialAllSettings,
  initialOvertimeSettings,
}: {
  initialEmployees: Employee[];
  initialOffices: Office[];
  initialAllSettings: SalarySettings[];
  initialOvertimeSettings: OvertimeSetting[];
}) {
  const router = useRouter();
  const employees = initialEmployees;
  const offices = initialOffices;
  const [allSettings, setAllSettings] = useState<SalarySettings[]>(initialAllSettings);
  // ★ 2026-10-08 user「設定画面が2か所あるのがわかりづらい」: 1 人ぶんの編集は 職員一覧の編集 (給与タブ) に一本化した。
  //   この画面は 一覧・CSV・残業設定。行を押すと そちらに移る
  const openEditor = (empId: string) => router.push(salaryEditHref(empId));

  // フィルター・ソート
  const [filterOfficeId, setFilterOfficeId] = useState("");
  // ★ 2026-10-07: 一覧が「在職者」だけで、休職者・退職者は 給与設定があっても 画面に出ていなかった (9 名)。
  //   在職・休職は常に出し、退職者は切り替えで出す (退職月までの給与は計算に使うので 見られないと確かめられない)
  const [showRetired, setShowRetired] = useState(false);
  const [sortCol, setSortCol] = useState<SortCol>("employee_number");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const importRef = useRef<HTMLInputElement>(null);
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  // ─── 残業設定 ────────────────────────────────────────────────
  // 残業設定は履歴 (job_type × effective_from)。画面は 改定月の時点で有効な行を出し、変えた職種だけ 改定月の行として保存する
  const [overtimeRevisionMonth, setOvertimeRevisionMonth] = useState(currentMonthJst());
  const [overtimeRows, setOvertimeRows] = useState<OvertimeSetting[]>(initialOvertimeSettings);
  const activeOvertime = useMemo(
    () => buildActiveOvertimeMap(overtimeRows, revisionMonthToDate(overtimeRevisionMonth) ?? `${currentMonthJst()}-01`),
    [overtimeRows, overtimeRevisionMonth],
  );
  // 編集中の値 (職種ごと)。保存するまで activeOvertime との差が「変更あり」
  const [overtimeEdits, setOvertimeEdits] = useState<Map<string, OvertimeSetting>>(new Map());
  const overtimeSettings = useMemo(() => {
    const m = new Map(activeOvertime);
    for (const [k, v] of overtimeEdits) m.set(k, v);
    return m;
  }, [activeOvertime, overtimeEdits]);
  const overtimeFieldKeys = ["scheduled_hours_per_month", ...INCLUDE_FIELDS.map((f) => f.key)] as (keyof OvertimeSetting)[];
  const changedOvertimeJobTypes = JOB_TYPES_FOR_OVERTIME.filter((jt) => {
    const e = overtimeEdits.get(jt);
    if (!e) return false;
    const a = activeOvertime.get(jt) ?? emptyOvertimeSetting(jt);
    return overtimeFieldKeys.some((k) => e[k] !== a[k]);
  });
  const [savingOvertime, setSavingOvertime] = useState(false);

  // 保存後の再評価用: server 側に再 fetch を投げる
  const refresh = useCallback(async () => {
    // setAllSettings 用に salary_settings を再取得 (selectedId / settings の更新用)
    const all: SalarySettings[] = [];
    let from = 0;
    const pageSize = 1000;
    while (true) {
      const { data } = await supabase
        .from("payroll_salary_settings")
        .select("*")
        // ★ order が無いとページ間で行の並びが保証されない (行が抜ける)。2026-09-27
        .order("id")
        .range(from, from + pageSize - 1);
      if (!data || data.length === 0) break;
      all.push(...(data as SalarySettings[]));
      if (data.length < pageSize) break;
      from += pageSize;
    }
    setAllSettings(all);
    // overtime も再取得
    const { data: otData, error: otErr } = await supabase.from("payroll_overtime_settings").select("*");
    if (otErr) toast.error(`残業設定の読み込みに失敗: ${otErr.message}`);
    else if (otData) { setOvertimeRows(otData as OvertimeSetting[]); setOvertimeEdits(new Map()); }
    // employees / offices は server 由来。 router.refresh で server 再評価
    router.refresh();
  }, [router]);


  // ─── CSV エクスポート（全員分） ────────────────────────────

  function handleExport() {
    // CSV 出力: 「現時点で active な設定」を出す (履歴は出力しない方針)。
    const exportSettingsMap = buildActiveSalaryMap(allSettings, thisMonthStart());

    const rows: string[][] = [CSV_HEADERS.slice()];

    // 画面と同じ人を出力 (在職・休職。「退職者も表示」なら退職者も) + 事業所フィルタ反映
    const targets = employees
      .filter((e) => !e.employment_status || e.employment_status !== "退職者" || showRetired)
      .filter((e) => !filterOfficeId || e.office_id === filterOfficeId);

    const officeByIdForExport = new Map(offices.map((o) => [o.id, o]));
    for (const emp of targets) {
      const s = exportSettingsMap.get(emp.id) ?? emptySettings(emp.id);
      const empOffice = officeByIdForExport.get(emp.office_id);
      rows.push([
        empOffice?.office_number ?? "",
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
        String(s.office_work_hourly_rate ?? 0),
        s.note,
      ]);
    }

    const _fo = offices.find((o) => o.id === filterOfficeId);
    const officeLabel = filterOfficeId ? ((_fo?.short_name || _fo?.name) ?? "") : "全事業所";
    downloadCsv(`給与設定_${officeLabel}.csv`, rows);
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
      // 事業所番号 × 社員番号 で職員を一意に特定（同じ社員番号が別事業所で別人に採番されている衝突対策）
      const officeByNum = new Map(offices.map((o) => [o.office_number, o]));
      const empByOfficeAndNum = new Map<string, Employee>();
      for (const e of employees) {
        const off = offices.find((o) => o.id === e.office_id);
        if (off) empByOfficeAndNum.set(`${off.office_number}|${e.employee_number}`, e);
      }
      // 下位互換: 事業所番号が無いCSVでも動作するよう、社員番号のみのマップも保持
      const empByNum = new Map(employees.map((e) => [e.employee_number, e]));
      const toInt = (s: string) => parseInt(s.trim(), 10) || 0;

      const hasOfficeColumn = idx("事業所番号") >= 0;

      const parsed: ImportRow[] = [];
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const get = (name: string) => (r[idx(name)] ?? "").trim();
        const empNum = get("社員番号");
        const officeNum = get("事業所番号");
        const name = get("名前");
        if (!empNum) continue;

        // 事業所番号が CSVにあれば office×番号 で突合、なければ従来通り番号のみ（事業所フィルタ適用）
        let emp: Employee | undefined;
        let err: string | undefined;
        if (hasOfficeColumn) {
          if (!officeNum) {
            err = `事業所番号が空欄`;
          } else if (!officeByNum.has(officeNum)) {
            err = `事業所番号「${officeNum}」が未登録`;
          } else {
            emp = empByOfficeAndNum.get(`${officeNum}|${empNum}`);
            if (!emp) err = `事業所「${officeNum}」に社員番号「${empNum}」が未登録`;
          }
        } else {
          const candidateEmps = filterOfficeId
            ? employees.filter((e) => e.office_id === filterOfficeId)
            : employees;
          const empByNumFiltered = filterOfficeId
            ? new Map(candidateEmps.map((e) => [e.employee_number, e]))
            : empByNum;
          // ★ 事業所を絞っていないと、番号だけの Map は **後勝ち**で 1 人しか残らない。
          //   職員番号は事業所をまたぐと重複する (2026-09-27 実測: 1,091 番号のうち 184 番号が別人と衝突)。
          //   ここは **給与設定を書き換える**経路なので、黙って別人を選ばずに その行を落とす。
          const sameNum = candidateEmps.filter((e) => e.employee_number === empNum);
          if (sameNum.length > 1) {
            const where = sameNum
              .map((e) => `${offices.find((o) => o.id === e.office_id)?.office_number ?? "?"}:${e.name}`)
              .join(" / ");
            err = `社員番号「${empNum}」が ${sameNum.length} 名に付いています (${where})。`
              + `CSV に「事業所番号」の列を入れるか、上の絞り込みで事業所を選んでから取り込んでください`;
          } else {
            emp = empByNumFiltered.get(empNum);
            if (!emp) err = `社員番号「${empNum}」が職員マスタに未登録`;
          }
        }

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
            // CSV 取込時の auto flag default: TRUE (自動計算)
            tenure_allowance_auto: true,
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
            office_work_hourly_rate: toInt(get("事務時給(円/時間)")),
            note: get("備考"),
          },
          error: err,
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
    // 履歴化方式: 常に upsert (employee_id, effective_from)。
    // effective_from は CSV 取込時は「今月」を採用 (=取込実行時の新適用)。
    const effFrom = thisMonthStart();
    let success = 0, fail = 0;

    const errSamples: string[] = [];
    for (const row of valid) {
      const payload = { employee_id: row.employee_id!, effective_from: effFrom, ...row.settings };
      const { error } = await supabase
        .from("payroll_salary_settings")
        .upsert(payload, { onConflict: "employee_id,effective_from" });
      if (error) {
        fail++;
        console.warn(
          `[salary-list] CSV import upsert 失敗 (emp=${row.employee_id}, name=${row.name}):`,
          error.message,
        );
        if (errSamples.length < 3) errSamples.push(error.message);
      } else success++;
    }

    setImporting(false);
    setImportOpen(false);
    setImportRows([]);
    refresh();

    if (fail === 0) toast.success(`${success}件をインポートしました (適用: ${effFrom} 〜)`);
    else toast.warning(`${success}件成功、${fail}件失敗 (詳細はコンソール: ${errSamples.join(" / ")})`);
  }

  // ─── 残業設定 保存 ───────────────────────────────────────────

  const updOvertime = (jobType: string, patch: Partial<OvertimeSetting>) => {
    setOvertimeEdits((prev) => {
      const next = new Map(prev);
      next.set(jobType, { ...(overtimeSettings.get(jobType) ?? emptyOvertimeSetting(jobType)), ...patch });
      return next;
    });
  };

  /**
   * ★ 2026-10-06: その場で UPDATE するのをやめた (1970-01-01 の行を書き換えると 過去の月の残業単価まで変わる)。
   *   変えた職種だけ 改定月の 1 日の行として upsert (同じ月なら上書き)。前の月は今までの設定のまま。
   */
  const handleSaveOvertime = async () => {
    const eff = revisionMonthToDate(overtimeRevisionMonth);
    if (!eff) { toast.error("改定月を入れてください (例: 2026-11)"); return; }
    if (changedOvertimeJobTypes.length === 0) { toast.info("変更はありません"); return; }
    const later = overtimeRows.filter((r) => (changedOvertimeJobTypes as string[]).includes(r.job_type) && (r.effective_from ?? "1970-01-01") > eff);
    if (!confirm(
      `${overtimeRevisionMonth.replace("-", "年")}月分の給与から 残業設定を変えます: ${changedOvertimeJobTypes.join("・")}\n` +
      `それより前の月は 今までの設定のまま計算されます。` +
      (later.length > 0 ? `\n\n⚠ もっと後の改定 (${[...new Set(later.map((r) => `${r.job_type} ${String(r.effective_from).slice(0, 7)}`))].join(" / ")}) があるため、その月以降は そちらの設定のままです。` : "") +
      `\n\nよいですか？`,
    )) return;
    setSavingOvertime(true);
    let fail = 0;
    const errSamples: string[] = [];
    for (const jt of changedOvertimeJobTypes) {
      const s = overtimeSettings.get(jt) ?? emptyOvertimeSetting(jt);
      const payload: Record<string, unknown> = { job_type: jt, effective_from: eff, updated_at: new Date().toISOString() };
      for (const k of overtimeFieldKeys) payload[k] = s[k];
      const { error } = await supabase.from("payroll_overtime_settings").upsert(payload, { onConflict: "job_type,effective_from" });
      if (error) {
        fail++;
        console.warn(`[salary-list] handleSaveOvertime 失敗 (jobType=${jt}):`, error.message);
        if (errSamples.length < 3) errSamples.push(error.message);
      }
    }
    setSavingOvertime(false);
    if (fail === 0) { toast.success("残業設定を保存しました"); refresh(); }
    else toast.error(`${fail}件の保存に失敗しました (詳細はコンソール: ${errSamples.join(" / ")})`);
  };

  // ─── テーブル用データ ─────────────────────────────────────────

  const activeEmployees = employees.filter(
    (e) => !e.employment_status || e.employment_status !== "退職者" || showRetired
  );
  const retiredCount = employees.filter((e) => e.employment_status === "退職者").length;

  // 履歴化方式: 一覧は「今日 active な row」を表示する。effective_from <= today の最新。
  // (= 未来日付 row は反映しない。/payroll の対象月計算は別途その月の active を使う)
  const todayStart = thisMonthStart();
  const settingsMap = buildActiveSalaryMap(allSettings, todayStart);
  const officeMap = new Map(offices.map((o) => [o.id, o]));

  const filtered = activeEmployees.filter((e) =>
    !filterOfficeId || e.office_id === filterOfficeId
  );

  const sorted = [...filtered].sort((a, b) => {
    let va: string | number = "";
    let vb: string | number = "";
    if (sortCol === "employee_number") { va = a.employee_number; vb = b.employee_number; }
    else if (sortCol === "name") { va = a.name; vb = b.name; }
    else if (sortCol === "office") {
      const _oa = officeMap.get(a.office_id ?? "");
      const _ob = officeMap.get(b.office_id ?? "");
      va = (_oa?.short_name || _oa?.name) ?? "";
      vb = (_ob?.short_name || _ob?.name) ?? "";
    }
    else if (sortCol === "salary_type") { va = a.salary_type ?? ""; vb = b.salary_type ?? ""; }
    else if (sortCol === "total") {
      va = fixedTotal(settingsMap.get(a.id) ?? emptySettings(a.id));
      vb = fixedTotal(settingsMap.get(b.id) ?? emptySettings(b.id));
    }
    if (typeof va === "number" && typeof vb === "number") {
      return sortDir === "asc" ? va - vb : vb - va;
    }
    const cmp = String(va).localeCompare(String(vb), "ja");
    return sortDir === "asc" ? cmp : -cmp;
  });

  // ─── 兼務職員の合算行 ─────────────────────────────────────────
  // 同じ auth_user_id を持つ payroll_employees 行が 2+ ある場合、
  // 各 row の下に「合算」行を 1 つ挿入。auth_user_id NULL の行は対象外。
  // フィルタ後（filterOfficeId 適用後）の sorted 内に 2 行以上ある場合のみ表示。
  type SortedRow =
    | { kind: "row"; emp: Employee }
    | { kind: "sum"; key: string; name: string; total: number; basePersonalSalary: number; treatment: number; rowCount: number };

  const authIdCounts = new Map<string, number>();
  for (const e of sorted) {
    if (!e.auth_user_id) continue;
    authIdCounts.set(e.auth_user_id, (authIdCounts.get(e.auth_user_id) ?? 0) + 1);
  }

  const sortedWithSum: SortedRow[] = [];
  // auth_user_id ごとの「最後の行」インデックスを把握 → そこで合算行を挿入
  const lastIdxByAuth = new Map<string, number>();
  sorted.forEach((e, i) => {
    if (e.auth_user_id && (authIdCounts.get(e.auth_user_id) ?? 0) >= 2) {
      lastIdxByAuth.set(e.auth_user_id, i);
    }
  });
  // 各 auth_user_id ごとの合算値を事前計算（合算は固定合計 / 本人給 / 処遇改善計）
  const sumByAuth = new Map<string, { name: string; total: number; basePersonalSalary: number; treatment: number; rowCount: number }>();
  for (const e of sorted) {
    if (!e.auth_user_id || (authIdCounts.get(e.auth_user_id) ?? 0) < 2) continue;
    const s = settingsMap.get(e.id);
    const total = s ? fixedTotal(s) : 0;
    const basePersonal = s?.base_personal_salary ?? 0;
    const treatment = s
      ? s.treatment_improvement + s.specific_treatment_improvement + s.treatment_subsidy
      : 0;
    const cur = sumByAuth.get(e.auth_user_id) ?? { name: e.name, total: 0, basePersonalSalary: 0, treatment: 0, rowCount: 0 };
    cur.total += total;
    cur.basePersonalSalary += basePersonal;
    cur.treatment += treatment;
    cur.rowCount += 1;
    sumByAuth.set(e.auth_user_id, cur);
  }
  sorted.forEach((e, i) => {
    sortedWithSum.push({ kind: "row", emp: e });
    if (e.auth_user_id && lastIdxByAuth.get(e.auth_user_id) === i) {
      const sum = sumByAuth.get(e.auth_user_id);
      if (sum) {
        sortedWithSum.push({ kind: "sum", key: `sum:${e.auth_user_id}`, ...sum });
      }
    }
  });

  const handleSort = (col: SortCol) => {
    if (sortCol === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("asc"); }
  };

  const sortIcon = (col: SortCol) => {
    if (sortCol !== col) return <span className="text-muted-foreground/40 ml-1">↕</span>;
    return <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>;
  };


  // ─── 描画 ─────────────────────────────────────────────────────

  return (
    <div>
      <h2 className="text-2xl font-bold mb-2">給与設定</h2>
      <p className="text-sm text-muted-foreground mb-6">
        1 人ぶんの設定 (本人給・手当・単価・履歴) は 行を押すと 職員一覧の編集 (給与タブ) で開きます。ここは 一覧・CSV・残業設定です。
      </p>

      <Tabs defaultValue="salary">
        <TabsList className="mb-6">
          <TabsTrigger value="salary">職員給与設定</TabsTrigger>
          <TabsTrigger value="overtime">残業設定（訪問種別別）</TabsTrigger>
        </TabsList>

        {/* ── 職員給与設定タブ ─────────────────────────────── */}
        <TabsContent value="salary">
          {/* ツールバー */}
          <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <Label className="whitespace-nowrap text-sm font-medium">事業所</Label>
              <select
                className="border rounded px-3 py-1.5 text-sm bg-background"
                value={filterOfficeId}
                onChange={(e) => setFilterOfficeId(e.target.value)}
              >
                <option value="">すべて</option>
                {offices.map((o) => (
                  <option key={o.id} value={o.id}>{o.short_name || o.name}</option>
                ))}
              </select>
              <span className="text-sm text-muted-foreground">{sorted.length}名</span>
              <label className="flex items-center gap-1 text-sm text-muted-foreground" title="退職月までの給与は計算に使うので、退職者の設定もここで確かめられる">
                <input type="checkbox" className="h-4 w-4" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
                退職者も表示 ({retiredCount})
              </label>
            </div>
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

          {/* 職員テーブル */}
          <div className="border rounded-md overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 border-b">
                  <th
                    className="text-left px-4 py-2 font-medium cursor-pointer hover:bg-muted/80 select-none whitespace-nowrap"
                    onClick={() => handleSort("employee_number")}
                  >
                    社員番号{sortIcon("employee_number")}
                  </th>
                  <th
                    className="text-left px-4 py-2 font-medium cursor-pointer hover:bg-muted/80 select-none"
                    onClick={() => handleSort("name")}
                  >
                    名前{sortIcon("name")}
                  </th>
                  <th
                    className="text-left px-4 py-2 font-medium cursor-pointer hover:bg-muted/80 select-none"
                    onClick={() => handleSort("office")}
                  >
                    事業所{sortIcon("office")}
                  </th>
                  <th
                    className="text-left px-4 py-2 font-medium cursor-pointer hover:bg-muted/80 select-none whitespace-nowrap"
                    onClick={() => handleSort("salary_type")}
                  >
                    給与種別{sortIcon("salary_type")}
                  </th>
                  <th
                    className="text-right px-4 py-2 font-medium cursor-pointer hover:bg-muted/80 select-none whitespace-nowrap"
                    onClick={() => handleSort("total")}
                  >
                    固定合計{sortIcon("total")}
                  </th>
                  <th className="text-right px-4 py-2 font-medium whitespace-nowrap">本人給</th>
                  <th className="text-right px-4 py-2 font-medium whitespace-nowrap">処遇改善計</th>
                  <th className="text-center px-4 py-2 font-medium">状態</th>
                  <th className="text-center px-4 py-2 font-medium whitespace-nowrap">履歴</th>
                </tr>
              </thead>
              <tbody>
                {sortedWithSum.map((row) => {
                  if (row.kind === "sum") {
                    return (
                      <tr
                        key={row.key}
                        className="border-b bg-muted/30 italic text-muted-foreground"
                        title="兼務職員の合算（複数事業所の合計）"
                      >
                        <td className="px-4 py-2 font-mono text-xs">—</td>
                        <td className="px-4 py-2 font-medium">{row.name}（合算）</td>
                        <td className="px-4 py-2 text-sm">—</td>
                        <td className="px-4 py-2">
                          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-600">
                            合算 {row.rowCount}件
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right font-medium">
                          {row.total > 0 ? row.total.toLocaleString("ja-JP") + "円" : "—"}
                        </td>
                        <td className="px-4 py-2 text-right text-sm">
                          {row.basePersonalSalary > 0 ? row.basePersonalSalary.toLocaleString("ja-JP") + "円" : "—"}
                        </td>
                        <td className="px-4 py-2 text-right text-sm">
                          {row.treatment > 0 ? row.treatment.toLocaleString("ja-JP") + "円" : "—"}
                        </td>
                        <td className="px-4 py-2 text-center">
                          <span className="text-xs">合算</span>
                        </td>
                        <td className="px-4 py-2 text-center text-muted-foreground/50 text-xs">—</td>
                      </tr>
                    );
                  }
                  const emp = row.emp;
                  const s = settingsMap.get(emp.id);
                  const hasSetting = !!s;
                  const total = hasSetting ? fixedTotal(s!) : 0;
                  const treatment = hasSetting
                    ? s!.treatment_improvement + s!.specific_treatment_improvement + s!.treatment_subsidy
                    : 0;
                  const _oe = officeMap.get(emp.office_id ?? "");
                  const officeName = (_oe?.short_name || _oe?.name) ?? "—";
                  return (
                    <tr
                      key={emp.id}
                      className="border-b hover:bg-muted/30 cursor-pointer"
                      onClick={() => openEditor(emp.id)}
                    >
                      <td className="px-4 py-2 font-mono text-xs">{emp.employee_number}</td>
                      <td className="px-4 py-2 font-medium">
                        {emp.name}
                        {emp.employment_status && emp.employment_status !== "在職者" && (
                          <span className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-normal ${emp.employment_status === "休職者" ? "bg-amber-100 text-amber-800" : "bg-gray-200 text-gray-700"}`}>
                            {emp.employment_status === "休職者" ? "休職" : "退職"}{emp.resignation_date ? ` ${emp.resignation_date}` : ""}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-sm text-muted-foreground">{officeName}</td>
                      <td className="px-4 py-2">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${emp.salary_type === "月給" ? "bg-blue-100 text-blue-700" : "bg-orange-100 text-orange-700"}`}>
                          {emp.salary_type ?? "—"}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right font-medium">
                        {hasSetting ? total.toLocaleString("ja-JP") + "円" : "—"}
                      </td>
                      <td className="px-4 py-2 text-right text-sm">
                        {hasSetting ? (s!.base_personal_salary > 0 ? s!.base_personal_salary.toLocaleString("ja-JP") + "円" : "—") : "—"}
                      </td>
                      <td className="px-4 py-2 text-right text-sm">
                        {hasSetting && treatment > 0 ? treatment.toLocaleString("ja-JP") + "円" : "—"}
                      </td>
                      <td className="px-4 py-2 text-center">
                        {hasSetting
                          ? <span className="text-xs text-green-600">設定済み</span>
                          : <span className="text-xs text-muted-foreground">未設定</span>}
                      </td>
                      <td className="px-4 py-2 text-center">
                        <button
                          type="button"
                          className="text-xs text-blue-600 hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            openEditor(emp.id);
                          }}
                        >
                          履歴を見る
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {sorted.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-10 text-center text-sm text-muted-foreground">
                      {activeEmployees.length === 0 ? "職員が登録されていません" : "該当する職員がいません"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>

        {/* ── 残業設定タブ ──────────────────────────────────── */}
        <TabsContent value="overtime">
          <OvertimeSettingsPanel
            settings={overtimeSettings}
            onUpdate={updOvertime}
            onSave={handleSaveOvertime}
            saving={savingOvertime}
            revisionMonth={overtimeRevisionMonth}
            onRevisionMonth={(m) => { setOvertimeRevisionMonth(m); setOvertimeEdits(new Map()); }}
            changedJobTypes={changedOvertimeJobTypes}
          />
        </TabsContent>
      </Tabs>

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
