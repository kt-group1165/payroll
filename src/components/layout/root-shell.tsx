"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/layout/sidebar";
import { OfficeSidebar } from "@/components/layout/office-sidebar";

/**
 * ルートのレイアウト。URLに応じてサイドバーを出し分ける。
 *   /office/** → 事業所向け簡易メニュー
 *   それ以外   → 管理用フルメニュー
 */
export function RootShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isOfficeView = pathname.startsWith("/office");
  return (
    <>
      {isOfficeView ? <OfficeSidebar /> : <Sidebar />}
      <main className="flex-1 overflow-auto">
        <div className="p-6">{children}</div>
      </main>
    </>
  );
}
