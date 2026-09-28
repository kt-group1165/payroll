/**
 * check:accompanied-flag — 「同行の旗が立っているが サービスが同行でない」実績を見張る。★ 基準値方式。
 *
 *   npm run check:accompanied-flag
 *   npm run check:accompanied-flag -- --update
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────────
 * `payroll_service_records.accompanied_visit` の旗は、★ 身体介護・身体生活 の行にも立っている。
 * 2026-09-28 までは 旗だけで「同行」と判定していたので、訪介同行時間が 実際の 2 倍になり、
 * 勤続手当 (= 同行を抜いた訪問時間 × 単価) が 過少になっていた。
 * 判定は `isAccompaniedRecord` (payroll-calc.ts) に集約した。★ この検査は その前提を見張る:
 *   ① 旗が立っているのに サービスが同行でない行が **増えていないか** (取込側の壊れ方が変わった合図)
 *   ② 「サービスが同行なのに 旗が無い」行が **出ていないか** (逆向き。0 件が期待値)
 *
 * ── 2026-09-28 の実測 ────────────────────────────────────────────────────
 *   旗が立っている行 2,079 / うち サービスが同行でない 76 行 (30 人月)
 *   ★ ① の「訪介同行時間」と突合すると (パート 2,293 人月)
 *       旗だけ 1,493 一致 / 旗かつ同行サービス 1,497 一致。★ 値が変わる 4 人月は 4/4 で後者が正しい
 *   ★ 金額は 26 人月が月給 (勤続は時間に依らない) で動かず、時給 2 人月が +¥15 ずつ ① と一致する側へ
 *   ★ 76 行はすべて平日 → 土日祝・日曜祝日・特日 の時間は動かない
 *
 * ── 見ていないもの ────────────────────────────────────────────────────────
 *   ・① との一致率そのもの (→ check:soukatsu-cause / check:soukatsu-item-gap)
 *   ・同行の単価や支給額 (→ visit-pay.ts)
 *   ・旗が正しいかどうか。★ ここは「当方の判定が旗だけに戻っていないか」を見る検査
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { restAll } from "./_rest.mjs";
import { isAccompaniedRecord } from "../src/lib/payroll/payroll-calc.js";

const UPDATE = process.argv.includes("--update");
const BASELINE = new URL("./check-accompanied-flag-baseline.json", import.meta.url);
const MONTHS = (process.env.MONTHS || "202603,202604,202605,202606,202607,202608").split(",");
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };

console.log("=== check:accompanied-flag (同行の旗と サービスの食い違い) ===");

type Rec = { office_number: string; processing_month: string; employee_number: string; employee_name: string; service_date: string; calc_duration: string; accompanied_visit: string | null; service_type: string | null; service_code: string | null };
const recs = await restAll<Rec>(`payroll_service_records?select=id,office_number,processing_month,employee_number,employee_name,service_date,calc_duration,accompanied_visit,service_type,service_code&processing_month=in.(${MONTHS.join(",")})`);
const flagged = recs.filter((r) => !!r.accompanied_visit && r.accompanied_visit.trim() !== "");
const mismatched = flagged.filter((r) => !isAccompaniedRecord(r));
// 逆向き: サービスは同行なのに 旗が無い
const noFlag = recs.filter((r) => (!r.accompanied_visit || r.accompanied_visit.trim() === "") && ((r.service_type ?? "").includes("同行") || ["010000", "010001", "010999"].includes(String(r.service_code ?? ""))));

const pm = new Set(mismatched.map((r) => `${r.office_number}|${r.employee_number}|${r.processing_month}`));
console.log(`実績 ${recs.length} 行 (${MONTHS.join("/")}) / 同行の旗 ${flagged.length} 行`);
console.log(`\n--- ① 旗は立っているが サービスが同行でない: ${mismatched.length} 行 / ${pm.size} 人月 ---`);
const byType = new Map<string, number>();
for (const r of mismatched) { const k = `${r.service_code} ${r.service_type}`; byType.set(k, (byType.get(k) ?? 0) + 1); }
console.log(`  サービス別: ${[...byType].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" / ")}`);
const byPm = new Map<string, number>();
for (const r of mismatched) { const k = `${r.office_number}|${r.employee_number}|${r.processing_month} ${r.employee_name}`; byPm.set(k, (byPm.get(k) ?? 0) + 1); }
for (const [k, n] of [...byPm].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`    ${k}  ${n} 行`);
console.log(`\n--- ② サービスは同行なのに 旗が無い: ${noFlag.length} 行 (期待値 0) ---`);
for (const r of noFlag.slice(0, 10)) console.log(`    ${r.office_number}|${r.employee_number}|${r.processing_month} ${r.employee_name} ${r.service_date} ${r.service_code} ${r.service_type}`);

console.log("\n--- 負のコントロール");
{
  const doukou = recs.find((r) => isAccompaniedRecord(r));
  expect(!!doukou, `同行と判定される行がある (${doukou ? `${doukou.service_code} ${doukou.service_type}` : "なし"})`);
  if (doukou) {
    expect(!isAccompaniedRecord({ service_type: "身1", service_code: "111111" }), "サービスが 身体介護 なら 同行と判定されない");
    expect(isAccompaniedRecord({ service_type: doukou.service_type, service_code: doukou.service_code }), "旗を渡さなくても サービスだけで 同行と判定される");
  }
  const one = mismatched[0];
  if (one) expect(!isAccompaniedRecord(one) && !!one.accompanied_visit, `旗が立っていても サービスが同行でなければ false (${one.service_code} ${one.service_type})`);
  const nf = noFlag[0];
  if (nf) expect(isAccompaniedRecord(nf), `旗が無くても サービスが同行なら true (${nf.service_code} ${nf.service_type})`);
}

type Baseline = { _readme: string[]; counts: Record<string, number> };
const counts: Record<string, number> = { "旗だけで同行でない行": mismatched.length, "旗だけで同行でない人月": pm.size, "同行なのに旗が無い行": noFlag.length };
const baseline: Baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline : { _readme: [], counts: {} };
if (UPDATE) {
  baseline.counts = counts;
  writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  console.log("\n基準値を更新しました");
} else {
  console.log("\n--- 基準値");
  for (const [k, v] of Object.entries(counts)) {
    const b = baseline.counts[k] ?? Number.POSITIVE_INFINITY;
    if (v > b) expect(false, `${k} が基準値から増えた (${v} > ${b})`);
  }
  expect(Object.entries(counts).every(([k, v]) => v <= (baseline.counts[k] ?? Number.POSITIVE_INFINITY)), `どの件数も基準値から増えていない (${Object.keys(counts).length} 項目)`);
}
console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS (★ 0 件 PASS ではない。基準値の件数を許容したうえでの PASS)");
process.exit(fail ? 1 : 0);
