/**
 * check:status-excluded-paid — ② (総括表・支払用) が払っているのに 在職区分の判定で 給与計算から外れる人月を数える (2026-09-27)。読み取りのみ。
 *
 *   npm run check:status-excluded-paid
 *   L2_SNAPSHOT=<json> npm run check:status-excluded-paid      # ② を読み直さない (payroll_soukatsu_rows の写し)
 *   npm run check:status-excluded-paid -- --update             ★ 基準値方式。減ったときだけ使う
 *
 * 判定は 給与計算と同じ関数 (src/lib/payroll/employment-in-month.ts):
 *   isEmployedInMonth で外れる (退職者で 退職日が空 / 月初より前)            … 時給・月給とも
 *   leaveInMonth(...).onLeave で外れる かつ その月の形態が 月給 (休職)       … 月給だけ
 *   ★ いまの職員マスタで判定する = 次に再計算したときに外れる人月 (9/23 の計算結果は見ない)
 *
 * 2026-09-27 の基準値 4 人月:
 *   林 美咲 (1270501180|3290 休職者) 202603〜05 ② ¥703,824 … 休職開始日が入れば 0 になるはず
 *   久保田 明美 (1270501180|250207 退職者・退職日空) 202608 ② ¥39,250 … 旧システムの退職日 2026-07-31。扱いは user 判断
 *
 * 負のコントロール: 在籍の判定を「全員在籍」に壊すと 0 件になり、「全員外す」に壊すと 母数と同じ数になること。
 * 見ていないもの: ② に行が無い人月 (① だけ に出る人は check:soukatsu-row-only) / 職員マスタに居ない番号 /
 *   時給者の休職 (時給は働いた記録で決まるので 在職区分では外さない) / 金額の差 (外れるかどうかだけ)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { restAll } from "./_rest.mjs";
import { isEmployedInMonth, leaveInMonth, monthBounds, type EmploymentFields } from "../src/lib/payroll/employment-in-month.js";

const UPDATE = process.argv.includes("--update");
const BASELINE = new URL("./check-status-excluded-paid-baseline.json", import.meta.url);
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");
const num = (v: unknown) => typeof v === "number" ? v : (typeof v === "string" && /^-?[\d,]+(\.\d+)?$/.test(v.trim()) ? Number(v.replace(/,/g, "")) : 0);
const yen = (n: number) => `¥${Math.round(n).toLocaleString()}`;

console.log("=== check:status-excluded-paid (② が払っているのに 在職区分の判定で外れる人月) ===");

// ── ② ──
type L2 = { office_number: string; employee_number: string; processing_month: string; total: unknown };
const L2_SNAPSHOT = process.env.L2_SNAPSHOT ?? "";
let l2: L2[];
if (L2_SNAPSHOT && existsSync(L2_SNAPSHOT)) {
  l2 = (JSON.parse(readFileSync(L2_SNAPSHOT, "utf8")) as { office_number: string; employee_number: string; processing_month: string; row_data: Record<string, unknown> }[])
    .map((r) => ({ office_number: r.office_number, employee_number: r.employee_number, processing_month: r.processing_month, total: r.row_data["総支給額"] }));
} else {
  l2 = await restAll<L2>("payroll_soukatsu_rows?select=id,office_number,employee_number,processing_month,total:row_data->>総支給額");
}

// ── 職員マスタ (休職の列が無い DB でも動く) ──
type Emp = EmploymentFields & { id: string; employee_number: string; name: string; office_id: string; salary_type: string | null };
const BASE_COLS = "id,employee_number,name,office_id,salary_type,employment_status,resignation_date";
let emps: Emp[];
let hasLeaveCols = true;
try { emps = await restAll<Emp>(`payroll_employees?select=${BASE_COLS},leave_start_date,leave_end_date`); }
catch (e) {
  if (!/leave_start_date|42703/.test(String(e))) throw e;
  hasLeaveCols = false;
  emps = await restAll<Emp>(`payroll_employees?select=${BASE_COLS}`);
}
console.log(`休職の期間の列: ${hasLeaveCols ? "あり" : "まだ無い (payroll_employees_leave_dates.sql 未適用。休職者は全部の月で外れる扱い)"}`);
const offices = await restAll<{ id: string; office_number: string }>("payroll_offices?select=id,office_number");
const sals = await restAll<{ employee_id: string; effective_from: string | null; salary_type: string | null }>("payroll_salary_settings?select=id,employee_id,effective_from,salary_type");
const offNum = new Map(offices.map((o) => [o.id, o.office_number]));
const empBy = new Map<string, Emp>();
for (const e of emps) { const k = `${offNum.get(e.office_id)}|${nn(e.employee_number)}`; if (!empBy.has(k)) empBy.set(k, e); }
const salBy = new Map<string, typeof sals>();
for (const s of sals) salBy.set(s.employee_id, [...(salBy.get(s.employee_id) ?? []), s]);
/** その月の形態 (月初までに始まった最後の給与設定の行 → 無ければ職員マスタ)。page.tsx の buildActiveSalaryMap + resolveEmploymentType と同じ考え方 */
const salaryTypeAt = (e: Emp, ym: string) => {
  const ms = monthBounds(ym).start;
  return (salBy.get(e.id) ?? []).filter((s) => !s.effective_from || s.effective_from <= ms)
    .sort((a, b) => String(a.effective_from ?? "").localeCompare(String(b.effective_from ?? ""))).at(-1)?.salary_type || e.salary_type || "";
};

