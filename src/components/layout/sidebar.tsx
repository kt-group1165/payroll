"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "ダッシュボード", icon: "📊" },
  { href: "/csv-import", label: "CSV取り込み", icon: "📁" },
  { href: "/attendance", label: "労働時間管理", icon: "🕐" },
  { href: "/employees", label: "職員一覧", icon: "👥" },
  { href: "/salary", label: "給与設定", icon: "⚙️" },
  { href: "/distance", label: "移動距離計算", icon: "🗺️" },
  { href: "/companies", label: "法人一覧", icon: "🏛️" },
  { href: "/offices", label: "事業所一覧", icon: "🏢" },
  { href: "/clients", label: "利用者一覧", icon: "📋" },
  { href: "/services", label: "サービスマスタ", icon: "📑" },
  { href: "/payroll", label: "給与計算", icon: "💰" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-60 border-r bg-muted/30 flex flex-col">
      <div className="p-4 border-b">
        <h1 className="text-lg font-bold">給与計算システム <span className="text-xs font-normal text-muted-foreground">V24</span></h1>
      </div>
      <nav className="flex-1 p-2">
        {navItems.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-muted"
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
