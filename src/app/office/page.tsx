"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { Office } from "@/types/database";
import { Input } from "@/components/ui/input";

export default function OfficeIndexPage() {
  const [offices, setOffices] = useState<Office[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    supabase.from("payroll_offices").select("*").order("office_number").then(({ data }) => {
      if (data) setOffices(data as Office[]);
    });
  }, []);

  const q = search.trim().toLowerCase();
  const filtered = offices.filter((o) =>
    !q ||
    o.office_number.toLowerCase().includes(q) ||
    o.name.toLowerCase().includes(q) ||
    (o.short_name?.toLowerCase().includes(q) ?? false)
  );

  return (
    <div>
      <h2 className="text-2xl font-bold mb-2">事業所管理</h2>
      <p className="text-sm text-muted-foreground mb-4">
        事業所を選択してください。各事業所のURLは個別に共有できます。
      </p>
      <Input
        placeholder="事業所番号 or 名前で検索"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="mb-4 max-w-md"
      />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.map((o) => (
          <Link
            key={o.id}
            href={`/office/${o.office_number}`}
            className="border rounded-md p-4 hover:bg-muted/40 transition-colors"
          >
            <div className="font-medium">{o.short_name || o.name}</div>
            <div className="text-xs text-muted-foreground mt-1 font-mono">{o.office_number}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{o.office_type}</div>
          </Link>
        ))}
        {filtered.length === 0 && (
          <p className="text-sm text-muted-foreground col-span-full">該当する事業所がありません</p>
        )}
      </div>
    </div>
  );
}
