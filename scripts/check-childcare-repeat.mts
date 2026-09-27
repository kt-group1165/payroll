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
 * ── 型 (組ごと。処理月ごとの 当方の育児手当 と ② の育児手当 を並べる) ────────────────
 *   ② は 1 回      繰り返した処理月のどれかで ② が 0 (かつ当方は払っている) → ★ 当方が 2 回払っている
 *   ② も 2 回?     繰り返した処理月の全部で ② が払っている
 *   判定できない    計算結果か ② の行が無い月がある
 * ── 別掲: 何月分が遠い記録 ───────────────────────────────────────────────
 *   「何月分」が処理月から 6 か月以上離れている保育料 (年の書き間違いの疑い)。
 *   2026-09-27: 岡田光生 1272401967|240401|202608 の 2025/07・2025/08 (当方は 2 か月ぶん 10,656 / ② 5,328)
 *   ★ 何月分の欄が 読めない形のものも ここに出る (190001 = Excel の日付の読み違い / "20604" = 打ち間違い)。
 *     時給者の育児手当は その「何月分」の訪問時間で按分するので、読めない月は 訪問 0 → 按分 0 円になる (払い不足の向き)
 *   ★ 正当に遠いものもある: 大矢 1272400142|728|202606 の 2025/12 (数か月ぶんをまとめて払う。memory の KT姉崎 大矢)
 * ── 判定 ─────────────────────────────────────────────────────────────
 *   繰り返しの組 / 遠い記録 が基準値に無いものが出たら FAIL
 * 負のコントロール: 1 件を別の処理月にも複製すると +1 / 1 組を消すと −1 / 当方の 2 回目を 0 にすると「② は 1 回」が減る /
 *   何月分を 1 年前にずらすと 遠い記録 +1
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

