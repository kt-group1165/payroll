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
  /** 本人給 (base 構成要素) — payroll_employees.kyotaku_honnin_kyu */
  honnin_kyu: number | null;
  /** 職能給 (base 構成要素) — payroll_employees.kyotaku_shokuno_kyu */
  shokuno_kyu: number | null;
  /** 固定残業手当 (base 構成要素) — payroll_employees.kyotaku_kotei_zangyo */
  kotei_zangyo: number | null;
  /** 資格手当 (total に独立加算) — payroll_employees.kyotaku_shikaku_teate */
  shikaku_teate: number | null;
  /** 固定 (total に独立加算) — payroll_employees.kyotaku_kotei */
  kotei: number | null;
  /** 特定処遇改善 (total に独立加算) — payroll_employees.kyotaku_tokutei_shogu */
  tokutei_shogu: number | null;
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

/**
 * 介護予防支援 件数 row (payroll_kyotaku_yobou_records と対応)。
 *
 * - 1 row = 1 staff × 1 提供月 × 1 請求月 の集約形式 (records と違い明細単位ではない)
 * - 件数集計時、要支援1/2 の row 数として yobou1_count + yobou2_count を加算する
 *   (records 側の「detail_row_no='1' かつ 要支援」row は通常空である運用前提なので、
 *    単純加算で良い)
 */
export type YobouRecord = {
  service_month: string; // YYYY-MM-01
  billing_month: string; // YYYY-MM-01
  staff_name: string;
  yobou1_count: number;
  yobou2_count: number;
};

/**
 * 出勤簿 1 行 (kyotaku-attendance 由来)。
 * 出張距離手当 計算で使う最小 view。
 * - staff_name で staff を識別 (dashboard 側で employee_id → name に変換済)
 * - work_date は YYYY-MM-DD
 * - business_km は出張距離 (km)、NULL/未入力は 0 扱い
 */
export type KyotakuAttendanceRecord = {
  staff_name: string;
  work_date: string;
  business_km: number | null;
};

export type SalaryBreakdown = {
  // base 構成要素 (UI 表示用に内訳保持)
  honnin: number; // 本人給
  shokuno: number; // 職能給
  kotei_zangyo: number; // 固定残業手当
  /** = honnin + shokuno + kotei_zangyo (プラン手当との比較に使う base) */
  base: number;
  // 独立加算 (total に直接足す)
  shikaku: number; // 資格手当
  kotei: number; // 固定 (ラベル表示は「勤続手当」、DB 列は kyotaku_kotei)
  tokutei: number; // 特定処遇改善
  // 件数連動
  plan: number; // プラン手当 (T+1 払い)
  kazan: number; // 加算手当 (T+1 払い、固定 10 円換算)
  chosei1: number; // 調整手当①(T+2 払い、late1 起源)
  chosei2: number; // 調整手当②(T+3 払い、late2 起源)
  /**
   * 出張距離手当 (= 月合計 business_km × office.travel_unit_price)。
   * 月固定で同月 (T+1) に支払う独立加算。NUMERIC 単価なので小数結果は呼び出し側で
   * 必要に応じ丸める (本 calc は raw 値を返す)。
   */
  business_trip_teate: number;
  /**
   * = base + plan + kazan + chosei1 + chosei2 + shikaku + kotei + tokutei
   *   + business_trip_teate
   */
  total: number;
  /**
   * UI モーダル等での内訳表示用の中間値。集計結果に影響しない情報を持つ。
   */
  details: {
    /** 介護費 単価 (円/単位、staff の kaigo_rate) */
    ki: number;
    /** 予防支援費 単価 (si) */
    si: number;
    /** 同月請求 (= service_month と billing_month が同月、または前月) 件数 (要介護) */
    normal_kaigo: number;
    /** 同月請求 件数 (要支援、yobou も含む) */
    normal_shien: number;
    /** 1ヶ月遅れ請求 件数 (要介護) */
    late1_kaigo: number;
    /** 1ヶ月遅れ請求 件数 (要支援) */
    late1_shien: number;
    /** 2ヶ月遅れ請求 件数 (要介護) */
    late2_kaigo: number;
    /** 2ヶ月遅れ請求 件数 (要支援) */
    late2_shien: number;
    /** = normal_kaigo*ki + normal_shien*si (T+1 払いの基礎額) */
    inc0: number;
    /** = inc0 + late1_kaigo*ki + late1_shien*si */
    inc1: number;
    /** = inc1 + late2_kaigo*ki + late2_shien*si */
    inc2: number;
    /** その月の business_km 合計 */
    business_km_total: number;
    /** 出張単価 (円/km) */
    travel_unit_price: number;
  };
};

