"use client";

import { useState, useEffect, useCallback, use } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import type { Company, CompanyInvoiceFormat } from "@/types/database";

/**
 * 法人ごとの請求書フォーマット設定画面
 * /billing/formats/[companyId]
 *
 * DB: company_invoice_formats (1法人につき1レコード、なければ作成)
 */

type Form = {
  invoice_title: string;
  mark_text: string;
  greeting: string;
  show_bank_account_number: boolean;
  show_bank_account_holder: boolean;
  show_bank_name: boolean;
  show_withdrawal_amount: boolean;
  show_reduction: boolean;
  show_mitigation: boolean;
  show_medical_deduction: boolean;
  show_tax: boolean;
  show_calendar: boolean;
  print_seal: boolean;
  overbilling_text: string;
  underbilling_text: string;
  offset_remaining_text: string;
  inquiry_tel: string;
  note: string;
};

const defaultForm: Form = {
  invoice_title: "ご利用料金のご案内",
  mark_text: "ご請求書・領収書在中",
  greeting: "",
  show_bank_account_number: true,
  show_bank_account_holder: true,
  show_bank_name: true,
  show_withdrawal_amount: true,
  show_reduction: true,
  show_mitigation: true,
  show_medical_deduction: true,
  show_tax: true,
  show_calendar: true,
  print_seal: false,
  overbilling_text: "",
  underbilling_text: "",
  offset_remaining_text: "",
  inquiry_tel: "",
  note: "",
};

