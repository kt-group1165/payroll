"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/layout/sidebar";
import { OfficeSidebar } from "@/components/layout/office-sidebar";

/**
 * ルートのレイアウト。URLに応じてサイドバーを出し分ける。
 *   /office と /office/** → 事業所向け簡易メニュー
 *   それ以外              → 管理用フルメニュー
 *
 * ⚠ startsWith("/office") だと /office-input と /office-worker-care まで
 *   事業所向けメニューになり、★ 管理メニューに戻る導線が無くなる (2026-09-28 user 報告)。
 *   /office ちょうど か /office/ で始まるときだけにする。
 */
export function RootShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isOfficeView = pathname === "/office" || pathname.startsWith("/office/");
  return (
    <>
      {isOfficeView ? <OfficeSidebar /> : <Sidebar />}
      <main className="flex-1 overflow-auto">
        <div className="p-6">{children}</div>
      </main>
    </>
  );
}
