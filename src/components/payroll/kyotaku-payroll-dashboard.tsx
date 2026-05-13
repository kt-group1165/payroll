"use client";

import { useState } from "react";

type Props = {
  officeNumber: string;
  officeName: string;
};

/**
 * 居宅介護支援 給与計算 dashboard
 *
 * Phase 1: 雛形のみ (本 file)
 * Phase 2: 以下を実装予定
 *   - payroll_kyotaku_records を fetch して計算
 *   - 国保連 CSV 取込 (src/lib/csv/kokuho-parser.ts 経由)
 *   - 計算ロジック (src/lib/payroll/kyotaku-calc.ts 経由)
 *   - 計算結果テーブル (SPEC.md §4: 15 行 / staff)
 *   - タブ切替: 支払いサマリー / 売上表 / 利用者内訳 / 差異明細
 *   - 確定 button (payroll_kyotaku_confirmations に append)
 *
 * 関連:
 *   - 仕様: apps/居宅給与計算/SPEC.md §4 (出力 sheet)
 *   - migration: apps/payroll-app/migrations/payroll_kyotaku_v1.sql
 */
export function KyotakuPayrollDashboard({ officeNumber, officeName }: Props) {
  // TODO Phase 2: importing state は CSV 取込時の loading 表示に使う
  const [importing] = useState(false);

  return (
    <div className="space-y-4 p-4">
      <header>
        <h1 className="text-xl font-bold">居宅介護支援 給与計算</h1>
        <p className="text-sm text-gray-500">
          {officeName} ({officeNumber})
        </p>
      </header>
      <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-gray-400">
        <p>Phase 1 雛形: 機能実装は Phase 2 で追加予定</p>
        <p className="text-xs mt-2">国保連 CSV 取込 → 計算 → 確定 のフロー</p>
        {importing && <p className="text-xs mt-2">取込中…</p>}
      </div>
    </div>
  );
}