type Pay = Map<string, { ours: number; l2: number }>;
const pay: Pay = new Map();
{
  const months = [...new Set(recs.map((r) => r.processing_month))];
  const calc = await restAll<{ office_number: string; processing_month: string; hourly: { employee_number: string; childcare_allowance?: number }[] | null; monthly: { employee_number: string; childcare_allowance?: number }[] | null }>(
    `payroll_calc_results?select=id,office_number,processing_month,hourly:payload->hourly,monthly:payload->monthly&processing_month=in.(${months.join(",")})`);
  const l2 = await restAll<{ office_number: string; employee_number: string; processing_month: string; row_data: Record<string, unknown> }>(
    `payroll_soukatsu_rows?select=id,office_number,employee_number,processing_month,row_data&processing_month=in.(${months.join(",")})`);
  const l2m = new Map<string, number>();
  for (const r of l2) { const v = Number(String(r.row_data["育児手当"] ?? "0").replace(/,/g, "")); l2m.set(`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, (l2m.get(`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`) ?? 0) + (Number.isFinite(v) ? v : 0)); }
  for (const c of calc) for (const e of [...(c.hourly ?? []), ...(c.monthly ?? [])]) {
    const k = `${c.office_number}|${nn(e.employee_number)}|${c.processing_month}`;
    if (l2m.has(k)) pay.set(k, { ours: e.childcare_allowance ?? 0, l2: l2m.get(k)! });
  }
}
function kindOf(line: string, p: Pay): string {
  const [key, ms] = line.split(" → "); const [o, e] = key.split("|");
  const xs = ms.split(",").map((m) => p.get(`${o}|${e}|${m}`));
  if (xs.some((x) => !x)) return "判定できない";
  if (xs.some((x) => x!.l2 === 0 && x!.ours > 0)) return "② は 1 回";
  return "② も 2 回?";
}
function far(rs: Rec[]) {
  const mIdx = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(4, 6));
  return rs.filter((r) => (r.amount ?? 0) > 0 && r.year_month && Math.abs(mIdx(normalizeYM(r.year_month)) - mIdx(r.processing_month)) >= 6)
    .map((r) => `${r.office_number}|${nn(r.employee_number)}|${r.processing_month} 何月分 ${normalizeYM(r.year_month!)} ${r.amount}`).sort();
}

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
const withCare = [...pay.values()].filter((x) => x.ours > 0 || x.l2 > 0).length;
console.log(`母数: 保育料の記録 ${recs.length} 件 / 育児がどちらかにある人月 ${withCare} (当方の計算 × ② の行がある月)。★ 繰り返しの組 ${cur.length}`);
const kinds = (xs: string[], p: Pay) => { const k: Record<string, number> = {}; for (const x of xs) k[kindOf(x, p)] = (k[kindOf(x, p)] ?? 0) + 1; return k; };
for (const x of cur) {
  const [key, ms] = x.split(" → "); const [o, e] = key.split("|");
  console.log(`  [${kindOf(x, pay)}] ${x}  (${ms.split(",").map((m) => { const v = pay.get(`${o}|${e}|${m}`); return v ? `${m} 当方${v.ours}/②${v.l2}` : `${m} -`; }).join(" ")})`);
}
console.log(`  型: ${JSON.stringify(kinds(cur, pay))}  ★ 規則にできない (② の手の入れ方が人ごとに違う)`);
const farCur = far(recs);
console.log(`
--- 別掲: 何月分が 処理月から 6 か月以上離れている記録 ${farCur.length} 件 (年の書き間違いの疑い)`);
for (const x of farCur) console.log(`  ${x}`);

console.log("\n--- 負のコントロール");
{
  const t = recs.find((r) => (r.amount ?? 0) > 0);
  const m = t ? repeats([...recs, { ...t, id: "copy", processing_month: "209912" }]) : cur;
  expect(!!t && m.length === cur.length + 1, `1 件を別の処理月にも複製すると +1 (${cur.length} → ${m.length})`);
  const first = cur[0]?.split(" → ")[0];
  const m2 = first ? repeats(recs.filter((r) => `${r.office_number}|${nn(r.employee_number)}|${normalizeYM(r.year_month ?? r.processing_month)}|${r.amount}` !== first)) : cur;
  expect(m2.length === cur.length - 1, `1 組を消すと −1 (${cur.length} → ${m2.length})`);
  const once = cur.find((x) => kindOf(x, pay) === "② は 1 回");
  if (once) {
    const [key, ms] = once.split(" → "); const [o, e] = key.split("|");
    const p2: Pay = new Map(pay);
    for (const mm of ms.split(",")) { const v = p2.get(`${o}|${e}|${mm}`); if (v && v.l2 === 0) p2.set(`${o}|${e}|${mm}`, { ...v, ours: 0 }); }
    // 同じ人月に 2 組ある人 (小倉) がいるので 1 以上減ればよい
    expect((kinds(cur, p2)["② は 1 回"] ?? 0) < (kinds(cur, pay)["② は 1 回"] ?? 0), `当方の 2 回目を 0 にすると「② は 1 回」が減る (${kinds(cur, pay)["② は 1 回"]} → ${kinds(cur, p2)["② は 1 回"] ?? 0})`);
  } else expect(false, "「② は 1 回」の組が無い (負のコントロールを当てられない)");
  const t2 = recs.find((r) => (r.amount ?? 0) > 0 && r.year_month);
  const f2 = t2 ? far([...recs, { ...t2, id: "copy2", year_month: `${Number(t2.processing_month.slice(0, 4)) - 1}/${t2.processing_month.slice(4, 6)}` }]) : farCur;
  expect(f2.length === farCur.length + 1, `何月分を 1 年前にずらした記録を足すと 遠い記録 +1 (${farCur.length} → ${f2.length})`);
}

type Baseline = { _readme: string[]; repeats: string[]; far?: string[] };
const baseline: Baseline | null = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline : null;
console.log("\n--- 基準値");
if (UPDATE || !baseline) {
  writeFileSync(BASELINE, JSON.stringify({ _readme: baseline?._readme ?? [], repeats: cur, far: farCur }, null, 2) + "\n", "utf8");
  console.log("  基準値を保存しました");
} else {
  const added = cur.filter((x) => !baseline.repeats.includes(x));
  expect(added.length === 0, `基準値に無い繰り返し ${added.length} 組${added.length ? `: ${added.join(" / ")}  ★ 当方が 2 回払っていないか ② と見比べる` : ""}`);
  const gone = baseline.repeats.filter((x) => !cur.includes(x));
  if (gone.length) console.log(`  (消えた: ${gone.length} 組。中身を見て --update)`);
  const farAdded = farCur.filter((x) => !(baseline.far ?? []).includes(x));
  expect(farAdded.length === 0, `基準値に無い 遠い記録 ${farAdded.length} 件${farAdded.length ? `: ${farAdded.join(" / ")}  ★ 年の書き間違いでないか` : ""}`);
}
console.log("\n見ていないもの: 金額が少し違う繰り返し / 子の名前の表記ゆれ / 手入力の育児手当");
console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS");
process.exit(fail ? 1 : 0);
