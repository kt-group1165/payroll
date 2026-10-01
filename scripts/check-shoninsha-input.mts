/**
 * check:shoninsha-input — ★ ② に初任者研修費があるのに 当方の研修時間が 入っていない / 違う 人月を出す (2026-10-01 新設)
 *
 *   npm run check:shoninsha-input
 *   PAYROLL_ENV=staging npm run check:shoninsha-input
 *   npm run check:shoninsha-input -- --update        ★ 基準値を更新 (減ったときだけ使う)
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────────
 * 初任者研修は **訪問ではない**ので MEISAI (稼働) にも 訪問カレンダー (スキャン) にも出ない。
 * ★ 事業所書式か 月次手入力 (shoninsha_training_minutes) にしか入る場所が無く、
 *   ★ 入れ忘れても **どこにも警告が出ない**。実際に 10 人月 ¥161,575 埋まっていた。
 *
 * ★ 発端: 江波戸祐子 (山武 202607)。総支給の差 ¥73,565 の最大要因を
 *   当初「MEISAI の再出力が要る」と誤診した。★ 実際は 訪問が 1 件も無い月で、
 *   ② の 出勤時間 3,030分 × 1,150円/h = 初任者研修費 58,075 と 1 円まで一致していた。
 *   ★ 当方の入力は 60分。★ MEISAI は正しく Box にあった。
 *
 * ── 何を見るか ────────────────────────────────────────────────────────────
 *   ② の「初任者研修費」> 0 の人月で、当方の shoninsha_pay と 1 円を超えて食い違うもの。
 *   ★ 2 つに分けて出す:
 *     A 当方が不足   … 入力が無い / 値が違う (★ 事業所に受講記録を確認して入れる)
 *     B 当方が多い   … 事業所書式にデータはあり 時間が少し多い (細かいズレ)
 *
 * ⚠ ② の値だけを根拠に埋めてはいけない (feedback_two_sources_before_filling_input)。
 *   ★ この検査は「どこを確認しに行くか」を出すもの。★ 埋めるのは 受講記録で裏が取れてから。
 *
 * ★ 基準値方式。★ 入力が進めば減る。増えたら落ちる。
 *
 * 負のコントロール: ① 当方を 0・② を大きくすると A が増える
 *                   ② ② の 1 件を 0 にすると 対象から外れて 合計が 1 減る
 *                   ③ 1 円の差は拾わない
 */
import { readFileSync, writeFileSync } from "node:fs";
import { restAll, normEmpNo, SB_REF } from "./_rest.mjs";
import { pickSoukatsu } from "../src/lib/payroll/soukatsu-diff.js";
import { TRAINING_RATE_PER_HOUR } from "../src/lib/payroll/payroll-calc.js";

const UPDATE = process.argv.includes("--update");
const BASELINE = new URL("./check-shoninsha-input-baseline.json", import.meta.url);
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);

type Calc = { office_number: string; processing_month: string; payload: Record<string, unknown> };
type Souk = { office_number: string; processing_month: string; employee_number: string; row_data: Record<string, unknown> };
const calc = await restAll<Calc>("payroll_calc_results?select=id,office_number,processing_month,payload");
const souk = await restAll<Souk>("payroll_soukatsu_rows?select=id,office_number,processing_month,employee_number,row_data&sheet_kind=eq.part");
const sOf = new Map(souk.map((s) => [`${s.office_number}|${s.processing_month}|${normEmpNo(s.employee_number)}`, s]));
const inp = await restAll<{ office_number: string; processing_month: string; employee_number: string; numeric_value: number }>(
  "payroll_monthly_inputs?select=id,office_number,processing_month,employee_number,numeric_value&item_key=eq.shoninsha_training_minutes");
const inpOf = new Map(inp.map((r) => [`${r.office_number}|${r.processing_month}|${normEmpNo(r.employee_number)}`, r.numeric_value]));
const offs = await restAll<{ office_number: string; office_id: string }>("payroll_offices?select=id,office_number,office_id");
const oName = new Map((await restAll<{ id: string; name: string }>("offices?select=id,name")).map((o) => [o.id, o.name]));
const nameOf = (on: string) => oName.get(offs.find((o) => o.office_number === on)?.office_id ?? "") ?? on;

