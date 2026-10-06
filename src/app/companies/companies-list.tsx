"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import type { Company } from "@/types/database";
import { decodeCP932, parseCsvLines } from "@/lib/csv/decoder";

export type MasterCompany = { id: string; name: string; address: string | null; phone: string | null };

/**
 * CSV の列 (2026-10-06 user「法人一覧は CSV で取り込めるように」)。
 * 突合は「法人名」= 共通マスタ companies.name。名称・住所・電話は介護アプリ側のマスタなので 取込では変えない (出力だけ)。
 * ★ 空欄のセルは「変更しない」。消したいときは画面の編集で消す (CSV の空欄で 請求書の差出人が消える事故を防ぐ)。
 */
const CSV_COLUMNS = [
  { header: "郵便番号", field: "zipcode" },
  { header: "代表TEL", field: "tel" },
  { header: "正式名称", field: "formal_name" },
  { header: "代表者", field: "representative" },
  { header: "FAX", field: "fax" },
  { header: "インボイス登録番号", field: "registration_number" },
  { header: "押印画像URL", field: "seal_image_url" },
  { header: "請求書の挨拶文", field: "invoice_greeting" },
  { header: "お問い合わせ先TEL", field: "inquiry_tel" },
] as const;
type CsvField = (typeof CSV_COLUMNS)[number]["field"];
const READONLY_HEADERS = ["住所(マスタ)", "電話番号(マスタ)"] as const;

