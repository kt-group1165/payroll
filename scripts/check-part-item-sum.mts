/**
 * check:part-item-sum — ★ 項目が 総支給を 過不足なく分解できているかを見る (2026-10-01 新設)
 *
 *   npm run check:part-item-sum
 *   PAYROLL_ENV=staging npm run check:part-item-sum      # staging を見る
 *   npm run check:part-item-sum -- --update              ★ ② 側の既知の壊れ (基準値方式) だけ更新
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────────
 * 「項目は全部 ±1 円以内で一致しているのに 総支給だけ合わない」人月が出ていた。
 * ★ 原因は **項目の定義が 総支給を分解できていなかった**こと。実際に 2 つ埋まっていた:
 *   ① 初任者研修費の二重計上  training_pay が既に含むのに 本人給にも足していた (26 人月)
 *   ② 初任者研修調整費の引き忘れ  grand_total は引くのに 本人給が引いていなかった (13 人月)
 * ★ どちらも 項目を 1 つずつ見ている限り 永久に見つからない。★ 和で見て初めて出る。
 *
 * ── 何を見るか ────────────────────────────────────────────────────────────
 *   当方: Σ(12 項目) = grand_total           ★ 0 件を目指す検査 (壊れたら落ちる)
 *   ②  : Σ(12 列)   = ② 総支給額            ★ 基準値方式 (② 自身の壊れは直せない)
 *
 * ② のパートの総支給の式 (2026-10-01 に 貪欲探索で実測。2,255/2,327 = 96.9% が 1 円一致):
 *   総支給額 = 本人給 + 通勤費 + 有給休暇手当 + 出張費 + 通信手当 + 移動手当
 *            + その他手当 + 勤続手当 + 処遇改善補助金手当 + 残業総額 + 調整手当 + 育児手当
 * ⚠ 「初任者研修費」「初任者研修調整費」「集計項目小計」「土日祝」「特日」「ドタキャン」は
 *   ② では **表示だけ**で 総支給には足されない (本人給の中に畳まれている)。
 *
 * 負のコントロール: ① 本人給から 初任者研修調整費を引くのをやめると 当方側が 13 件に増える
 *                   ② その他手当から 初任者研修費を引くのをやめると 当方側が 26 件に増える
 *                   ③ ② の写しの 1 行の 本人給 を +1,000 すると ② 側が +1 になる
 */
import { readFileSync, writeFileSync } from "node:fs";
import { restAll, normEmpNo, SB_REF } from "./_rest.mjs";
import { pickSoukatsu } from "../src/lib/payroll/soukatsu-diff.js";
import { ourItems, shoninshaInSoukatsuOf } from "../src/lib/payroll/verification-items.js";
import { shoninshaAdjustmentOf, type HourlyPayroll, type OvertimeSetting } from "../src/lib/payroll/payroll-calc.js";

const UPDATE = process.argv.includes("--update");
const BASELINE = new URL("./check-part-item-sum-baseline.json", import.meta.url);
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);

/** ② の総支給の式に入る 12 列。★ ここを変えるときは 上の実測をやり直すこと */
const TOTAL_COLS = ["本人給", "通勤費", "有給休暇手当", "出張費", "通信手当", "移動手当",
  "その他手当", "勤続手当", "処遇改善補助金手当", "残業総額", "調整手当", "育児手当"];

type Calc = { office_number: string; processing_month: string; payload: Record<string, unknown> };
type Souk = { office_number: string; processing_month: string; employee_number: string; row_data: Record<string, unknown> };

const calc = await restAll<Calc>("payroll_calc_results?select=id,office_number,processing_month,payload");
const souk = await restAll<Souk>("payroll_soukatsu_rows?select=id,office_number,processing_month,employee_number,row_data&sheet_kind=eq.part");
const sOf = new Map(souk.map((s) => [`${s.office_number}|${s.processing_month}|${normEmpNo(s.employee_number)}`, s]));

