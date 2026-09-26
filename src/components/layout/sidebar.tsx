"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";

/**
 * メニューの表示モード (2026-09-26 user)。
 *   "payroll" 給与モード … 給与に関わるものだけ出す
 *   "billing" 請求モード … 請求に関わるものだけ出す
 * ★ NavItem の `mode` を省いた項目は **どちらのモードでも出る** (両方に関わるもの)。
 *   分類を変えたいときは その項目の mode を足す / 消すだけでよい。
 */
type Mode = "payroll" | "billing";

type NavItem = { href: string; label: string; icon: string; mode?: Mode };

/**
 * サイドバーはセクション分けされており、将来セクションごと切り離し・停止しやすい。
 * 請求管理セクションは給与計算とは独立。
 */
const sections: { title: string; items: NavItem[] }[] = [
  {
    title: "全般",
    items: [
      // ダッシュボードと実績の取り込みは 給与・請求 どちらの入口にもなるので mode を付けない
      { href: "/", label: "ダッシュボード", icon: "📊" },
      { href: "/csv-import", label: "実績データ取り込み", icon: "📁" },
      { href: "/csv-import/batch", label: "一括取込 (フォルダ)", icon: "📂" },
    ],
  },
  {
    title: "マスタ",
    items: [
      // マスタはどちらからも参照するので 原則 mode を付けない
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
      { href: "/service-records",       label: "サービス記録一覧", icon: "📝", mode: "payroll" },
      { href: "/attendance",            label: "労働時間管理", icon: "🕐", mode: "payroll" },
      { href: "/kyotaku-attendance",    label: "出勤簿",       icon: "📅", mode: "payroll" },
      { href: "/kyotaku-labor-check",   label: "居宅労働時間チェック", icon: "🩺", mode: "payroll" },
      { href: "/office-input",          label: "事業所書式入力", icon: "🏤", mode: "payroll" },
      { href: "/monthly-inputs",        label: "月ごとの手入力", icon: "✏️", mode: "payroll" },
      { href: "/bonus-payments",        label: "報奨金の支給", icon: "🎁", mode: "payroll" },
      { href: "/office-worker-care",    label: "事務員の訪問分", icon: "🧾", mode: "payroll" },
      { href: "/salary",                label: "給与設定",     icon: "⚙️", mode: "payroll" },
      { href: "/distance",            label: "移動距離計算", icon: "🗺️", mode: "payroll" },
      { href: "/payroll",             label: "給与計算",     icon: "💰", mode: "payroll" },
      { href: "/payroll-summary",     label: "総括表",       icon: "📊", mode: "payroll" },
      { href: "/verification",        label: "総括表との検証", icon: "🔍", mode: "payroll" },
    ],
  },
  {
    title: "請求管理",
    items: [
      { href: "/billing",                label: "請求管理",         icon: "🧾", mode: "billing" },
      { href: "/billing/import",         label: "請求CSV取り込み",   icon: "📁", mode: "billing" },
      { href: "/billing/withdrawals",    label: "引落結果取り込み",   icon: "💴", mode: "billing" },
      { href: "/billing/reconciliation", label: "突合・月次サマリ",   icon: "📊", mode: "billing" },
      { href: "/billing/formats",        label: "請求書様式管理",     icon: "📝", mode: "billing" },
    ],
  },
  {
    title: "設定",
    items: [
      // 会社休日は 給与 (法定休日・割増) に効く。請求には効かない
      { href: "/settings/company-holidays", label: "会社休日", icon: "🎌", mode: "payroll" },
    ],
  },
];

