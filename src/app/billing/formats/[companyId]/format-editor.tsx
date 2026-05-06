"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import type { Company, CompanyInvoiceFormat } from "@/types/database";

export type FormatFormValues = {
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

export function FormatEditor({
  companyId,
  company,
  initialFormatId,
  initialForm,
}: {
  companyId: string;
  company: Company;
  initialFormatId: string | null;
  initialForm: FormatFormValues;
}) {
  const [formatId, setFormatId] = useState<string | null>(initialFormatId);
  const [form, setForm] = useState<FormatFormValues>(initialForm);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
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
      const { error } = await supabase.from("payroll_company_invoice_formats").update(payload).eq("id", formatId);
      if (error) { toast.error(`保存エラー: ${error.message}`); setSaving(false); return; }
    } else {
      const { data, error } = await supabase.from("payroll_company_invoice_formats").insert(payload).select().single();
      if (error) { toast.error(`保存エラー: ${error.message}`); setSaving(false); return; }
      if (data) setFormatId((data as CompanyInvoiceFormat).id);
    }
    toast.success("保存しました");
    setSaving(false);
  };

  return (
    <div>
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

      {/* 2カラム: 左=編集フォーム / 右=リアルタイムプレビュー */}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-4">
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
        {/* 右カラム: プレビュー */}
        <div className="xl:sticky xl:top-2 xl:self-start">
          <InvoicePreview form={form} company={company} />
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

// ── プレビュー（サンプルデータで請求書の見た目をリアルタイム再現） ──
function InvoicePreview({ form, company }: { form: FormatFormValues; company: Company }) {
  const today = new Date();
  const issueDate = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
  const yen = (n: number) => n.toLocaleString("ja-JP");

  // サンプルデータ
  const sample = {
    clientName: "山田 太郎",
    clientAddress: "千葉県千葉市中央区1-2-3",
    clientNumber: "1234567890",
    bankName: "千葉銀行",
    bankBranch: "中央",
    bankAccountType: "普通",
    bankAccountNumber: "1234567",
    bankAccountHolder: "ヤマダ タロウ",
    withdrawalDue: "4月27日",
    totalDue: 12340,
    officeName: "Ｈａｎａヘルパーステーション サンプル",
    unitRows: [
      { name: "身体介護1", count: 244, reps: 30, total: 7320 },
      { name: "生活援助3", count: 220, reps: 5, total: 1100 },
      { name: "処遇改善加算Ⅱ", count: null, reps: 1, total: 454 },
    ],
    amountRows: [
      { name: "利用者負担額", amount: 12340 },
    ],
    miniTable: { medical_deduction: 12340, reduction: 0, mitigation: 0, tax: 0 },
  };

  const SCALE = 0.72;
  return (
    <div className="sticky top-2">
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-sm font-semibold">プレビュー</h3>
        <span className="text-[10px] text-muted-foreground">A4縦・サンプルデータ</span>
      </div>
      {/* A4縦の紙枠（210 × 297mm を 0.72 倍で表示、影付き） */}
      <div className="mx-auto" style={{
        width: `calc(210mm * ${SCALE})`,
        maxWidth: "100%",
      }}>
        <div
          className="bg-white shadow-lg border border-gray-400 relative overflow-hidden mx-auto"
          style={{
            width: `calc(210mm * ${SCALE})`,
            height: `calc(297mm * ${SCALE})`,
          }}
        >
          {/* A4 ラベル（右上） */}
          <span className="absolute top-1 right-1 text-[9px] text-gray-400 z-10 bg-white px-1 border border-gray-300 rounded">A4縦</span>
          <div className="text-[10px] leading-[14px]" style={{ width: "210mm", height: "297mm", transform: `scale(${SCALE})`, transformOrigin: "top left", padding: "4mm", overflow: "hidden" }}>
          {/* ヘッダ */}
          <div className="grid grid-cols-[1fr_auto_1fr] gap-4 items-start mb-2">
            <div>
              <div className="inline-block border border-black px-3 py-0.5 text-lg font-bold">
                {form.invoice_title || "—"}
              </div>
              <div className="mt-3">
                <p>〒 {sample.clientAddress}</p>
                <p className="text-base font-bold mt-0.5">{sample.clientName}　様　<span className="text-[9px] font-normal">({sample.clientNumber})</span></p>
              </div>
            </div>
            <div className="self-center">
              {form.mark_text && (
                <div className="border border-black px-3 py-1 text-[11px] whitespace-nowrap">
                  {form.mark_text}
                </div>
              )}
            </div>
            <div className="text-right text-[10px] leading-[14px]">
              <div className="flex items-start justify-end gap-2 mb-1">
                <span>{issueDate}</span>
                <div className="border border-black px-1 py-0.5 text-[9px] inline-flex flex-col items-start gap-0.5 leading-[12px]">
                  <span>☑介護</span>
                  <span>☐障害</span>
                  <span>☐事業所書式(自費)</span>
                </div>
              </div>
              {/* 法人情報ブロック */}
              <div className="mt-1">
                {company.zipcode && <p>〒{company.zipcode}</p>}
                {company.address && <p>{company.address}</p>}
                {company.formal_name && <p className="font-medium">{company.formal_name}</p>}
                {company.representative && <p>{company.representative}</p>}
                {company.tel && <p>TEL：{company.tel}</p>}
                {company.fax && <p>FAX：{company.fax}</p>}
                {company.registration_number && <p className="text-[9px]">登録番号：{company.registration_number}</p>}
              </div>
            </div>
          </div>

          {/* 挨拶文 + 押印 */}
          <div className="grid grid-cols-[1fr_auto] gap-4 items-start mb-2">
            <p className="text-[10px] whitespace-pre-wrap">
              {form.greeting || "拝啓　毎々格別のお引立に預かり厚く御礼申し上げます。…（挨拶文が未設定）"}
            </p>
            <div className="text-right min-w-[140px]">
              {form.print_seal && company.seal_image_url ? (
                // eslint-disable-next-line @next/next/no-img-element -- print preview / PDF 出力で next/image は不適 (lazy load + optimization が印刷側で動かない)
                <img src={company.seal_image_url} alt="印" className="h-16 w-16 object-contain ml-auto" />
              ) : form.print_seal ? (
                <span className="text-[10px] text-red-600">※押印画像未登録</span>
              ) : (
                <span className="text-[10px]">※押印は省略させていただきます。</span>
              )}
            </div>
          </div>

          {/* 振替情報テーブル */}
          <table className="w-full border-collapse mb-2 text-[10px]">
            <thead>
              <tr>
                <th className="border border-black px-1 py-0.5 bg-muted/20 w-20">振替日</th>
                {form.show_bank_name && <th className="border border-black px-1 py-0.5 bg-muted/20 w-24">金融機関</th>}
                {form.show_bank_name && <th className="border border-black px-1 py-0.5 bg-muted/20 w-16">支店名</th>}
                {form.show_bank_account_number && <th className="border border-black px-1 py-0.5 bg-muted/20">種目・口座番号</th>}
                {form.show_bank_account_holder && <th className="border border-black px-1 py-0.5 bg-muted/20">口座名義人</th>}
                {form.show_withdrawal_amount && <th className="border border-black px-1 py-0.5 bg-muted/20 w-28">お引落予定金額</th>}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="border border-black px-1 py-1 text-center">{sample.withdrawalDue}</td>
                {form.show_bank_name && <td className="border border-black px-1 py-1 text-center">{sample.bankName}</td>}
                {form.show_bank_name && <td className="border border-black px-1 py-1 text-center">{sample.bankBranch}</td>}
                {form.show_bank_account_number && <td className="border border-black px-1 py-1 text-center">{sample.bankAccountType} {sample.bankAccountNumber}</td>}
                {form.show_bank_account_holder && <td className="border border-black px-1 py-1 text-center">{sample.bankAccountHolder}</td>}
                {form.show_withdrawal_amount && <td className="border border-black px-1 py-1 text-right font-bold">￥{yen(sample.totalDue)}</td>}
              </tr>
            </tbody>
          </table>

          {/* 引落金額内訳 + 過誤注記 */}
          <table className="w-full border-collapse mb-3 text-[10px]">
            <tbody>
              <tr>
                <td className="border border-black align-top w-1/2 p-1">
                  <p className="font-medium mb-1">引落金額内訳</p>
                  <p>{sample.clientName}様　{sample.officeName}　3月利用【介護】　{yen(sample.totalDue)}円</p>
                </td>
                <td className="border border-black align-top w-1/2 p-1 text-red-700">
                  {form.overbilling_text && <p>{form.overbilling_text}</p>}
                  {form.underbilling_text && <p>{form.underbilling_text}</p>}
                  {form.offset_remaining_text && <p>{form.offset_remaining_text}</p>}
                  {!form.overbilling_text && !form.underbilling_text && !form.offset_remaining_text && (
                    <span className="text-muted-foreground/60 text-[9px]">（過誤・相殺文言が設定されるとここに表示）</span>
                  )}
                </td>
              </tr>
            </tbody>
          </table>

          {/* セクション（事業所×区分） */}
          <section className="mb-3">
            {form.inquiry_tel && (
              <p className="bg-yellow-200/70 text-[10px] px-1 font-medium">お問い合わせ先 {form.inquiry_tel}</p>
            )}
            <p className="text-[10px] mb-1 mt-0.5">
              <span className="font-semibold">{sample.officeName}</span>
              <span className="mx-1 text-red-700">{company.formal_name ?? ""}</span>
              【ご利用内訳　{sample.clientName}様　期間：3月1日〜3月31日】
            </p>

            <table className="w-full border-collapse text-[10px] mb-1">
              <thead>
                <tr>
                  <th className="border border-black px-1 py-0.5 text-left">内訳</th>
                  <th className="border border-black px-1 py-0.5 text-left w-28">備考</th>
                  <th className="border border-black px-1 py-0.5 text-center w-10">控除</th>
                  <th className="border border-black px-1 py-0.5 text-right w-16">単位数</th>
                  <th className="border border-black px-1 py-0.5 text-right w-12">回数</th>
                  <th className="border border-black px-1 py-0.5 text-right w-20">単位</th>
                </tr>
              </thead>
              <tbody>
                {sample.unitRows.map((u, i) => (
                  <tr key={i}>
                    <td className="border border-black px-1 py-0.5">{u.name}</td>
                    <td className="border border-black px-1 py-0.5"></td>
                    <td className="border border-black px-1 py-0.5 text-center">＊</td>
                    <td className="border border-black px-1 py-0.5 text-right">{u.count != null ? yen(u.count) : ""}</td>
                    <td className="border border-black px-1 py-0.5 text-right">{u.reps}</td>
                    <td className="border border-black px-1 py-0.5 text-right">{yen(u.total)}単位</td>
                  </tr>
                ))}
                <tr>
                  <td className="border border-black px-1 py-0.5" colSpan={3}></td>
                  <td className="border border-black px-1 py-0.5 text-right font-medium">合計単位数</td>
                  <td className="border border-black px-1 py-0.5"></td>
                  <td className="border border-black px-1 py-0.5 text-right">{yen(sample.unitRows.reduce((s, u) => s + u.total, 0))}単位</td>
                </tr>
              </tbody>
            </table>

            {/* 金額 */}
            <table className="w-full border-collapse text-[10px] mb-1">
              <thead>
                <tr>
                  <th className="border border-black px-1 py-0.5 text-left">内訳</th>
                  <th className="border border-black px-1 py-0.5 text-left w-28">備考</th>
                  <th className="border border-black px-1 py-0.5 text-center w-10">控除</th>
                  <th className="border border-black px-1 py-0.5 text-right w-16">単価</th>
                  <th className="border border-black px-1 py-0.5 text-right w-16">時間</th>
                  <th className="border border-black px-1 py-0.5 text-right w-12">回数</th>
                  <th className="border border-black px-1 py-0.5 text-right w-20">金額</th>
                </tr>
              </thead>
              <tbody>
                {sample.amountRows.map((a, i) => (
                  <tr key={i}>
                    <td className="border border-black px-1 py-0.5">{a.name}</td>
                    <td className="border border-black px-1 py-0.5"></td>
                    <td className="border border-black px-1 py-0.5 text-center">＊</td>
                    <td className="border border-black px-1 py-0.5"></td>
                    <td className="border border-black px-1 py-0.5"></td>
                    <td className="border border-black px-1 py-0.5"></td>
                    <td className="border border-black px-1 py-0.5 text-right">{yen(a.amount)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="border border-black px-1 py-0.5 font-medium">利用者負担　本人</td>
                  <td className="border border-black px-1 py-0.5"></td>
                  <td className="border border-black px-1 py-0.5"></td>
                  <td className="border border-black px-1 py-0.5"></td>
                  <td className="border border-black px-1 py-0.5"></td>
                  <td className="border border-black px-1 py-0.5 text-right font-medium">利用者負担額</td>
                  <td className="border border-black px-1 py-0.5 text-right font-bold">¥{yen(sample.miniTable.medical_deduction)}</td>
                </tr>
              </tbody>
            </table>

            {/* ミニ表 */}
            <div className="flex gap-2 mt-1 mb-1">
              {form.show_medical_deduction && <MiniPreviewBox label="医療費控除対象額" value={sample.miniTable.medical_deduction} />}
              {form.show_reduction && <MiniPreviewBox label="減免額" value={sample.miniTable.reduction} />}
              {form.show_mitigation && <MiniPreviewBox label="軽減額" value={sample.miniTable.mitigation} />}
              {form.show_tax && <MiniPreviewBox label="消費税→内消費税" value={sample.miniTable.tax} />}
            </div>
          </section>

          {/* カレンダー（A4枠内に収めるためコンパクト化） */}
          {form.show_calendar && (
            <div className="mt-2">
              <p className="text-[10px] text-blue-700 text-center mb-0.5">カレンダーの表示</p>
              <div className="grid grid-cols-3 gap-2">
                <div className="border-[3px] border-orange-500 rounded p-1.5">
                  <p className="text-center text-[10px] font-semibold">{sample.officeName}</p>
                  <p className="text-center text-[10px] mb-1">ご利用日</p>
                  <div className="grid grid-cols-7 gap-0.5 text-center text-[9px]">
                    {["日", "月", "火", "水", "木", "金", "土"].map((d) => (
                      <div key={d} className="font-medium">{d}</div>
                    ))}
                    {Array.from({ length: 31 }).map((_, i) => (
                      <div key={i} className={i % 5 === 0 ? "font-bold border border-black rounded-full" : ""}>{i + 1}</div>
                    ))}
                  </div>
                  <p className="text-center text-[9px] text-orange-700 mt-1">介護</p>
                </div>
                <div className="text-muted-foreground/40 text-center text-[9px] self-center">障害セクション</div>
                <div className="text-muted-foreground/40 text-center text-[9px] self-center">自費セクション</div>
              </div>
            </div>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniPreviewBox({ label, value }: { label: string; value: number }) {
  const yen = (n: number) => n.toLocaleString("ja-JP");
  return (
    <div className="border border-black px-2 py-0.5">
      <p className="text-[9px] text-center">{label}</p>
      <p className="text-right text-[10px]">¥{yen(value)}</p>
    </div>
  );
}
