"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SalaryBreakdown } from "@/lib/payroll/kyotaku-calc";

/**
 * 居宅介護支援 給与項目の計算式 + (任意で) 個別内訳を表示するモーダル。
 *
 * 使い方:
 *   - mode="formula": 一般的な計算式説明のみ (ヘッダークリック想定)
 *   - mode="detail":  formula + そのスタッフの内訳 (セルクリック想定)
 */

export type SalaryItemKey =
  | "honnin"
  | "shokuno"
  | "kotei_zangyo"
  | "shikaku"
  | "kotei"
  | "tokutei"
  | "plan"
  | "kazan"
  | "chosei1"
  | "chosei2"
  | "business_trip_teate";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemKey: SalaryItemKey | null;
  mode: "formula" | "detail";
  /** mode="detail" 時の対象スタッフ名 */
  staffName?: string;
  /** mode="detail" 時の breakdown (calcSalary 結果) */
  breakdown?: SalaryBreakdown;
};

const ITEMS: Record<
  SalaryItemKey,
  { label: string; formula: string; description: string }
> = {
  honnin: {
    label: "本人給",
    formula: "payroll_kyotaku_salary.honnin_kyu",
    description:
      "本人ごとの基本給。マスタの本人給を毎月そのまま支給。給与計算では変動なし。",
  },
  shokuno: {
    label: "職能給",
    formula: "payroll_kyotaku_salary.shokuno_kyu",
    description:
      "職能ごとの給与。マスタ値をそのまま支給。base (= 本人給 + 職能給 + 固定残業) の構成要素として、件数連動手当 (プラン/調整) の判定にも使う。",
  },
  kotei_zangyo: {
    label: "固定残業手当",
    formula: "payroll_kyotaku_salary.kotei_zangyo",
    description:
      "固定残業代。マスタ値をそのまま支給。base (= 本人給 + 職能給 + 固定残業) の構成要素。",
  },
  shikaku: {
    label: "資格手当",
    formula: "payroll_kyotaku_salary.shikaku_teate",
    description: "資格保有者向けの固定手当。マスタ値をそのまま加算。",
  },
  kotei: {
    label: "勤続手当",
    formula: "payroll_kyotaku_salary.kotei",
    description:
      "勤続年数ベースの固定手当。マスタ値 (DB 列名は payroll_kyotaku_salary.kotei) をそのまま加算。",
  },
  tokutei: {
    label: "特定処遇改善",
    formula: "payroll_kyotaku_salary.tokutei_shogu",
    description:
      "介護職員等特定処遇改善加算。マスタ値をそのまま加算。",
  },
  plan: {
    label: "プラン手当",
    formula: "max(0, inc0 - base)",
    description:
      "当月請求分の件数連動成果報酬。inc0 = 要介護 normal件数 × 介護費単価 (ki) + 要支援 normal件数 × 予防支援費単価 (si)。inc0 が base を超えた分のみプラン手当として支給 (T+1 払い)。",
  },
  kazan: {
    label: "加算手当",
    formula: "Σ(加算項目件数 × 単位数) × 10円",
    description:
      "国保連 CSV の加算項目を staff×service_month で集計し、単位数 × 10円換算で合計。T+1 払い。",
  },
  chosei1: {
    label: "調整手当①",
    formula: "max(0, inc1 - base) - max(0, inc0 - base)",
    description:
      "1ヶ月遅れ請求 (late1) 由来の調整。inc1 = inc0 + late1件数 × 単価。late1 分が確定したタイミング (T+2 払い) で差分を支給。",
  },
  chosei2: {
    label: "調整手当②",
    formula: "max(0, inc2 - base) - max(0, inc1 - base)",
    description:
      "2ヶ月遅れ請求 (late2) 由来の調整。inc2 = inc1 + late2件数 × 単価。late2 分が確定したタイミング (T+3 払い) で差分を支給。",
  },
  business_trip_teate: {
    label: "出張手当",
    formula: "Σ出勤簿 business_km × payroll_offices.travel_unit_price",
    description:
      "出張距離手当。月内の出勤簿 (payroll_kyotaku_attendance_records.business_km) の合計 × 事業所マスタの 出張単価 (円/km)。T+1 払い。",
  },
};

function yen(n: number): string {
  return `${Math.round(n).toLocaleString("ja-JP")}円`;
}

function num(n: number): string {
  return n.toLocaleString("ja-JP");
}