export type CalcConfig = {
  settings: EmployeeSetting[];
  units: ServiceUnit[];
  rates: RegionalRate[];
  /**
   * 介護予防支援 件数の集約 row (任意 / 省略時は空配列扱い)。
   * 同一 office の row だけを呼び出し側で絞り込んで渡す前提。
   */
  yobouRecords?: YobouRecord[];
  /**
   * 出勤簿 row (任意 / 省略時は出張距離手当 = 0)。同一 office の row だけを
   * 呼び出し側で絞り込み、employee_id → staff_name 解決済の形で渡す前提。
   */
  attendanceRecords?: KyotakuAttendanceRecord[];
  /**
   * 出張距離手当の単価 (円/km、payroll_offices.travel_unit_price)。
   * CalcConfig は office 単位で組み立てられる前提なので、配列ではなく単一値。
   * NULL/未設定なら 0 (= 出張距離手当 0)。
   */
  officeTravelUnitPrice?: number | null;
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
 *
 * yobouRecords (介護予防支援) は別 source として 要支援1/2 件数を delay 別に加算する。
 * - 国保連 records は介護給付ベースで、要支援件数は通常 0 件 (袖ヶ浦 CSV 等)。
 * - 介護予防支援は独立した集約 row なので、records カウントに足し込めば二重計上は出ない。
 */
function countByDelay(
  records: KyotakuRecord[],
  staffName: string,
  serviceMonth: string,
  yobouRecords?: YobouRecord[],
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

  // 介護予防支援件数 (要支援1/2 を加算)
  if (yobouRecords && yobouRecords.length > 0) {
    for (const yr of yobouRecords) {
      if (yr.staff_name !== staffName) continue;
      if (yr.service_month !== serviceMonth) continue;
      if (!yr.billing_month) continue;

      let delay: number;
      try {
        delay = monthDiff(yr.service_month, yr.billing_month);
      } catch {
        delay = 1;
      }

      const add = (yr.yobou1_count ?? 0) + (yr.yobou2_count ?? 0);
      if (add === 0) continue;

      if (delay <= 0) {
        out.same_shien += add;
      } else if (delay === 1) {
        out.normal_shien += add;
      } else if (delay === 2) {
        out.late1_shien += add;
      } else {
        out.late2_shien += add;
      }
    }
  }

  return out;
}

/**
 * 設定 lookup (見つからなければ default)。
 *
 * base 仕様 (2026-05-13 6 列分解):
 *   - 設定 row が存在し honnin/shokuno/kotei_zangyo のいずれかが非 NULL なら
 *     base = (honnin ?? 0) + (shokuno ?? 0) + (kotei_zangyo ?? 0)
 *   - 設定 row が無い or 3 列すべて NULL なら DEFAULT_BASE_SALARY=250000 へ fallback
 *     (旧 base_salary 1 列時代の互換挙動)
 *   - shikaku/kotei/tokutei は base に含まれない。total への独立加算用に別途返す。
 */
function resolveSetting(
  settings: EmployeeSetting[],
  staffName: string,
): {
  base: number;
  ki: number;
  si: number;
  honnin: number;
  shokuno: number;
  koteiZ: number;
  shikaku: number;
  kotei: number;
  tokutei: number;
} {
  const s = settings.find((x) => x.staff_name === staffName);
  const honnin = s?.honnin_kyu ?? 0;
  const shokuno = s?.shokuno_kyu ?? 0;
  const koteiZ = s?.kotei_zangyo ?? 0;
  // 3 列すべて NULL の場合は fallback (= 設定 row 自体が無い or 全 NULL)
  const allNull =
    !s ||
    (s.honnin_kyu === null && s.shokuno_kyu === null && s.kotei_zangyo === null);
  const base = allNull ? DEFAULT_BASE_SALARY : honnin + shokuno + koteiZ;
  return {
    base,
    ki: s?.kaigo_rate ?? 0,
    si: s?.shien_rate ?? 0,
    honnin,
    shokuno,
    koteiZ,
    shikaku: s?.shikaku_teate ?? 0,
    kotei: s?.kotei ?? 0,
    tokutei: s?.tokutei_shogu ?? 0,
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
  // 同 staff/月 の行を 1 度抽出
  const subset = records.filter(
    (r) => r.staff_name === staffName && r.service_month === serviceMonth,
  );
  if (subset.length === 0) return 0;

  // 加算対象 units を事前 filter (毎 row 走査でフラグ判定しない)。
  // SPEC §8.14: 部分一致で "特定事業所加算" 系を二重防御。
  const addUnits = units.filter(
    (u) =>
      u.is_addition &&
      !u.is_office_addition &&
      !u.item_name.includes("特定事業所加算"),
  );
  if (addUnits.length === 0) return 0;

  // service_name を事前抽出 (毎 unit 比較で `r.service_name ?? ""` を再評価しない)。
  const svcNames: string[] = [];
  for (const r of subset) {
    const svc = r.service_name ?? "";
    if (svc) svcNames.push(svc);
  }
  if (svcNames.length === 0) return 0;

  let kazan = 0;
  for (const u of addUnits) {
    let count = 0;
    for (const svc of svcNames) {
      if (svc.includes(u.item_name)) count += 1;
    }
    kazan += count * u.unit_count * 10;
  }
  return kazan;
}

/**
 * 出張距離手当の月計算。
 *
 * serviceMonth (YYYY-MM-01) の staff_name の attendance rows を集計し、
 * sum(business_km) × officeTravelUnitPrice を返す。
 * - attendanceRecords が undefined / 空、または officeTravelUnitPrice が null/0 なら 0
 * - work_date の YYYY-MM が serviceMonth の YYYY-MM と一致する行だけ集計
 *
 * 単価は NUMERIC(10,2) (整数 or 0.01 刻みの小数) なので、結果も小数になり得る。
 * 丸めは呼び出し側の表示処理に委ねる (calc は raw 値を返す)。
 */
function calcBusinessTripTeate(
  staffName: string,
  serviceMonth: string,
  config: CalcConfig,
): number {
  const att = config.attendanceRecords;
  const rate = config.officeTravelUnitPrice ?? 0;
  if (!att || att.length === 0 || !rate) return 0;
  const ym = serviceMonth.slice(0, 7); // YYYY-MM
  let kmSum = 0;
  for (const r of att) {
    if (r.staff_name !== staffName) continue;
    if (!r.work_date) continue;
    if (r.work_date.slice(0, 7) !== ym) continue;
    const km = r.business_km ?? 0;
    if (km > 0) kmSum += km;
  }
  return kmSum * rate;
}

// =====================================================================
// 主要 API
// =====================================================================

/**
 * 提供月 T の給与を内訳に分解。
 *
 * 6 列分解 (2026-05-13):
 *   base = honnin + shokuno + kotei_zangyo   (resolveSetting で算出済)
 *   shikaku / kotei / tokutei は独立加算 (total に直接足す)
 *
 * 3 段階調整 (SPEC §3.2):
 *   inc0 = (same + normal) * rate           // T+1 払いの基準
 *   inc1 = inc0 + late1 * rate              // T+2 払い込み
 *   inc2 = inc1 + late2 * rate              // T+3 払い込み
 *   plan    = max(0, inc0 - base)
 *   chosei1 = max(0, inc1 - base) - max(0, inc0 - base)
 *   chosei2 = max(0, inc2 - base) - max(0, inc1 - base)
 *
 * total = base + plan + kazan + chosei1 + chosei2 + shikaku + kotei + tokutei
 *         + business_trip_teate
 *
 * 出張距離手当 (business_trip_teate, 2026-05-13 追加):
 *   月合計 business_km × office.travel_unit_price (config.officeTravelUnitPrice)
 *   月固定で同月 (T+1) に支払う独立加算。
 */
export function calcSalary(
  records: KyotakuRecord[],
  staffName: string,
  serviceMonth: string,
  config: CalcConfig,
): SalaryBreakdown {
  const { base, ki, si, honnin, shokuno, koteiZ, shikaku, kotei, tokutei } =
    resolveSetting(config.settings, staffName);
  const c = countByDelay(records, staffName, serviceMonth, config.yobouRecords);

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

  const business_trip_teate = calcBusinessTripTeate(
    staffName,
    serviceMonth,
    config,
  );

  // details: 出張km 合計 を再計算 (calcBusinessTripTeate 内では rate と掛け算済の値しか返らないため)
  const att = config.attendanceRecords;
  const ym = serviceMonth.slice(0, 7);
  let kmSum = 0;
  if (att) {
    for (const r of att) {
      if (r.staff_name !== staffName) continue;
      if (!r.work_date) continue;
      if (r.work_date.slice(0, 7) !== ym) continue;
      const km = r.business_km ?? 0;
      if (km > 0) kmSum += km;
    }
  }
  const travelRate = config.officeTravelUnitPrice ?? 0;

  const total =
    base +
    plan +
    kazan +
    chosei1 +
    chosei2 +
    shikaku +
    kotei +
    tokutei +
    business_trip_teate;
  return {
    honnin,
    shokuno,
    kotei_zangyo: koteiZ,
    base,
    shikaku,
    kotei,
    tokutei,
    plan,
    kazan,
    chosei1,
    chosei2,
    business_trip_teate,
    total,
    details: {
      ki,
      si,
      normal_kaigo: n_k,
      normal_shien: n_s,
      late1_kaigo: l1_k,
      late1_shien: l1_s,
      late2_kaigo: l2_k,
      late2_shien: l2_s,
      inc0,
      inc1,
      inc2,
      business_km_total: kmSum,
      travel_unit_price: travelRate,
    },
  };
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
  // staff 限定の全提供月 set (records + yobouRecords の和)
  const serviceMonths = new Set<string>();
  for (const r of records) {
    if (r.staff_name !== staffName) continue;
    if (r.service_month) serviceMonths.add(r.service_month);
  }
  if (config.yobouRecords) {
    for (const yr of config.yobouRecords) {
      if (yr.staff_name !== staffName) continue;
      if (yr.service_month) serviceMonths.add(yr.service_month);
    }
  }

  // attendance も pay_month に対応した提供月を漏らさず舐めるため、attendance だけが
  // ある月 (records / yobou に出てこない月) も serviceMonths に取り込む。
  if (config.attendanceRecords) {
    for (const ar of config.attendanceRecords) {
      if (ar.staff_name !== staffName) continue;
      if (!ar.work_date) continue;
      const ym = ar.work_date.slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(ym)) continue;
      serviceMonths.add(`${ym}-01`);
    }
  }

  let total = 0;
  for (const sm of serviceMonths) {
    const {
      base,
      plan,
      kazan,
      chosei1,
      chosei2,
      shikaku,
      kotei,
      tokutei,
      business_trip_teate,
    } = calcSalary(records, staffName, sm, config);
    // T+1 払い: base (= honnin+shokuno+kotei_zangyo) + plan + kazan
    //          + 独立手当 (shikaku/kotei/tokutei/business_trip_teate) も月固定で同月に支払う
    if (addMonths(sm, 1) === payMonth)
      total +=
        base +
        plan +
        kazan +
        shikaku +
        kotei +
        tokutei +
        business_trip_teate;
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
  const {
    settings,
    units,
    rates,
    yobouRecords,
    attendanceRecords,
    officeTravelUnitPrice,
    confirmations,
  } = config;
  // 性能改善 (2026-06-19): calcSalary は内部で records / yobouRecords /
  // attendanceRecords を毎回 staff_name でフィルタする。calcAdjustments では
  // 同じ staff で複数の serviceMonth に対し calcSalary を繰り返し呼ぶため、
  // 事前に staff 名で 1 回だけ絞った subset を渡すと、内部フィルタは小さい
  // 集合に対する no-op で済み、出力は変わらない (= 同値リファクタ)。
  const staffRecords = records.filter((r) => r.staff_name === staffName);
  const staffYobou = yobouRecords?.filter((y) => y.staff_name === staffName);
  const staffAttendance = attendanceRecords?.filter(
    (a) => a.staff_name === staffName,
  );
  const staffConfig: CalcConfig = {
    settings,
    units,
    rates,
    yobouRecords: staffYobou,
    attendanceRecords: staffAttendance,
    officeTravelUnitPrice,
  };

  // 1) late_adj: T+1 へ流れる過去月の chosei
  const { base, plan, kazan, shikaku, kotei, tokutei, business_trip_teate } =
    calcSalary(staffRecords, staffName, serviceMonth, staffConfig);
  const payMonth = addMonths(serviceMonth, 1);
  const late_adj =
    calcPaymentForMonth(staffRecords, staffName, payMonth, staffConfig) -
    (base +
      plan +
      kazan +
      shikaku +
      kotei +
      tokutei +
      business_trip_teate);

  // 2) sayi_adj: 最新未確定月にのみ集約
  //    最新未確定月 = staff の全提供月を新しい順に走査し、
  //      confirmations[(staff, T+1)] が無い (or amount===0) の最初の T
  const staffMonthsSet = new Set<string>();
  for (const r of staffRecords) {
    if (r.service_month) staffMonthsSet.add(r.service_month);
  }
  if (staffYobou) {
    for (const yr of staffYobou) {
      if (yr.service_month) staffMonthsSet.add(yr.service_month);
    }
  }
  if (staffAttendance) {
    // attendance only ある月も sayi 計算対象に取り込む (出張距離手当 差異検出)
    for (const ar of staffAttendance) {
      if (!ar.work_date) continue;
      const ym = ar.work_date.slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(ym)) continue;
      staffMonthsSet.add(`${ym}-01`);
    }
  }
  const staffMonths = Array.from(staffMonthsSet).sort();

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
      const prev = calcSalary(staffRecords, staffName, prevMonth, staffConfig);
      const diff =
        prev.base +
        prev.plan +
        prev.kazan +
        prev.shikaku +
        prev.kotei +
        prev.tokutei +
        prev.business_trip_teate -
        prevPaid;
      sayi_adj += diff;
    }
  }

  return { late_adj, sayi_adj };
}
