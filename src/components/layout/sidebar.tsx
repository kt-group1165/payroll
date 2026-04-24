"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; icon: string };

/**
 * サイドバーはセクション分けされており、将来セクションごと切り離し・停止しやすい。
 * 請求管理セクションは給与計算とは独立。
 */
const sections: { title: string; items: NavItem[] }[] = [
  {
    title: "全般",
    items: [
      { href: "/", label: "ダッシュボード", icon: "📊" },
      { href: "/csv-import", label: "CSV取り込み", icon: "📁" },
    ],
  },
  {
    title: "マスタ",
    items: [
      { href: "/companies", label: "法人一覧", icon: "🏛️" },
      { href: "/offices",   label: "事業所一覧", icon: "🏢" },
      { href: "/employees", label: "職員一覧",   icon: "👥" },
      { href: "/clients",   label: "利用者一覧", icon: "📋" },
      { href: "/services",  label: "サービスマスタ", icon: "📑" },
    ],
  },
  {
    title: "給与計算",
    items: [
      { href: "/attendance",      label: "労働時間管理", icon: "🕐" },
      { href: "/salary",          label: "給与設定",     icon: "⚙️" },
      { href: "/distance",        label: "移動距離計算", icon: "🗺️" },
      { href: "/payroll",         label: "給与計算",     icon: "💰" },
      { href: "/payroll-summary", label: "総括表",       icon: "📊" },
    ],
  },
  {
    title: "請求管理",
    items: [
      { href: "/billing",         label: "請求管理",       icon: "🧾" },
      { href: "/billing/import",  label: "請求CSV取り込み", icon: "📁" },
      { href: "/billing/formats", label: "請求書様式管理",   icon: "📝" },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();

  // /billing と /billing/import のように href が前方一致する場合、
  // 最も長く一致した1つだけをアクティブにする（親menuが一緒に点灯しないように）
  const allHrefs = sections.flatMap((s) => s.items.map((i) => i.href));
  const activeHref = (() => {
    const matches = allHrefs.filter((h) =>
      h === "/" ? pathname === "/" : pathname === h || pathname.startsWith(h + "/")
    );
    if (matches.length === 0) return null;
    return matches.reduce((best, h) => (h.length > best.length ? h : best));
  })();

  return (
    <aside className="w-60 border-r bg-muted/30 flex flex-col">
      <div className="p-4 border-b">
        <h1 className="text-lg font-bold">
          給与計算システム
          <span className="text-xs font-normal text-muted-foreground ml-1">V68</span>
        </h1>
      </div>
      <nav className="flex-1 p-2 overflow-y-auto">
        {sections.map((sec) => (
          <div key={sec.title} className="mb-3">
            <p className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              {sec.title}
            </p>
            {sec.items.map((item) => {
              const isActive = activeHref === item.href;
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
          </div>
        ))}
      </nav>
    </aside>
  );
}