type Row = { month: string; name: string; off: string; s2: number; ours: number; needMin: number; haveMin: number | null };
/** mutate: 負のコントロール用。(ours, s2) を書き換える */
function measure(mutate?: (v: { ours: number; s2: number }, i: number) => void): { A: Row[]; B: Row[] } {
  const A: Row[] = [], B: Row[] = [];
  let i = 0;
  for (const c of calc) for (const e of (c.payload.hourly ?? []) as Record<string, unknown>[]) {
    const n = normEmpNo(String(e.employee_number ?? ""));
    const s = sOf.get(`${c.office_number}|${c.processing_month}|${n}`); if (!s) continue;
    const v = { ours: num(e.shoninsha_pay), s2: pickSoukatsu(s.row_data, "初任者研修費") };
    mutate?.(v, i++);
    if (v.s2 <= 0) continue;
    if (Math.abs(v.ours - v.s2) <= 1) continue;
    const row: Row = {
      month: c.processing_month,
      name: String(e.employee_name ?? "").replace(/\s+/g, " ").slice(0, 10),
      off: nameOf(c.office_number), s2: Math.round(v.s2), ours: Math.round(v.ours),
      needMin: Math.round((v.s2 / TRAINING_RATE_PER_HOUR) * 60),
      haveMin: inpOf.get(`${c.office_number}|${c.processing_month}|${n}`) ?? null,
    };
    (v.ours < v.s2 ? A : B).push(row);
  }
  return { A, B };
}

console.log("=== check:shoninsha-input (② に初任者研修費があるのに 当方の時間が無い/違う) 2026-10-01 新設・読み取り専用 ===");
const { A, B } = measure();
const yen = (rs: Row[]) => rs.reduce((a, r) => a + Math.abs(r.s2 - r.ours), 0);
console.log(`  [${SB_REF}] 合計 ${A.length + B.length} 人月 / 差の計 ¥${(yen(A) + yen(B)).toLocaleString()}`);
console.log("");
console.log(`── A 当方が不足 (★ 事業所に受講記録を確認して入れる): ${A.length} 人月 / ¥${yen(A).toLocaleString()}`);
for (const r of A.sort((a, b) => (b.s2 - b.ours) - (a.s2 - a.ours))) {
  const have = r.haveMin === null ? "(無し)" : `${r.haveMin}分`;
  console.log(`   ${r.month} ${r.name.padEnd(12)} ${r.off.padEnd(26)} ② ¥${String(r.s2).padStart(6)} / 当方 ¥${String(r.ours).padStart(6)}  ② が示す時間 ${String(r.needMin).padStart(5)}分  当方の入力 ${have}`);
}
console.log("");
console.log(`── B 当方のほうが多い (書式にデータはある。細かいズレ): ${B.length} 人月 / ¥${yen(B).toLocaleString()}`);
for (const r of B.sort((a, b) => (b.ours - b.s2) - (a.ours - a.s2))) {
  console.log(`   ${r.month} ${r.name.padEnd(12)} ${r.off.padEnd(26)} ② ¥${String(r.s2).padStart(6)} / 当方 ¥${String(r.ours).padStart(6)}  差 ${Math.round(((r.ours - r.s2) / TRAINING_RATE_PER_HOUR) * 60)}分`);
}

console.log("");
console.log("--- 負のコントロール");
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };
let bumped = false;
const c1 = measure((v) => { if (!bumped && v.s2 === 0 && v.ours === 0) { v.s2 = 100000; bumped = true; } });
expect(c1.A.length === A.length + 1, `研修費 0 の 1 件を ② 10 万にすると A が 1 増える (${A.length} → ${c1.A.length})`);
let zeroed = false;
const c2 = measure((v) => { if (!zeroed && v.s2 > 0 && Math.abs(v.ours - v.s2) > 1) { v.s2 = 0; zeroed = true; } });
expect(c2.A.length + c2.B.length === A.length + B.length - 1, `② の 1 件を 0 にすると 対象から外れる (${A.length + B.length} → ${c2.A.length + c2.B.length})`);
let nudged = false;
const c3 = measure((v) => { if (!nudged && v.s2 > 0 && Math.abs(v.ours - v.s2) <= 1) { v.ours = v.s2 + 1; nudged = true; } });
expect(c3.A.length + c3.B.length === A.length + B.length, `1 円の差は拾わない (${A.length + B.length} のまま ${c3.A.length + c3.B.length})`);

console.log("");
console.log("--- 基準値");
const total = A.length + B.length;
if (UPDATE) {
  const cur = JSON.parse(readFileSync(BASELINE, "utf8")) as { _readme: string[]; total: number; A: number; B: number };
  cur.total = total; cur.A = A.length; cur.B = B.length;
  writeFileSync(BASELINE, JSON.stringify(cur, null, 2) + "\n", "utf8");
  console.log(`  基準値を 合計 ${total} (A ${A.length} / B ${B.length}) に更新しました`);
} else {
  const base = JSON.parse(readFileSync(BASELINE, "utf8")) as { total: number; A: number; B: number };
  if (total > base.total) { console.log(`  ★ FAIL 合計が基準値から増えた (${total} > ${base.total})`); fail++; }
  else console.log(`  o 合計 ${total} (基準値 ${base.total})${total < base.total ? "  ★ 減っています。-- --update で基準値を下げてください" : ""}`);
}
console.log("");
console.log(fail ? `★ FAIL ${fail} 件` : "PASS (★ 0 件 PASS ではない。基準値の件数を許容したうえでの PASS)");
process.exit(fail ? 1 : 0);
