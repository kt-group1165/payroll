// kyotaku-calc.ts
// 居宅介護支援 ケアマネ給与計算ロジック
//
// apps/居宅給与計算/集計.py (calc_salary / calc_payment_for_month / 確定差異集約) の
// TypeScript pure-function 移植。DB 接続 / React UI は呼び出し側で実装する。
//
// 仕様: apps/居宅給与計算/SPEC.md §3 (給与計算) / §6 (ユーティリティ) / §8.4 (最新未確定月) / §8.5 (固定 10 円)
//
// 月文字列の表現は仕様に従い YYYY-MM-01 (DATE 互換) に統一。Python 版は YYYY/MM を
// 内部表現としていたが、DB DATE 列と相互運用しやすい形式へ変更している。

// =====================================================================
// Type 定義
// =====================================================================

export type CareLevel =
  | "要支援１"
  | "要支援２"
  | "要介護１"
  | "要介護２"
  | "要介護３"
  | "要介護４"
  | "要介護５";

export type EmployeeSetting = {
  /** payroll_employees.name (= payroll_kyotaku_records.staff_name と完全一致 match) */
  staff_name: string;
  /** payroll_employees.kyotaku_base_salary (NULL → DEFAULT_BASE_SALARY=250000 にフォールバック) */
  base_salary: number | null;
  /** payroll_employees.kyotaku_kaigo_rate (NULL → 0) */
  kaigo_rate: number | null;
  /** payroll_employees.kyotaku_shien_rate (NULL → 0) */
  shien_rate: number | null;
};

export type ServiceUnit = {
  item_name: string;
  unit_count: number;
  is_addition: boolean;
  is_office_addition: boolean;
};

export type RegionalRate = {
  insurer_name: string;
  rate: number;
};

export type Confirmation = {
  staff_name: string;
  pay_month: string;
  amount: number;
};

export type KyotakuRecord = {
  service_month: string; // YYYY-MM-01
  billing_month: string; // YYYY-MM-01
  staff_name: string;
  detail_row_no: string | null;
  insurer_name: string | null;
  service_name: string | null;
  unit_total: number | null;
  care_level: string | null;
};

export type SalaryBreakdown = {
  base: number;
  plan: number; // プラン手当 (T+1 払い)
  kazan: number; // 加算手当 (T+1 払い、固定 10 円換算)
  chosei1: number; // 調整手当①(T+2 払い、late1 起源)
  chosei2: number; // 調整手当②(T+3 払い、late2 起源)
  total: number; // 上記合計
};

export type CalcConfig = {
  settings: EmployeeSetting[];
  units: ServiceUnit[];
  rates: RegionalRate[];
};

export type CalcConfigWithConfirmations = CalcConfig & {
  confirmations: Confirmation[];
};

// 既定値 (集計.py DEFAULT_BASE_SALARY)
const DEFAULT_BASE_SALARY = 250000;

// =====================================================================
// ユーティリティ
// =====================================================================

const MONTH_PATTERNS: ReadonlyArray<RegExp> = [
  /^(\d{4})年(\d{1,2})月\d+日$/, // 2025年5月13日
  /^(\d{4})年(\d{1,2})月$/, // 2025年5月
  /^(\d{4})\/(\d{1,2})\/\d+$/, // 2025/5/13
  /^(\d{4})\/(\d{1,2})$/, // 2025/5 or 2025/05
  /^(\d{4})-(\d{1,2})-\d+$/, // 2025-05-13 / 2025-5-1
  /^(\d{4})-(\d{1,2})$/, // 2025-05 / 2025-5
];

/** 様々な日付/月文字列を YYYY-MM-01 に統一する。失敗時は null。 */
export function normalizeMonth(raw: string): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  for (const pat of MONTH_PATTERNS) {
    const m = pat.exec(trimmed);
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      if (!Number.isFinite(y) || !Number.isFinite(mo)) continue;
      if (mo < 1 || mo > 12) continue;
      return `${m[1]}-${String(mo).padStart(2, "0")}-01`;
    }
  }

  // Date 解析にフォールバック (UTC 基準、TZ ずれを避ける)
  const dt = new Date(trimmed);
  if (!Number.isNaN(dt.getTime())) {
    const y = dt.getUTCFullYear();
    const mo = dt.getUTCMonth() + 1;
    return `${y}-${String(mo).padStart(2, "0")}-01`;
  }

  return null;
}

