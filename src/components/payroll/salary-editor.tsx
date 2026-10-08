"use client";

/**
 * 職員の「月ごとの給与設定」(payroll_salary_settings) の編集部品。
 *
 * 2026-10-08 user「設定画面が2か所あるのがわかりづらい。従業員設定の方に一本化」:
 *   これまで /salary の編集ダイアログと 職員一覧の編集ダイアログ の 2 か所に分かれていた。
 *   職員一覧の編集ダイアログ (給与タブ) だけで直すようにし、その中身をここに置く。
 *   保存はダイアログの「保存」ボタン 1 つで 職員マスタと一緒に行う (useSalaryEditor().save)。
 *
 * 履歴の持ち方は今までどおり: (employee_id, effective_from) で 1 行。
 *   同じ適用開始月で保存すると その行を直す / 新しい月なら 新しい行ができ 前の行は履歴として残る。
 */

import { useCallback, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { currentMonthJst } from "@/lib/payroll/office-price-revision";

// ─── 型・ユーティリティ ──────────────────────────────────────

export type SalarySettings = {
  id?: string;
  employee_id: string;
  /** 適用開始月 (YYYY-MM-DD)。同 employee 内で 対象月 >= effective_from の最新が有効 */
  effective_from: string;
  base_personal_salary: number;
  skill_salary: number;
  position_allowance: number;
  qualification_allowance: number;
  tenure_allowance: number;
  /** 勤続手当を自動計算するか。FALSE のときは tenure_allowance の手入力値 */
  tenure_allowance_auto: boolean;
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
  /** 事務時給 (円/時間)。事務員のみ、出勤簿の出勤時間 × この単価を本人給に足す */
  office_work_hourly_rate: number;
  /** この適用開始月からの給与形態。NULL = 職員マスタの値 */
  salary_type?: string | null;
  /** この適用開始月からの役職。NULL = 職員マスタの値 */
  role_type?: string | null;
  /** 有給休暇手当の単価 (円/日)。NULL = 職員マスタの有給手当単価 */
  paid_leave_unit_price?: number | null;
  /** この適用開始月からの通信費タイプ。NULL = 職員マスタの値 */
  communication_fee_type?: string | null;
  /** この適用開始月からの社保加入。NULL = 職員マスタの値 (2026-10-08) */
  social_insurance?: boolean | null;
  note: string;
};

/** 通信費タイプの表示名 (履歴一覧用) */
export const COMM_FEE_LABEL: Record<string, string> = {
  none: "標準",
  variable: "時間で500/1,000/1,500",
  lend: "貸与あり (0円)",
  lend_fee: "貸与希望 (-1,700円)",
};

/** 今月の 1 日 ('YYYY-MM-01') */
export function thisMonthStart(): string {
  return `${currentMonthJst()}-01`;
}

export const emptySettings = (employeeId: string, effectiveFrom?: string): SalarySettings => ({
  employee_id: employeeId,
  effective_from: effectiveFrom ?? thisMonthStart(),
  base_personal_salary: 0,
  skill_salary: 0,
  position_allowance: 0,
  qualification_allowance: 0,
  tenure_allowance: 0,
  tenure_allowance_auto: true,
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
  office_work_hourly_rate: 0,
  note: "",
});

export function fixedTotal(s: SalarySettings): number {
  return (
    s.base_personal_salary + s.skill_salary +
    s.position_allowance + s.qualification_allowance + s.tenure_allowance +
    s.treatment_improvement + s.specific_treatment_improvement + s.treatment_subsidy +
    s.fixed_overtime_pay + s.special_bonus
  );
}

const withoutId = (r: SalarySettings): SalarySettings => {
  const { id: _id, ...rest } = r;
  void _id;
  return rest as SalarySettings;
};

// ─── 状態 (読み込み・保存) ────────────────────────────────────

export type SalaryEditorState = ReturnType<typeof useSalaryEditor>;

/**
 * 編集中の 1 人ぶん。open() / reset() はイベントから呼ぶ (effect では呼ばない)。
 * dirty = 開いたときの値から変わったか。save() は 変わっていなければ何もしないで true を返す。
 */
export function useSalaryEditor() {
  const [rows, setRows] = useState<SalarySettings[]>([]);
  const [draft, setDraft] = useState<SalarySettings>(() => emptySettings(""));
  const [base, setBase] = useState<string>(() => JSON.stringify(emptySettings("")));
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (employeeId: string) => {
    setLoading(true);
    setLoadError(null);
    const { data, error } = await supabase
      .from("payroll_salary_settings")
      .select("*")
      .eq("employee_id", employeeId)
      .order("effective_from", { ascending: false });
    if (error) {
      console.warn("[salary-editor] 給与設定を読めませんでした:", error.message);
      setLoadError(error.message);
      setRows([]);
      setLoading(false);
      return;
    }
    const list = (data ?? []) as SalarySettings[];
    setRows(list);
    // 一番新しい行を雛形に、適用開始月は今月 (= 今月から変える、が既定)
    const next = list[0] ? { ...withoutId(list[0]), effective_from: thisMonthStart() } : emptySettings(employeeId);
    setDraft(next);
    setBase(JSON.stringify(next));
    setLoading(false);
  }, []);

  const open = useCallback((employeeId: string) => { void load(employeeId); }, [load]);

  const reset = useCallback(() => {
    const e = emptySettings("");
    setRows([]); setDraft(e); setBase(JSON.stringify(e)); setLoadError(null); setLoading(false);
  }, []);

  /** 履歴の 1 行を 直すために開く (適用開始月はその行のまま。保存するとその行が直る) */
  const openRow = useCallback((r: SalarySettings) => {
    const d = withoutId(r);
    setDraft(d); setBase(JSON.stringify(d));
  }, []);

  const set = useCallback(<K extends keyof SalarySettings>(key: K, val: SalarySettings[K]) => {
    setDraft((prev) => ({ ...prev, [key]: val }));
  }, []);

  const dirty = JSON.stringify(draft) !== base;

  /**
   * 変わっていれば保存する。employeeId は新規登録した直後の id を渡すため。
   * 戻り値 false = 保存しなかった/失敗 (呼び出し側はダイアログを閉じない)
   */
  const save = useCallback(async (employeeId: string): Promise<boolean> => {
    if (JSON.stringify(draft) === base) return true;
    if (!draft.effective_from) { toast.error("給与設定の適用開始月を入力してください"); return false; }
    // 過去の月からの設定は 給与計算済みの月も変わる (計算し直したとき)。黙って書かない (2026-10-06)
    if (draft.effective_from < thisMonthStart()) {
      const d = draft.effective_from;
      if (!confirm(`給与設定を ${d.slice(0, 4)}年${Number(d.slice(5, 7))}月${d.endsWith("-01") ? "" : `${Number(d.slice(8, 10))}日`}分から にします。\n過去の月を含むので、その月々の給与も (計算し直したときに) 変わります。よいですか？`)) return false;
    }
    const payload = { ...withoutId(draft), employee_id: employeeId };
    const { error } = await supabase
      .from("payroll_salary_settings")
      .upsert(payload, { onConflict: "employee_id,effective_from" });
    if (error) {
      console.warn(`[salary-editor] 保存失敗 (emp=${employeeId}, eff=${payload.effective_from}):`, error.message);
      toast.error(`給与設定の保存エラー: ${error.message}`);
      return false;
    }
    toast.success(`給与設定を保存しました (${payload.effective_from} 〜)`);
    await load(employeeId);
    return true;
  }, [draft, base, load]);

  const deleteRow = useCallback(async (r: SalarySettings) => {
    if (!r.id) return;
    if (!confirm(`${r.effective_from} からの給与設定の行を削除します。よろしいですか？\n(この月以降は 1 つ前の行の値で計算されます)`)) return;
    const { error } = await supabase.from("payroll_salary_settings").delete().eq("id", r.id);
    if (error) { toast.error(`削除エラー: ${error.message}`); return; }
    toast.success("履歴の行を削除しました");
    await load(r.employee_id);
  }, [load]);

  return { rows, draft, set, dirty, loading, loadError, open, reset, openRow, save, deleteRow };
}

