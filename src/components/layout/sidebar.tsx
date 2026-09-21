"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useSyncExternalStore } from "react";
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
      { href: "/csv-import", label: "実績データ取り込み", icon: "📁" },
      { href: "/csv-import/batch", label: "一括取込 (フォルダ)", icon: "📂" },
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
      { href: "/attendance",            label: "労働時間管理", icon: "🕐" },
      { href: "/kyotaku-attendance",    label: "出勤簿",       icon: "📅" },
      { href: "/kyotaku-labor-check",   label: "居宅労働時間チェック", icon: "🩺" },
      { href: "/office-input",          label: "事業所書式入力", icon: "🏤" },
      { href: "/monthly-inputs",        label: "月ごとの手入力", icon: "✏️" },
      { href: "/salary",                label: "給与設定",     icon: "⚙️" },
      { href: "/distance",            label: "移動距離計算", icon: "🗺️" },
      { href: "/payroll",             label: "給与計算",     icon: "💰" },
      { href: "/payroll-summary",     label: "総括表",       icon: "📊" },
    ],
  },
  {
    title: "請求管理",
    items: [
      { href: "/billing",                label: "請求管理",         icon: "🧾" },
      { href: "/billing/import",         label: "請求CSV取り込み",   icon: "📁" },
      { href: "/billing/withdrawals",    label: "引落結果取り込み",   icon: "💴" },
      { href: "/billing/reconciliation", label: "突合・月次サマリ",   icon: "📊" },
      { href: "/billing/formats",        label: "請求書様式管理",     icon: "📝" },
    ],
  },
  {
    title: "設定",
    items: [
      { href: "/settings/company-holidays", label: "会社休日", icon: "🎌" },
    ],
  },
];

/** 畳んだセクションの記憶先。読めなくても動くので try/catch で握る (プライベートウィンドウ等) */
const STORAGE_KEY = "kt-payroll-sidebar-collapsed";
/** 同じタブ内の変更を拾うための自前イベント (storage イベントは他タブにしか飛ばない) */
const CHANGED = "kt-payroll-sidebar-changed";

const subscribe = (onChange: () => void) => {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGED, onChange);
  };
};
/** スナップショットは「生の文字列」。毎回 parse すると参照が変わって無限再描画になる */
const readRaw = () => { try { return localStorage.getItem(STORAGE_KEY) ?? ""; } catch { return ""; } };
const readRawServer = () => "";

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

  const activeSection = sections.find((s) => s.items.some((i) => i.href === activeHref))?.title ?? null;

  // SSR では「全部開いた状態」。ハイドレーション後に localStorage の記憶へ切り替わる
  const raw = useSyncExternalStore(subscribe, readRaw, readRawServer);
  const collapsed = useMemo<string[]>(() => {
    if (!raw) return [];
    try { const v = JSON.parse(raw); return Array.isArray(v) ? (v as string[]) : []; } catch { return []; }
  }, [raw]);

  const toggle = (title: string) => {
    const next = collapsed.includes(title) ? collapsed.filter((t) => t !== title) : [...collapsed, title];
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* 保存できなくても動く */ }
    window.dispatchEvent(new Event(CHANGED));
  };

  return (
    <aside className="w-60 border-r bg-muted/30 flex flex-col">
      <div className="p-4 border-b">
        <h1 className="text-lg font-bold">
          給与計算システム
          <span className="text-xs font-normal text-muted-foreground ml-1">V82</span>
        </h1>
      </div>
      <nav className="flex-1 p-2 overflow-y-auto">
        {sections.map((sec) => {
          // ⚠ 「今いるページのセクションは常に開く」にはしない。
          //   今いるページのセクションこそ畳みたい (2026-09-21 user)
          const isOpen = !collapsed.includes(sec.title);
          const hasActive = sec.title === activeSection;
          return (
            <div key={sec.title} className="mb-3">
              <button
                type="button"
                onClick={() => toggle(sec.title)}
                aria-expanded={isOpen}
                className="w-full flex items-center gap-1 px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
              >
                <span className={cn("transition-transform", isOpen ? "rotate-90" : "")}>▸</span>
                <span>{sec.title}</span>
                {!isOpen && (
                  <span className="ml-auto normal-case tracking-normal">
                    {hasActive ? "●" : sec.items.length}
                  </span>
                )}
              </button>
              {isOpen && sec.items.map((item) => {
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
          );
        })}
      </nav>
    </aside>
  );
}