function downloadCsv(filename: string, rows: string[][]): void {
  const escape = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const csv = rows.map((r) => r.map(escape).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/** 法人名の突合用 (全角半角・空白・中黒の揺れを吸収) */
const normName = (s: string) => s.normalize("NFKC").replace(/\s/g, "").replace(/[･・]/g, "・");

type ImportPlan = {
  inserts: { master_company_id: string; name: string; values: Partial<Record<CsvField, string>> }[];
  updates: { id: string; name: string; changes: Partial<Record<CsvField, string>> }[];
  unchanged: number;
  errors: string[];
};

const defaultForm = {
  master_company_id: "",
  zipcode: "",
  formal_name: "",
  registration_number: "",
  tel: "",
  fax: "",
  representative: "",
  seal_image_url: "",
  invoice_greeting: "",
  inquiry_tel: "",
};

export function CompaniesList({
  initialCompanies,
  masters,
}: {
  initialCompanies: Company[];
  masters: MasterCompany[];
}) {
  const router = useRouter();
  const companies = initialCompanies;
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(defaultForm);
  const importRef = useRef<HTMLInputElement>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [importing, setImporting] = useState(false);

  const handleExport = () => {
    const header = ["法人名", ...READONLY_HEADERS, ...CSV_COLUMNS.map((c) => c.header)];
    const rows = companies.map((c) => [
      c.name ?? "", c.address ?? "", c.phone ?? "",
      ...CSV_COLUMNS.map((col) => String(c[col.field] ?? "")),
    ]);
    downloadCsv(`法人一覧_${new Date().toISOString().slice(0, 10)}.csv`, [header, ...rows]);
  };

  /** 読むだけ。保存は プレビューで「取り込む」を押してから */
  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const buf = await file.arrayBuffer();
    const b = new Uint8Array(buf);
    const isUtf8Bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
    const text = (isUtf8Bom ? new TextDecoder("utf-8").decode(buf) : decodeCP932(buf)).replace(/^\uFEFF/, "");
    const rows = parseCsvLines(text).filter((r) => r.some((v) => v.trim() !== ""));
    if (rows.length < 2) { toast.error("データ行がありません"); return; }
    const headers = rows[0].map((h) => h.trim());
    const nameIdx = headers.indexOf("法人名");
    if (nameIdx < 0) { toast.error("「法人名」の列がありません (CSV出力した形式で取り込んでください)"); return; }
    const colIdx = CSV_COLUMNS.map((c) => ({ ...c, idx: headers.indexOf(c.header) })).filter((c) => c.idx >= 0);
    if (colIdx.length === 0) { toast.error(`取り込める列がありません (${CSV_COLUMNS.map((c) => c.header).join(" / ")})`); return; }

    const masterByName = new Map(masters.map((m) => [normName(m.name), m]));
    const companyByMaster = new Map(companies.filter((c) => c.master_company_id).map((c) => [c.master_company_id as string, c]));
    const next: ImportPlan = { inserts: [], updates: [], unchanged: 0, errors: [] };
    const seen = new Set<string>();
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const name = (r[nameIdx] ?? "").trim();
      if (!name) { next.errors.push(`${i + 1}行目: 法人名が空です`); continue; }
      const master = masterByName.get(normName(name));
      if (!master) { next.errors.push(`${i + 1}行目: 「${name}」が共通マスタの法人にありません (法人の追加は介護アプリ側)`); continue; }
      if (seen.has(master.id)) { next.errors.push(`${i + 1}行目: 「${name}」が 2 回出てきます (後の行は無視)`); continue; }
      seen.add(master.id);
      const values: Partial<Record<CsvField, string>> = {};
      for (const c of colIdx) {
        const v = (r[c.idx] ?? "").trim();
        if (v !== "") values[c.field] = v;           // 空欄 = 変更しない
      }
      const existing = companyByMaster.get(master.id);
      if (!existing) { next.inserts.push({ master_company_id: master.id, name: master.name, values }); continue; }
      const changes: Partial<Record<CsvField, string>> = {};
      for (const [k, v] of Object.entries(values) as [CsvField, string][]) {
        if ((existing[k] ?? "") !== v) changes[k] = v;
      }
      if (Object.keys(changes).length === 0) next.unchanged++;
      else next.updates.push({ id: existing.id, name: existing.name || master.name, changes });
    }
    setPlan(next);
  };

  const applyImport = async () => {
    if (!plan) return;
    setImporting(true);
    const failed: string[] = [];
    for (const u of plan.updates) {
      const { error } = await supabase.from("payroll_companies").update(u.changes).eq("id", u.id);
      if (error) failed.push(`${u.name}: ${error.message}`);
    }
    for (const ins of plan.inserts) {
      const { error } = await supabase.from("payroll_companies").insert({ master_company_id: ins.master_company_id, ...ins.values });
      if (error) failed.push(`${ins.name}: ${error.message}`);
    }
    setImporting(false);
    if (failed.length > 0) {
      console.error("companies import failed:", failed);
      toast.error(`取り込みエラー ${failed.length}件: ${failed[0]}`);
    } else {
      toast.success(`取り込みました (更新 ${plan.updates.length} / 追加 ${plan.inserts.length})`);
    }
    setPlan(null);
    router.refresh();
  };

  const resetForm = () => {
    setForm(defaultForm);
    setEditingId(null);
  };

  const handleSubmit = async () => {
    if (!form.master_company_id) {
      toast.error("法人(マスタ)を選択してください");
      return;
    }

    const toNull = (v: string) => (v.trim() === "" ? null : v);
    const payload = {
      master_company_id: form.master_company_id,
      zipcode: toNull(form.zipcode),
      formal_name: toNull(form.formal_name),
      registration_number: toNull(form.registration_number),
      tel: toNull(form.tel),
      fax: toNull(form.fax),
      representative: toNull(form.representative),
      seal_image_url: toNull(form.seal_image_url),
      invoice_greeting: toNull(form.invoice_greeting),
      inquiry_tel: toNull(form.inquiry_tel),
    };

    if (editingId) {
      const { master_company_id: _omit, ...updatePayload } = payload;
      void _omit;
      const { error } = await supabase.from("payroll_companies").update(updatePayload).eq("id", editingId);
      if (error) { toast.error(`更新エラー: ${error.message}`); return; }
      toast.success("法人を更新しました");
    } else {
      const { error } = await supabase.from("payroll_companies").insert(payload);
      if (error) { toast.error(`登録エラー: ${error.message}`); return; }
      toast.success("法人を登録しました");
    }

    setIsOpen(false);
    resetForm();
    router.refresh();
  };

  const handleEdit = (company: Company) => {
    setForm({
      master_company_id: company.master_company_id ?? "",
      zipcode: company.zipcode ?? "",
      formal_name: company.formal_name ?? "",
      registration_number: company.registration_number ?? "",
      tel: company.tel ?? "",
      fax: company.fax ?? "",
      representative: company.representative ?? "",
      seal_image_url: company.seal_image_url ?? "",
      invoice_greeting: company.invoice_greeting ?? "",
      inquiry_tel: company.inquiry_tel ?? "",
    });
    setEditingId(company.id);
    setIsOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("この法人を削除しますか？関連する事業所の法人情報が解除されます。")) return;
    const { error } = await supabase.from("payroll_companies").delete().eq("id", id);
    if (error) { toast.error(`削除エラー: ${error.message}`); return; }
    toast.success("法人を削除しました");
    router.refresh();
  };

  const linkedMasterIds = new Set(
    companies
      .filter((c) => c.master_company_id && c.id !== editingId)
      .map((c) => c.master_company_id as string),
  );
  const availableMasters = masters.filter((m) => !linkedMasterIds.has(m.id));
  const selectedMaster = masters.find((m) => m.id === form.master_company_id);

  return (
    <div>
      <input ref={importRef} type="file" accept=".csv" className="hidden" onChange={handleImportFile} />
      <Dialog open={!!plan} onOpenChange={(open) => { if (!open && !importing) setPlan(null); }}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>CSV 取り込みの確認</DialogTitle>
          </DialogHeader>
          {plan && (
            <div className="space-y-3 text-sm">
              <p>
                更新 <b>{plan.updates.length}</b> 件 / 追加 <b>{plan.inserts.length}</b> 件 / 変更なし {plan.unchanged} 件
                {plan.errors.length > 0 && <> / <span className="text-destructive">取り込めない行 {plan.errors.length} 件</span></>}
              </p>
              <p className="text-xs text-muted-foreground">空欄のセルは変更しません。名称・住所・電話 (マスタ) は取り込みでは変わりません。</p>
              {plan.errors.length > 0 && (
                <ul className="rounded border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive space-y-0.5">
                  {plan.errors.map((er) => <li key={er}>{er}</li>)}
                </ul>
              )}
              {[...plan.updates.map((u) => ({ key: u.id, kind: "更新", name: u.name, vals: u.changes })),
                ...plan.inserts.map((x) => ({ key: x.master_company_id, kind: "追加", name: x.name, vals: x.values }))].map((row) => (
                <div key={row.key} className="rounded border p-2">
                  <p className="font-medium">{row.kind}: {row.name}</p>
                  <ul className="mt-1 text-xs text-muted-foreground space-y-0.5">
                    {CSV_COLUMNS.filter((c) => row.vals[c.field] !== undefined).map((c) => (
                      <li key={c.field} className="whitespace-pre-wrap break-all">{c.header}: {row.vals[c.field]}</li>
                    ))}
                  </ul>
                </div>
              ))}
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setPlan(null)} disabled={importing}>やめる</Button>
                <Button onClick={applyImport} disabled={importing || (plan.updates.length === 0 && plan.inserts.length === 0)}>
                  {importing ? "取り込み中…" : "取り込む"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">法人一覧</h2>
        <div className="flex gap-2">
        <Button variant="outline" onClick={handleExport} disabled={companies.length === 0}>📥 CSV出力</Button>
        <Button variant="outline" onClick={() => importRef.current?.click()}>📤 CSV取り込み</Button>
        <Dialog open={isOpen} onOpenChange={(open) => { setIsOpen(open); if (!open) resetForm(); }}>
          <DialogTrigger render={<Button />}>新規登録</DialogTrigger>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editingId ? "法人を編集" : "法人を登録"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="rounded border bg-muted/30 p-3 space-y-2">
                <Label className="text-xs text-muted-foreground">
                  法人(マスタ) - 名称・住所・電話の編集は介護アプリ側
                </Label>
                {editingId ? (
                  <div className="text-sm">
                    <p className="font-medium">{selectedMaster?.name ?? "(未紐付け)"}</p>
                    {selectedMaster?.address && <p className="text-xs text-muted-foreground">{selectedMaster.address}</p>}
                    {selectedMaster?.phone && <p className="text-xs text-muted-foreground">TEL: {selectedMaster.phone}</p>}
                    <p className="text-[10px] text-muted-foreground mt-1">編集中の紐付けは変更できません</p>
                  </div>
                ) : availableMasters.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    紐付け可能な法人(マスタ)がありません。先に介護アプリで法人を作成してください。
                  </p>
                ) : (
                  <Select
                    value={form.master_company_id || "__none__"}
                    onValueChange={(v) => setForm({ ...form, master_company_id: !v || v === "__none__" ? "" : v })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="法人(マスタ)を選択">
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
                        <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {!editingId && selectedMaster && (
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    {selectedMaster.address && <p>{selectedMaster.address}</p>}
                    {selectedMaster.phone && <p>TEL: {selectedMaster.phone}</p>}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-[120px_1fr] gap-2">
                <div>
                  <Label>郵便番号</Label>
                  <Input
                    value={form.zipcode}
                    onChange={(e) => setForm({ ...form, zipcode: e.target.value })}
                    placeholder="299-0110"
                  />
                </div>
                <div>
                  <Label>代表TEL（請求書表記）</Label>
                  <Input
                    value={form.tel}
                    onChange={(e) => setForm({ ...form, tel: e.target.value })}
                    placeholder="例: 0436-60-3236"
                  />
                </div>
              </div>

              <div className="pt-3 border-t">
                <Label className="text-sm">請求書 差出人情報</Label>
                <p className="text-xs text-muted-foreground mb-2">請求書のヘッダ右上に表示されます。</p>
                <div className="space-y-3">
                  <div>
                    <Label className="text-xs">正式名称（請求書表記）</Label>
                    <Input
                      value={form.formal_name}
                      onChange={(e) => setForm({ ...form, formal_name: e.target.value })}
                      placeholder="例: (株)ケイ・ティ・サービス"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">代表者（役職＋氏名）</Label>
                    <Input
                      value={form.representative}
                      onChange={(e) => setForm({ ...form, representative: e.target.value })}
                      placeholder="例: 代表取締役　手代木　正儀"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">FAX（請求書表記）</Label>
                    <Input
                      value={form.fax}
                      onChange={(e) => setForm({ ...form, fax: e.target.value })}
                      placeholder="例: 0436-60-3230"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">インボイス登録番号</Label>
                    <Input
                      value={form.registration_number}
                      onChange={(e) => setForm({ ...form, registration_number: e.target.value })}
                      placeholder="T00000000000"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">押印画像URL（seal_required=ONの利用者に表示）</Label>
                    <Input
                      value={form.seal_image_url}
                      onChange={(e) => setForm({ ...form, seal_image_url: e.target.value })}
                      placeholder="https://..."
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      空欄の場合、該当する利用者の請求書では「押印省略」表記になります。
                    </p>
                  </div>
                  <div>
                    <Label className="text-xs">請求書の挨拶文</Label>
                    <textarea
                      className="w-full border rounded px-3 py-2 text-sm bg-background resize-none"
                      rows={4}
                      value={form.invoice_greeting}
                      onChange={(e) => setForm({ ...form, invoice_greeting: e.target.value })}
                      placeholder={"拝啓　毎々格別のお引立に預かり厚く御礼申し上げます。\nさて、ご利用分の請求書をお送りさせていただきましたので、ご査収の程よろしくお願いいたします。\n敬具"}
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      空欄の場合、既定の挨拶文が使われます。
                    </p>
                  </div>
                  <div>
                    <Label className="text-xs">お問い合わせ先TEL（請求書下部）</Label>
                    <Input
                      value={form.inquiry_tel}
                      onChange={(e) => setForm({ ...form, inquiry_tel: e.target.value })}
                      placeholder="例: 0436-60-3236"
                    />
                  </div>
                </div>
              </div>

              <Button onClick={handleSubmit} className="w-full" disabled={!form.master_company_id}>
                {editingId ? "更新" : "登録"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>法人名(マスタ)</TableHead>
            <TableHead>正式名称</TableHead>
            <TableHead>住所</TableHead>
            <TableHead>電話番号</TableHead>
            <TableHead>登録番号</TableHead>
            <TableHead className="w-[120px]">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {companies.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground">
                法人が登録されていません
              </TableCell>
            </TableRow>
          ) : (
            companies.map((company) => (
              <TableRow key={company.id}>
                <TableCell className="font-medium">{company.name || "(未紐付け)"}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{company.formal_name || "—"}</TableCell>
                <TableCell className="text-sm">
                  {company.zipcode && <span className="text-xs text-muted-foreground">〒{company.zipcode}　</span>}
                  {company.address || "—"}
                </TableCell>
                <TableCell>{company.phone || company.tel || "—"}</TableCell>
                <TableCell className="text-xs font-mono">{company.registration_number || "—"}</TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => handleEdit(company)}>編集</Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(company.id)}>削除</Button>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
