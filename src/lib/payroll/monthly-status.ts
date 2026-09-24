// 給与の月次ステータスと 確定後の過誤 (2026-09-24 user)
//
// 訪問介護の給与には 確定 (ロック) の概念が無く、誰でもいつでも再計算で上書きできた。
// 本稼働では 支給後にマスタを直すと 過去月の金額が黙って変わる。
//
// user の方針:
//   「確定した後に計算しなおして差額が出たら 過誤で翌月や翌々月で清算」
//   → 確定した月の金額は **動かさない**。差額は後の月の 調整手当 (adjustment) に乗せる。
//   旧システムの総括表も同じ形で、「調整手当」「先月の調整手当」「誤差」の列がある。

/** 事業所 × 処理月 の状態 */
export const MONTHLY_STATUSES = ["未着手", "取込済", "計算済", "確認済", "確定"] as const;
export type MonthlyStatus = (typeof MONTHLY_STATUSES)[number];

/** その状態で 給与計算の結果を上書きしてよいか */
export function canOverwriteResult(status: MonthlyStatus): boolean {
  return status !== "確定";
}

/** 次に進める状態 (人が押せるもの)。自動で進む 取込済・計算済 は含めない */
export function nextManualStatus(status: MonthlyStatus): MonthlyStatus | null {
  if (status === "計算済") return "確認済";
  if (status === "確認済") return "確定";
  return null;
}

/** 確定を解除できるか。解除は必ず理由を残す */
export function canRevert(status: MonthlyStatus): boolean {
  return status === "確定";
}

/** 1 円以下は同じとみなす (端数の丸め) */
export const SETTLEMENT_TOLERANCE = 1;

export type ConfirmedTotal = {
  employee_number: string;
  employee_name?: string | null;
  grand_total: number;
};

export type Discrepancy = {
  employee_number: string;
  employee_name: string | null;
  confirmed_total: number;
  recalculated_total: number;
  /** recalculated − confirmed。プラス = 払い足りない / マイナス = 払いすぎ */
  difference: number;
  kind: "不足" | "過払い" | "確定後に増えた人" | "確定後に消えた人";
};

/**
 * 確定した金額と 計算し直した金額を突き合わせて 過誤を出す。
 *
 * ⚠ 人の増減も拾う。確定後に職員が足された / 実績が入った場合は
 *   「確定後に増えた人」として満額が差額になる。黙って落とすと 払い漏れになる。
 */
export function findDiscrepancies(
  confirmed: ConfirmedTotal[],
  recalculated: ConfirmedTotal[],
): Discrepancy[] {
  const norm = (s: string) => String(s ?? "").replace(/^0+/, "");
  const cMap = new Map(confirmed.map((c) => [norm(c.employee_number), c]));
  const rMap = new Map(recalculated.map((r) => [norm(r.employee_number), r]));
  const out: Discrepancy[] = [];
  for (const [k, r] of rMap) {
    const c = cMap.get(k);
    if (!c) {
      if (Math.abs(r.grand_total) <= SETTLEMENT_TOLERANCE) continue;
      out.push({ employee_number: r.employee_number, employee_name: r.employee_name ?? null,
        confirmed_total: 0, recalculated_total: r.grand_total, difference: r.grand_total, kind: "確定後に増えた人" });
      continue;
    }
    const d = r.grand_total - c.grand_total;
    if (Math.abs(d) <= SETTLEMENT_TOLERANCE) continue;
    out.push({ employee_number: r.employee_number, employee_name: r.employee_name ?? c.employee_name ?? null,
      confirmed_total: c.grand_total, recalculated_total: r.grand_total, difference: d, kind: d > 0 ? "不足" : "過払い" });
  }
  for (const [k, c] of cMap) {
    if (rMap.has(k)) continue;
    if (Math.abs(c.grand_total) <= SETTLEMENT_TOLERANCE) continue;
    out.push({ employee_number: c.employee_number, employee_name: c.employee_name ?? null,
      confirmed_total: c.grand_total, recalculated_total: 0, difference: -c.grand_total, kind: "確定後に消えた人" });
  }
  return out.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
}

/** 'YYYYMM' の n か月後 */
export function addMonths(yyyymm: string, n: number): string {
  const y = Number(yyyymm.slice(0, 4)), m = Number(yyyymm.slice(4, 6));
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}${String((t % 12) + 1).padStart(2, "0")}`;
}

/**
 * 清算月の既定 = 差額が出た月の翌月。
 * ただし 翌月も確定済みなら さらに次へ送る (確定した月は動かさないため)。
 */
export function defaultSettlementMonth(
  originMonth: string,
  isConfirmed: (yyyymm: string) => boolean,
  maxAhead = 12,
): string {
  for (let i = 1; i <= maxAhead; i++) {
    const m = addMonths(originMonth, i);
    if (!isConfirmed(m)) return m;
  }
  return addMonths(originMonth, maxAhead);
}