// ─── 表示 ─────────────────────────────────────────────────────

/** まとまり (見出し + 行 + 小計) */
function Section({ title, total, children }: { title: string; total: number; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border p-3 flex flex-col gap-1.5">
      <p className="text-xs font-semibold text-muted-foreground">{title}</p>
      {children}
      <div className="mt-auto pt-1.5 border-t flex justify-between text-sm font-semibold">
        <span>計</span><span>{total.toLocaleString("ja-JP")}円</span>
      </div>
    </div>
  );
}

/** 1 行: ラベル | 入力 (右寄せ・単位付き)。説明は hint (小さく 1 行) */
function Field({
  label, value, onChange, unit = "円", hint, nullable = false, placeholder = "0",
}: {
  label: string; value: number | null; onChange: (v: number | null) => void;
  unit?: string; hint?: string; nullable?: boolean; placeholder?: string;
}) {
  return (
    <div className="grid grid-cols-[1fr_8.5rem] items-center gap-2">
      <div className="min-w-0">
        <p className="text-sm leading-tight truncate">{label}</p>
        {hint && <p className="text-[11px] text-muted-foreground leading-tight truncate" title={hint}>{hint}</p>}
      </div>
      <div className="relative">
        <Input
          type="number" min={0} step={1}
          value={nullable ? (value ?? "") : (value || "")} placeholder={placeholder}
          onChange={(e) => onChange(e.target.value === "" ? (nullable ? null : 0) : (parseFloat(e.target.value) || 0))}
          className="h-8 pr-11 text-right text-sm"
        />
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground pointer-events-none">{unit}</span>
      </div>
    </div>
  );
}

