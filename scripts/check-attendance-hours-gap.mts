/**
 * 出勤簿の「勤務時間の欄」と「終了−開始−休憩」の食い違いを出す (2026-09-23)。
 *
 *   npx tsx scripts/check-attendance-hours-gap.mts            # 2026 年ぶん
 *   YEAR=2026 MONTH=6 npx tsx scripts/check-attendance-hours-gap.mts
 *
 * 当システムは 終了−開始−休憩 を正とする (user 2026-09-23)。欄は手入力で実態と合わない日がある
 * (ちはら台 鎗田裕子 2026-06: 8:00-18:00 休1:00 = 9時間 なのに欄は 8:00 が 20 日)。
 * 総括表は欄を拾っているので、この一覧がそのまま「総括表とのずれの理由」になる。
 * ⚠ これは 落ちる検査ではない (差があること自体は想定内)。件数と内訳を見るためのもの。
 */
import { readFileSync } from "node:fs";

const env: Record<string, string> = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY };
const YEAR = Number(process.env.YEAR ?? 2026);
const MONTH = process.env.MONTH ? Number(process.env.MONTH) : null;

type Row = {
  office_number: string; employee_number: string; employee_name: string;
  year: number; month: number; day: number;
  start_time_1: string | null; end_time_1: string | null; break_time: string | null; work_hours: string | null;
  start_time_2?: string | null; end_time_2?: string | null;
};

const get = async (q: string): Promise<Row[]> => {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${q}&order=id`, { headers: { ...H, Range: `${from}-${from + 999}` } });
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(JSON.stringify(j));
    out.push(...(j as Row[]));
    if (j.length < 1000) break;
  }
  return out;
};
const hm = (s: string | null | undefined): number => {
  if (!s || !String(s).trim()) return 0;
  const t = String(s).trim();
  if (!t.includes(":")) { const n = parseFloat(t); return isNaN(n) ? 0 : Math.round(n * 60); }
  const [h, m] = t.split(":").map(Number);
  const v = (h || 0) * 60 + (m || 0);
  return v >= 1440 ? 0 : v;
};
const clock = (s: string | null | undefined): number | null => {
  if (!s || !String(s).trim()) return null;
  const m = /^(\d{1,2}):+(\d{1,2})/.exec(String(s).trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

const cols = "office_number,employee_number,employee_name,year,month,day,start_time_1,end_time_1,start_time_2,end_time_2,break_time,work_hours";
const rows = await get(`payroll_attendance_records?select=${cols}&year=eq.${YEAR}${MONTH ? `&month=eq.${MONTH}` : ""}`);

type Agg = { name: string; days: number; fromTimes: number; fromColumn: number };
const byEmp = new Map<string, Agg>();
let changed = 0, unreadable = 0;
for (const r of rows) {
  let span = 0, ranges = 0;
  for (const i of [1, 2]) {
    const st = clock(r[`start_time_${i}` as keyof Row] as string | null);
    const en = clock(r[`end_time_${i}` as keyof Row] as string | null);
    if (st == null || en == null) continue;
    span += (en >= st ? en : en + 1440) - st;
    ranges++;
  }
  const found = ranges > 0;
  // 時間帯が 2 つ以上の日は その間が休憩なので 休憩欄を引かない (payroll-calc.ts と同じ)
  const fromTimes = !found ? 0 : ranges >= 2 ? span : Math.max(0, span - hm(r.break_time));
  const fromColumn = hm(r.work_hours);
  if (!found && fromColumn === 0 && String(r.start_time_1 ?? "").trim()) unreadable++;
  if (!found || fromTimes === fromColumn) continue;
  changed++;
  const k = `${r.office_number}|${r.employee_number}|${r.year}/${String(r.month).padStart(2, "0")}`;
  const a = byEmp.get(k) ?? { name: r.employee_name, days: 0, fromTimes: 0, fromColumn: 0 };
  a.days++; a.fromTimes += fromTimes; a.fromColumn += fromColumn;
  byEmp.set(k, a);
}

const list = [...byEmp.entries()]
  .map(([k, a]) => ({ k, ...a, diff: a.fromTimes - a.fromColumn }))
  .sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
const plus = list.filter((x) => x.diff > 0).reduce((s, x) => s + x.diff, 0);
const minus = list.filter((x) => x.diff < 0).reduce((s, x) => s + x.diff, 0);

console.log(`=== 出勤簿: 欄と 終了−開始−休憩 の食い違い (${YEAR}年${MONTH ? `${MONTH}月` : ""}) ===`);
console.log(`対象 ${rows.length} 行 / 食い違う日 ${changed} / 人月 ${list.length}`);
console.log(`合計 時刻から ${plus} 分 多い / ${minus} 分 少ない (当システムは時刻を正とする)`);
console.log("\n差の大きい人月 (上位 20)");
for (const x of list.slice(0, 20)) {
  const [off, num, ym] = x.k.split("|");
  console.log(`  ${off} ${ym} ${x.name} (${num}) ${x.days}日 時刻 ${x.fromTimes}分 / 欄 ${x.fromColumn}分 → ${x.diff > 0 ? "+" : ""}${x.diff}分`);
}
if (unreadable > 0) console.log(`\n⚠ 開始・終了が読めず 欄も 0 の日: ${unreadable} 件 (その日は 0 分になる)`);
