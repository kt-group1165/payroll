"use client";

import { useState } from "react";
import { formatHM } from "@/lib/payroll/attendance-calc";
import type { SalaryBreakdown } from "@/lib/payroll/kyotaku-calc";
import {
  useKyotakuSummary,
  type SummaryRow,
} from "@/lib/swr/use-kyotaku-summary";
import {
  KyotakuSalaryFormulaModal,
  type SalaryItemKey,
} from "./kyotaku-salary-formula-modal";

/**
 * 居宅介護支援 総括表セクション
 *
 * Props で officeId + month + weekStart を受け取り、対応する出勤簿集計を表示する。
 * 事業所/月 selector は親 page に統一されているのでこの section 内には持たない。
 *
 * 表示:
 *   - ケアマネ全員について出勤簿集計 (日数・時間・出張km)
 *   - 給与: kyotaku-calc.calcSalary で計算した本人給/職能給/固定残業/資格/勤続/特定処遇
 *     + プラン/加算/調整①②/出張手当 + 支給合計を表示
 *
 * データソース: live (DB 都度集計)。
 */

// =====================================================================
// 型
// =====================================================================

type Props = {
  /** 選択中の office id (payroll_offices.id)。空文字なら "事業所未選択" 表示 */
  officeId: string;
  /** 対象月 YYYY-MM */
  month: string;
  /** 週起算曜日 (0=日, ..., 6=土)。office.work_week_start を親から渡す */
  weekStart: number;
};

// SummaryRow / fetch ロジックは @/lib/swr/use-kyotaku-summary に集約。
// SWR を撤去するときは hook 内部を useEffect+useState に書き換えるだけで OK。

// =====================================================================
// 補助関数
// =====================================================================

function yen(n: number): string {
  return n > 0 ? `${n.toLocaleString("ja-JP")}円` : "—";
}

function num(n: number): string {
  return n > 0 ? n.toLocaleString("ja-JP") : "—";
}

// クリック可能な給与項目ヘッダー (formula モーダルを開く)
function SalaryHead({
  itemKey,
  onOpen,
  children,
}: {
  itemKey: SalaryItemKey;
  onOpen: (k: SalaryItemKey) => void;
  children: React.ReactNode;
}) {
  return (
    <th
      className="px-3 py-2 font-medium text-right cursor-help underline decoration-dotted decoration-muted-foreground/40 hover:bg-muted/40"
      onClick={() => onOpen(itemKey)}
      title="クリックで計算式を表示"
    >
      {children}
    </th>
  );
}

// クリック可能な給与セル (detail モーダルを開く)
function SalaryCell({
  itemKey,
  amount,
  row,
  onOpen,
}: {
  itemKey: SalaryItemKey;
  amount: number;
  row: SummaryRow;
  onOpen: (k: SalaryItemKey, r: SummaryRow) => void;
}) {
  return (
    <td
      className="px-3 py-1.5 text-right cursor-pointer hover:bg-muted/40"
      onClick={() => onOpen(itemKey, row)}
      title="クリックで計算内訳を表示"
    >
      {yen(amount)}
    </td>
  );
}

function hm(n: number): string {
  return n > 0 ? formatHM(n) : "—";
}

// =====================================================================
// Component
// =====================================================================

