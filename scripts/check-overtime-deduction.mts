/**
 * check:overtime-deduction — 社員の残業代から引く「120h以上+深夜」(careOvertimeOffsetForOvertime) を ② と比べる (2026-09-27 給与D)。★ 基準値方式・計算は変えない
 *
 *   npm run check:overtime-deduction
 *   SNAPSHOT=<path.json> npm run check:overtime-deduction       # check:soukatsu-cause と同じ形の保存済み取得結果を使う (無ければ取得して保存)
 *   npm run check:overtime-deduction -- --update                ★ 基準値を更新 (先に中身を見ること)
 *
 * ── 見ているもの (2 つの規則の候補。★ どちらも実装していない。user 判断待ち) ─────────────
 *   A  訪問時間が閾値 (介護超過の閾値。通常 120h) に届かない月は、② は深夜分も控除しない
 *      当方は 閾値未満でも 深夜手当 (深夜h × 500) を控除している。
 *      2026-09-27: 該当 2 / 反例 0 (伊井 1273400844|9039|202606 / 渡邉智子 1272400142|765|202603)。
 *      ★ 2 件では規則と決められない。増えたら再検討する。反例 (閾値未満で ② が控除している人月) が出たら規則ではない
 *   B  閾値以上の月の 深夜分の控除単価。(② の控除 − 超過分 × 介護超過単価) ÷ 深夜h を人月ごとに逆算する
 *      2026-09-27: 1272400142 / 1273400844 / 1279000366 は 17/17 が 400 円 (当方は 500 円)。
 *      ★ おゆみ野 1270501180 だけ逆算値がマイナス = 定数ではなく 式が違う (控除の訪問時間に 0.75 換算がかかる?)。
 *      ★ 当方の 500 円の根拠 (峯島 157h) は おゆみ野 の人月。★ 500 は 1 事業所から一般化した値の可能性がある。未解明
 *   金額に出るのは 控除 < 残業代 の人月だけ (多くは 控除が残業代を上回り 当方も ② も 0)。
 *
 * ── 判定 ─────────────────────────────────────────────────────────────
 *   A: 反例が 0 から増えたら ★ FAIL (規則の候補が崩れた = 知らせる)。該当の増減は表示だけ
 *   B: 事業所ごとの逆算値の分布を基準値と比べる。新しい値が出たら FAIL にせず表示 (データが変わった)
 * 負のコントロール: 写しの ② の控除を閾値未満の人月に足すと A の反例が +1 になること
 * 見ていないもの: 提責・事務員 (控除は社員だけ) / 深夜h が 0 の人月 (B は逆算できない) / 時給者
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { restAll } from "./_rest.mjs";
import { careOvertimeOffsetForOvertime, type MonthlyPayroll } from "../src/lib/payroll/payroll-calc.js";
import { soukatsuMinutes } from "../src/lib/payroll/soukatsu-time.js";

const UPDATE = process.argv.includes("--update");
const BASELINE = new URL("./check-overtime-deduction-baseline.json", import.meta.url);
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");
const num = (v: unknown): number => {
  const x = v && typeof v === "object" && "result" in (v as object) ? (v as { result: unknown }).result : v;
  const n = typeof x === "number" ? x : parseFloat(String(x ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

type CalcRow = { office_number: string; processing_month: string; calculated_at: string; payload: { monthly?: MonthlyPayroll[] } | null };
type SRow = { office_number: string; employee_number: string; processing_month: string; sheet_kind: string; row_data: Record<string, unknown> };
type Snap = { calc: CalcRow[]; soukatsu: SRow[] };
let snap: Snap;
const P = process.env.SNAPSHOT ?? "";
if (P && existsSync(P)) snap = JSON.parse(readFileSync(P, "utf8")) as Snap;
else {
  snap = {
    calc: await restAll<CalcRow>("payroll_calc_results?select=id,office_number,processing_month,calculated_at,payload"),
    soukatsu: await restAll<SRow>("payroll_soukatsu_rows?select=id,office_number,employee_number,processing_month,sheet_kind,row_data&sheet_kind=eq.shaseki"),
  };
  if (P) writeFileSync(P, JSON.stringify(snap));
}
const rows = new Map<string, Record<string, unknown>>();
for (const r of snap.soukatsu) if (r.sheet_kind === "shaseki") rows.set(`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, r.row_data);

type P1 = { key: string; office: string; p: MonthlyPayroll; row: Record<string, unknown> };
const pairs: P1[] = [];
for (const c of snap.calc) for (const p of c.payload?.monthly ?? []) {
  if (p.role_type !== "社員") continue;
  const key = `${c.office_number}|${nn(p.employee_number)}|${c.processing_month}`;
  const row = rows.get(key);
  if (row) pairs.push({ key, office: c.office_number, p, row });
}
const calcAt = snap.calc.map((c) => c.calculated_at).sort();
console.log("=== check:overtime-deduction (社員の「120h以上+深夜」 当方 vs ②。★ 計算は変えていない) ===");
console.log(`母数: 社員の対 ${pairs.length} 人月 (計算 ${calcAt[0]} 〜 ${calcAt.at(-1)})`);

function measure(ps: P1[]) {
  const a = { hit: [] as string[], counter: [] as string[] };
  const b: Record<string, Record<string, number>> = {};
  for (const { key, office, p, row } of ps) {
    const sh = p.shinya_hours ?? 0, thr = (p.settings?.care_overtime_threshold_hours ?? 0) * 60, unit = p.settings?.care_overtime_unit_price ?? 0;
    if (!(sh > 0) || !(thr > 0)) continue;
    const l2ded = num(row["120h以上+深夜"]);
    if ((p.summary?.visitMinutes ?? 0) < thr) {
      const ours = careOvertimeOffsetForOvertime(p);
      if (l2ded > 0) a.counter.push(`${key} ② 控除 ${l2ded} / 当方 ${ours}`);
      else if (ours > 0) a.hit.push(`${key} ${p.employee_name} 深夜${sh}h 控除 当方 ${ours} / ② 0`);
      continue;
    }
    if (!(l2ded > 0)) continue;
    const v2 = soukatsuMinutes(row["訪問時間"], "minutes") ?? 0;
    const rate = Math.round((l2ded - Math.round((Math.max(0, v2 - thr) / 60) * unit)) / sh);
    const label = rate === 400 || rate === 500 ? String(rate) : rate < 0 ? "逆算不能 (マイナス)" : `その他 (${rate})`;
    (b[office] ??= {})[label] = (b[office][label] ?? 0) + 1;
  }
  return { a, b };
}
const cur = measure(pairs);
console.log(`\n--- A: 閾値未満の月の深夜控除  該当 (当方だけ控除) ${cur.a.hit.length} / 反例 (② も控除) ${cur.a.counter.length}`);
for (const x of cur.a.hit) console.log(`    該当 ${x}`);
for (const x of cur.a.counter) console.log(`    ★ 反例 ${x}`);
console.log("\n--- B: 閾値以上の月の 深夜分の控除単価 (② から逆算。当方は 500)");
for (const [o, m] of Object.entries(cur.b).sort()) console.log(`  ${o}  ${Object.entries(m).map(([k, v]) => `${k}:${v}`).join(" / ")}`);

console.log("\n--- 負のコントロール");
{
  const t = pairs.find((x) => (x.p.shinya_hours ?? 0) > 0 && (x.p.settings?.care_overtime_threshold_hours ?? 0) > 0
    && (x.p.summary?.visitMinutes ?? 0) < (x.p.settings?.care_overtime_threshold_hours ?? 0) * 60 && !(num(x.row["120h以上+深夜"]) > 0));
  if (!t) expect(false, "壊す元 (閾値未満・深夜あり・② 控除 0) の人月が見つからない");
  else {
    const m = measure(pairs.map((x) => (x === t ? { ...x, row: { ...x.row, "120h以上+深夜": 1000 } } : x)));
    expect(m.a.counter.length === cur.a.counter.length + 1, `② の控除を 1,000 にすると A の反例 +1 (${cur.a.counter.length} → ${m.a.counter.length})`);
  }
}

type Baseline = { _readme: string[]; pairs: number; a: { hit: number; counter: number }; b: Record<string, Record<string, number>> };
const baseline: Baseline | null = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline : null;
console.log("\n--- 基準値");
if (UPDATE || !baseline) {
  writeFileSync(BASELINE, JSON.stringify({ _readme: baseline?._readme ?? [], pairs: pairs.length, a: { hit: cur.a.hit.length, counter: cur.a.counter.length }, b: cur.b }, null, 2) + "\n", "utf8");
  console.log("  基準値を保存しました");
} else {
  expect(cur.a.counter.length <= baseline.a.counter, `A の反例 ${baseline.a.counter} → ${cur.a.counter.length}${cur.a.counter.length > baseline.a.counter ? "  ★ 規則の候補が崩れた" : ""}`);
  if (cur.a.hit.length !== baseline.a.hit) console.log(`  (A の該当 ${baseline.a.hit} → ${cur.a.hit.length}。増えたら規則として再検討できる)`);
  if (JSON.stringify(cur.b) !== JSON.stringify(baseline.b)) console.log(`  (B の分布が基準値と違う = データが変わった。中身を見てから --update)\n    基準 ${JSON.stringify(baseline.b)}`);
  if (baseline.pairs !== pairs.length) console.log(`  (母数 ${baseline.pairs} → ${pairs.length})`);
}
console.log("\n見ていないもの: 提責・事務員 / 深夜h 0 の人月 / 時給者 / おゆみ野の控除の式 (未解明)");
console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS");
process.exit(fail ? 1 : 0);