function splitMonth(month: string): { y: number; m: number } {
  // YYYY-MM-01 / YYYY-MM / YYYY/MM 等を許容しつつ y / m を抽出
  const m1 = /^(\d{4})[-/](\d{1,2})/.exec(month);
  if (!m1) {
    throw new Error(`invalid month: ${month}`);
  }
  return { y: Number(m1[1]), m: Number(m1[2]) };
}

/** YYYY-MM-01 に n か月加算 (n 負値可)。出力も YYYY-MM-01。 */
export function addMonths(month: string, n: number): string {
  const { y, m } = splitMonth(month);
  // m を 0-indexed に変換して加算 → 範囲外を吸収
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

/** m2 - m1 の月数差 (= addMonths(m1, diff) === m1+diff)。 */
export function monthDiff(m1: string, m2: string): number {
  const a = splitMonth(m1);
  const b = splitMonth(m2);
  return (b.y - a.y) * 12 + (b.m - a.m);
}

/**
 * 要介護度 → 基本サービス単位。単位数 master の item_name と部分マッチで分岐:
 *   要介護１/２ → "要介護１～２" (全角チルダ U+FF5E / 互換で U+301C も探す)
 *   要介護３/４/５ → "要介護３～５"
 *   要支援１/２ → "要支援１" / "要支援２"
 */
export function getBaseUnit(careLevel: string, units: ServiceUnit[]): number {
  if (!careLevel) return 0;

  const findUnit = (...keys: string[]): number => {
    for (const k of keys) {
      const u = units.find((x) => x.item_name === k);
      if (u) return u.unit_count;
    }
    return 0;
  };

  if (careLevel === "要介護１" || careLevel === "要介護２") {
    return findUnit("要介護１～２", "要介護１〜２");
  }
  if (
    careLevel === "要介護３" ||
    careLevel === "要介護４" ||
    careLevel === "要介護５"
  ) {
    return findUnit("要介護３～５", "要介護３〜５");
  }
  if (careLevel === "要支援１") return findUnit("要支援１");
  if (careLevel === "要支援２") return findUnit("要支援２");
  return 0;
}

// =====================================================================
// 内部ヘルパー
// =====================================================================

type DelayCounts = {
  same_kaigo: number;
  same_shien: number;
  normal_kaigo: number;
  normal_shien: number;
  late1_kaigo: number;
  late1_shien: number;
  late2_kaigo: number;
  late2_shien: number;
};

function emptyDelayCounts(): DelayCounts {
  return {
    same_kaigo: 0,
    same_shien: 0,
    normal_kaigo: 0,
    normal_shien: 0,
    late1_kaigo: 0,
    late1_shien: 0,
    late2_kaigo: 0,
    late2_shien: 0,
  };
}

/**
 * 指定 staff / serviceMonth の delay 別件数を集計。
 * detail_row_no === "1" の行のみ (= 基本サービス行) を対象とする。
 */
function countByDelay(
  records: KyotakuRecord[],
  staffName: string,
  serviceMonth: string,
): DelayCounts {
  const out = emptyDelayCounts();

  for (const r of records) {
    if (r.staff_name !== staffName) continue;
    if (r.service_month !== serviceMonth) continue;
    if (r.detail_row_no !== "1") continue;
    if (!r.billing_month) continue;
    if (!r.care_level) continue;

    const isKaigo = r.care_level.startsWith("要介護");
    const isShien = r.care_level.startsWith("要支援");
    if (!isKaigo && !isShien) continue;

    let delay: number;
    try {
      delay = monthDiff(r.service_month, r.billing_month);
    } catch {
      delay = 1; // 不正な billing_month は normal 扱い (Python 互換)
    }

    if (delay <= 0) {
      // 集計.py では `delay == 0` 厳密判定だが、負値 (請求が提供月より前) は
      // 実務上ありえず、出たら same として扱う方が安全
      if (isKaigo) out.same_kaigo += 1;
      else out.same_shien += 1;
    } else if (delay === 1) {
      if (isKaigo) out.normal_kaigo += 1;
      else out.normal_shien += 1;
    } else if (delay === 2) {
      if (isKaigo) out.late1_kaigo += 1;
      else out.late1_shien += 1;
    } else {
      if (isKaigo) out.late2_kaigo += 1;
      else out.late2_shien += 1;
    }
  }

  return out;
}

/** 設定 lookup (見つからなければ default)。 */
function resolveSetting(
  settings: EmployeeSetting[],
  staffName: string,
): { base: number; ki: number; si: number } {
  const s = settings.find((x) => x.staff_name === staffName);
  return {
    base: s?.base_salary ?? DEFAULT_BASE_SALARY,
    ki: s?.kaigo_rate ?? 0,
    si: s?.shien_rate ?? 0,
  };
}

/**
 * 加算手当を計算。集計.py §3.3 のロジックに準拠:
 *   - is_addition === true かつ is_office_addition === false な item のみ対象
 *   - 件数 = 該当 staff / serviceMonth の records から
 *     "service_name に item_name を含む行" の件数 (detail_row_no 問わず)
 *   - 単価 = unit_count
 *   - 換算 = 固定 10 円 (SPEC §8.5)
 */
function calcKazan(
  records: KyotakuRecord[],
  staffName: string,
  serviceMonth: string,
  units: ServiceUnit[],
): number {
  let kazan = 0;

  // 同 staff/月 の行を 1 度抽出
  const subset = records.filter(
    (r) => r.staff_name === staffName && r.service_month === serviceMonth,
  );

  for (const u of units) {
    if (!u.is_addition) continue;
    if (u.is_office_addition) continue;
    // SPEC §8.14: 部分一致で "特定事業所加算" 系を二重防御
    if (u.item_name.includes("特定事業所加算")) continue;

    let count = 0;
    for (const r of subset) {
      const svc = r.service_name ?? "";
      if (svc && svc.includes(u.item_name)) {
        count += 1;
      }
    }
    kazan += count * u.unit_count * 10;
  }

  return kazan;
}

// =====================================================================
// 主要 API
// =====================================================================

/**
 * 提供月 T の給与を 5 要素 (base / plan / kazan / chosei1 / chosei2) に分解。
 * 3 段階調整 (SPEC §3.2):
 *   inc0 = (same + normal) * rate           // T+1 払いの基準
 *   inc1 = inc0 + late1 * rate              // T+2 払い込み
 *   inc2 = inc1 + late2 * rate              // T+3 払い込み
 *   plan    = max(0, inc0 - base)
 *   chosei1 = max(0, inc1 - base) - max(0, inc0 - base)
 *   chosei2 = max(0, inc2 - base) - max(0, inc1 - base)
 *
 * total = base + plan + kazan + chosei1 + chosei2
 */
export function calcSalary(
  records: KyotakuRecord[],
  staffName: string,
  serviceMonth: string,
  config: CalcConfig,
): SalaryBreakdown {
  const { base, ki, si } = resolveSetting(config.settings, staffName);
  const c = countByDelay(records, staffName, serviceMonth);

  const n_k = c.same_kaigo + c.normal_kaigo;
  const n_s = c.same_shien + c.normal_shien;
  const l1_k = c.late1_kaigo;
  const l1_s = c.late1_shien;
  const l2_k = c.late2_kaigo;
  const l2_s = c.late2_shien;

  const inc0 = n_k * ki + n_s * si;
  const inc1 = inc0 + l1_k * ki + l1_s * si;
  const inc2 = inc1 + l2_k * ki + l2_s * si;

  const plan = Math.max(0, inc0 - base);
  const chosei1 = Math.max(0, inc1 - base) - Math.max(0, inc0 - base);
  const chosei2 = Math.max(0, inc2 - base) - Math.max(0, inc1 - base);

  const kazan = calcKazan(records, staffName, serviceMonth, config.units);

  const total = base + plan + kazan + chosei1 + chosei2;
  return { base, plan, kazan, chosei1, chosei2, total };
}

/**
 * 指定 staff / pay_month に支払うべき合計額。
 * 集計.py calc_payment_for_month と同じ:
 *   全提供月を舐め、それぞれの T+1 (base+plan+kazan) / T+2 (chosei1) / T+3 (chosei2) を集約。
 */
export function calcPaymentForMonth(
  records: KyotakuRecord[],
  staffName: string,
  payMonth: string,
  config: CalcConfig,
): number {
  // staff 限定の全提供月 set
  const serviceMonths = new Set<string>();
  for (const r of records) {
    if (r.staff_name !== staffName) continue;
    if (r.service_month) serviceMonths.add(r.service_month);
  }

  let total = 0;
  for (const sm of serviceMonths) {
    const { base, plan, kazan, chosei1, chosei2 } = calcSalary(
      records,
      staffName,
      sm,
      config,
    );
    if (addMonths(sm, 1) === payMonth) total += base + plan + kazan;
    if (addMonths(sm, 2) === payMonth) total += chosei1;
    if (addMonths(sm, 3) === payMonth) total += chosei2;
  }
  return total;
}

/**
 * 確定差異集約 (SPEC §3.6 / §8.4)。
 *
 * 戻り値:
 *   late_adj: その提供月 T の支払い月 (T+1) に流れ込む、過去月起源の chosei1/chosei2 合計
 *            = calcPaymentForMonth(staff, T+1) - (base + plan + kazan)
 *   sayi_adj: そのケアマネの「最新未確定月」に限り、過去確定済み月の (計算値 - 支給済み) を全合計
 *            (差分は正負どちらも積み上げ — 過払いは負値)
 */
export function calcAdjustments(
  records: KyotakuRecord[],
  staffName: string,
  serviceMonth: string,
  config: CalcConfigWithConfirmations,
): { late_adj: number; sayi_adj: number } {
  const { settings, units, rates, confirmations } = config;
  const baseConfig: CalcConfig = { settings, units, rates };

  // 1) late_adj: T+1 へ流れる過去月の chosei
  const { base, plan, kazan } = calcSalary(
    records,
    staffName,
    serviceMonth,
    baseConfig,
  );
  const payMonth = addMonths(serviceMonth, 1);
  const late_adj =
    calcPaymentForMonth(records, staffName, payMonth, baseConfig) -
    (base + plan + kazan);

  // 2) sayi_adj: 最新未確定月にのみ集約
  //    最新未確定月 = staff の全提供月を新しい順に走査し、
  //      confirmations[(staff, T+1)] が無い (or amount===0) の最初の T
  const staffMonths = Array.from(
    new Set(
      records
        .filter((r) => r.staff_name === staffName && r.service_month)
        .map((r) => r.service_month),
    ),
  ).sort();

  // confirmations を (staff, pay_month) → amount に index 化
  const paidMap = new Map<string, number>();
  for (const c of confirmations) {
    if (c.staff_name !== staffName) continue;
    paidMap.set(c.pay_month, c.amount);
  }

  let latestUnconfirmed: string | null = null;
  for (let i = staffMonths.length - 1; i >= 0; i--) {
    const m = staffMonths[i];
    const pm = addMonths(m, 1);
    const amt = paidMap.get(pm) ?? 0;
    if (!amt) {
      latestUnconfirmed = m;
      break;
    }
  }

  let sayi_adj = 0;
  if (latestUnconfirmed !== null && serviceMonth === latestUnconfirmed) {
    for (const prevMonth of staffMonths) {
      if (prevMonth >= serviceMonth) continue;
      const prevPay = addMonths(prevMonth, 1);
      const prevPaid = paidMap.get(prevPay) ?? 0;
      if (prevPaid === 0) continue;
      const prev = calcSalary(records, staffName, prevMonth, baseConfig);
      const diff = prev.base + prev.plan + prev.kazan - prevPaid;
      sayi_adj += diff;
    }
  }

  return { late_adj, sayi_adj };
}
