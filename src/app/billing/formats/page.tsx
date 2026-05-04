"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { supabase } from "@/lib/supabase";
import { sortCompanies } from "@/lib/sort-companies";
import type { Company, CompanyInvoiceFormat } from "@/types/database";

/**
 * /billing/formats
 * 法人ごとの請求書様式(フォーマット) の一覧。クリックすると編集画面へ。
 */
export default function InvoiceFormatsPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [formats, setFormats] = useState<CompanyInvoiceFormat[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const [coRes, fmtRes] = await Promise.all([
      supabase.from("payroll_companies").select("*").order("name"),
      supabase.from("payroll_company_invoice_formats").select("*"),
    ]);
    if (coRes.data) setCompanies(sortCompanies(coRes.data as Company[]));
    if (fmtRes.data) setFormats(fmtRes.data as CompanyInvoiceFormat[]);
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const formatByCompany = new Map(formats.map((f) => [f.company_id, f]));

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 className="text-2xl font-bold">請求書様式管理</h2>
      </div>

      <p className="text-sm text-muted-foreground mb-3">
        法人ごとに請求書のタイトル・挨拶文・振替情報の表示項目・ミニ表・カレンダー・押印などを設定できます。<br />
        設定が未登録の場合はデフォルト値で描画されます。
      </p>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>法人名</TableHead>
            <TableHead>正式名称</TableHead>
            <TableHead>タイトル</TableHead>
            <TableHead>設定</TableHead>
            <TableHead className="w-[120px]">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-4">読み込み中…</TableCell></TableRow>
          ) : companies.length === 0 ? (
            <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-4">法人が登録されていません</TableCell></TableRow>
          ) : (
            companies.map((co) => {
              const fmt = formatByCompany.get(co.id);
              return (
                <TableRow key={co.id}>
                  <TableCell className="font-medium">{co.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{co.formal_name || "—"}</TableCell>
                  <TableCell className="text-sm">{fmt?.invoice_title ?? <span className="text-muted-foreground/60">（デフォルト）</span>}</TableCell>
                  <TableCell className="text-xs">
                    {fmt ? (
                      <span className="inline-flex gap-2 flex-wrap">
                        {fmt.print_seal && <span className="bg-green-100 text-green-800 rounded px-1.5 py-0.5">押印</span>}
                        {fmt.show_calendar && <span className="bg-blue-100 text-blue-800 rounded px-1.5 py-0.5">カレンダー</span>}
                        {!fmt.show_bank_name && <span className="bg-gray-200 text-gray-700 rounded px-1.5 py-0.5">金融機関非表示</span>}
                        {!fmt.show_reduction && <span className="bg-gray-200 text-gray-700 rounded px-1.5 py-0.5">減免非表示</span>}
                        {!fmt.show_mitigation && <span className="bg-gray-200 text-gray-700 rounded px-1.5 py-0.5">軽減非表示</span>}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/60">未設定</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Link href={`/billing/formats/${co.id}`}>
                      <Button variant="outline" size="sm">編集</Button>
                    </Link>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