export default function InvoiceFormatPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = use(params);
  const [company, setCompany] = useState<Company | null>(null);
  const [formatId, setFormatId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(defaultForm);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const [coRes, fmtRes] = await Promise.all([
      supabase.from("companies").select("*").eq("id", companyId).single(),
      supabase.from("company_invoice_formats").select("*").eq("company_id", companyId).maybeSingle(),
    ]);
    if (coRes.data) setCompany(coRes.data as Company);
    if (fmtRes.data) {
      const f = fmtRes.data as CompanyInvoiceFormat;
      setFormatId(f.id);
      setForm({
        invoice_title: f.invoice_title ?? defaultForm.invoice_title,
        mark_text: f.mark_text ?? defaultForm.mark_text,
        greeting: f.greeting ?? "",
        show_bank_account_number: f.show_bank_account_number ?? true,
        show_bank_account_holder: f.show_bank_account_holder ?? true,
        show_bank_name: f.show_bank_name ?? true,
        show_withdrawal_amount: f.show_withdrawal_amount ?? true,
        show_reduction: f.show_reduction ?? true,
        show_mitigation: f.show_mitigation ?? true,
        show_medical_deduction: f.show_medical_deduction ?? true,
        show_tax: f.show_tax ?? true,
        show_calendar: f.show_calendar ?? true,
        print_seal: f.print_seal ?? false,
        overbilling_text: f.overbilling_text ?? "",
        underbilling_text: f.underbilling_text ?? "",
        offset_remaining_text: f.offset_remaining_text ?? "",
        inquiry_tel: f.inquiry_tel ?? "",
        note: f.note ?? "",
      });
    } else {
      // まだ存在しない場合は companies の既存値を初期値に流し込む
      if (coRes.data) {
        const c = coRes.data as Company;
        setForm((prev) => ({
          ...prev,
          greeting: c.invoice_greeting ?? "",
          inquiry_tel: c.inquiry_tel ?? "",
        }));
      }
    }
    setLoading(false);
  }, [companyId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSave = async () => {
    if (!company) return;
    setSaving(true);
    const toNull = (v: string) => (v.trim() === "" ? null : v);
    const payload = {
      company_id: companyId,
      invoice_title: toNull(form.invoice_title),
      mark_text: toNull(form.mark_text),
      greeting: toNull(form.greeting),
      show_bank_account_number: form.show_bank_account_number,
      show_bank_account_holder: form.show_bank_account_holder,
      show_bank_name: form.show_bank_name,
      show_withdrawal_amount: form.show_withdrawal_amount,
      show_reduction: form.show_reduction,
      show_mitigation: form.show_mitigation,
      show_medical_deduction: form.show_medical_deduction,
      show_tax: form.show_tax,
      show_calendar: form.show_calendar,
      print_seal: form.print_seal,
      overbilling_text: toNull(form.overbilling_text),
      underbilling_text: toNull(form.underbilling_text),
      offset_remaining_text: toNull(form.offset_remaining_text),
      inquiry_tel: toNull(form.inquiry_tel),
      note: toNull(form.note),
    };

    if (formatId) {
      const { error } = await supabase.from("company_invoice_formats").update(payload).eq("id", formatId);
      if (error) { toast.error(`保存エラー: ${error.message}`); setSaving(false); return; }
    } else {
      const { data, error } = await supabase.from("company_invoice_formats").insert(payload).select().single();
      if (error) { toast.error(`保存エラー: ${error.message}`); setSaving(false); return; }
      if (data) setFormatId((data as CompanyInvoiceFormat).id);
    }
    toast.success("保存しました");
    setSaving(false);
  };

  if (loading) return <div className="p-4 text-sm text-muted-foreground">読み込み中…</div>;
  if (!company) return <div className="p-4 text-sm text-red-700">法人が見つかりません</div>;

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Link href="/billing/formats" className="hover:underline">請求書様式管理</Link>
            <span>/</span>
            <span>{company.name}</span>
          </div>
          <h2 className="text-2xl font-bold mt-1">請求書様式 編集</h2>
        </div>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "保存中…" : "💾 保存"}
        </Button>
      </div>

      <div className="space-y-6">
        {/* ── タイトル・文言 ── */}
        <section className="border rounded-md p-4 space-y-3">
          <h3 className="text-sm font-semibold">タイトル・文言</h3>
          <div>
            <Label className="text-xs">請求書タイトル</Label>
            <Input value={form.invoice_title} onChange={(e) => setForm({ ...form, invoice_title: e.target.value })}
              placeholder="ご利用料金のご案内" />
          </div>
          <div>
            <Label className="text-xs">在中マーク文言</Label>
            <Input value={form.mark_text} onChange={(e) => setForm({ ...form, mark_text: e.target.value })}
              placeholder="ご請求書・領収書在中" />
          </div>
          <div>
            <Label className="text-xs">挨拶文</Label>
            <textarea className="w-full border rounded px-3 py-2 text-sm bg-background min-h-[120px]"
              value={form.greeting}
              onChange={(e) => setForm({ ...form, greeting: e.target.value })}
              placeholder="拝啓　毎々格別のお引立に預かり厚く御礼申し上げます。…" />
          </div>
        </section>

        {/* ── 振替情報の表示制御 ── */}
        <section className="border rounded-md p-4 space-y-3">
          <h3 className="text-sm font-semibold">振替情報テーブルに載せる項目</h3>
          <p className="text-xs text-muted-foreground">
            引落口座を持つ利用者の請求書に表示される振替情報テーブルの各列を個別に ON/OFF
          </p>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <Toggle label="金融機関名・支店名" value={form.show_bank_name} onChange={(v) => setForm({ ...form, show_bank_name: v })} />
            <Toggle label="口座番号（種目・口座番号）" value={form.show_bank_account_number} onChange={(v) => setForm({ ...form, show_bank_account_number: v })} />
            <Toggle label="口座名義人" value={form.show_bank_account_holder} onChange={(v) => setForm({ ...form, show_bank_account_holder: v })} />
            <Toggle label="お引落予定金額" value={form.show_withdrawal_amount} onChange={(v) => setForm({ ...form, show_withdrawal_amount: v })} />
          </div>
        </section>

        {/* ── 金額ミニ表 ── */}
        <section className="border rounded-md p-4 space-y-3">
          <h3 className="text-sm font-semibold">金額テーブルのミニ表</h3>
          <p className="text-xs text-muted-foreground">
            金額テーブルの下に並ぶ小さな内訳項目の表示 ON/OFF
          </p>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <Toggle label="医療費控除対象額" value={form.show_medical_deduction} onChange={(v) => setForm({ ...form, show_medical_deduction: v })} />
            <Toggle label="減免額" value={form.show_reduction} onChange={(v) => setForm({ ...form, show_reduction: v })} />
            <Toggle label="軽減額" value={form.show_mitigation} onChange={(v) => setForm({ ...form, show_mitigation: v })} />
            <Toggle label="消費税" value={form.show_tax} onChange={(v) => setForm({ ...form, show_tax: v })} />
          </div>
        </section>

        {/* ── カレンダー・押印 ── */}
        <section className="border rounded-md p-4 space-y-3">
          <h3 className="text-sm font-semibold">その他の表示設定</h3>
          <div className="space-y-2">
            <Toggle label="利用日カレンダーを表示する（請求書末尾）" value={form.show_calendar} onChange={(v) => setForm({ ...form, show_calendar: v })} />
            <Toggle label="角印（押印）を印刷する" value={form.print_seal} onChange={(v) => setForm({ ...form, print_seal: v })} />
            {form.print_seal && !company.seal_image_url && (
              <p className="text-[11px] text-amber-700 ml-6">
                ⚠ 法人マスタに押印画像 (seal_image_url) が設定されていません。/companies で画像URLを登録してください。
              </p>
            )}
          </div>
        </section>

        {/* ── 過誤・相殺・問合せ ── */}
        <section className="border rounded-md p-4 space-y-3">
          <h3 className="text-sm font-semibold">過誤・相殺・お問い合わせ</h3>
          <div>
            <Label className="text-xs">過誤（過大請求）の文言</Label>
            <Input value={form.overbilling_text} onChange={(e) => setForm({ ...form, overbilling_text: e.target.value })}
              placeholder="例: 過大請求分をご返金いたします" />
          </div>
          <div>
            <Label className="text-xs">過誤（過小請求）の文言</Label>
            <Input value={form.underbilling_text} onChange={(e) => setForm({ ...form, underbilling_text: e.target.value })}
              placeholder="例: 過小請求分を次回以降ご請求いたします" />
          </div>
          <div>
            <Label className="text-xs">相殺残額発生時の文言</Label>
            <Input value={form.offset_remaining_text} onChange={(e) => setForm({ ...form, offset_remaining_text: e.target.value })}
              placeholder="例: 相殺残額は次回以降に繰越します" />
          </div>
          <div>
            <Label className="text-xs">お問い合わせ先（請求書上部の黄色ハイライト）</Label>
            <Input value={form.inquiry_tel} onChange={(e) => setForm({ ...form, inquiry_tel: e.target.value })}
              placeholder="例: TEL 043-XXX-XXXX" />
          </div>
        </section>

        {/* ── 備考 ── */}
        <section className="border rounded-md p-4">
          <Label className="text-xs">備考（管理用メモ）</Label>
          <textarea className="w-full border rounded px-3 py-2 text-sm bg-background min-h-[80px] mt-1"
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
            placeholder="このフォーマットに関するメモ（請求書には印字されません）" />
        </section>

        <div className="flex justify-end gap-2">
          <Link href="/billing/formats">
            <Button variant="ghost">戻る</Button>
          </Link>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "保存中…" : "💾 保存"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
