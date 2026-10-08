/**
 * 有給の付与日数・日当・繰越の決まり (2026-10-08)。純関数だけ。
 *
 * Box 03_有給/<法人>/<年度>/00_<法人>_有給データ.xlsm の式を逆算したもの (5 法人で式は同じ)。
 *   KT 16 事業所 2026-04 付与 421 名で 付与日数 414 (98.3%) / 日当 400 (95.0%) を再現 (外れは入力側の欠け)。
 *   詳細は memory payroll_paid_leave_grant_rules。
 * ★ Excel の「手修正の傾向」(入浴月給者・途中で支払形態が変わった人 など) は 規則にしていない。
 *   提案の画面で 警告として出し 人が決める。
 */

/** 付与年度ごとの基準日数 (入社 1〜9 月)。index = 付与の年 − 入社の年。6 以上は 20 */
export const BASE_DAYS_JAN_SEP = [10, 11, 12, 14, 16, 18, 20] as const;
/** 入社 10〜12 月は 初回が翌年になるので 1 年ずれる。7 以上は 20 */
export const BASE_DAYS_OCT_DEC = [0, 10, 11, 12, 14, 16, 18, 20] as const;

/** 職種の区分 (年間稼働日数の表の行) */
export type PaidLeaveJobCategory = "ヘルパー" | "入浴" | "ケアマネ" | "看護師" | "福祉用具" | "事務" | "薬局";

/**
 * 年間稼働日数 (前年 4/1〜3/31)。KT・至誠堂は お盆・年末年始も控除 (236/237)、他の 3 法人は まだ (239/242)。
 * ★ 2026 年の付与用の値。年が変わると 祝日の数で変わるので 年ごとに足す
 */
export const ANNUAL_WORK_DAYS_2026: Record<"KT・至誠堂" | "儀八・サービスワン・ムツミ", Record<PaidLeaveJobCategory, number>> = {
  "KT・至誠堂": { ヘルパー: 261, 入浴: 259, ケアマネ: 236, 看護師: 236, 福祉用具: 236, 事務: 236, 薬局: 237 },
  "儀八・サービスワン・ムツミ": { ヘルパー: 261, 入浴: 259, ケアマネ: 239, 看護師: 239, 福祉用具: 239, 事務: 239, 薬局: 242 },
};

/** 法人名 → 年間稼働日数の表のどちらか */
export function annualDaysGroupOf(companyName: string | null | undefined): keyof typeof ANNUAL_WORK_DAYS_2026 {
  const n = (companyName ?? "").normalize("NFKC");
  return /ケイ・?ティ|ＫＴ|KT|至誠堂/.test(n) ? "KT・至誠堂" : "儀八・サービスワン・ムツミ";
}

/** 事業所の種別 → 職種の区分 (KT の所属名の決め方 「居宅」→ケアマネ・「入浴」→入浴・他→ヘルパー に合わせる) */
export function jobCategoryOfOfficeType(officeType: string | null | undefined): PaidLeaveJobCategory {
  switch (officeType) {
    case "居宅介護支援": return "ケアマネ";
    case "訪問入浴": return "入浴";
    case "訪問看護": return "看護師";
    case "福祉用具貸与": return "福祉用具";
    case "薬局": return "薬局";
    case "本社": return "事務";
    default: return "ヘルパー";
  }
}

/** 基準日数。hireDate 'YYYY-MM-DD'、grantDate 'YYYY-MM-DD' (付与日の年で数える) */
export function baseGrantDays(hireDate: string, grantDate: string): number {
  const hy = Number(hireDate.slice(0, 4)), hm = Number(hireDate.slice(5, 7));
  const diff = Number(grantDate.slice(0, 4)) - hy;
  if (diff < 0) return 0;
  const table = hm >= 10 ? BASE_DAYS_OCT_DEC : BASE_DAYS_JAN_SEP;
  return table[Math.min(diff, table.length - 1)];
}

