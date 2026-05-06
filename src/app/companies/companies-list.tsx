"use client";

import { useState } from "react";
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

export type MasterCompany = { id: string; name: string; address: string | null; phone: string | null };

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
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">法人一覧</h2>
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
