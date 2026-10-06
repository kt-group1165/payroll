"use client";

/**
 * /settings/history 給与の設定の履歴 (2026-10-06 user「履歴持つべきものは全部持って、画面でも閲覧できるように」)
 *
 * 金額に効くアプリ設定 (payroll_app_setting_history) を 設定ごとに「何月分から 何が変わったか」で見せる。
 * 事業所の単価・職員の給与設定・区分時給・残業設定・居宅の給与 は それぞれの画面に履歴がある (ここからリンク)。
 */
import { useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { MONEY_SETTING_LABELS } from "@/lib/app-settings";
import { SettingHistoryTable, useOfficeNames } from "@/components/payroll/setting-history";

const OTHER_HISTORIES: { href: string; label: string; where: string }[] = [
  { href: "/offices", label: "事業所の単価・週起算曜日", where: "事業所一覧 → 編集 の下の「改定履歴」" },
  { href: "/salary", label: "職員の給与設定", where: "給与設定 → 各職員の「履歴を見る」" },
  { href: "/salary", label: "残業設定", where: "給与設定 → 残業設定 → 職種ごとの「履歴」" },
  { href: "/services", label: "区分時給", where: "サービスマスタ → 時給設定 (時期ごとの表)" },
  { href: "/services", label: "サービスコード → 類型", where: "サービスマスタ → マッピング → 各行の「履歴」" },
  { href: "/payroll", label: "居宅の給与・介護報酬の単位数", where: "給与計算 → 居宅介護支援 → 設定 / 単位数の履歴" },
];

export default function SettingsHistoryPage() {
  const officeNames = useOfficeNames();
  const keys = Object.keys(MONEY_SETTING_LABELS);
  const [open, setOpen] = useState<string | null>(keys[0] ?? null);

  return (
    <div className="max-w-6xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold">設定の履歴</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          金額に効く設定を「何月分から 何が変わったか」で見られます。給与計算は 対象月に有効だった値で計算します。
          色の付いたセルは 前の行から変わった値です。
        </p>
      </div>

      <Card>
        <CardContent className="pt-4">
          <p className="mb-2 text-sm font-semibold">ほかの画面にある履歴</p>
          <ul className="space-y-1 text-sm">
            {OTHER_HISTORIES.map((o) => (
              <li key={o.label}>
                <Link href={o.href} className="font-medium text-primary hover:underline">{o.label}</Link>
                <span className="ml-2 text-muted-foreground">{o.where}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <div className="space-y-2">
        {keys.map((k) => (
          <Card key={k}>
            <CardContent className="py-3">
              <button
                type="button"
                className="flex w-full items-center justify-between text-left"
                onClick={() => setOpen((cur) => (cur === k ? null : k))}
                aria-expanded={open === k}
              >
                <span className="font-semibold">{MONEY_SETTING_LABELS[k]}</span>
                <span className="text-xs text-muted-foreground">{open === k ? "▲ 閉じる" : "▼ 履歴を見る"}</span>
              </button>
              {open === k && (
                <div className="mt-3">
                  <SettingHistoryTable settingKey={k} officeNames={officeNames} />
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