/** 初回の付与日 = 入社日 + 6 か月 (Excel EDATE: 月末に丸める) */
export function firstGrantDate(hireDate: string): string {
  const y = Number(hireDate.slice(0, 4)), m = Number(hireDate.slice(5, 7)), d = Number(hireDate.slice(8, 10));
  const t = new Date(Date.UTC(y, m - 1 + 6, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}

/** Excel の ROUND (0.5 は切り上げ。負の数は扱わない) */
export const excelRound = (x: number) => Math.floor(x + 0.5 + 1e-9);

export type GrantKind = "初回" | "前年度途中入社" | "通常";

/**
 * 付与の種類。grantDate が 4/1 の一斉付与なら 入社日で 通常 / 前年度途中入社 を分ける。
 * 4/1 以外 (= 入社 + 6 か月) は 初回
 */
export function grantKindOf(hireDate: string, grantDate: string): GrantKind {
  if (grantDate.slice(5) !== "04-01") return "初回";
  const gy = Number(grantDate.slice(0, 4));
  if (hireDate >= `${gy - 1}-10-01`) return "初回";
  if (hireDate >= `${gy - 2}-10-01`) return "前年度途中入社";
  return "通常";
}

export type GrantCalcInput = {
  kind: GrantKind;
  /** 付与時点の支払形態 */
  salaryType: "月給" | "時給";
  baseDays: number;
  annualDays: number;
  /** 期間 (通常・途中入社 = 前年 4〜3 月 / 初回 = 入社月から 6 か月) の 稼働日数の合計 */
  workDaysTotal: number;
  /** 稼働日数のデータがある月の数 (途中入社の分母に使う) */
  monthsWithData: number;
  /** 期間の 金額の合計 (日当の元) */
  amountTotal: number;
};

export type GrantCalcResult = { rate: number | null; grantDays: number; dailyRate: number | null };

/** 稼働率・付与日数・日当 */
export function calcGrant(i: GrantCalcInput): GrantCalcResult {
  if (i.workDaysTotal <= 0 || i.baseDays <= 0) return { rate: null, grantDays: 0, dailyRate: null };
  const denom = i.kind === "初回" ? i.annualDays / 2
    : i.kind === "前年度途中入社" ? (i.annualDays / 12) * i.monthsWithData
    : i.annualDays;
  const rate = denom > 0 ? i.workDaysTotal / denom : null;
  let grantDays: number;
  if (i.salaryType === "月給") {
    grantDays = rate == null ? i.baseDays : rate > 0.8 ? i.baseDays : rate < 0.4 ? 1 : excelRound((i.baseDays * 2) / 3);
  } else if (i.kind === "初回") {
    grantDays = Math.min(excelRound((i.baseDays * i.workDaysTotal) / (i.annualDays / 2)), i.baseDays);
  } else {
    // 途中入社でも分母は年間 (月数で按分しない) = Excel のまま
    grantDays = Math.min(excelRound((i.baseDays * i.workDaysTotal) / i.annualDays), i.baseDays);
  }
  const dailyRate = grantDays > 0 ? excelRound(i.amountTotal / i.workDaysTotal) : null;
  return { rate, grantDays, dailyRate };
}

/**
 * 前年度繰越 = MIN(前年度付与, 前年度繰越 + 前年度付与 − 前年度消化)。0 未満は 0。
 * ★ Excel は 前年度の繰越欄が空だと 消化を引かずに満額繰越す (バグ)。ここは 正しい式で出す
 */
export function carryOverDays(prevGrantDays: number, prevCarryDays: number, prevUsed: number): number {
  return Math.max(0, Math.min(prevGrantDays, prevCarryDays + prevGrantDays - prevUsed));
}

/**
 * 1 か月の 稼働日数 = 出勤日数 + 有給日数 + 特休日数 (給与集計表の列の足し算。半休は足さない)。
 * 2026-10-08 実測 (KT 2026-03〜06 / 883 人月): この形が Box 有給基礎の稼働日数と 670 件 (76%) 一致で最多
 *   (半休 0.5 を足すと 618)。残りは 出勤日数そのものが 旧システムと ±0.5〜1 日違う (入力の差)
 */
export function monthWorkDays(s: { workDays?: number | null; paidLeave?: number | null; specialLeave?: number | null }): number {
  return Number(s.workDays ?? 0) + Number(s.paidLeave ?? 0) + Number(s.specialLeave ?? 0);
}

/** 給与計算の結果 (payroll_calc_results.payload) の 1 人ぶん → その月の 稼働日数・金額 */
export type GrantMonthInput = { days: number; amount: number | null; salaryType: "月給" | "時給"; note?: string };

/**
 * 時給者の金額 = 税法上支給額 = 総支給 − 通勤費 − 出張費 (通信手当は課税)。
 *   2026-10-08 実測: KT 時給者 544 人月で Box 有給基礎と 430 件一致 (残りは総支給そのものの差)
 * 月給者の金額 = 調整手当 (介護超過 + 事務員の訪問分 + 夜朝 + 特日。verification-items の「調整手当(内訳計)」と同じ)。
 *   ただし 固定残業代がある人・部門が介護でない人は 空 (ムツミは部門の条件なし)。居宅は時給者も月給者も 空
 */
export function grantAmountOf(
  kind: "時給" | "月給",
  e: { grand_total?: number | null; commute_fee?: number | null; business_trip_fee?: number | null },
  monthlyAdjustment: number,
  fixedOvertimePay: number,
  officeType: string,
  isMutsumi: boolean,
): number | null {
  if (officeType === "居宅介護支援") return null;
  if (kind === "時給") return Number(e.grand_total ?? 0) - Number(e.commute_fee ?? 0) - Number(e.business_trip_fee ?? 0);
  if (fixedOvertimePay > 0) return null;
  if (!isMutsumi && officeType !== "訪問介護") return null;
  return monthlyAdjustment;
}
