// kyotaku-provisional-calc.ts
// 居宅介護支援ケアマネ 仮計算 (出勤簿 月次 inputs ベース)
//
// 設計:
//   月締め後の国保連 CSV 取込前に admin に「仮の支給額」を提示するための
//   pure-function 計算ロジック。CSV ベースの確定計算 (kyotaku-calc.ts:calcSalary) と
//   並存し、確定差額は呼び出し側で `calcProvisionalDiff` で算出する。
//
// 仕様:
//   provisional_amount =
//       kaigo_count × kaigo_rate                  // 介護件数 × プラン単価
//     + yobou_count × shien_rate                  // 予防件数 × 予防単価
//     + Σ (kasan_unit × kasan_count × 10)         // 規定加算 (固定 10 円換算)
//     + Σ free_amount                             // 自由記述加算
//
//   kaigo_rate / shien_rate は payroll_employees.kyotaku_kaigo_rate /
//   kyotaku_shien_rate と同じ意味 (NULL → 0)。

// =====================================================================
// 型定義
// =====================================================================

/**
 * 仮計算の入力源となる加算 1 行。
 * payroll_kyotaku_attendance_monthly_kasan の 1 row と対応。
 *
 * 規定加算行: kasan_unit (200/300/.../900) + kasan_count
 * 自由記述行: free_label + free_amount
 *
 * (一方のみ non-null、他方は null。DB 側の CHECK 制約と同じ前提)
 */
export type ProvisionalKasanInput = {
  kasan_unit: number | null;
  kasan_count: number | null;
  free_label: string | null;
  free_amount: number | null;
};

export type ProvisionalCalcInput = {
  /** 介護件数 (= 月次 kaigo_count) */
  kaigo_count: number;
  /** 予防件数 (= 月次 yobou_count) */
  yobou_count: number;
  /** プラン単価 (円/件) = payroll_employees.kyotaku_kaigo_rate */
  kaigo_rate: number | null;
  /** 予防単価 (円/件) = payroll_employees.kyotaku_shien_rate */
  shien_rate: number | null;
  /** 月次加算 rows (規定 + 自由記述) */
  kasanRows: ProvisionalKasanInput[];
};

export type ProvisionalBreakdown = {
  /** 介護件数 × プラン単価 */
  kaigo: number;
  /** 予防件数 × 予防単価 */
  yobou: number;
  /** 規定加算合計 (= Σ kasan_unit × kasan_count × 10) */
  kasanTotal: number;
  /** 自由記述加算合計 (= Σ free_amount) */
  freeTotal: number;
  /** = kaigo + yobou + kasanTotal + freeTotal */
  total: number;
};

// =====================================================================
// 主要 API
// =====================================================================

const KASAN_YEN_PER_UNIT = 10;

/**
 * 仮計算を実行して内訳 + total を返す。pure function。
 *
 * NULL/NaN 防御:
 *   - kaigo_rate / shien_rate が null なら 0 として扱う
 *   - 各加算行は (kasan_unit IS NULL) なら自由記述、それ以外なら規定加算
 *   - kasan_count / free_amount が null/NaN なら 0 として扱う
 */
export function calcProvisional(
  input: ProvisionalCalcInput,
): ProvisionalBreakdown {
  const kr = input.kaigo_rate ?? 0;
  const sr = input.shien_rate ?? 0;
  const kaigo = (input.kaigo_count || 0) * kr;
  const yobou = (input.yobou_count || 0) * sr;

  let kasanTotal = 0;
  let freeTotal = 0;
  for (const r of input.kasanRows) {
    if (r.kasan_unit !== null && r.kasan_unit !== undefined) {
      const count = r.kasan_count ?? 0;
      if (count > 0) {
        kasanTotal += r.kasan_unit * count * KASAN_YEN_PER_UNIT;
      }
    } else if (r.free_amount !== null && r.free_amount !== undefined) {
      const amt = r.free_amount ?? 0;
      freeTotal += amt;
    }
  }

  const total = kaigo + yobou + kasanTotal + freeTotal;
  return { kaigo, yobou, kasanTotal, freeTotal, total };
}

/**
 * 仮計算 → 確定計算 (CSV ベース) の差額を計算。
 *
 * diff = csvBased - provisional
 *   - 正値 → 仮で過少支給 → 翌月で追加支給する分
 *   - 負値 → 仮で過剰支給 → 翌月で控除する分
 *
 * いずれも nullish なら 0 として計算 (片方しか無い月でも安全)。
 */
export function calcProvisionalDiff(
  provisional: number | null | undefined,
  csvBased: number | null | undefined,
): number {
  const p = provisional ?? 0;
  const c = csvBased ?? 0;
  return c - p;
}
