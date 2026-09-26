/**
 * check:employment-in-month — 在籍・休職の月ごとの判定 (src/lib/payroll/employment-in-month.ts) の検査 (2026-09-27)。読み取りのみ。
 *
 *   npm run check:employment-in-month
 *
 * ① 同値性 (列を足す前): 以前の判定と 全組み合わせで一致すること
 *    以前の判定 = page.tsx の DB 側の条件 .or(employment_status.neq.退職者, resignation_date.gte.<月初>) (★ SQL の NULL の扱いで)
 *               + 月給の条件 (!employment_status || 在職者 || 退職者)
 *    在職区分 7 通り × 退職日 境界まわり × 月 の全組み合わせ
 * ② 実データでの同値性: 202603〜08 の各月で 以前の .or() をそのまま PostgREST に投げた結果 (職員の id の集合) と
 *    全員読んで isEmployedInMonth で絞った集合が 一致すること (★ SQL の NULL・日付比較の解釈違いを実物で確かめる)
 * ③ 休職の境界値 (列を足した後): 開始日 = 月初 / 月の途中 / 前月末 / 翌月初、終了日 = 月末 / 月の途中 / 空、開始日が空
 * ④ 負のコントロール: 退職日の比較を >= から > に壊した判定を ① に通すと 不一致が出ること
 *
 * 見ていないもの: 給与の金額そのもの (★ 判定の入力=職員の集合が同じなら 計算は同じ、までしか示さない) /
 *   過去の月を選んで入力する 5 画面 (monthly-inputs / distance / office-input / 出勤簿 / office-worker-care) は まだ今の状態で絞っている
 */
import { restAll } from "./_rest.mjs";
import { isEmployedInMonth, leaveInMonth, monthBounds, type EmploymentFields } from "../src/lib/payroll/employment-in-month.js";

let fail = 0;
const ok = (c: boolean, msg: string) => { console.log(`  ${c ? "o" : "★ FAIL"} ${msg}`); if (!c) fail++; };

// ── 以前の判定 (page.tsx 2026-09-27 以前) ──
/** DB 側: (st IS NOT NULL AND st <> '退職者') OR (rd IS NOT NULL AND rd >= 月初)。NULL <> x は真にならない */
const oldLoad = (e: EmploymentFields, ym: string) => {
  const start = monthBounds(ym).start;
  return (e.employment_status != null && e.employment_status !== "退職者") || (e.resignation_date != null && e.resignation_date >= start);
};
const oldMonthly = (e: EmploymentFields) => !e.employment_status || e.employment_status === "在職者" || e.employment_status === "退職者";

// ── ① 全組み合わせ ──
console.log("=== check:employment-in-month ===");
const STATUSES = [undefined, null, "", "在職者", "休職者", "退職者", "その他"];
const MONTHS: string[] = [];
for (const y of [2024, 2025, 2026]) for (let m = 1; m <= 12; m++) MONTHS.push(`${y}${String(m).padStart(2, "0")}`);
function resignCandidates(ym: string): (string | null | undefined)[] {
  const { start, end } = monthBounds(ym);
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(4));
  const prevEnd = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
  const nextStart = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  return [undefined, null, prevEnd, start, `${ym.slice(0, 4)}-${ym.slice(4)}-15`, end, nextStart, "2000-01-01", "2099-12-31"];
}
function compare(load: (e: EmploymentFields, ym: string) => boolean, monthly: (e: EmploymentFields, ym: string) => boolean) {
  let n = 0, bad = 0; const samples: string[] = [];
  for (const ym of MONTHS) for (const st of STATUSES) for (const rd of resignCandidates(ym)) {
    const e: EmploymentFields = { employment_status: st, resignation_date: rd };
    n++;
    const a1 = oldLoad(e, ym), b1 = load(e, ym), a2 = oldMonthly(e), b2 = monthly(e, ym);
    if (a1 !== b1 || a2 !== b2) { bad++; if (samples.length < 3) samples.push(`${ym} 状態=${String(st)} 退職日=${String(rd)} 読込 ${a1}→${b1} 月給 ${a2}→${b2}`); }
  }
  return { n, bad, samples };
}
const newMonthly = (e: EmploymentFields, ym: string) => !leaveInMonth(e, ym).onLeave;
{
  const r = compare(isEmployedInMonth, newMonthly);
  ok(r.bad === 0, `① 以前の判定と全組み合わせで一致: ${r.n - r.bad}/${r.n} 通り (在職区分 ${STATUSES.length} × 退職日 9 × ${MONTHS.length} か月)`);
  for (const s of r.samples) console.log(`      ${s}`);
}

