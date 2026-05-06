import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Company, CompanyInvoiceFormat } from "@/types/database";
import { COMPANY_MASTER_JOIN, flattenCompanyMaster } from "@/types/database";
import { FormatEditor, type FormatFormValues } from "./format-editor";

/**
 * 法人ごとの請求書フォーマット設定画面
 * /billing/formats/[companyId]
 *
 * Server Component: company / format を await 取得して、編集フォームは
 * `<FormatEditor>` (client component) に渡す。
 *
 * DB: company_invoice_formats (1法人につき1レコード、なければ作成)
 */

const defaultForm: FormatFormValues = {
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

export default async function InvoiceFormatPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [coRes, fmtRes] = await Promise.all([
    supabase.from("payroll_companies").select(`*, ${COMPANY_MASTER_JOIN}`).eq("id", companyId).single(),
    supabase.from("payroll_company_invoice_formats").select("*").eq("company_id", companyId).maybeSingle(),
  ]);

  const company: Company | null = coRes.data
    ? (flattenCompanyMaster([coRes.data as never])[0] as unknown as Company)
    : null;
  if (!company) notFound();

  const fmt = fmtRes.data as CompanyInvoiceFormat | null;
  let initialFormatId: string | null = null;
  let initialForm: FormatFormValues = { ...defaultForm };

  if (fmt) {
    initialFormatId = fmt.id;
    initialForm = {
      invoice_title: fmt.invoice_title ?? defaultForm.invoice_title,
      mark_text: fmt.mark_text ?? defaultForm.mark_text,
      greeting: fmt.greeting ?? "",
      show_bank_account_number: fmt.show_bank_account_number ?? true,
      show_bank_account_holder: fmt.show_bank_account_holder ?? true,
      show_bank_name: fmt.show_bank_name ?? true,
      show_withdrawal_amount: fmt.show_withdrawal_amount ?? true,
      show_reduction: fmt.show_reduction ?? true,
      show_mitigation: fmt.show_mitigation ?? true,
      show_medical_deduction: fmt.show_medical_deduction ?? true,
      show_tax: fmt.show_tax ?? true,
      show_calendar: fmt.show_calendar ?? true,
      print_seal: fmt.print_seal ?? false,
      overbilling_text: fmt.overbilling_text ?? "",
      underbilling_text: fmt.underbilling_text ?? "",
      offset_remaining_text: fmt.offset_remaining_text ?? "",
      inquiry_tel: fmt.inquiry_tel ?? "",
      note: fmt.note ?? "",
    };
  } else {
    // まだ存在しない場合は companies の既存値を初期値に流し込む
    initialForm = {
      ...initialForm,
      greeting: company.invoice_greeting ?? "",
      inquiry_tel: company.inquiry_tel ?? "",
    };
  }

  return (
    <FormatEditor
      companyId={companyId}
      company={company}
      initialFormatId={initialFormatId}
      initialForm={initialForm}
    />
  );
}