function renderDetailBlock(
  itemKey: SalaryItemKey,
  breakdown: SalaryBreakdown,
): React.ReactNode {
  const d = breakdown.details;
  const baseLine = `base = 本人給 ${yen(breakdown.honnin)} + 職能給 ${yen(
    breakdown.shokuno,
  )} + 固定残業 ${yen(breakdown.kotei_zangyo)} = ${yen(breakdown.base)}`;

  switch (itemKey) {
    case "honnin":
      return <div>{yen(breakdown.honnin)} (マスタ値そのまま)</div>;
    case "shokuno":
      return <div>{yen(breakdown.shokuno)} (マスタ値そのまま)</div>;
    case "kotei_zangyo":
      return <div>{yen(breakdown.kotei_zangyo)} (マスタ値そのまま)</div>;
    case "shikaku":
      return <div>{yen(breakdown.shikaku)} (マスタ値そのまま)</div>;
    case "kotei":
      return <div>{yen(breakdown.kotei)} (マスタ値そのまま)</div>;
    case "tokutei":
      return <div>{yen(breakdown.tokutei)} (マスタ値そのまま)</div>;
    case "plan":
      return (
        <div className="space-y-1">
          <div>{baseLine}</div>
          <div>
            inc0 = 要介護 {num(d.normal_kaigo)}件 × {yen(d.ki)}/件
            {" + "}
            要支援 {num(d.normal_shien)}件 × {yen(d.si)}/件
            {" = "}
            {yen(d.inc0)}
          </div>
          <div className="font-semibold">
            プラン = max(0, inc0 − base) = max(0, {yen(d.inc0)} − {yen(breakdown.base)}) = {yen(breakdown.plan)}
          </div>
        </div>
      );
    case "kazan":
      return (
        <div className="space-y-1">
          <div>加算項目の件数集計 → 単位数 × 10円 で算出 (詳細は給与計算ページ参照)</div>
          <div className="font-semibold">加算手当 合計: {yen(breakdown.kazan)}</div>
        </div>
      );
    case "chosei1":
      return (
        <div className="space-y-1">
          <div>{baseLine}</div>
          <div>
            inc1 = inc0 {yen(d.inc0)} + 要介護 late1 {num(d.late1_kaigo)}件 × {yen(d.ki)} + 要支援 late1 {num(d.late1_shien)}件 × {yen(d.si)} = {yen(d.inc1)}
          </div>
          <div className="font-semibold">
            調整① = max(0, inc1 − base) − max(0, inc0 − base) = {yen(Math.max(0, d.inc1 - breakdown.base))} − {yen(Math.max(0, d.inc0 - breakdown.base))} = {yen(breakdown.chosei1)}
          </div>
        </div>
      );
    case "chosei2":
      return (
        <div className="space-y-1">
          <div>{baseLine}</div>
          <div>
            inc2 = inc1 {yen(d.inc1)} + 要介護 late2 {num(d.late2_kaigo)}件 × {yen(d.ki)} + 要支援 late2 {num(d.late2_shien)}件 × {yen(d.si)} = {yen(d.inc2)}
          </div>
          <div className="font-semibold">
            調整② = max(0, inc2 − base) − max(0, inc1 − base) = {yen(Math.max(0, d.inc2 - breakdown.base))} − {yen(Math.max(0, d.inc1 - breakdown.base))} = {yen(breakdown.chosei2)}
          </div>
        </div>
      );
    case "business_trip_teate":
      return (
        <div className="space-y-1">
          <div>
            出張km 月合計: {d.business_km_total.toFixed(1)} km
          </div>
          <div>
            出張単価: {yen(d.travel_unit_price)}/km
          </div>
          <div className="font-semibold">
            出張手当 = {d.business_km_total.toFixed(1)} × {yen(d.travel_unit_price)} = {yen(breakdown.business_trip_teate)}
          </div>
        </div>
      );
  }
}

export function KyotakuSalaryFormulaModal({
  open,
  onOpenChange,
  itemKey,
  mode,
  staffName,
  breakdown,
}: Props) {
  if (!itemKey) return null;
  const spec = ITEMS[itemKey];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {spec.label}
            {mode === "detail" && staffName && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                / {staffName}
              </span>
            )}
          </DialogTitle>
          <DialogDescription>{spec.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 mt-2">
          <div className="rounded-md bg-muted/40 px-3 py-2 text-sm font-mono">
            {spec.formula}
          </div>

          {mode === "detail" && breakdown && (
            <div className="rounded-md border px-3 py-2 text-sm">
              <div className="text-xs text-muted-foreground mb-2">この人の内訳</div>
              {renderDetailBlock(itemKey, breakdown)}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
