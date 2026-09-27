/**
 * check:childcare-repeat — 同じ保育料 (職員・何月分・金額) が 2 つ以上の処理月の事業所書式に出る組を数える (2026-09-27 給与D)。★ 基準値方式・計算は変えない
 *
 *   npm run check:childcare-repeat
 *   npm run check:childcare-repeat -- --update     ★ 基準値を更新 (中身を見てから)
 *
 * ── なぜ ───────────────────────────────────────────────────────────────
 * computeChildcareAllowance は 処理月の書式にある保育料を 何月分ごとに払う。同じ「何月分」の保育料が 翌月の書式にも
 * もう一度書かれていると、当方は 2 回払う (過払いの向き)。② (総括表 支払用) は 1 回しか払っていない人がいる:
 *   河野佳子 1278600398|11045  6 月分 7,000 が 202606・202607 の両方 → 当方 06 2,800 + 07 5,600 / ② 06 0 + 07 5,600
 *   小倉有希 1272400142|260405 4 月分・5 月分 9,600 が 202605・202606 の両方 → 当方 05 4,480 + 06 4,480 / ② 05 0 + 06 4,464
 *   渡邉美吹 1271500942|260404 5 月分 28,600 が 202605・202606 の両方 → 当方 11,440 × 2 / ② 1,045 + 5,961
 * ★ ただし ② が 2 回払っているように見える人もいる (石井愛美 1278600398|220601・高尾和美 1272403534|1270) ので 規則にはしていない。
 *   ② の手の入れ方が人ごとに違う (2026-09-27 育児 128 人月を分解: 一致 76 / 端数 30 / 食い違い 22)。
 *
 * ── 判定 ─────────────────────────────────────────────────────────────
 *   組の数が基準値より増えたら FAIL (新しい月の書式で 同じ保育料が繰り返された = 2 回払っていないか見る)
 * 負のコントロール: 写しの 1 件を 別の処理月にも複製すると +1 になること
 * 見ていないもの: 金額が 1 円でも違う繰り返し / 子の名前の表記ゆれ (「陸」と「柴田陸」) / 手入力の育児手当 (payroll_monthly_inputs)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { restAll } from "./_rest.mjs";
import { normalizeYM } from "../src/lib/payroll/payroll-calc.js";

const UPDATE = process.argv.includes("--update");
const BASELINE = new URL("./check-childcare-repeat-baseline.json", import.meta.url);
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");

type Rec = { id: string; office_number: string; employee_number: string; processing_month: string; year_month: string | null; child_name: string | null; amount: number | null };
const recs = await restAll<Rec>("payroll_office_form_records?select=id,office_number,employee_number,processing_month,year_month,child_name,amount&record_type=eq.childcare");

function repeats(rs: Rec[]) {
  const g = new Map<string, Rec[]>();
  for (const r of rs) {
    if (!((r.amount ?? 0) > 0)) continue;
    const k = `${r.office_number}|${nn(r.employee_number)}|${normalizeYM(r.year_month ?? r.processing_month)}|${r.amount}`;
    const l = g.get(k);
    if (l) l.push(r); else g.set(k, [r]);
  }
  return [...g.entries()].filter(([, l]) => new Set(l.map((r) => r.processing_month)).size > 1)
    .map(([k, l]) => `${k} → ${[...new Set(l.map((r) => r.processing_month))].sort().join(",")}`).sort();
}

console.log("=== check:childcare-repeat (同じ保育料が 2 つ以上の処理月の書式に出る) ===");
const cur = repeats(recs);
console.log(`母数: 保育料の記録 ${recs.length} 件。★ 繰り返しの組 ${cur.length}`);
for (const x of cur) console.log(`  ${x}`);

console.log("\n--- 負のコントロール");
{
  const t = recs.find((r) => (r.amount ?? 0) > 0);
  const m = t ? repeats([...recs, { ...t, id: "copy", processing_month: "209912" }]) : cur;
  expect(!!t && m.length === cur.length + 1, `1 件を別の処理月にも複製すると +1 (${cur.length} → ${m.length})`);
}

type Baseline = { _readme: string[]; repeats: string[] };
const baseline: Baseline | null = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline : null;
console.log("\n--- 基準値");
if (UPDATE || !baseline) {
  writeFileSync(BASELINE, JSON.stringify({ _readme: baseline?._readme ?? [], repeats: cur }, null, 2) + "\n", "utf8");
  console.log("  基準値を保存しました");
} else {
  const added = cur.filter((x) => !baseline.repeats.includes(x));
  expect(added.length === 0, `基準値に無い繰り返し ${added.length} 組${added.length ? `: ${added.join(" / ")}  ★ 当方が 2 回払っていないか ② と見比べる` : ""}`);
  const gone = baseline.repeats.filter((x) => !cur.includes(x));
  if (gone.length) console.log(`  (消えた: ${gone.length} 組。中身を見て --update)`);
}
console.log("\n見ていないもの: 金額が少し違う繰り返し / 子の名前の表記ゆれ / 手入力の育児手当");
console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS");
process.exit(fail ? 1 : 0);
