/**
 * check:soukatsu-item-gap — 時給者 (パート) の手当を 項目ごとに 当方と総括表 ① で突き合わせる。
 * 片側にしか無いものは 両方向とも数える。① の総支給額が どの項目の合計になっているかも毎回確かめる。
 *
 *   npm run check:soukatsu-item-gap                       # ① を xlsm から再抽出する (重い。数分かかる)
 *   L1_DIR=<抽出済みフォルダ> CALC_SNAPSHOT=<json> L2_SNAPSHOT=<json> npm run check:soukatsu-item-gap
 *       再抽出・再読込をせずに使い回す。CALC_SNAPSHOT / L2_SNAPSHOT は無ければ作る
 *   npm run check:soukatsu-item-gap -- --update           ★ 基準値方式の数だけ更新
 *
 * ★★ 当方の数字は 2026-09-23 22:17〜22:31 (UTC) の給与計算 (payroll_calc_results) に基づく。
 *    再計算したら 1 回 --update せずに回し、増減の中身を見てから取り直すこと。
 *
 * ── ① の総支給額 (総支給額（パート）) の中身 (2026-09-27 実測・パート 3,143 人月) ─────────
 *   総支給 = 集計項目小計（土日祝含む） + 勤続手当（パート） + 処遇改善 + 移動手当 + 育児手当
 *          + その他手当計 + 通信手当 + 残業手当総額_パート + 通勤費 + 出張費 + ベースアップ加算手当
 *   で 3,011 / 3,143 人月が 1 円まで一致する。
 *   ★ ① は項目として出しているのに 総支給に入れていないもの:
 *     - 処遇改善補助金手当  ベースアップ加算手当と同じ額を表示しているだけ (② の「処遇改善補助金手当」= ① のベースアップ)
 *     - 休日手当            土日祝と同じ額を表示しているだけ
 *     - 初任者研修費        小計に入るのは 25,875 円 (22.5 時間 × 1,150) まで。★ 超えた分は ① では払っていない。
 *                           ★ ② は 本人給 に全額入れている (杉尾加奈子 202606: ① 25,875 / ② 64,975)。
 *     - 会議費              一部の事業所・月で その他手当計に出るが 総支給に入らない (残差が −575 の倍数)。
 *   → ① の総支給は「旧システムが払った額」ではなく 手で直す前の値。★ 項目の突合は ① の項目の値で行う。
 *
 * ── 項目の対応 (当方 → ①) ─────────────────────────────────────────────
 *   本人給系  totalPay + 土日祝 + キャンセル + 特日     → 集計項目小計 + 土日祝 + キャンセル手当（金額） + 特日
 *   初任者    shoninsha_pay                          → 初任者研修費 (★ ① の表示額。総支給には 25,875 まで)
 *   研修会議  training_pay − shoninsha_pay + meeting_fee → その他手当計 (= HRD研修費 + 研修費 + 会議費。3,143/3,143 一致)
 *   勤続 / 処遇改善 (→ ベースアップ加算手当 + 処遇改善) / 移動 / 通信 / 残業 (+法定休日) / 育児 / 通勤 / 出張
 *   有給・事務 は ① に列が無い (① は有給を計算しない。② で足している) → 参考として件数だけ出す
 *
 * ── 基準値方式 ─────────────────────────────────────────────────────────
 *   項目ごとに「当方だけが払っている人月」「① だけが払っている人月」の数を固定し、増えたら落ちる。
 *   ★ 0 を目指す検査ではない。★ 中身は scripts/check-soukatsu-item-gap-baseline.json の _readme。
 * 負のコントロール: 写しの 1 セルを壊して 当方だけ / ① だけ / 総支給の式 がそれぞれ 1 件動くことを確かめる。
 * 見ていないもの: 月給者 (① 提責_社員 シート) / 行ごと片側にしか居ない人月 (件数だけ出す) /
 *   両方にあって額が違うもの (件数と差額の合計だけ出す。合否には使わない)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restAll } from "./_rest.mjs";
import { hourlyTenure, weekendHolidayAllowanceAmount, weekendAllowanceMinutes, type HourlyPayroll } from "../src/lib/payroll/payroll-calc.js";

const UPDATE = process.argv.includes("--update");
const BASELINE = new URL("./check-soukatsu-item-gap-baseline.json", import.meta.url);
const MONTHS = (process.env.MONTHS || "202603,202604,202605,202606,202607,202608").split(",");
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");
const num = (v: unknown) => (typeof v === "number" ? v : 0);
const yen = (n: number) => `¥${Math.round(n).toLocaleString()}`;

console.log("=== check:soukatsu-item-gap (時給者の手当 当方 vs 総括表 ①・項目ごと・両方向) ===");
console.log("★ 当方の数字は 2026-09-23 22:17〜22:31 (UTC) の給与計算に基づく");

// ── ① ──
type L1Row = { office_number: string; employee_number: string; sheet_kind: string; source_file: string; row_data: Record<string, unknown> };
let L1_DIR = process.env.L1_DIR ?? "";
if (!L1_DIR) {
  L1_DIR = join(tmpdir(), "soukatsu-item-gap-l1");
  if (existsSync(L1_DIR)) rmSync(L1_DIR, { recursive: true, force: true });
  console.log("① を xlsm から再抽出しています (数分かかります)...");
  execSync("node migrations/extract_soukatsu_from_xlsm.mjs --execute", { env: { ...process.env, OUT: L1_DIR, MONTHS: MONTHS.join(",") }, stdio: "inherit" });
}
const l1: { key: string; m: string; d: Record<string, unknown> }[] = [];
for (const f of readdirSync(L1_DIR).filter((x) => /_(\d{6})\.json$/.test(x))) {
  const m = /_(\d{6})\.json$/.exec(f)![1];
  if (!MONTHS.includes(m)) continue;
  for (const r of JSON.parse(readFileSync(`${L1_DIR}/${f}`, "utf8")) as L1Row[]) {
    if (r.sheet_kind === "part") l1.push({ key: `${r.office_number}|${nn(r.employee_number)}|${m}`, m, d: r.row_data });
  }
}

// ── 当方 (payroll_calc_results の hourly) ──
type CalcRow = { office_number: string; processing_month: string; calculated_at: string; hourly: (HourlyPayroll & { grand_total?: number })[] | null };
const CALC_SNAPSHOT = process.env.CALC_SNAPSHOT ?? "";
let calc: CalcRow[];
if (CALC_SNAPSHOT && existsSync(CALC_SNAPSHOT)) calc = JSON.parse(readFileSync(CALC_SNAPSHOT, "utf8")) as CalcRow[];
else {
  calc = await restAll<CalcRow>("payroll_calc_results?select=id,office_number,processing_month,calculated_at,hourly:payload->hourly");
  if (CALC_SNAPSHOT) writeFileSync(CALC_SNAPSHOT, JSON.stringify(calc));
}
const calcAt = calc.map((c) => c.calculated_at).sort();
console.log(`給与計算 ${calc.length} 事業所月 (計算日時 ${calcAt[0]} 〜 ${calcAt.at(-1)}) / ① パート ${l1.length} 人月`);

// ── ② (① が総支給に入れていない分を ② が払っているかを見るため) ──
type L2Row = { office_number: string; employee_number: string; processing_month: string; sheet_kind: string; row_data: Record<string, unknown> };
const L2_SNAPSHOT = process.env.L2_SNAPSHOT ?? "";
let l2rows: L2Row[];
if (L2_SNAPSHOT && existsSync(L2_SNAPSHOT)) l2rows = JSON.parse(readFileSync(L2_SNAPSHOT, "utf8")) as L2Row[];
else {
  l2rows = await restAll<L2Row>("payroll_soukatsu_rows?select=id,office_number,employee_number,processing_month,sheet_kind,row_data&sheet_kind=eq.part");
  if (L2_SNAPSHOT) writeFileSync(L2_SNAPSHOT, JSON.stringify(l2rows));
}
const l2 = new Map<string, Record<string, unknown>>();
for (const r of l2rows) if (r.sheet_kind === "part") l2.set(`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, r.row_data);

// ── 項目 ──
type Items = Record<string, number>;
const ITEMS = ["本人給系", "初任者", "研修会議", "勤続", "処遇改善", "移動", "通信", "残業", "育児", "通勤", "出張"] as const;
const NO_L1_COLUMN = ["有給", "事務"] as const;
function oursItems(es: (HourlyPayroll & { grand_total?: number })[]): Items {
  const o: Items = {};
  const add = (k: string, v: number) => { o[k] = (o[k] ?? 0) + (v || 0); };
  for (const e of es) {
    add("本人給系", e.totalPay + weekendHolidayAllowanceAmount(weekendAllowanceMinutes(e), e.weekend_holiday_rate) + e.cancel_allowance + (e.tokubi_allowance ?? 0));
    add("初任者", e.shoninsha_pay ?? 0);
    add("研修会議", e.training_pay - (e.shoninsha_pay ?? 0) + e.meeting_fee);
    add("勤続", hourlyTenure(e)); add("処遇改善", e.treatment_subsidy); add("移動", e.travel_allowance);
    add("通信", e.communication_fee); add("残業", (e.overtime_pay ?? 0) + (e.legal_holiday_pay ?? 0));
    add("育児", e.childcare_allowance); add("通勤", e.commute_fee); add("出張", e.business_trip_fee);
    add("有給", e.paid_leave_allowance); add("事務", e.office_work_pay);
  }
  return o;
}
const l1Items = (d: Record<string, unknown>): Items => ({
  本人給系: num(d["集計項目小計"]) + num(d["土日祝"]) + num(d["キャンセル手当（金額）"]) + num(d["特日"]),
  初任者: num(d["初任者研修費"]) + num(d["初任者調整費"]),
  研修会議: num(d["その他手当計"]), 勤続: num(d["勤続手当（パート）"]),
  処遇改善: num(d["ベースアップ加算手当"]) + num(d["処遇改善"]), 移動: num(d["移動手当"]), 通信: num(d["通信手当"]),
  残業: num(d["残業手当総額_パート"]), 育児: num(d["育児手当"]), 通勤: num(d["通勤費"]), 出張: num(d["出張費"]),
});
const L1_TOTAL_TERMS = ["集計項目小計（土日祝含む）", "勤続手当（パート）", "処遇改善", "移動手当", "育児手当", "その他手当計", "通信手当", "残業手当総額_パート", "通勤費", "出張費", "ベースアップ加算手当"];
const SHONINSHA_CAP = 25875;

const oursByKey = new Map<string, (HourlyPayroll & { grand_total?: number })[]>();
for (const c of calc) for (const e of c.hourly ?? []) {
  const k = `${c.office_number}|${nn(e.employee_number)}|${c.processing_month}`;
  if (!MONTHS.includes(c.processing_month)) continue;
  oursByKey.set(k, [...(oursByKey.get(k) ?? []), e]);
}
const calcMonths = new Set(calc.map((c) => `${c.office_number}|${c.processing_month}`));

type Result = {
  formulaOk: number; formulaN: number; formulaBad: { key: string; diff: number }[];
  capped: { key: string; shown: number; excess: number; l2Honnin: number | null; ours: number | null }[];
  meetingExcluded: { key: string; amount: number }[];
  oursOnly: Record<string, { key: string; v: number }[]>; l1Only: Record<string, { key: string; v: number }[]>;
  bothDiff: Record<string, { n: number; net: number }>;
  rowOnlyL1: number; rowOnlyOurs: number; noColumn: Record<string, { n: number; sum: number }>; sanity: number;
};
function run(l1rows: typeof l1, ours: typeof oursByKey): Result {
  const r: Result = { formulaOk: 0, formulaN: 0, formulaBad: [], capped: [], meetingExcluded: [], oursOnly: {}, l1Only: {}, bothDiff: {}, rowOnlyL1: 0, rowOnlyOurs: 0, noColumn: {}, sanity: 0 };
  for (const k of ITEMS) { r.oursOnly[k] = []; r.l1Only[k] = []; r.bothDiff[k] = { n: 0, net: 0 }; }
  for (const k of NO_L1_COLUMN) r.noColumn[k] = { n: 0, sum: 0 };
  const seen = new Set<string>();
  for (const x of l1rows) {
    const d = x.d;
    // ① の総支給の式
    r.formulaN++;
    const diff = num(d["総支給額（パート）"]) - L1_TOTAL_TERMS.reduce((s, t) => s + num(d[t]), 0);
    if (Math.abs(diff) < 1.5) r.formulaOk++;
    else if (Math.round(diff) % 575 === 0 && diff < 0 && -diff <= num(d["その他手当計"])) r.meetingExcluded.push({ key: x.key, amount: -diff });
    else r.formulaBad.push({ key: x.key, diff });
    const sh = num(d["初任者研修費"]);
    if (sh > SHONINSHA_CAP) {
      const h2 = l2.get(x.key);
      const os = oursByKey.get(x.key);
      r.capped.push({ key: x.key, shown: sh, excess: sh - SHONINSHA_CAP, l2Honnin: h2 ? num(h2["初任者研修費"]) || null : null, ours: os ? os.reduce((s, e) => s + (e.shoninsha_pay ?? 0) + (e.training_pay ?? 0), 0) : null });
    }
    const [on, , m] = x.key.split("|");
    const es = ours.get(x.key);
    if (!es) { if (calcMonths.has(`${on}|${m}`) && num(d["総支給額（パート）"]) > 0) r.rowOnlyL1++; continue; }
    seen.add(x.key);
    const o = oursItems(es), a = l1Items(d);
    for (const k of ITEMS) {
      const ov = Math.round(o[k] ?? 0), av = Math.round(a[k] ?? 0);
      if (ov > 0 && av === 0) r.oursOnly[k].push({ key: x.key, v: ov });
      else if (av > 0 && ov === 0) r.l1Only[k].push({ key: x.key, v: av });
      else if (Math.abs(ov - av) > 1) { r.bothDiff[k].n++; r.bothDiff[k].net += ov - av; }
    }
    for (const k of NO_L1_COLUMN) if ((o[k] ?? 0) > 0) { r.noColumn[k].n++; r.noColumn[k].sum += o[k]; }
    // 当方の項目の合計 = 保存された grand_total か (対応表の取り違え検知)
    const gt = es.reduce((s, e) => s + (e.grand_total ?? 0), 0);
    const sum = Object.values(o).reduce((s, v) => s + v, 0) + es.reduce((s, e) => s + e.error_adjustment, 0);
    if (Math.abs(gt - sum) > 1) r.sanity++;
  }
  const l1Months = new Set(l1rows.map((x) => { const [on, , m] = x.key.split("|"); return `${on}|${m}`; }));
  for (const [k, es] of ours) {
    const [on, , m] = k.split("|");
    if (!seen.has(k) && l1Months.has(`${on}|${m}`) && es.some((e) => (e.grand_total ?? 0) > 0)) r.rowOnlyOurs++;
  }
  return r;
}

const r0 = run(l1, oursByKey);
if (process.env.DUMP) writeFileSync(process.env.DUMP, JSON.stringify(r0));

console.log(`\n--- ① の総支給の式: ${r0.formulaOk} / ${r0.formulaN} 人月が一致`);
console.log(`  会議費が総支給に入っていない: ${r0.meetingExcluded.length} 人月 ${yen(r0.meetingExcluded.reduce((s, x) => s + x.amount, 0))}`);
const bOff = new Map<string, number>(); for (const x of r0.meetingExcluded) { const [on, , m] = x.key.split("|"); bOff.set(`${on} ${m}`, (bOff.get(`${on} ${m}`) ?? 0) + 1); }
console.log(`    事業所・月: ${[...bOff].map(([k, n]) => `${k}(${n})`).join(" ")}`);
console.log(`  説明のつかない残差: ${r0.formulaBad.length} 人月`);
for (const x of r0.formulaBad.slice(0, 10)) console.log(`    ${x.key} 残差 ${yen(x.diff)}`);

console.log(`\n--- ① の初任者研修費が 25,875 円 (22.5h) を超えた人月: ${r0.capped.length} (超えた分 計 ${yen(r0.capped.reduce((s, x) => s + x.excess, 0))})`);
for (const x of r0.capped) console.log(`    ${x.key} ① 表示 ${yen(x.shown)} → 総支給に入るのは 25,875 / ② 初任者研修費 ${x.l2Honnin == null ? "行なし" : yen(x.l2Honnin)} / 当方 研修+初任者 ${x.ours == null ? "計算なし" : yen(x.ours)}`);

console.log(`\n--- 項目ごと (人月が両方にあるもの)。★ 当方だけ = 当方は払い ① は 0 / ① だけ = その逆`);
console.log(`  項目        当方だけ              ① だけ                両方あり・額が違う (件数 / 当方−① の合計)`);
for (const k of ITEMS) {
  const a = r0.oursOnly[k], b = r0.l1Only[k];
  console.log(`  ${k.padEnd(6, "　")}  ${String(a.length).padStart(4)} 人月 ${yen(a.reduce((s, x) => s + x.v, 0)).padStart(11)}   ${String(b.length).padStart(4)} 人月 ${yen(b.reduce((s, x) => s + x.v, 0)).padStart(11)}   ${r0.bothDiff[k].n} / ${yen(r0.bothDiff[k].net)}`);
}
const oursOnlySum = ITEMS.reduce((s, k) => s + r0.oursOnly[k].reduce((t, x) => t + x.v, 0), 0);
const l1OnlySum = ITEMS.reduce((s, k) => s + r0.l1Only[k].reduce((t, x) => t + x.v, 0), 0);
console.log(`  合計 当方だけ ${yen(oursOnlySum)} / ① だけ ${yen(l1OnlySum)}`);
console.log(`  参考 (① に列が無い): ${NO_L1_COLUMN.map((k) => `${k} ${r0.noColumn[k].n} 人月 ${yen(r0.noColumn[k].sum)}`).join(" / ")}`);
console.log(`  行ごと片側: ① だけ (総支給>0・同じ事業所月は計算済み) ${r0.rowOnlyL1} 人月 / 当方だけ ${r0.rowOnlyOurs} 人月`);
console.log(`  当方の項目の合計 ≠ 保存された grand_total: ${r0.sanity} 人月 (0 でなければ 対応表が取りこぼしている)`);

// ── 負のコントロール (写しを壊す) ──
console.log("\n--- 負のコントロール");
{
  const i = l1.findIndex((x) => { const o = oursByKey.get(x.key); return o && num(x.d["移動手当"]) > 0 && oursItems(o)["移動"] > 0; });
  const copy = l1.map((x, j) => (j === i ? { ...x, d: { ...x.d, 移動手当: 0 } } : x));
  const n = run(copy, oursByKey).oursOnly["移動"].length;
  expect(i >= 0 && n === r0.oursOnly["移動"].length + 1, `① の写しの 移動手当 を 1 件 0 にすると 当方だけ(移動) が +1 (${r0.oursOnly["移動"].length} → ${n})`);
}
{
  const k = [...oursByKey.keys()].find((key) => { const x = l1.find((y) => y.key === key); return x && num(x.d["ベースアップ加算手当"]) > 0 && oursItems(oursByKey.get(key)!)["処遇改善"] > 0; });
  const copy = new Map(oursByKey);
  if (k) copy.set(k, oursByKey.get(k)!.map((e) => ({ ...e, treatment_subsidy: 0 })));
  const n = run(l1, copy).l1Only["処遇改善"].length;
  expect(!!k && n === r0.l1Only["処遇改善"].length + 1, `当方の写しの 処遇改善 を 1 件 0 にすると ① だけ(処遇改善) が +1 (${r0.l1Only["処遇改善"].length} → ${n})`);
}
{
  const i = l1.findIndex((x) => Math.abs(num(x.d["総支給額（パート）"]) - L1_TOTAL_TERMS.reduce((s, t) => s + num(x.d[t]), 0)) < 1.5 && num(x.d["総支給額（パート）"]) > 0);
  const copy = l1.map((x, j) => (j === i ? { ...x, d: { ...x.d, "総支給額（パート）": num(x.d["総支給額（パート）"]) + 1000 } } : x));
  const n = run(copy, oursByKey).formulaOk;
  expect(n === r0.formulaOk - 1, `① の写しの 総支給 を 1 件 +1,000 すると 式の一致が −1 (${r0.formulaOk} → ${n})`);
}

// ── 基準値 ──
type Baseline = { _readme: string[]; counts: Record<string, number> };
const counts: Record<string, number> = { 初任者超過: r0.capped.length, 説明のつかない残差: r0.formulaBad.length };
for (const k of ITEMS) { counts[`当方だけ:${k}`] = r0.oursOnly[k].length; counts[`①だけ:${k}`] = r0.l1Only[k].length; }
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
console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS (★ 2026-09-23 の計算に基づく)");
process.exit(fail ? 1 : 0);