type Row = { k: string; name: string; ours: number; ourSum: number; s: number; sSum: number };
/** mutate: 負のコントロール用に 値をいじる差し込み口 */
function measure(mutate?: (r: Row, e: Record<string, unknown>, row: Record<string, unknown>) => void): { ourBad: Row[]; sBad: Row[]; n: number } {
  const ourBad: Row[] = [], sBad: Row[] = [];
  let n = 0;
  for (const c of calc) {
    const otMap = new Map(((c.payload.overtime_settings ?? []) as OvertimeSetting[]).map((r) => [r.job_type, r]));
    for (const e of (c.payload.hourly ?? []) as Record<string, unknown>[]) {
      const key = normEmpNo(String(e.employee_number ?? ""));
      const s = sOf.get(`${c.office_number}|${c.processing_month}|${key}`); if (!s) continue;
      if (/[_＿]/.test(String(s.row_data["氏名"] ?? ""))) continue;
      const sTotal = pickSoukatsu(s.row_data, "総支給額"); if (sTotal <= 0) continue;
      n++;
      const items = new Map(ourItems(e, "part", otMap, shoninshaInSoukatsuOf(s.row_data)).map((x) => [x.item, x.ours]));
      const r: Row = { k: `${c.office_number}|${c.processing_month}|${key}`,
        name: String(e.employee_name ?? "").replace(/\s+/g, " ").slice(0, 10),
        ours: num(e.grand_total), ourSum: TOTAL_COLS.reduce((a, t) => a + (items.get(t) ?? 0), 0),
        s: sTotal, sSum: TOTAL_COLS.reduce((a, t) => a + pickSoukatsu(s.row_data, t), 0) };
      mutate?.(r, e, s.row_data);
      if (Math.abs(r.ourSum - r.ours) > 1) ourBad.push(r);
      if (Math.abs(r.sSum - r.s) > 1) sBad.push(r);
    }
  }
  return { ourBad, sBad, n };
}

console.log(`=== check:part-item-sum (項目の和 = 総支給 か) 2026-10-01 新設・読み取り専用 ===`);
const { ourBad, sBad, n } = measure();
console.log(`  [${SB_REF}] パート (② 総支給>0) ${n} 人月`);
console.log(`  ★ 当方  Σ(12項目) ≠ grand_total : ${ourBad.length} 人月   ★ 0 を目指す`);
console.log(`     ②   Σ(12列)   ≠ 総支給額     : ${sBad.length} 人月   (基準値方式)`);
for (const r of [...ourBad].sort((a, b) => Math.abs(b.ourSum - b.ours) - Math.abs(a.ourSum - a.ours)).slice(0, 8))
  console.log(`       当方 ${r.k} ${r.name.padEnd(10)} Σ ${Math.round(r.ourSum).toLocaleString()} ≠ ${Math.round(r.ours).toLocaleString()} (差 ${Math.round(r.ourSum - r.ours).toLocaleString()})`);
for (const r of [...sBad].sort((a, b) => Math.abs(b.sSum - b.s) - Math.abs(a.sSum - a.s)).slice(0, 8))
  console.log(`       ②   ${r.k} ${r.name.padEnd(10)} Σ ${Math.round(r.sSum).toLocaleString()} ≠ ${Math.round(r.s).toLocaleString()} (差 ${Math.round(r.sSum - r.s).toLocaleString()})`);

console.log("\n--- 負のコントロール");
let ngc = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) ngc++; };
const a = measure((r, e) => { r.ourSum += shoninshaAdjustmentOf(e as unknown as HourlyPayroll); });
expect(a.ourBad.length > ourBad.length, `本人給から 初任者研修調整費 を引かないと 当方側が増える (${ourBad.length} → ${a.ourBad.length})`);
const b = measure((r, e, row) => { if (shoninshaInSoukatsuOf(row)) r.ourSum += num(e.shoninsha_pay); });
expect(b.ourBad.length > ourBad.length, `その他手当から 初任者研修費 を引かないと 当方側が増える (${ourBad.length} → ${b.ourBad.length})`);
let once = true;
const cc = measure((r) => { if (once) { r.sSum += 1000; once = false; } });
expect(cc.sBad.length === sBad.length + 1, `② の 1 行を +1,000 すると ② 側が +1 (${sBad.length} → ${cc.sBad.length})`);

console.log("\n--- 基準値");
let fail = ngc;
if (UPDATE) {
  const cur = JSON.parse(readFileSync(BASELINE, "utf8")) as { _readme: string[]; soukatsuBroken: number };
  cur.soukatsuBroken = sBad.length;
  writeFileSync(BASELINE, JSON.stringify(cur, null, 2) + "\n", "utf8");
  console.log(`  ② 側の基準値を ${sBad.length} に更新しました`);
} else {
  const base = JSON.parse(readFileSync(BASELINE, "utf8")) as { soukatsuBroken: number };
  if (ourBad.length > 0) { console.log(`  ★ FAIL 当方側は 0 でなければならない (${ourBad.length} 件)`); fail++; }
  else console.log("  o 当方側 0 件");
  if (sBad.length > base.soukatsuBroken) { console.log(`  ★ FAIL ② 側が基準値から増えた (${sBad.length} > ${base.soukatsuBroken})`); fail++; }
  else console.log(`  o ② 側 ${sBad.length} (基準値 ${base.soukatsuBroken})`);
}
console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS");
process.exit(fail ? 1 : 0);
