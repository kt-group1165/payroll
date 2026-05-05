"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import { OFFICE_MASTER_JOIN, flattenOfficeMaster } from "@/types/database";

export function OfficeSidebar() {
  const pathname = usePathname();
  // URL から事業所番号を抽出（/office/[officeNumber]/... or /office/[officeNumber]）
  const m = pathname?.match(/^\/office\/([^/]+)(?:\/.*)?$/);
  const officeNumber = m?.[1] ?? null;

  const [officeName, setOfficeName] = useState<string>("");

  useEffect(() => {
    if (!officeNumber) {
      setOfficeName("");
      return;
    }
    supabase
      .from("payroll_offices")
      .select(`short_name, ${OFFICE_MASTER_JOIN}`)
      .eq("office_number", officeNumber)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          const flat = flattenOfficeMaster([data as never])[0] as unknown as { short_name: string; name: string };
          setOfficeName(flat.short_name || flat.name);
        }
      });
  }, [officeNumber]);

  // 事業所スコープがあるかどうかで navItems を切り替え
  const navItems = officeNumber
    ? [
        { href: `/office/${officeNumber}`, label: "ダッシュボード", icon: "🏠" },
        { href: `/office/${officeNumber}/employees`, label: "職員一覧", icon: "👥" },
        { href: `/office/${officeNumber}/clients`, label: "利用者一覧", icon: "📋" },
      ]
    : [{ href: "/office", label: "事業所選択", icon: "🏢" }];

  return (
    <aside className="w-60 border-r bg-muted/30 flex flex-col">
      <div className="p-4 border-b">
        <h1 className="text-lg font-bold">
          事業所管理
          <span className="text-xs font-normal text-muted-foreground ml-1">V40</span>
        </h1>
        {officeName && (
          <p className="text-xs text-muted-foreground mt-1 truncate" title={officeName}>
            {officeName}
          </p>
        )}
      </div>
      <nav className="flex-1 p-2">
        {navItems.map((item) => {
          // ダッシュボードは完全一致、それ以外はstartsWith
          const isActive =
            item.href === `/office/${officeNumber}` || item.href === "/office"
              ? pathname === item.href
              : pathname?.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
                isActive ? "bg-primary text-primary-foreground" : "hover:bg-muted"
              )}
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