/** 畳んだセクションの記憶先。読めなくても動くので try/catch で握る (プライベートウィンドウ等) */
const STORAGE_KEY = "kt-payroll-sidebar-collapsed";
/** サイドバー全体を畳んだかどうか。表が横に切れるので全部隠せるようにした (2026-09-21 user) */
const WIDE_KEY = "kt-payroll-sidebar-mini";
/** 給与モード / 請求モード (2026-09-26 user) */
const MODE_KEY = "kt-payroll-sidebar-mode";
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
const readRaw = () => {
  try {
    return `${localStorage.getItem(STORAGE_KEY) ?? ""} ${localStorage.getItem(WIDE_KEY) ?? ""} ${localStorage.getItem(MODE_KEY) ?? ""}`;
  } catch { return "  "; }
};
const readRawServer = () => "  ";

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
  const [collapsedRaw, miniRaw, modeRaw] = raw.split(" ");
  const collapsed = useMemo<string[]>(() => {
    if (!collapsedRaw) return [];
    try { const v = JSON.parse(collapsedRaw); return Array.isArray(v) ? (v as string[]) : []; } catch { return []; }
  }, [collapsedRaw]);
  const mini = miniRaw === "1";
  // 記憶が無いときは給与モード (これまでの見え方に近いほう)
  const mode: Mode = modeRaw === "billing" ? "billing" : "payroll";

  const write = (key: string, value: string) => {
    try { localStorage.setItem(key, value); } catch { /* 保存できなくても動く */ }
    window.dispatchEvent(new Event(CHANGED));
  };
  const toggle = (title: string) => {
    const next = collapsed.includes(title) ? collapsed.filter((t) => t !== title) : [...collapsed, title];
    write(STORAGE_KEY, JSON.stringify(next));
  };

  /**
   * そのモードで出す項目か。
   * ★ mode を付けていない項目は 両方に関わるので どちらでも出す。
   * ⚠ **いま開いているページは モードが違っても必ず出す。**
   *   消えると「今どこに居るのか」が分からなくなり、戻る手段も無くなる。
   */
  const visible = (item: NavItem) => !item.mode || item.mode === mode || item.href === activeHref;

  const shownSections = sections
    .map((sec) => ({ ...sec, items: sec.items.filter(visible) }))
    .filter((sec) => sec.items.length > 0);   // 全部隠れたセクションは見出しごと出さない

  const modeBtn = (m: Mode, label: string, icon: string) => (
    <button
      type="button"
      onClick={() => write(MODE_KEY, m)}
      aria-pressed={mode === m}
      // アクセシビリティツリーに名前が出ていなかったので明示する (中身が emoji + span のため)
      aria-label={`${label}モードに切り替え`}
      title={`${label}モードに切り替え`}
      className={cn(
        "flex items-center justify-center gap-1 rounded-md border text-xs py-1 transition-colors",
        mini ? "w-full px-0" : "flex-1 px-2",
        mode === m ? "bg-primary text-primary-foreground border-primary font-medium" : "bg-background hover:bg-muted text-muted-foreground"
      )}
    >
      <span>{icon}</span>
      {!mini && <span>{label}</span>}
    </button>
  );

  return (
    <aside className={cn("border-r bg-muted/30 flex flex-col transition-[width]", mini ? "w-14" : "w-60")}>
      <div className={cn("border-b", mini ? "p-2" : "p-4")}>
        <div className={cn("flex items-center gap-1", mini && "justify-center")}>
          {!mini && (
            <h1 className="text-lg font-bold flex-1 min-w-0 truncate">
              給与計算システム
              <span className="text-xs font-normal text-muted-foreground ml-1">V82</span>
            </h1>
          )}
          <button
            type="button"
            onClick={() => write(WIDE_KEY, mini ? "0" : "1")}
            title={mini ? "サイドバーを開く" : "サイドバーを畳む"}
            aria-label={mini ? "サイドバーを開く" : "サイドバーを畳む"}
            className="shrink-0 rounded-md border px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            {mini ? "»" : "«"}
          </button>
        </div>
        {/* 給与 / 請求 の切り替え。押したモードに関わるメニューだけ出す (2026-09-26 user) */}
        <div className={cn("flex gap-1", mini ? "flex-col mt-2" : "mt-3")}>
          {modeBtn("payroll", "給与", "💰")}
          {modeBtn("billing", "請求", "🧾")}
        </div>
      </div>
      <nav className={cn("flex-1 overflow-y-auto", mini ? "p-1" : "p-2")}>
        {shownSections.map((sec) => {
          // ⚠ 「今いるページのセクションは常に開く」にはしない。
          //   今いるページのセクションこそ畳みたい (2026-09-21 user)
          const isOpen = !collapsed.includes(sec.title);
          const hasActive = sec.title === activeSection;
          return (
            <div key={sec.title} className="mb-3">
              {/* 見出し自体がボタン。押せると分かるように枠と hover を付けてある (2026-09-21 user) */}
              {!mini && (
                <button
                  type="button"
                  onClick={() => toggle(sec.title)}
                  aria-expanded={isOpen}
                  title={isOpen ? `${sec.title} を畳む` : `${sec.title} を開く`}
                  className="w-full flex items-center gap-1.5 px-2 py-1.5 mb-0.5 rounded-md text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                >
                  <span className="text-[10px] leading-none w-3">{isOpen ? "▼" : "▶"}</span>
                  <span>{sec.title}</span>
                  <span className="ml-auto text-[10px] tabular-nums">
                    {isOpen ? "" : hasActive ? "●" : sec.items.length}
                  </span>
                </button>
              )}
              {(isOpen || mini) && sec.items.map((item) => {
                const isActive = activeHref === item.href;
                // モード違いなのに出ている = いま開いているページ。それと分かるように印を付ける
                const otherMode = !!item.mode && item.mode !== mode;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    title={mini ? item.label : otherMode ? `${item.mode === "billing" ? "請求" : "給与"}モードの画面です` : undefined}
                    className={cn(
                      "flex items-center rounded-md text-sm transition-colors",
                      mini ? "justify-center px-0 py-2" : "gap-3 px-3 py-2",
                      isActive ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                    )}
                  >
                    <span>{item.icon}</span>
                    {!mini && <span className="flex-1 min-w-0 truncate">{item.label}</span>}
                    {!mini && otherMode && (
                      <span className="shrink-0 text-[10px] opacity-70">{item.mode === "billing" ? "請求" : "給与"}</span>
                    )}
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