const selectCls = "block h-8 mt-0.5 rounded-md border bg-background px-2 text-sm";

/** 月ごとの給与設定の入力 + 履歴 */
export function SalaryEditorBody({ editor }: { editor: SalaryEditorState }) {
  const { draft: s, set, rows, loading, loadError } = editor;
  if (loading) return <p className="text-center py-6 text-sm text-muted-foreground">給与設定を読み込み中…</p>;
  if (loadError) return <p className="py-3 text-sm text-red-600">給与設定を読めませんでした: {loadError}</p>;
  const sameMonthRow = rows.find((r) => r.effective_from === s.effective_from);
  // 社保の列 (payroll_salary_settings_social_insurance.sql) が DB にあるか。select("*") の行にキーがあれば入っている。
  // ★ 無いうちに送ると保存がエラーになるので 欄を出さない
  const hasSocialInsuranceCol = rows.some((r) => "social_insurance" in r);

  return (
    <div className="space-y-4">
      {/* 何月分から / 途中で変わった人だけ入れる項目 / 合計 */}
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <label className="text-xs text-muted-foreground">適用開始月
          <Input type="date" value={s.effective_from} onChange={(e) => set("effective_from", e.target.value)} className="h-8 w-40 mt-0.5 text-sm" />
        </label>
        <label className="text-xs text-muted-foreground" title="月の途中で時給 ↔ 月給が変わった人だけ入れる。空 = 上の「給与形態」">この月からの給与形態
          <select className={selectCls} value={s.salary_type ?? ""} onChange={(e) => set("salary_type", e.target.value || null)}>
            <option value="">上の値のまま</option>
            <option value="時給">時給</option>
            <option value="月給">月給</option>
          </select>
        </label>
        <label className="text-xs text-muted-foreground" title="途中で役職が変わった人だけ入れる。空 = 上の「役職」">この月からの役職
          <select className={selectCls} value={s.role_type ?? ""} onChange={(e) => set("role_type", e.target.value || null)}>
            <option value="">上の値のまま</option>
            {["パート", "社員", "提責", "事務員", "管理者"].map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label className="text-xs text-muted-foreground" title="途中で通信費の扱いが変わった人だけ入れる。空 = 上の「通信費」">この月からの通信費
          <select className={selectCls + " max-w-64"} value={s.communication_fee_type ?? ""} onChange={(e) => set("communication_fee_type", e.target.value || null)}>
            <option value="">上の値のまま</option>
            <option value="none">標準 (社保加入は0円・未加入は時間で500/1,000/1,500円)</option>
            <option value="variable">社保加入でも時間で500/1,000/1,500円</option>
            <option value="lend">スマホ貸与あり (0円)</option>
            <option value="lend_fee">貸与要件外で貸与を希望 (-1,700円)</option>
          </select>
        </label>
        {hasSocialInsuranceCol && <label className="text-xs text-muted-foreground" title="途中で社保に入った/抜けた人だけ入れる。空 = 上の「社会保険」。月ごとの手入力があればそちらが優先">この月からの社保
          <select
            className={selectCls}
            value={s.social_insurance == null ? "" : s.social_insurance ? "1" : "0"}
            onChange={(e) => set("social_insurance", e.target.value === "" ? null : e.target.value === "1")}
          >
            <option value="">上の値のまま</option>
            <option value="1">加入</option>
            <option value="0">未加入</option>
          </select>
        </label>}
        <div className="ml-auto text-right">
          <p className="text-xs text-muted-foreground">固定支給合計 (月額)</p>
          <p className="text-xl font-bold leading-tight">{fixedTotal(s).toLocaleString("ja-JP")}円</p>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground -mt-2">
        {sameMonthRow
          ? <>この適用開始月の行は もうあります。保存すると <b>その行を直します</b>。</>
          : <>保存すると この月からの新しい行ができ、前の値は履歴として残ります。</>}
        {editor.dirty && <span className="ml-2 font-semibold text-amber-700">変更あり (上の「保存」で保存されます)</span>}
      </p>

      {/* 毎月の固定支給 */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Section title="基本給" total={s.base_personal_salary + s.skill_salary}>
          <Field label="本人給" value={s.base_personal_salary} onChange={(v) => set("base_personal_salary", v ?? 0)} />
          <Field label="職能給" value={s.skill_salary} onChange={(v) => set("skill_salary", v ?? 0)} />
        </Section>
        <Section title="手当" total={s.position_allowance + s.qualification_allowance + s.tenure_allowance}>
          <Field label="役職手当" value={s.position_allowance} onChange={(v) => set("position_allowance", v ?? 0)} />
          <Field label="資格手当" value={s.qualification_allowance} onChange={(v) => set("qualification_allowance", v ?? 0)} />
          <Field label={s.tenure_allowance_auto ? "勤続手当 (自動)" : "勤続手当"} value={s.tenure_allowance} onChange={(v) => set("tenure_allowance", v ?? 0)} />
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground" title="資格要件: 介護福祉士 / 実務者研修修了者 / 居宅介護支援職員">
            <input type="checkbox" checked={s.tenure_allowance_auto} onChange={(e) => set("tenure_allowance_auto", e.target.checked)} />
            勤続手当を自動計算する
          </label>
        </Section>
        <Section title="処遇改善" total={s.treatment_improvement + s.specific_treatment_improvement + s.treatment_subsidy}>
          <Field label="処遇改善手当" value={s.treatment_improvement} onChange={(v) => set("treatment_improvement", v ?? 0)} />
          <Field label="特定処遇改善" value={s.specific_treatment_improvement} onChange={(v) => set("specific_treatment_improvement", v ?? 0)} />
          <Field label="処遇改善補助金" value={s.treatment_subsidy} onChange={(v) => set("treatment_subsidy", v ?? 0)} />
        </Section>
        <Section title="残業・特別報奨金" total={s.fixed_overtime_pay + s.special_bonus}>
          <Field label="固定残業代" value={s.fixed_overtime_pay} onChange={(v) => set("fixed_overtime_pay", v ?? 0)} />
          <Field label="特別報奨金" hint="毎月固定で払う分" value={s.special_bonus} onChange={(v) => set("special_bonus", v ?? 0)} />
        </Section>
      </div>

      {/* 単価・条件付き: 固定支給合計には入らない */}
      <div className="rounded-lg border border-dashed p-3">
        <p className="text-xs font-semibold text-muted-foreground mb-2">単価・条件付き (固定支給合計には入らない)</p>
        <div className="grid gap-x-6 gap-y-2 md:grid-cols-2 xl:grid-cols-3">
          <Field label="報奨金" hint="支給する月は「報奨金の支給」画面で選ぶ" value={s.bonus_amount} onChange={(v) => set("bonus_amount", v ?? 0)} />
          <Field label="移動費単価" unit="円/km" hint="移動距離 × 単価" value={s.travel_unit_price} onChange={(v) => set("travel_unit_price", v ?? 0)} />
          <Field label="夜朝手当単価" unit="円/時" hint="夜朝時間 × 単価" value={s.yocho_unit_price} onChange={(v) => set("yocho_unit_price", v ?? 0)} />
          <Field label="介護超過 閾値" unit="時間" hint="月のサービス時間がこれを超えた分に払う (社員)。0 = 無効" value={s.care_overtime_threshold_hours} onChange={(v) => set("care_overtime_threshold_hours", v ?? 0)} />
          <Field label="介護超過 単価" unit="円/時" hint="超過時間 × 単価" value={s.care_overtime_unit_price} onChange={(v) => set("care_overtime_unit_price", v ?? 0)} />
          <Field label="事務時給" unit="円/時" hint="出勤時間 × 単価 = 本人給 (事務員)" value={s.office_work_hourly_rate} onChange={(v) => set("office_work_hourly_rate", v ?? 0)} />
          <Field label="有給 1日単価" unit="円/日" hint="空欄 = 上の「有給手当単価」" nullable placeholder="上の値"
            value={s.paid_leave_unit_price ?? null} onChange={(v) => set("paid_leave_unit_price", v)} />
        </div>
      </div>

      <label className="block text-xs text-muted-foreground">備考
        <textarea className="mt-0.5 w-full border rounded px-3 py-1.5 text-sm bg-background resize-none" rows={2} placeholder="特記事項があれば入力"
          value={s.note ?? ""} onChange={(e) => set("note", e.target.value)} />
      </label>

      <SalaryHistoryTable editor={editor} />
    </div>
  );
}

/** 履歴 (新しい順)。1 つ古い行から変わったセルに色。「直す」でその行を上の入力に出す */
function SalaryHistoryTable({ editor }: { editor: SalaryEditorState }) {
  const { rows } = editor;
  const dash = (title?: string) => <span className="text-muted-foreground/50" title={title}>—</span>;
  return (
    <div>
      <p className="text-xs font-semibold text-muted-foreground mb-1">
        給与設定の履歴 ({rows.length}件)
        <span className="ml-2 font-normal">色付き = 1 つ前の行から変わったところ。「直す」でその行を上に出して直せます。過去の値を足すときは 適用開始月を過去の日付にして保存</span>
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-red-600">★ 給与設定の行がありません。月給者はこの状態だと <b>総支給額が 0 円</b>になります</p>
      ) : (
        <div className="overflow-x-auto border rounded-md">
          <table className="w-full text-xs whitespace-nowrap">
            <thead>
              <tr className="bg-muted/50 border-b">
                <th className="text-left px-2 py-1.5 font-medium">適用開始月</th>
                <th className="text-left px-2 py-1.5 font-medium">給与形態</th>
                <th className="text-left px-2 py-1.5 font-medium">役職</th>
                <th className="text-right px-2 py-1.5 font-medium">本人給</th>
                <th className="text-right px-2 py-1.5 font-medium">職能給</th>
                <th className="text-right px-2 py-1.5 font-medium">役職手当</th>
                <th className="text-right px-2 py-1.5 font-medium">資格</th>
                <th className="text-right px-2 py-1.5 font-medium">勤続</th>
                <th className="text-right px-2 py-1.5 font-medium">処遇改善</th>
                <th className="text-right px-2 py-1.5 font-medium">特定処遇</th>
                <th className="text-right px-2 py-1.5 font-medium">補助金</th>
                <th className="text-right px-2 py-1.5 font-medium">固定残業</th>
                <th className="text-right px-2 py-1.5 font-medium">特別報奨</th>
                <th className="text-right px-2 py-1.5 font-medium">固定合計</th>
                <th className="text-right px-2 py-1.5 font-medium" title="介護超過手当の 閾値(時間) と 単価(円/時)">介護超過</th>
                <th className="text-right px-2 py-1.5 font-medium" title="夜朝手当の単価 (円/時)。0 = 対象外">夜朝</th>
                <th className="text-right px-2 py-1.5 font-medium" title="事務時給 (円/時)">事務時給</th>
                <th className="text-right px-2 py-1.5 font-medium" title="有給休暇手当の単価 (円/日)">有給単価</th>
                <th className="text-left px-2 py-1.5 font-medium" title="この月からの社保加入。— = 上の値">社保</th>
                <th className="text-left px-2 py-1.5 font-medium">通信費</th>
                <th className="text-right px-2 py-1.5 font-medium" title="移動費の単価 (円/km)">移動費単価</th>
                <th className="text-right px-2 py-1.5 font-medium" title="報奨金 (支給する月は「報奨金の支給」画面で選ぶ)">報奨金</th>
                <th className="text-left px-2 py-1.5 font-medium">備考</th>
                <th className="text-center px-2 py-1.5 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const prev = rows[i + 1];
                const chg = (f: (x: SalarySettings) => unknown) =>
                  prev && JSON.stringify(f(prev) ?? null) !== JSON.stringify(f(r) ?? null) ? " bg-amber-100 font-semibold dark:bg-amber-900/40" : "";
                const editing = editor.draft.effective_from === r.effective_from;
                return (
                  <tr key={r.id ?? r.effective_from} className={"border-b hover:bg-muted/20" + (editing ? " outline outline-1 outline-blue-400" : "")}>
                    <td className="px-2 py-1.5 font-mono">
                      {r.effective_from === "1970-01-01" ? <span title="いつからか分からないので 最初から有効という扱い">最初から</span> : r.effective_from}
                    </td>
                    <td className={"px-2 py-1.5" + chg((x) => x.salary_type)}>{r.salary_type || dash("上の値を使う")}</td>
                    <td className={"px-2 py-1.5" + chg((x) => x.role_type)}>{r.role_type || dash("上の値を使う")}</td>
                    <td className={"px-2 py-1.5 text-right" + chg((x) => x.base_personal_salary)}>{r.base_personal_salary.toLocaleString()}</td>
                    <td className={"px-2 py-1.5 text-right" + chg((x) => x.skill_salary)}>{r.skill_salary.toLocaleString()}</td>
                    <td className={"px-2 py-1.5 text-right" + chg((x) => x.position_allowance)}>{r.position_allowance.toLocaleString()}</td>
                    <td className={"px-2 py-1.5 text-right" + chg((x) => x.qualification_allowance)}>{r.qualification_allowance.toLocaleString()}</td>
                    <td className={"px-2 py-1.5 text-right" + chg((x) => x.tenure_allowance)}>{r.tenure_allowance.toLocaleString()}</td>
                    <td className={"px-2 py-1.5 text-right" + chg((x) => x.treatment_improvement)}>{r.treatment_improvement.toLocaleString()}</td>
                    <td className={"px-2 py-1.5 text-right" + chg((x) => x.specific_treatment_improvement)}>{r.specific_treatment_improvement.toLocaleString()}</td>
                    <td className={"px-2 py-1.5 text-right" + chg((x) => x.treatment_subsidy)}>{r.treatment_subsidy.toLocaleString()}</td>
                    <td className={"px-2 py-1.5 text-right" + chg((x) => x.fixed_overtime_pay)}>{r.fixed_overtime_pay.toLocaleString()}</td>
                    <td className={"px-2 py-1.5 text-right" + chg((x) => x.special_bonus)}>{r.special_bonus.toLocaleString()}</td>
                    <td className={"px-2 py-1.5 text-right font-semibold" + chg((x) => fixedTotal(x))}>{fixedTotal(r).toLocaleString()}</td>
                    <td className={"px-2 py-1.5 text-right" + chg((x) => [x.care_overtime_threshold_hours, x.care_overtime_unit_price])}>
                      {r.care_overtime_threshold_hours > 0 || r.care_overtime_unit_price > 0
                        ? `${r.care_overtime_threshold_hours}h / ${r.care_overtime_unit_price.toLocaleString()}` : dash()}
                    </td>
                    <td className={"px-2 py-1.5 text-right" + chg((x) => x.yocho_unit_price)}>{r.yocho_unit_price > 0 ? r.yocho_unit_price.toLocaleString() : dash()}</td>
                    <td className={"px-2 py-1.5 text-right" + chg((x) => x.office_work_hourly_rate)}>{r.office_work_hourly_rate > 0 ? r.office_work_hourly_rate.toLocaleString() : dash()}</td>
                    <td className={"px-2 py-1.5 text-right" + chg((x) => x.paid_leave_unit_price)}>{r.paid_leave_unit_price != null ? r.paid_leave_unit_price.toLocaleString() : dash("上の値を使う")}</td>
                    <td className={"px-2 py-1.5" + chg((x) => x.social_insurance ?? null)}>{r.social_insurance == null ? dash("上の値を使う") : r.social_insurance ? "加入" : "未加入"}</td>
                    <td className={"px-2 py-1.5" + chg((x) => x.communication_fee_type)}>{r.communication_fee_type ? COMM_FEE_LABEL[r.communication_fee_type] ?? r.communication_fee_type : dash("上の値を使う")}</td>
                    <td className={"px-2 py-1.5 text-right" + chg((x) => x.travel_unit_price)}>{r.travel_unit_price > 0 ? r.travel_unit_price.toLocaleString() : dash()}</td>
                    <td className={"px-2 py-1.5 text-right" + chg((x) => x.bonus_amount)}>{r.bonus_amount > 0 ? r.bonus_amount.toLocaleString() : dash()}</td>
                    <td className="px-2 py-1.5 max-w-[14rem] truncate text-muted-foreground" title={r.note ?? ""}>{r.note || ""}</td>
                    <td className="px-2 py-1.5 text-center space-x-2">
                      <button type="button" className="text-xs text-blue-600 hover:underline" onClick={() => editor.openRow(r)}>直す</button>
                      {r.id && <button type="button" className="text-xs text-red-600 hover:underline" onClick={() => void editor.deleteRow(r)}>削除</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** 一覧などから「この人の給与設定を開く」ボタン (職員一覧の編集・給与タブへ) */
export function salaryEditHref(employeeId: string): string {
  return `/employees?edit=${encodeURIComponent(employeeId)}&tab=salary`;
}