type Hit = { key: string; name: string; why: string; l2: number };
function run(employed: (e: Emp, ym: string) => boolean, onLeave: (e: Emp, ym: string) => boolean) {
  const hits: Hit[] = []; let denom = 0, noMaster = 0;
  for (const r of l2) {
    const t = num(r.total); if (t <= 0) continue;
    denom++;
    const e = empBy.get(`${r.office_number}|${nn(r.employee_number)}`);
    if (!e) { noMaster++; continue; }
    const ym = r.processing_month, key = `${r.office_number}|${nn(r.employee_number)}|${ym}`;
    if (!employed(e, ym)) hits.push({ key, name: e.name, why: `退職 (退職日 ${e.resignation_date ?? "空"})`, l2: t });
    else if (salaryTypeAt(e, ym) === "月給" && onLeave(e, ym)) hits.push({ key, name: e.name, why: `${e.employment_status} (開始日 ${e.leave_start_date ?? (hasLeaveCols ? "空" : "列なし")})`, l2: t });
  }
  return { hits, denom, noMaster };
}

const real = run(isEmployedInMonth, (e, ym) => leaveInMonth(e, ym).onLeave);
console.log(`母数: ② の総支給 > 0 の行 ${real.denom} (うち職員マスタに居ない ${real.noMaster} は対象外)`);
// 負のコントロール
{
  const none = run(() => true, () => false).hits.length;
  const all = run(() => false, () => true).hits.length;
  const okNc = none === 0 && all === real.denom - real.noMaster;
  console.log(`負のコントロール: 全員在籍 → ${none} 件 (期待 0) / 全員外す → ${all} 件 (期待 ${real.denom - real.noMaster})  ${okNc ? "o" : "★ FAIL"}`);
  if (!okNc) process.exit(1);
}

console.log(`\n外れる人月: ${real.hits.length} / ② ${yen(real.hits.reduce((s, h) => s + h.l2, 0))}`);
for (const h of real.hits.sort((a, b) => a.key.localeCompare(b.key))) console.log(`  ${h.key} ${h.name} ${h.why} ② ${yen(h.l2)}`);

const cur = { count: real.hits.length, keys: real.hits.map((h) => h.key).sort() };
if (UPDATE || !existsSync(BASELINE)) {
  writeFileSync(BASELINE, JSON.stringify({
    _readme: "② が払っているのに 在職区分の判定で給与計算から外れる人月。★ 増えたら FAIL。"
      + " 2026-09-27 の 4 件 = 林 美咲 202603〜05 (休職者。休職開始日が入れば 0 になるはず) / 久保田 明美 202608 (退職者・退職日空。旧の退職日 2026-07-31。扱いは user 判断)。"
      + " ★ 減ったときだけ --update。増えたまま --update しない",
    ...cur,
  }, null, 2) + "\n");
  console.log(`基準値を${UPDATE ? "更新" : "作成"}しました`);
} else {
  const b = JSON.parse(readFileSync(BASELINE, "utf8")) as typeof cur;
  const added = cur.keys.filter((k) => !b.keys.includes(k)), gone = b.keys.filter((k) => !cur.keys.includes(k));
  for (const k of gone) console.log(`  o 基準値から消えた: ${k} (中身を見てから --update)`);
  for (const k of added) console.log(`  ★ FAIL 新しく外れる: ${k}`);
  console.log(added.length ? `★ 基準値より悪化 ${added.length} 件` : "o 基準値から悪化なし");
  if (added.length) process.exitCode = 1;
}
console.log("\n見ていないもの: ② に行が無い人月 (check:soukatsu-row-only) / 職員マスタに居ない番号 / 時給者の休職 / 金額の差");