// ── ④ 負のコントロール ──
{
  const broken = (e: EmploymentFields, ym: string) =>
    (e.employment_status != null && e.employment_status !== "退職者") || (!!e.resignation_date && e.resignation_date > monthBounds(ym).start);
  const r = compare(broken, newMonthly);
  ok(r.bad > 0, `④ 負のコントロール: 退職日の比較を > に壊すと 不一致 ${r.bad} 通りが出る (0 なら この検査は効いていない)`);
}

// ── ③ 休職の境界値 (列を足した後) ──
{
  const ym = "202605";
  const cases: [string, EmploymentFields, boolean, boolean][] = [
    // [説明, 職員, 外すか, 警告が出るか]
    ["在職者 は外さない", { employment_status: "在職者", leave_start_date: null }, false, false],
    ["休職者・列がまだ無い (undefined) → 以前どおり外す", { employment_status: "休職者" }, true, false],
    ["休職者・開始日が空 → 外さない + 警告", { employment_status: "休職者", leave_start_date: null, leave_end_date: null }, false, true],
    ["開始日 = 月初・終了日 空 → 外す", { employment_status: "休職者", leave_start_date: "2026-05-01", leave_end_date: null }, true, false],
    ["開始日 = 前月末・終了日 = 月末 → 外す", { employment_status: "休職者", leave_start_date: "2026-04-30", leave_end_date: "2026-05-31" }, true, false],
    ["開始日 = 月の途中 → 外さない + 警告", { employment_status: "休職者", leave_start_date: "2026-05-15", leave_end_date: null }, false, true],
    ["終了日 = 月の途中 → 外さない + 警告", { employment_status: "休職者", leave_start_date: "2026-01-01", leave_end_date: "2026-05-20" }, false, true],
    ["開始日 = 翌月初 (休職前の月) → 外さない", { employment_status: "休職者", leave_start_date: "2026-06-01", leave_end_date: null }, false, false],
    ["終了日 = 前月末 (復職後の月) → 外さない", { employment_status: "休職者", leave_start_date: "2026-01-01", leave_end_date: "2026-04-30" }, false, false],
    ["退職者 は休職の判定をしない", { employment_status: "退職者", leave_start_date: "2026-01-01" }, false, false],
  ];
  for (const [label, e, off, warn] of cases) {
    const r = leaveInMonth(e, ym);
    ok(r.onLeave === off && !!r.warning === warn, `③ ${label}: 外す=${r.onLeave} 警告=${r.warning ? "あり" : "なし"}`);
  }
  // 2 月の月末 (閏年)
  ok(monthBounds("202402").end === "2024-02-29" && monthBounds("202602").end === "2026-02-28", "③ 2 月の月末 (閏年 29 日 / 平年 28 日)");
}

// ── ② 実データ: 以前の .or() を PostgREST に投げた集合 と JS の集合 ──
{
  type E = { id: string; employment_status: string | null; resignation_date: string | null };
  const all = await restAll<E>("payroll_employees?select=id,employment_status,resignation_date");
  console.log(`  (職員マスタ ${all.length} 名。在職区分が NULL の行 ${all.filter((e) => e.employment_status == null).length})`);
  for (const ym of ["202603", "202604", "202605", "202606", "202607", "202608"]) {
    const start = monthBounds(ym).start;
    const db = await restAll<{ id: string }>(`payroll_employees?select=id&or=(employment_status.neq.退職者,resignation_date.gte.${start})`);
    const dbSet = new Set(db.map((r) => r.id));
    const js = all.filter((e) => isEmployedInMonth(e, ym));
    const jsSet = new Set(js.map((e) => e.id));
    const onlyDb = [...dbSet].filter((id) => !jsSet.has(id)).length, onlyJs = [...jsSet].filter((id) => !dbSet.has(id)).length;
    ok(onlyDb === 0 && onlyJs === 0, `② ${ym}: DB の .or() ${dbSet.size} 名 / JS ${jsSet.size} 名 (DB だけ ${onlyDb} / JS だけ ${onlyJs})`);
  }
}

console.log(fail ? `\n★ FAIL ${fail} 件` : "\no すべて通過");
console.log("見ていないもの: 金額そのもの (職員の集合が同じ = 計算の入力が同じ、まで) / 過去の月を選んで入力する 5 画面 (まだ今の状態で絞っている)");
if (fail) process.exit(1);
