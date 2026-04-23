"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/office/employees", label: "職員一覧", icon: "👥" },
  { href: "/office/clients", label: "利用者一覧", icon: "📋" },
];

export function OfficeSidebar() {
  const pathname = usePathname();
  return (
    <aside className="w-60 border-r bg-muted/30 flex flex-col">
      <div className="p-4 border-b">
        <h1 className="text-lg font-bold">
          事業所管理
          <span className="text-xs font-normal text-muted-foreground ml-1">V39</span>
        </h1>
      </div>
      <nav className="flex-1 p-2">
        {navItems.map((item) => {
          const isActive = pathname.startsWith(item.href);
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
