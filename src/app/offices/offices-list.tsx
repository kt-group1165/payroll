"use client";

import { useState, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import {
  COMPANY_MASTER_JOIN,
  flattenCompanyMaster,
  type Office,
  type OfficeType,
  type Company,
} from "@/types/database";
import { compareOffices, compareOfficesDefault } from "@/lib/office-order";
import { OFFICE_PRICE_KEYS, type OfficePriceKey } from "@/lib/payroll/office-price-history";
import {
  changedPriceKeys, currentMonthJst, insertInitialPriceRow, priceValuesOf,
  recordOfficePriceRevision, revisionMonthToDate,
} from "@/lib/payroll/office-price-revision";

/** 単価の項目名 (改定の確認・履歴の表示用) */
const PRICE_LABEL: Record<OfficePriceKey, string> = {
  travel_unit_price: "出張",
  commute_unit_price: "通勤",
  treatment_subsidy_amount: "処遇補助金",
  cancel_unit_price: "キャンセル",
  doukou_cancel_unit_price: "同行キャンセル",
  travel_allowance_rate: "移動手当",
  communication_fee_amount: "通信費",
  meeting_unit_price: "会議1",
  distance_adjustment_rate: "距離調整",
};
/** 単価の表示 (移動手当は DB が 円/時 なので 円/分 に直す) */
const priceText = (k: OfficePriceKey, v: number | null | undefined): string => {
  if (v == null) return "—";
  if (k === "travel_allowance_rate") return `${Math.round((Number(v) / 60) * 100) / 100}円/分`;
  if (k === "distance_adjustment_rate") return `${Number(v)}%`;
  if (k === "travel_unit_price" || k === "commute_unit_price") return `${Number(v)}円/km`;
  return `${Number(v)}円`;
};
type PriceHistoryRow = { effective_from: string } & Partial<Record<OfficePriceKey, number | null>>;

const OFFICE_TYPES: OfficeType[] = [
  "訪問介護",
  "訪問看護",
  "訪問入浴",
  "居宅介護支援",
  "福祉用具貸与",
  "薬局",
  "本社",
];

const CSV_HEADERS = [
  "表示順", "事業所番号", "正式名称", "略称", "住所", "種別", "週起算曜日",
  "出張単価", "通勤単価", "処遇補助金", "キャンセル単価", "同行キャンセル単価",
  "移動手当単価(円/分)", "通信費", "会議1単価", "距離調整係数", "法人名",
] as const;

export type MasterOffice = {
  id: string;
  name: string;
  address: string | null;
  business_number: string | null;
  short_name: string | null;
  service_type: string | null;
  is_active: boolean | null;
  company_id: string | null;
};

/** 共通マスタ offices.service_type → payroll_offices.office_type のマッピング */
const SERVICE_TYPE_TO_OFFICE_TYPE: Record<string, OfficeType> = {
  "訪問介護": "訪問介護",
  "訪問看護": "訪問看護",
  "訪問入浴": "訪問入浴",
  "居宅介護支援": "居宅介護支援",
  "福祉用具": "福祉用具貸与",
  "本社": "本社",
};

function downloadCsv(filename: string, rows: string[][]): void {
  const escape = (v: string) =>
    v.includes(",") || v.includes('"') || v.includes("\n")
      ? `"${v.replace(/"/g, '""')}"`
      : v;
  const csv = rows.map((r) => r.map(escape).join(",")).join("\r\n");
  const bom = "﻿";
  const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/** 編集ダイアログの 1 行: 左に見出し (色付きの欄)、右に入力。旧給与システムの設定画面のレイアウトに寄せた */
function FormRow({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 border-b last:border-b-0 sm:grid-cols-[11rem_1fr]">
      <div className="flex items-center bg-muted px-3 py-2 text-sm font-semibold">{label}</div>
      <div className="space-y-1 px-3 py-2">
        {children}
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
    </div>
  );
}

export function OfficesList({
  initialOffices,
  masters,
  initialCompanies,
}: {
  initialOffices: Office[];
  masters: MasterOffice[];
  initialCompanies: Company[];
}) {
  const router = useRouter();
  const companies = initialCompanies;
  const companyNameById = new Map(companies.map((c) => [c.id, c.name]));
  const companyNameOf = (o: Office) => (o.company_id ? companyNameById.get(o.company_id) : null);
  // 並び順: sort_order (画面で並べ替えた順) → 無ければ 既定の順 (法人 → 種別)。src/lib/office-order.ts
  // ドラッグで並べ替えた直後の並び (保存と再読込が終わるまで 画面をこの順で出す。戻ってちらつかないように)
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const offices = [...initialOffices].sort((a, b) => compareOffices(a, b, companyNameOf));
  if (localOrder) {
    const pos = new Map(localOrder.map((id, i) => [id, i]));
    offices.sort((a, b) => (pos.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (pos.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }
  // sort_order 列があるか (migrations/payroll_offices_sort_order.sql の適用前は 並べ替えボタンを出さない)
  const canReorder = initialOffices.length > 0 && initialOffices.every((o) => "sort_order" in o);
  const [reordering, setReordering] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({
    office_id: "",                       // FK → master offices.id
    office_number: "",
    shogai_office_number: "",
    short_name: "",
    office_type: "訪問介護" as OfficeType,
    work_week_start: 0,
    travel_unit_price: 0,
    commute_unit_price: 0,
    treatment_subsidy_amount: 0,
    cancel_unit_price: 0,
    doukou_cancel_unit_price: 0,
    travel_allowance_rate: 0,
    communication_fee_amount: 0,
    meeting_unit_price: 0,
    distance_adjustment_rate: 100,
    company_id: "",
  });

  const resetForm = () => {
    setForm({
      office_id: "",
      office_number: "",
      shogai_office_number: "",
      short_name: "",
      office_type: "訪問介護",
      work_week_start: 0,
      travel_unit_price: 0,
      commute_unit_price: 0,
      treatment_subsidy_amount: 0,
      cancel_unit_price: 0,
      doukou_cancel_unit_price: 0,
      travel_allowance_rate: 0,
      communication_fee_amount: 0,
      meeting_unit_price: 0,
      distance_adjustment_rate: 100,
      company_id: "",
    });
    setEditingId(null);
  };

  // 単価の改定月 (編集のとき)。単価を変えたら この月の給与から新しい単価にする。それより前の月は今までの単価
  const [revisionMonth, setRevisionMonth] = useState(currentMonthJst());
  const [priceHistory, setPriceHistory] = useState<PriceHistoryRow[] | null>(null);
  const [saving, setSaving] = useState(false);
  const editingOffice = editingId ? initialOffices.find((o) => o.id === editingId) ?? null : null;
  const changedInForm = editingOffice ? changedPriceKeys(priceValuesOf(editingOffice), priceValuesOf(form)) : [];

  const handleSubmit = async () => {
    if (!form.office_id) { toast.error("事業所(マスタ)を選択してください"); return; }
    if (!form.office_number) { toast.error("事業所番号は必須です"); return; }

    const nonPrice = {
      short_name: form.short_name,
      office_type: form.office_type,
      shogai_office_number: form.shogai_office_number || null,
      work_week_start: form.work_week_start,
      company_id: form.company_id || null,
    };
    const after = priceValuesOf(form);

    if (editingId && editingOffice) {
      const changed = changedInForm;
      let writePricesToCurrent = true;
      if (changed.length > 0) {
        const eff = revisionMonthToDate(revisionMonth);
        if (!eff) { toast.error("単価の改定月を入れてください (例: 2026-11)"); return; }
        const list = changed.map((k) => `${PRICE_LABEL[k]} ${priceText(k, editingOffice[k])} → ${priceText(k, after[k])}`).join("\n");
        if (!confirm(`${revisionMonth.replace("-", "年")}月分の給与から 単価を変えます。\n${list}\n\nそれより前の月は 今までの単価のまま計算されます。よいですか？`)) return;
        setSaving(true);
        try {
          const { laterFrom } = await recordOfficePriceRevision(
            supabase, editingId, priceValuesOf(editingOffice), after, eff, `事業所の編集画面から改定 (${new Date().toISOString().slice(0, 10)})`,
          );
          if (laterFrom.length > 0) {
            // もっと後の改定がある → 今の値はそちらのまま (今の値 = いちばん新しい改定)
            writePricesToCurrent = false;
            toast.warning(`${laterFrom.map((d) => d.slice(0, 7)).join("・")} からの改定が既にあるため、その月以降は そちらの単価のままです`);
          }
        } catch (e) {
          setSaving(false);
          console.error("price revision failed:", e);
          toast.error(e instanceof Error ? e.message : String(e));
          return;
        }
      }
      const { error } = await supabase
        .from("payroll_offices")
        .update(writePricesToCurrent ? { ...nonPrice, ...after } : nonPrice)
        .eq("id", editingId);
      setSaving(false);
      if (error) { toast.error(`更新エラー: ${error.message}`); return; }
      toast.success(changed.length > 0 ? `事業所を更新しました (単価は ${revisionMonth.replace("-", "年")}月分から)` : "事業所を更新しました");
    } else {
      setSaving(true);
      const { data: created, error } = await supabase.from("payroll_offices").insert({
        office_id: form.office_id,
        office_number: form.office_number,
        shogai_office_number: form.shogai_office_number || null,
        short_name: form.short_name,
        office_type: form.office_type,
        work_week_start: form.work_week_start,
        travel_unit_price: form.travel_unit_price,
        commute_unit_price: form.commute_unit_price,
        treatment_subsidy_amount: form.treatment_subsidy_amount,
        cancel_unit_price: form.cancel_unit_price,
        doukou_cancel_unit_price: form.doukou_cancel_unit_price,
        travel_allowance_rate: form.travel_allowance_rate,
        communication_fee_amount: form.communication_fee_amount,
        meeting_unit_price: form.meeting_unit_price,
        distance_adjustment_rate: form.distance_adjustment_rate,
        company_id: form.company_id || null,
      }).select("id").single();
      if (error || !created) { setSaving(false); toast.error(`登録エラー: ${error?.message ?? "登録した行が返りませんでした"}`); return; }
      // 単価を入れて登録したときは 履歴にも初期値を入れる (無いと給与計算が「単価の履歴なし」になる)。
      // 全部 0 のまま登録したときは入れない (「未設定」と分かる形で残す)
      if (OFFICE_PRICE_KEYS.some((k) => k !== "distance_adjustment_rate" && after[k] !== 0)) {
        try {
          await insertInitialPriceRow(supabase, created.id, after, `事業所の登録時の単価 (${new Date().toISOString().slice(0, 10)})`);
        } catch (e) {
          console.error("initial price row failed:", e);
          toast.error(`事業所は登録しましたが ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      setSaving(false);
      toast.success("事業所を登録しました");
    }

    setIsOpen(false);
    resetForm();
    router.refresh();
  };

  const handleEdit = (office: Office) => {
    setForm({
      office_id: office.office_id ?? "",
      office_number: office.office_number,
      shogai_office_number: office.shogai_office_number ?? "",
      short_name: office.short_name ?? "",
      office_type: office.office_type,
      work_week_start: office.work_week_start ?? 0,
      travel_unit_price: office.travel_unit_price ?? 0,
      commute_unit_price: office.commute_unit_price ?? 0,
      treatment_subsidy_amount: office.treatment_subsidy_amount ?? 0,
      cancel_unit_price: office.cancel_unit_price ?? 0,
      doukou_cancel_unit_price: office.doukou_cancel_unit_price ?? 0,
      travel_allowance_rate: office.travel_allowance_rate ?? 0,
      communication_fee_amount: office.communication_fee_amount ?? 0,
      meeting_unit_price: office.meeting_unit_price ?? 0,
      distance_adjustment_rate: office.distance_adjustment_rate ?? 100,
      company_id: office.company_id ?? "",
    });
    setEditingId(office.id);
    setIsOpen(true);
    setRevisionMonth(currentMonthJst());
    setPriceHistory(null);
    void supabase
      .from("payroll_office_unit_prices")
      .select(`effective_from, ${OFFICE_PRICE_KEYS.join(", ")}`)
      .eq("office_id", office.id)
      .order("effective_from")
      .then(({ data, error }) => {
        if (error) { console.error("price history read failed:", error.message); toast.error(`単価の履歴を読めませんでした: ${error.message}`); return; }
        setPriceHistory((data ?? []) as unknown as PriceHistoryRow[]);
      });
  };

  const handleDelete = async (id: string) => {
    if (!confirm("この事業所を削除しますか？")) return;
    const { error } = await supabase.from("payroll_offices").delete().eq("id", id);
    if (error) { toast.error(`削除エラー: ${error.message}`); return; }
    toast.success("事業所を削除しました");
    router.refresh();
  };

  // ─── 並び替え ─────────────────────────────────────────
  /** 新しい並びで sort_order を 10 刻みに振り直し、変わった行だけ保存 */
  const saveOrder = async (next: Office[]) => {
    setLocalOrder(next.map((o) => o.id));
    const changed = next
      .map((o, i) => ({ id: o.id, sort_order: (i + 1) * 10, prev: o.sort_order ?? null }))
      .filter((x) => x.prev !== x.sort_order);
    if (changed.length === 0) return;
    setReordering(true);
    const results = await Promise.all(
      changed.map((x) => supabase.from("payroll_offices").update({ sort_order: x.sort_order }).eq("id", x.id)),
    );
    setReordering(false);
    const failed = results.filter((r) => r.error);
    if (failed.length > 0) {
      console.error("sort_order update failed:", failed.map((r) => r.error?.message));
      toast.error(`並び順の保存エラー (${failed.length}件): ${failed[0].error?.message}`);
    }
    router.refresh();
  };

  /**
   * ドラッグで並べ替え (2026-10-06 user「一つずつ変えていくより ドラッグで」)。ライブラリは使わず HTML 標準のドラッグ。
   * 左端の ⠿ をつかんだときだけ行をドラッグできる (行のどこでもにすると 文字を選べなくなる)。
   */
  const [dragArmedId, setDragArmedId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const endDrag = () => { setDragArmedId(null); setDragId(null); setOverId(null); };
  const dropOn = (targetId: string) => {
    const from = offices.findIndex((o) => o.id === dragId);
    const to = offices.findIndex((o) => o.id === targetId);
    endDrag();
    if (from < 0 || to < 0 || from === to) return;
    const next = [...offices];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);                 // 下へ動かすと 落とした行の下、上へ動かすと 落とした行の上に入る
    void saveOrder(next);
  };

  const resetOrder = () => {
    if (!confirm("並び順を既定 (法人 → 種別 → 事業所番号) に戻しますか？")) return;
    void saveOrder([...initialOffices].sort((a, b) => compareOfficesDefault(a, b, companyNameOf)));
  };

  // ─── master 選択 ─────────────────────────────────────────
  const linkedMasterIds = new Set(
    offices
      .filter((o) => o.office_id && o.id !== editingId)
      .map((o) => o.office_id as string),
  );
  const availableMasters = masters.filter((m) => !linkedMasterIds.has(m.id));
  const selectedMaster = masters.find((m) => m.id === form.office_id);

  // ─── 共通マスタから取込 ─────────────────────────────────────────
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importChecked, setImportChecked] = useState<Record<string, boolean>>({});
  const [importTypes, setImportTypes] = useState<Record<string, OfficeType | "">>({});

  // editingId に関係なく「payroll_offices にリンク済みの master id」全件
  const allLinkedMasterIds = new Set(
    offices.filter((o) => o.office_id).map((o) => o.office_id as string),
  );
  const existingOfficeNumbers = new Set(offices.map((o) => o.office_number));
  const activeMasters = masters.filter((m) => m.is_active !== false);
  const unimportedMasters = activeMasters.filter((m) => !allLinkedMasterIds.has(m.id));

  /** master 行の取込可否と警告理由 */
  const importBlockReason = (m: MasterOffice): string | null => {
    if (!m.business_number) return "事業所番号(business_number)が未設定のため取込不可";
    if (existingOfficeNumbers.has(m.business_number)) return "同じ事業所番号が既に登録済み";
    return null;
  };

  /** master 行の office_type (ユーザー選択 > service_type マッピング) */
  const resolvedImportType = (m: MasterOffice): OfficeType | "" =>
    importTypes[m.id] ?? SERVICE_TYPE_TO_OFFICE_TYPE[m.service_type ?? ""] ?? "";

  /** master.company_id → payroll_companies の対応行 */
  const payrollCompanyForMaster = (m: MasterOffice): Company | undefined =>
    m.company_id
      ? companies.find((c) => c.master_company_id === m.company_id)
      : undefined;

  const resetImportState = () => {
    setImportChecked({});
    setImportTypes({});
  };

  const checkedMasters = unimportedMasters.filter(
    (m) => importChecked[m.id] && !importBlockReason(m),
  );

  const handleImportSubmit = async () => {
    if (checkedMasters.length === 0) {
      toast.error("取込む事業所を選択してください");
      return;
    }
    const missingType = checkedMasters.filter((m) => !resolvedImportType(m));
    if (missingType.length > 0) {
      toast.error(`事業所種別を選択してください: ${missingType.map((m) => m.name).slice(0, 3).join(", ")}`);
      return;
    }
    const numCounts = new Map<string, number>();
    for (const m of checkedMasters) {
      const n = m.business_number as string;
      numCounts.set(n, (numCounts.get(n) ?? 0) + 1);
    }
    const dupNums = [...numCounts.entries()].filter(([, c]) => c > 1).map(([n]) => n);
    if (dupNums.length > 0) {
      toast.error(`同じ事業所番号の行が複数選択されています: ${dupNums.join(", ")}`);
      return;
    }

    // 単価系パラメータは DB デフォルト (0 / 100) 任せで INSERT に含めない
    const payload = checkedMasters.map((m) => ({
      office_id: m.id,
      office_number: m.business_number as string,
      short_name: m.short_name ?? "",
      office_type: resolvedImportType(m) as OfficeType,
      company_id: payrollCompanyForMaster(m)?.id ?? null,
    }));

    setImporting(true);
    const { error } = await supabase.from("payroll_offices").insert(payload);
    setImporting(false);
    if (error) {
      toast.error(`取込エラー: ${error.message}`);
      return;
    }
    toast.success(`${payload.length}件を共通マスタから取込みました`);
    setImportOpen(false);
    resetImportState();
    router.refresh();
  };

  const onMasterChange = (id: string) => {
    const m = masters.find((x) => x.id === id);
    setForm((prev) => ({
      ...prev,
      office_id: id,
      // マスタ選択時、business_number が UNIQUE 制約のキーになるので自動コピー
      office_number: prev.office_number || m?.business_number || "",
    }));
  };

  // ─── CSV エクスポート ─────────────────────────────────────────

  const companyMap = new Map(companies.map((c) => [c.id, c.name]));

  function handleExport() {
    const rows: string[][] = [CSV_HEADERS.slice()];
    for (const o of offices) {
      rows.push([
        o.sort_order != null ? String(o.sort_order) : "",
        o.office_number,
        o.name,
        o.short_name ?? "",
        o.address,
        o.office_type,
        ["日", "月", "火", "水", "木", "金", "土"][o.work_week_start ?? 0] ?? "日",   // 曜日の字で出す (取込は 日〜土 / 0-6 / 「金曜日」のどれでも読める)
        String(o.travel_unit_price ?? 0),
        String(o.commute_unit_price ?? 0),
        String(o.treatment_subsidy_amount ?? 0),
        String(o.cancel_unit_price ?? 0),
        String(o.doukou_cancel_unit_price ?? 0),
        String(Math.round(((o.travel_allowance_rate ?? 0) / 60) * 100) / 100),   // 画面と同じ 円/分 で出す (DB は 円/時)
        String(o.communication_fee_amount ?? 0),
        String(o.meeting_unit_price ?? 0),
        String(o.distance_adjustment_rate ?? 100),
        o.company_id ? (companyMap.get(o.company_id) ?? "") : "",
      ]);
    }
    downloadCsv("事業所一覧.csv", rows);
    toast.success(`${offices.length}件をエクスポートしました`);
  }

  // ─── CSV インポート ───────────────────────────────────────────

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    const reader = new FileReader();
    reader.onload = async (ev) => {
      const buf = ev.target?.result as ArrayBuffer;
      const bytes = new Uint8Array(buf);
      const isUtf8Bom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
      const text = new TextDecoder(isUtf8Bom ? "utf-8" : "shift-jis").decode(buf).replace(/^﻿/, "");

      const parseCsvLine = (line: string): string[] => {
        const out: string[] = [];
        let cur = ""; let inQ = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === '"') {
            if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
            else { inQ = !inQ; }
          } else if (ch === "," && !inQ) { out.push(cur); cur = ""; }
          else { cur += ch; }
        }
        out.push(cur);
        return out;
      };

      const toHalfNum = (s: string) =>
        s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
         .replace(/[．。]/g, ".").replace(/[ー−―]/g, "-").trim();

      const rows = text.split(/\r?\n/).filter((l) => l.trim()).map(parseCsvLine);
      if (rows.length < 2) { toast.error("データ行がありません"); return; }

      const get = (row: string[], headers: string[], name: string) => {
        const idx = headers.indexOf(name);
        return idx >= 0 ? (row[idx] ?? "") : "";
      };

      const headers = rows[0].map((h) => h.trim());

      // master companies / master offices を取得
      const [{ data: compData }, { data: masterOfficeData }] = await Promise.all([
        supabase.from("payroll_companies").select(`id, ${COMPANY_MASTER_JOIN}`),
        supabase.from("offices").select("id, business_number"),
      ]);
      const flatComps = flattenCompanyMaster((compData ?? []) as never) as unknown as Company[];
      const cMap = new Map(flatComps.map((c) => [c.name, c.id]));
      const masterByBusinessNumber = new Map(
        ((masterOfficeData ?? []) as { id: string; business_number: string | null }[])
          .filter((m) => m.business_number)
          .map((m) => [m.business_number as string, m.id]),
      );

      const ALLOWED_TYPES = new Set<string>(OFFICE_TYPES);
      const DAY_MAP: Record<string, number> = {
        "日": 0, "月": 1, "火": 2, "水": 3, "木": 4, "金": 5, "土": 6,
      };
      const payload: Record<string, string | number | null>[] = [];
      const errors: string[] = [];
      const numOr = (s: string, fallback: number) => {
        const n = parseFloat(toHalfNum(s));
        return isNaN(n) ? fallback : n;
      };

      for (let i = 1; i < rows.length; i++) {
        const cols = rows[i];
        const officeNum = get(cols, headers, "事業所番号").trim();
        const csvName = (get(cols, headers, "正式名称") || get(cols, headers, "名称")).trim();
        if (!officeNum || !csvName) continue;

        // master 突合: business_number = 事業所番号
        const masterOfficeId = masterByBusinessNumber.get(officeNum);
        if (!masterOfficeId) {
          errors.push(`行${i + 1}: 事業所番号「${officeNum}」が共通マスタ offices に存在しません。先にマスタへ登録してください`);
          continue;
        }

        const companyName = get(cols, headers, "法人名").trim();
        const companyId = companyName ? (cMap.get(companyName) ?? null) : null;

        const rawType = get(cols, headers, "種別").replace(/[\s　]/g, "");
        const officeType = rawType || "訪問介護";
        if (!ALLOWED_TYPES.has(officeType)) {
          errors.push(`行${i + 1}: 種別「${rawType}」は無効（許可: ${OFFICE_TYPES.join("/")}）`);
          continue;
        }

        const rawWeek = get(cols, headers, "週起算曜日").replace(/[\s　曜日]/g, "");
        let weekStart = 0;
        if (rawWeek) {
          if (DAY_MAP[rawWeek] !== undefined) {
            weekStart = DAY_MAP[rawWeek];
          } else {
            const n = parseInt(toHalfNum(rawWeek), 10);
            if (isNaN(n) || n < 0 || n > 6) {
              errors.push(`行${i + 1}: 週起算曜日「${rawWeek}」は無効（0-6 または 日〜土）`);
              continue;
            }
            weekStart = n;
          }
        }

        // 表示順 (2026-10-06): 列があるときだけ送る。空欄 = 今の値のまま。
        // ★ 全行で同じキーを送る (行ごとにキーが違うと 無い行に NULL が明示送信され 並び順が消える)
        let sortOrder: number | null | undefined;
        if (headers.includes("表示順")) {
          const rawSort = toHalfNum(get(cols, headers, "表示順"));
          if (rawSort === "") {
            sortOrder = offices.find((o) => o.office_number === officeNum)?.sort_order ?? null;
          } else if (/^\d+$/.test(rawSort)) {
            sortOrder = parseInt(rawSort, 10);
          } else {
            errors.push(`行${i + 1}: 表示順「${rawSort}」は数字で入れてください (小さいほど上)`);
            continue;
          }
        }

        payload.push({
          ...(sortOrder !== undefined ? { sort_order: sortOrder } : {}),
          office_id: masterOfficeId,
          office_number: officeNum,
          short_name: get(cols, headers, "略称").trim(),
          office_type: officeType,
          work_week_start: weekStart,
          travel_unit_price: numOr(get(cols, headers, "出張単価"), 0),
          commute_unit_price: numOr(get(cols, headers, "通勤単価"), 0),
          treatment_subsidy_amount: numOr(get(cols, headers, "処遇補助金"), 0),
          cancel_unit_price: numOr(get(cols, headers, "キャンセル単価"), 0),
          // 旧形式の CSV (列なし) は 既定 600 円 (総括表② 全事業所 600 円)
          doukou_cancel_unit_price: headers.includes("同行キャンセル単価") ? numOr(get(cols, headers, "同行キャンセル単価"), 0) : 600,
          // 円/分 の列 (今の出力) を優先。旧形式の「移動手当単価」列は 円/時 のまま読む
          travel_allowance_rate: headers.includes("移動手当単価(円/分)")
            ? numOr(get(cols, headers, "移動手当単価(円/分)"), 0) * 60
            : numOr(get(cols, headers, "移動手当単価"), 0),
          communication_fee_amount: numOr(get(cols, headers, "通信費"), 0),
          meeting_unit_price: numOr(get(cols, headers, "会議1単価"), 0),
          distance_adjustment_rate: numOr(get(cols, headers, "距離調整係数"), 100),
          company_id: companyId,
        });
      }

      if (errors.length > 0) {
        toast.error(errors.slice(0, 5).join("\n"));
        return;
      }
      if (payload.length === 0) { toast.error("有効なデータがありません"); return; }

      const dedupMap = new Map<string, typeof payload[number]>();
      const duplicates = new Set<string>();
      for (const p of payload) {
        const key = p.office_number as string;
        if (dedupMap.has(key)) duplicates.add(key);
        dedupMap.set(key, p);
      }
      const deduped = Array.from(dedupMap.values());
      if (duplicates.size > 0) {
        toast.warning(`事業所番号重複${duplicates.size}件を後勝ちで統合（例: ${[...duplicates].slice(0, 3).join(", ")}）`);
      }

      // 単価が変わる既存の事業所は 改定月を聞いて 履歴に書く (書かないと給与計算に効かない。office-price-revision.ts)
      const existingByNumber = new Map(offices.map((o) => [o.office_number, o]));
      const revisions = deduped
        .map((p) => ({ p, ex: existingByNumber.get(p.office_number as string) }))
        .filter((x): x is { p: typeof x.p; ex: Office } => !!x.ex)
        .map(({ p, ex }) => ({ ex, before: priceValuesOf(ex), after: priceValuesOf(p as Partial<Record<OfficePriceKey, number>>) }))
        .filter((x) => changedPriceKeys(x.before, x.after).length > 0);
      if (revisions.length > 0) {
        const lines = revisions.slice(0, 8).map((r) =>
          `${r.ex.short_name || r.ex.name}: ${changedPriceKeys(r.before, r.after).map((k) => `${PRICE_LABEL[k]} ${priceText(k, r.before[k])}→${priceText(k, r.after[k])}`).join(" / ")}`);
        const month = window.prompt(
          `${revisions.length} 事業所の単価が変わります。\n${lines.join("\n")}${revisions.length > 8 ? "\n…" : ""}\n\n何月分の給与から新しい単価にしますか？ (例: ${currentMonthJst()})\nそれより前の月は今までの単価のまま計算されます。`,
          currentMonthJst(),
        );
        if (month === null) { toast.info("取り込みをやめました"); return; }
        const eff = revisionMonthToDate(month.trim());
        if (!eff) { toast.error(`改定月「${month}」は 2026-11 の形で入れてください。取り込みはしていません`); return; }
        const laterAll: string[] = [];
        for (const r of revisions) {
          try {
            const { laterFrom } = await recordOfficePriceRevision(supabase, r.ex.id, r.before, r.after, eff, `CSV取込で改定 (${new Date().toISOString().slice(0, 10)})`);
            if (laterFrom.length > 0) laterAll.push(`${r.ex.short_name || r.ex.name} (${laterFrom.map((d) => d.slice(0, 7)).join("・")})`);
          } catch (e) {
            console.error("price revision failed:", e);
            toast.error(`${r.ex.short_name || r.ex.name}: ${e instanceof Error ? e.message : String(e)}。取り込みを中止しました`);
            return;
          }
        }
        if (laterAll.length > 0) toast.warning(`もっと後の改定が既にある事業所は その月以降 そちらの単価のままです: ${laterAll.join(" / ")}`);
      }

      const { data: upserted, error } = await supabase.from("payroll_offices").upsert(deduped, { onConflict: "office_number" }).select("id, office_number");
      if (error) { toast.error(`取り込みエラー: ${error.message}`); return; }
      // 新しく増えた事業所は 単価の初期値を履歴に入れる (全部 0 なら入れない)
      for (const row of (upserted ?? []) as { id: string; office_number: string }[]) {
        if (existingByNumber.has(row.office_number)) continue;
        const p = deduped.find((d) => d.office_number === row.office_number);
        if (!p) continue;
        const vals = priceValuesOf(p as Partial<Record<OfficePriceKey, number>>);
        if (!OFFICE_PRICE_KEYS.some((k) => k !== "distance_adjustment_rate" && vals[k] !== 0)) continue;
        try {
          await insertInitialPriceRow(supabase, row.id, vals, `CSV取込で登録 (${new Date().toISOString().slice(0, 10)})`);
        } catch (e) {
          console.error("initial price row failed:", e);
          toast.error(`${row.office_number}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      toast.success(`${deduped.length}件を取り込みました`);
      setLocalOrder(null);   // ドラッグ直後の並びではなく 取り込んだ表示順で出し直す
      router.refresh();
    };
    reader.readAsArrayBuffer(file);
  }

  return (
    <div>
      <input
        ref={importRef}
        type="file"
        accept=".csv"
        className="hidden"
        onChange={handleImportFile}
      />
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">事業所一覧</h2>
        <div className="flex gap-2">
          {canReorder && (
            <Button variant="outline" onClick={resetOrder} disabled={reordering}>
              既定の順に戻す
            </Button>
          )}
          <Button variant="outline" onClick={handleExport} disabled={offices.length === 0}>
            📥 CSV出力
          </Button>
          <Button variant="outline" onClick={() => importRef.current?.click()}>
            📤 CSV取り込み
          </Button>
          <Dialog
            open={importOpen}
            onOpenChange={(open) => {
              setImportOpen(open);
              if (!open) resetImportState();
            }}
          >
            <DialogTrigger render={<Button variant="outline" />}>
              🔗 共通マスタから取込{unimportedMasters.length > 0 ? ` (${unimportedMasters.length})` : ""}
            </DialogTrigger>
            <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>共通マスタから取込</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  事業所の新規作成は介護アプリ側 (共通マスタ) で行い、ここから取込みます。
                  取込済: {activeMasters.length - unimportedMasters.length}件 / 未取込: {unimportedMasters.length}件
                </p>
                {unimportedMasters.length === 0 ? (
                  <p className="text-sm text-muted-foreground border rounded p-4 text-center">
                    未取込の事業所はありません。共通マスタの有効な事業所はすべて取込済です。
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[36px]"></TableHead>
                        <TableHead>名称</TableHead>
                        <TableHead>種別(マスタ)</TableHead>
                        <TableHead>事業所番号</TableHead>
                        <TableHead>事業所種別(給与)</TableHead>
                        <TableHead>法人</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {unimportedMasters.map((m) => {
                        const blockReason = importBlockReason(m);
                        const company = payrollCompanyForMaster(m);
                        const typeValue = resolvedImportType(m);
                        return (
                          <TableRow key={m.id} className={blockReason ? "opacity-50" : ""}>
                            <TableCell>
                              <input
                                type="checkbox"
                                className="h-4 w-4 accent-primary"
                                checked={!!importChecked[m.id] && !blockReason}
                                disabled={!!blockReason || importing}
                                onChange={(e) =>
                                  setImportChecked((prev) => ({ ...prev, [m.id]: e.target.checked }))
                                }
                              />
                            </TableCell>
                            <TableCell>
                              <p className="font-medium">{m.name}</p>
                              {blockReason && (
                                <p className="text-xs text-destructive">{blockReason}</p>
                              )}
                            </TableCell>
                            <TableCell className="text-sm">{m.service_type || "—"}</TableCell>
                            <TableCell className="text-sm">{m.business_number || "—"}</TableCell>
                            <TableCell>
                              {blockReason ? (
                                <span className="text-sm">{typeValue || "—"}</span>
                              ) : (
                                <Select
                                  value={typeValue || "__none__"}
                                  onValueChange={(v) =>
                                    setImportTypes((prev) => ({
                                      ...prev,
                                      [m.id]: !v || v === "__none__" ? "" : (v as OfficeType),
                                    }))
                                  }
                                >
                                  <SelectTrigger className="w-[150px]">
                                    <SelectValue placeholder="種別を選択">
                                      {(v: string) =>
                                        !v || v === "__none__" ? "種別を選択" : v
                                      }
                                    </SelectValue>
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="__none__">種別を選択</SelectItem>
                                    {OFFICE_TYPES.map((t) => (
                                      <SelectItem key={t} value={t}>{t}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              )}
                              {!blockReason && !typeValue && (
                                <p className="text-xs text-destructive mt-1">種別を選択してください</p>
                              )}
                            </TableCell>
                            <TableCell className="text-sm">
                              {company
                                ? company.name
                                : <span className="text-muted-foreground">未紐付け (法人なしで取込)</span>}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
                {unimportedMasters.length > 0 && (
                  <Button
                    onClick={handleImportSubmit}
                    className="w-full"
                    disabled={checkedMasters.length === 0 || importing}
                  >
                    {importing ? "取込中..." : `選択した ${checkedMasters.length} 件を取込`}
                  </Button>
                )}
              </div>
            </DialogContent>
          </Dialog>
          <Dialog
            open={isOpen}
            onOpenChange={(open) => {
              setIsOpen(open);
              if (!open) resetForm();
            }}
          >
            <DialogTrigger render={<Button />}>新規登録</DialogTrigger>
            <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{editingId ? "事業所を編集" : "事業所を登録"}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="overflow-hidden rounded-md border">
                  <FormRow label="事業所(マスタ)" note="名称・住所の編集は介護アプリ側">
                  {editingId ? (
                    <div className="text-sm">
                      <p className="font-medium">{selectedMaster?.name ?? "(未紐付け)"}</p>
                      {selectedMaster?.address && <p className="text-xs text-muted-foreground">{selectedMaster.address}</p>}
                      <p className="text-[10px] text-muted-foreground mt-1">編集中の紐付けは変更できません</p>
                    </div>
                  ) : availableMasters.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      紐付け可能な事業所(マスタ)がありません。先に介護アプリで事業所を作成してください。
                    </p>
                  ) : (
                    <Select
                      value={form.office_id || "__none__"}
                      onValueChange={(v) => onMasterChange(!v || v === "__none__" ? "" : v)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="事業所(マスタ)を選択">
                          {(v: string) => {
                            if (!v || v === "__none__") return "選択してください";
                            const m = masters.find((x) => x.id === v);
                            return m ? m.name : "選択してください";
                          }}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">選択してください</SelectItem>
                        {availableMasters.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.name}{m.business_number ? ` (${m.business_number})` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {!editingId && selectedMaster && (
                    <div className="text-xs text-muted-foreground">
                      {selectedMaster.address && <p>{selectedMaster.address}</p>}
                    </div>
                  )}
                  </FormRow>
                  <FormRow label="事業所番号（介護保険）" note={!editingId ? "マスタ選択時に business_number を自動入力。手動修正可" : undefined}>
                    <Input
                      className="max-w-60"
                      value={form.office_number}
                      onChange={(e) => setForm({ ...form, office_number: e.target.value })}
                      disabled={!!editingId}
                      placeholder="例: 1271500942"
                    />
                  </FormRow>
                  <FormRow label="障害福祉事業所番号" note="任意。請求CSV取り込み時の紐付けに使用">
                    <Input
                      className="max-w-60"
                      value={form.shogai_office_number}
                      onChange={(e) => setForm({ ...form, shogai_office_number: e.target.value })}
                      placeholder="例: 1221910277"
                    />
                  </FormRow>
                  <FormRow label="略称" note="システム内の表示名。未設定の場合は正式名称を使用">
                    <Input
                      className="max-w-60"
                      value={form.short_name}
                      onChange={(e) => setForm({ ...form, short_name: e.target.value })}
                      placeholder="例: 茂原"
                    />
                  </FormRow>
                  <FormRow label="事業所種別">
                  <Select
                    value={form.office_type}
                    onValueChange={(v) => setForm({ ...form, office_type: (v ?? form.office_type) as OfficeType })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {OFFICE_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>{t}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  </FormRow>
                  <FormRow label="法人">
                  <Select
                    value={form.company_id || "__none__"}
                    onValueChange={(v) => setForm({ ...form, company_id: !v || v === "__none__" ? "" : v })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="法人を選択">
                        {(v: string) => {
                          if (!v || v === "__none__") return "未設定";
                          const c = companies.find((x) => x.id === v);
                          return c ? c.name : "法人を選択";
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">未設定</SelectItem>
                      {companies.map((c) => (
                        <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  </FormRow>
                  <FormRow label="週起算曜日" note="残業計算用">
                  <Select
                    value={String(form.work_week_start)}
                    onValueChange={(v) => setForm({ ...form, work_week_start: parseInt(v ?? "0", 10) })}
                  >
                    <SelectTrigger>
                      <SelectValue>
                        {(v: string) => {
                          const days = ["日", "月", "火", "水", "木", "金", "土"];
                          const i = parseInt(v ?? "0", 10);
                          return Number.isFinite(i) && days[i] ? `${days[i]}曜日` : "";
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {["日", "月", "火", "水", "木", "金", "土"].map((d, i) => (
                        <SelectItem key={i} value={String(i)}>{d}曜日</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  </FormRow>
                  <FormRow label="出張手当単価">
                    <div className="flex items-center gap-2">
                      <Input
                        className="w-32 text-right"
                        type="number" min={0} step={0.01}
                        value={form.travel_unit_price || ""}
                        placeholder="0"
                        onChange={(e) => setForm({ ...form, travel_unit_price: parseFloat(e.target.value) || 0 })}
                      />
                      <span className="text-sm text-muted-foreground">円/km</span>
                    </div>
                  </FormRow>
                  <FormRow label="通勤手当単価">
                    <div className="flex items-center gap-2">
                      <Input
                        className="w-32 text-right"
                        type="number" min={0} step={0.01}
                        value={form.commute_unit_price || ""}
                        placeholder="0"
                        onChange={(e) => setForm({ ...form, commute_unit_price: parseFloat(e.target.value) || 0 })}
                      />
                      <span className="text-sm text-muted-foreground">円/km</span>
                    </div>
                  </FormRow>
                  <FormRow label="処遇改善補助金手当">
                    <div className="flex items-center gap-2">
                      <Input
                        className="w-32 text-right"
                        type="number" min={0}
                        value={form.treatment_subsidy_amount || ""}
                        placeholder="0"
                        onChange={(e) => setForm({ ...form, treatment_subsidy_amount: parseFloat(e.target.value) || 0 })}
                      />
                      <span className="text-sm text-muted-foreground">円/月（社保加入者）</span>
                    </div>
                  </FormRow>
                  <FormRow label="キャンセル手当単価">
                    <div className="flex items-center gap-2">
                      <Input
                        className="w-32 text-right"
                        type="number" min={0}
                        value={form.cancel_unit_price || ""}
                        placeholder="0"
                        onChange={(e) => setForm({ ...form, cancel_unit_price: parseFloat(e.target.value) || 0 })}
                      />
                      <span className="text-sm text-muted-foreground">円/件</span>
                    </div>
                  </FormRow>
                  <FormRow label="同行キャンセル手当単価" note="同行ドタキャン (010999) 1件あたり">
                    <div className="flex items-center gap-2">
                      <Input
                        className="w-32 text-right"
                        type="number" min={0}
                        value={form.doukou_cancel_unit_price || ""}
                        placeholder="0"
                        onChange={(e) => setForm({ ...form, doukou_cancel_unit_price: parseFloat(e.target.value) || 0 })}
                      />
                      <span className="text-sm text-muted-foreground">円/件</span>
                    </div>
                  </FormRow>
                  {/* 移動手当: DB は 円/時 で持つ (計算は travelAllowanceAmount が 円/時)。画面は 円/分 で入力する: 20円/分 = 1200円/時 */}
                  <FormRow label="移動手当単価">
                    <div className="flex items-center gap-2">
                      <Input
                        className="w-32 text-right"
                        type="number" min={0} step={0.01}
                        value={form.travel_allowance_rate ? Math.round((form.travel_allowance_rate / 60) * 100) / 100 : ""}
                        placeholder="0"
                        onChange={(e) => setForm({ ...form, travel_allowance_rate: (parseFloat(e.target.value) || 0) * 60 })}
                      />
                      <span className="text-sm text-muted-foreground">円/分</span>
                    </div>
                  </FormRow>
                  <FormRow label="会議1単価">
                    <div className="flex items-center gap-2">
                      <Input
                        className="w-32 text-right"
                        type="number" min={0}
                        value={form.meeting_unit_price || ""}
                        placeholder="0"
                        onChange={(e) => setForm({ ...form, meeting_unit_price: parseFloat(e.target.value) || 0 })}
                      />
                      <span className="text-sm text-muted-foreground">円/件</span>
                    </div>
                  </FormRow>
                  <FormRow label="距離調整係数">
                    <div className="flex items-center gap-2">
                      <Input
                        className="w-32 text-right"
                        type="number" min={1} step={1}
                        value={form.distance_adjustment_rate || ""}
                        placeholder="100"
                        onChange={(e) => setForm({ ...form, distance_adjustment_rate: parseFloat(e.target.value) || 100 })}
                      />
                      <span className="text-sm text-muted-foreground">%（例: 125 = 125%）</span>
                    </div>
                  </FormRow>
                  {editingId && (
                    <FormRow
                      label="単価の改定月"
                      note={changedInForm.length > 0
                        ? `変えた単価 (${changedInForm.map((k) => PRICE_LABEL[k]).join("・")}) は この月の給与から。前の月は今までの単価のまま`
                        : "単価を変えたときだけ使います。この月の給与から新しい単価になり、前の月は今までの単価のまま"}
                    >
                      <Input
                        className="w-40"
                        type="month"
                        value={revisionMonth}
                        onChange={(e) => setRevisionMonth(e.target.value)}
                      />
                    </FormRow>
                  )}
                  {editingId && (
                    <FormRow label="単価の改定履歴">
                      {priceHistory === null ? (
                        <p className="text-xs text-muted-foreground">読み込み中…</p>
                      ) : priceHistory.length === 0 ? (
                        <p className="text-xs text-destructive">履歴がありません (給与計算は 上の単価をそのまま使います)</p>
                      ) : (
                        <ul className="space-y-1 text-xs">
                          {priceHistory.map((r, i) => {
                            const prev = i > 0 ? priceHistory[i - 1] : null;
                            const keys = OFFICE_PRICE_KEYS.filter((k) => r[k] != null && (!prev || Number(prev[k]) !== Number(r[k])));
                            return (
                              <li key={r.effective_from}>
                                <span className="font-medium">{r.effective_from === "1970-01-01" ? "初期値" : `${r.effective_from.slice(0, 7).replace("-", "年")}月分から`}</span>
                                <span className="ml-2 text-muted-foreground">
                                  {keys.length === 0 ? "変更なし" : keys.map((k) => `${PRICE_LABEL[k]} ${priceText(k, r[k])}`).join(" / ")}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </FormRow>
                  )}
                </div>
                <Button onClick={handleSubmit} className="w-full" disabled={!form.office_id || saving}>
                  {saving ? "保存中…" : editingId ? "更新" : "登録"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* 横スクロールバーを画面の一番下に出す (表の下端まで行かなくてよい)。見出しは上に固定。6.5rem = 上の余白+見出し行+下の余白 */}
      <div className="max-h-[calc(100dvh-6.5rem)] overflow-auto rounded-md border [&>[data-slot=table-container]]:overflow-visible">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background shadow-[0_1px_0_var(--border)]">
          <TableRow>
            {canReorder && <TableHead className="w-8 px-1" title="⠿ をつかんで上下にドラッグすると並びを変えられます" />}
            <TableHead>事業所番号</TableHead>
            <TableHead>正式名称(マスタ)</TableHead>
            <TableHead>略称</TableHead>
            <TableHead>法人</TableHead>
            <TableHead>種別</TableHead>
            <TableHead>週起算</TableHead>
            <TableHead className="text-right">出張単価</TableHead>
            <TableHead className="text-right">通勤単価</TableHead>
            <TableHead className="text-right">処遇補助金</TableHead>
            <TableHead className="text-right">キャンセル単価</TableHead>
            <TableHead className="text-right">同行キャンセル単価</TableHead>
            <TableHead className="text-right">移動手当単価</TableHead>
            <TableHead className="text-right">会議1単価</TableHead>
            <TableHead className="text-right">距離調整係数</TableHead>
            <TableHead>住所(マスタ)</TableHead>
            <TableHead className="w-[120px]">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {offices.length === 0 ? (
            <TableRow>
              <TableCell colSpan={canReorder ? 17 : 16} className="text-center text-muted-foreground">
                事業所が登録されていません
              </TableCell>
            </TableRow>
          ) : (
            offices.map((office) => (
              <TableRow
                key={office.id}
                draggable={canReorder && !reordering && dragArmedId === office.id}
                onDragStart={(e) => { setDragId(office.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", office.id); }}
                onDragOver={(e) => { if (!dragId) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (overId !== office.id) setOverId(office.id); }}
                onDrop={(e) => { e.preventDefault(); if (dragId) dropOn(office.id); }}
                onDragEnd={endDrag}
                className={
                  dragId === office.id ? "opacity-40"
                    : overId === office.id && dragId
                      ? (offices.findIndex((o) => o.id === dragId) < offices.findIndex((o) => o.id === office.id)
                          ? "shadow-[inset_0_-2px_0_var(--primary)]"   // 下へ動かす: この行の下に入る
                          : "shadow-[inset_0_2px_0_var(--primary)]")   // 上へ動かす: この行の上に入る
                      : undefined
                }
              >
                {canReorder && (
                  <TableCell
                    className="w-8 cursor-grab select-none px-1 text-center text-muted-foreground active:cursor-grabbing"
                    title="つかんで上下にドラッグすると並びを変えられます"
                    onPointerDown={() => setDragArmedId(office.id)}
                    onPointerUp={() => { if (!dragId) setDragArmedId(null); }}
                  >
                    ⠿
                  </TableCell>
                )}
                <TableCell>{office.office_number}</TableCell>
                <TableCell>{office.name || "(未紐付け)"}</TableCell>
                <TableCell className="font-medium">{office.short_name || "—"}</TableCell>
                <TableCell className="text-sm">
                  {office.company_id
                    ? (companies.find((c) => c.id === office.company_id)?.name ?? "—")
                    : "—"}
                </TableCell>
                <TableCell>{office.office_type}</TableCell>
                <TableCell>{["日","月","火","水","木","金","土"][office.work_week_start ?? 0]}曜</TableCell>
                <TableCell className="text-right text-sm">
                  {office.travel_unit_price ? `${office.travel_unit_price}円/km` : "—"}
                </TableCell>
                <TableCell className="text-right text-sm">
                  {office.commute_unit_price ? `${office.commute_unit_price}円/km` : "—"}
                </TableCell>
                <TableCell className="text-right text-sm">
                  {office.treatment_subsidy_amount ? `${office.treatment_subsidy_amount}円` : "—"}
                </TableCell>
                <TableCell className="text-right text-sm">
                  {office.cancel_unit_price ? `${office.cancel_unit_price}円/件` : "—"}
                </TableCell>
                <TableCell className="text-right text-sm">
                  {office.doukou_cancel_unit_price ? `${office.doukou_cancel_unit_price}円/件` : "—"}
                </TableCell>
                <TableCell className="text-right text-sm">
                  {office.travel_allowance_rate ? `${Math.round((office.travel_allowance_rate / 60) * 100) / 100}円/分` : "—"}
                </TableCell>
                <TableCell className="text-right text-sm">
                  {office.meeting_unit_price ? `${office.meeting_unit_price}円/件` : "—"}
                </TableCell>
                <TableCell className="text-right text-sm">
                  {office.distance_adjustment_rate != null && office.distance_adjustment_rate !== 100
                    ? `${office.distance_adjustment_rate}%`
                    : "100%"}
                </TableCell>
                <TableCell>{office.address || "-"}</TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => handleEdit(office)}>編集</Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(office.id)}>削除</Button>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      </div>
    </div>
  );
}
