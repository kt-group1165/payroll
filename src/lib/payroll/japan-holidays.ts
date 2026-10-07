// japan-holidays.ts
// 日本の祝日を 祝日法の決まりから計算する (2026-10-07。以前は 2024〜2027 年の手書きの表)。
//
// ★ 以前は 表が 2 つあり (ここ と payroll-calc.ts の JAPAN_HOLIDAYS)、給与計算の側には
//   2026-09-22 (国民の休日) と 2027-03-22 (振替休日) が抜けていた。どちらの表も 2028 年以降は空だった。
//   → 表をやめて 決まりから毎年出す。給与計算・勤怠・画面 (設定 → 計算の決まり) は すべてここを使う。
//
// 含む:
//   - 国民の祝日 (16 日)。日付が決まっているもの / 第 n 月曜 (ハッピーマンデー) / 春分・秋分 (天文計算の近似式)
//   - 振替休日 (祝日が日曜 → その後の最初の祝日でない日)
//   - 国民の休日 (祝日と祝日に挟まれた 祝日でない日)
// 含まない:
//   - 年末年始・お盆など 会社の休み (= 会社休日 payroll_company_holidays。設定 → 会社休日)
//
// 対象は 2022 年以降の現行の祝日法 (2020・2021 の五輪の特例は扱わない。給与のデータは 2025 年からなので不要)。
// 春分・秋分の式は 1980〜2099 年で国立天文台の暦要項と一致する近似式。暦要項は前年 2 月に公表されるので、
// ずれた年が出たら check (verify-payroll-calc-boundary の祝日の項) に公表値を足して確かめること。

type Holiday = { date: string; name: string };

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
/** 月の第 n 月曜日 (日) */
function nthMonday(y: number, m: number, n: number): number {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();   // 0=日
  const firstMon = 1 + ((8 - first) % 7);
  return firstMon + (n - 1) * 7;
}
function shunbun(y: number): number {
  return Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
}
function shubun(y: number): number {
  return Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
}

const cache = new Map<number, Map<string, string>>();

/** その年の祝日 (振替休日・国民の休日を含む)。日付 (YYYY-MM-DD) → 名前 */
export function japaneseHolidaysOf(year: number): Map<string, string> {
  const hit = cache.get(year);
  if (hit) return hit;
  const base: Holiday[] = [
    { date: iso(year, 1, 1), name: "元日" },
    { date: iso(year, 1, nthMonday(year, 1, 2)), name: "成人の日" },
    { date: iso(year, 2, 11), name: "建国記念の日" },
    { date: iso(year, 2, 23), name: "天皇誕生日" },
    { date: iso(year, 3, shunbun(year)), name: "春分の日" },
    { date: iso(year, 4, 29), name: "昭和の日" },
    { date: iso(year, 5, 3), name: "憲法記念日" },
    { date: iso(year, 5, 4), name: "みどりの日" },
    { date: iso(year, 5, 5), name: "こどもの日" },
    { date: iso(year, 7, nthMonday(year, 7, 3)), name: "海の日" },
    { date: iso(year, 8, 11), name: "山の日" },
    { date: iso(year, 9, nthMonday(year, 9, 3)), name: "敬老の日" },
    { date: iso(year, 9, shubun(year)), name: "秋分の日" },
    { date: iso(year, 10, nthMonday(year, 10, 2)), name: "スポーツの日" },
    { date: iso(year, 11, 3), name: "文化の日" },
    { date: iso(year, 11, 23), name: "勤労感謝の日" },
  ];
  const m = new Map<string, string>(base.map((h) => [h.date, h.name]));
  const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
  const add = (s: string, days: number) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

  // 国民の休日: 前日と翌日が祝日で、その日は祝日でない (振替休日より先に決める = 祝日法 3 条 3 項は「国民の祝日」に挟まれた日)
  for (const h of base) {
    const mid = add(h.date, 1);
    if (!m.has(mid) && m.has(add(h.date, 2)) && toDate(mid).getUTCDay() !== 0) m.set(mid, "国民の休日");
  }
  // 振替休日: 祝日が日曜 → その後で最初の「祝日でない日」
  for (const h of base) {
    if (toDate(h.date).getUTCDay() !== 0) continue;
    let d = add(h.date, 1);
    while (m.has(d)) d = add(d, 1);
    m.set(d, "振替休日");
  }
  const sorted = new Map([...m].sort((a, b) => a[0].localeCompare(b[0])));
  cache.set(year, sorted);
  return sorted;
}

/** "YYYY-MM-DD" / "YYYYMMDD" / "YYYY/MM/DD" のどれでも受ける */
function normalize(date: string): string | null {
  const digits = date.replace(/[^0-9]/g, "");
  if (digits.length < 8) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

/** 指定日が日本の祝日 (振替休日・国民の休日を含む) か */
export function isJapaneseHoliday(date: string): boolean {
  const d = normalize(date);
  return d ? japaneseHolidaysOf(Number(d.slice(0, 4))).has(d) : false;
}

/** 指定日の祝日名。祝日でなければ null。例: getJapaneseHolidayName("2026-05-05") → "こどもの日" */
export function getJapaneseHolidayName(date: string): string | null {
  const d = normalize(date);
  return d ? japaneseHolidaysOf(Number(d.slice(0, 4))).get(d) ?? null : null;
}
