"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { Office } from "@/types/database";

export default function OfficeDashboardPage() {
  const params = useParams<{ officeNumber: string }>();
  const officeNumber = params.officeNumber;
  const [office, setOffice] = useState<Office | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    supabase
      .from("payroll_offices")
      .select("*")
      .eq("office_number", officeNumber)
      .maybeSingle()
      .then(({ data }) => {
        if (!data) setNotFound(true);
        else setOffice(data as Office);
      });
  }, [officeNumber]);

  if (notFound) {
    return (
      <div>
        <h2 className="text-2xl font-bold mb-2">事業所が見つかりません</h2>
        <p className="text-sm text-muted-foreground">
          事業所番号「{officeNumber}」は登録されていません。URLをご確認ください。
        </p>
      </div>
    );
  }

  const officeName = office ? (office.short_name || office.name) : "読み込み中...";

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold">{officeName}</h2>
        <p className="text-sm text-muted-foreground mt-1">事業所番号: {officeNumber}</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-xl">
        <Link
          href={`/office/${officeNumber}/employees`}
          className="border rounded-md p-6 hover:bg-muted/40 transition-colors"
        >
          <div className="text-3xl mb-2">👥</div>
          <div className="font-bold">職員一覧</div>
          <p className="text-sm text-muted-foreground mt-1">
            この事業所の職員の閲覧・登録・編集
          </p>
        </Link>
        <Link
          href={`/office/${officeNumber}/clients`}
          className="border rounded-md p-6 hover:bg-muted/40 transition-colors"
        >
          <div className="text-3xl mb-2">📋</div>
          <div className="font-bold">利用者一覧</div>
          <p className="text-sm text-muted-foreground mt-1">
            この事業所の利用者の閲覧・登録・編集
          </p>
        </Link>
      </div>
    </div>
  );
}