export function KyotakuSummarySection({ officeId, month, weekStart }: Props) {
  // SWR 経由でデータ取得 (再訪時は cache から即表示、背景で revalidate)
  const { rows, isLoading, error } = useKyotakuSummary(officeId, month, weekStart);
  const loading = isLoading;
  const err = error ? `集計の取得に失敗: ${error.message}` : null;

  // 給与項目モーダル: itemKey + mode (formula or detail) + staffName + breakdown
  type ModalState =
    | { open: false }
    | {
        open: true;
        itemKey: SalaryItemKey;
        mode: "formula" | "detail";
        staffName?: string;
        breakdown?: SalaryBreakdown;
      };
  const [modal, setModal] = useState<ModalState>({ open: false });
  const openFormulaModal = (itemKey: SalaryItemKey) => {
    setModal({ open: true, itemKey, mode: "formula" });
  };
  const openDetailModal = (
    itemKey: SalaryItemKey,
    row: SummaryRow,
  ) => {
    setModal({
      open: true,
      itemKey,
      mode: "detail",
      staffName: row.name,
      breakdown: row.breakdown,
    });
  };

  // 合計
  const grandTotal = rows.reduce((s, r) => s + r.total, 0);

  return (
    <div className="border rounded-md overflow-hidden mb-6">
      <div className="bg-muted/40 px-3 py-2 text-sm font-medium">
        居宅介護支援 ({rows.length}名)
      </div>

      {err && (
        <div className="px-3 py-2 text-sm text-destructive bg-destructive/5 border-b">
          {err}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs whitespace-nowrap">
          <thead className="bg-muted/20 border-b">
            <tr>
              <th className="px-3 py-2 font-medium text-left">社員番号</th>
              <th className="px-3 py-2 font-medium text-left">氏名</th>
              <th className="px-3 py-2 font-medium text-left">役職</th>
              <th className="px-3 py-2 font-medium text-right">出勤日数</th>
              <th className="px-3 py-2 font-medium text-right">実労働</th>
              <th className="px-3 py-2 font-medium text-right">日次残業</th>
              <th className="px-3 py-2 font-medium text-right">週次残業</th>
              <th className="px-3 py-2 font-medium text-right">深夜</th>
              <th className="px-3 py-2 font-medium text-right">法休勤務</th>
              <th className="px-3 py-2 font-medium text-right">欠勤</th>
              <th className="px-3 py-2 font-medium text-right">有給</th>
              <th className="px-3 py-2 font-medium text-right">出張km</th>
              <SalaryHead itemKey="honnin" onOpen={openFormulaModal}>本人給</SalaryHead>
              <SalaryHead itemKey="shokuno" onOpen={openFormulaModal}>職能給</SalaryHead>
              <SalaryHead itemKey="kotei_zangyo" onOpen={openFormulaModal}>固定残業</SalaryHead>
              <SalaryHead itemKey="shikaku" onOpen={openFormulaModal}>資格手当</SalaryHead>
              <SalaryHead itemKey="kotei" onOpen={openFormulaModal}>勤続手当</SalaryHead>
              <SalaryHead itemKey="tokutei" onOpen={openFormulaModal}>特定処遇</SalaryHead>
              <SalaryHead itemKey="plan" onOpen={openFormulaModal}>プラン</SalaryHead>
              <SalaryHead itemKey="kazan" onOpen={openFormulaModal}>加算</SalaryHead>
              <SalaryHead itemKey="chosei1" onOpen={openFormulaModal}>調整①</SalaryHead>
              <SalaryHead itemKey="chosei2" onOpen={openFormulaModal}>調整②</SalaryHead>
              <SalaryHead itemKey="business_trip_teate" onOpen={openFormulaModal}>出張手当</SalaryHead>
              <th className="px-3 py-2 font-medium text-right">支給合計</th>
            </tr>
          </thead>
          <tbody>
            {!officeId ? (
              <tr>
                <td colSpan={24} className="text-center text-muted-foreground py-4">
                  事業所を選択してください
                </td>
              </tr>
            ) : loading ? (
              <tr>
                <td colSpan={24} className="text-center text-muted-foreground py-4">
                  読み込み中...
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={24} className="text-center text-muted-foreground py-4">
                  データなし
                </td>
              </tr>
            ) : (
              <>
                {rows.map((r) => (
                  <tr key={r.employee_id} className="border-b last:border-b-0">
                    <td className="px-3 py-1.5 font-mono text-xs">{r.employee_number}</td>
                    <td className="px-3 py-1.5">{r.name}</td>
                    <td className="px-3 py-1.5">{r.role_type}</td>
                    <td className="px-3 py-1.5 text-right">{num(r.workDays)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{hm(r.workMin)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{hm(r.dailyOvertimeMin)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{hm(r.weeklyOvertimeMin)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{hm(r.midnightMin)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{hm(r.holidayWorkMin)}</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${r.absenceMin > 0 ? "text-rose-600" : ""}`}>{hm(r.absenceMin)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {r.paidLeaveDays > 0
                        ? `${r.paidLeaveDays.toFixed(1).replace(/\.0$/, "")}日`
                        : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {r.businessKmTotal > 0 ? `${r.businessKmTotal.toFixed(1)}km` : "—"}
                    </td>
                    <SalaryCell itemKey="honnin" amount={r.honnin} row={r} onOpen={openDetailModal} />
                    <SalaryCell itemKey="shokuno" amount={r.shokuno} row={r} onOpen={openDetailModal} />
                    <SalaryCell itemKey="kotei_zangyo" amount={r.kotei_zangyo} row={r} onOpen={openDetailModal} />
                    <SalaryCell itemKey="shikaku" amount={r.shikaku} row={r} onOpen={openDetailModal} />
                    <SalaryCell itemKey="kotei" amount={r.kotei} row={r} onOpen={openDetailModal} />
                    <SalaryCell itemKey="tokutei" amount={r.tokutei} row={r} onOpen={openDetailModal} />
                    <SalaryCell itemKey="plan" amount={r.plan} row={r} onOpen={openDetailModal} />
                    <SalaryCell itemKey="kazan" amount={r.kazan} row={r} onOpen={openDetailModal} />
                    <SalaryCell itemKey="chosei1" amount={r.chosei1} row={r} onOpen={openDetailModal} />
                    <SalaryCell itemKey="chosei2" amount={r.chosei2} row={r} onOpen={openDetailModal} />
                    <SalaryCell itemKey="business_trip_teate" amount={r.business_trip_teate} row={r} onOpen={openDetailModal} />
                    <td className="px-3 py-1.5 text-right font-bold">{r.total.toLocaleString("ja-JP")}円</td>
                  </tr>
                ))}
                <tr className="border-t bg-muted/10 font-semibold">
                  <td colSpan={23} className="px-3 py-1.5 text-right">合計</td>
                  <td className="px-3 py-1.5 text-right">{grandTotal.toLocaleString("ja-JP")}円</td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-2 text-xs text-muted-foreground border-t">
        ※ 支給合計 = 本人給 + 職能給 + 固定残業 + 資格 + 勤続 + 特定処遇
        + プラン + 加算 + 調整① + 調整② + 出張手当 (kyotaku-calc.calcSalary 由来)。
        対象月 = サービス提供月。プラン/加算/調整の確定は給与計算ページから。
        各給与項目のヘッダーをクリックで計算式、セルをクリックで内訳を表示。
      </div>

      {/* 給与項目モーダル (ヘッダー click = formula / セル click = detail) */}
      <KyotakuSalaryFormulaModal
        open={modal.open}
        onOpenChange={(o) => {
          if (!o) setModal({ open: false });
        }}
        itemKey={modal.open ? modal.itemKey : null}
        mode={modal.open ? modal.mode : "formula"}
        staffName={modal.open ? modal.staffName : undefined}
        breakdown={modal.open ? modal.breakdown : undefined}
      />
    </div>
  );
}
