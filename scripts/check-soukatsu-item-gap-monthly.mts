/**
 * check:soukatsu-item-gap-monthly — 月給者 (提責・社員) の手当を 項目ごとに 当方と総括表 ① (提責_社員 シート) で突き合わせる。
 * 時給者は check:soukatsu-item-gap。作法は同じ (両方向・基準値方式・負のコントロール)。
 *
 *   npm run check:soukatsu-item-gap-monthly                   # ① を xlsm から再抽出する (重い)
 *   L1_DIR=<抽出済みフォルダ> CALC_SNAPSHOT=<json> npm run check:soukatsu-item-gap-monthly
 *   npm run check:soukatsu-item-gap-monthly -- --update       ★ 基準値方式の数だけ更新
 *
 * ★★ 当方の数字は 2026-09-23 22:17〜22:31 (UTC) の給与計算 (payroll_calc_results) に基づく。
 *    再計算したら 1 回 --update せずに回し、増減の中身を見てから取り直すこと。
 *
 * ── ① の総支給額 (総支給額（介社）) の中身 (2026-09-27 実測・1,578 人月) ──────────────
 *   総支給 = 本人給 + 職能給 + 役職手当 + 資格手当 + 勤続手当 + 固定残業手当 + 処遇改善 + 特定処遇改善
 *          + ベースアップ加算手当 + 出張費 + 通勤費 + 育児手当 + 介護超過 + 夜朝 + 深夜_3
 *   で 1,502 / 1,578 人月が 1 円まで一致する。
 *   ★ ① が項目として出しているのに 総支給に入れていないもの: 残業手当総額 / 特日 / 欠勤控除 / 過誤 / 調整手当_従業員。
 *   ⚠ ① の xlsm には 数値が "10,000" のような カンマ付きの文字列で入っている事業所がある (1272403534)。数値に直して読む。
 *
 * ── 除いて別に数えるもの ──────────────────────────────────────────────
 *   働いた記録が 1 つも無い月の固定給 (check:fixed-pay-no-work と同じ定義)。
 *   ① にも当方にも固定給だけが出て、どちらかに偏って見えるため 突合から除き、件数と金額だけ出す。
 *
 * ── 項目の対応 (当方 → ①) ─────────────────────────────────────────────
 *   本人給 / 職能給 / 役職 / 資格 / 勤続 / 固定残業 / 処遇改善 / 特定処遇改善 / ベースアップ (← treatment_subsidy)
 *   出張 (出張費 + 移動の距離×単価 travelFeeAmount) / 通勤 / 育児 / 介護超過 / 夜朝深夜 (← 夜朝 + 深夜_3) / 特日 / 欠勤控除
 *   残業: 当方の超過残業 (総支給 − 他の項目) ↔ ① の 残業手当総額 − 固定残業手当 (0 未満は 0)。★ ① は総支給に入れていない
 *   有給・事務員の介護分・泊まり・報奨金 は ① に列が無い → 参考として件数だけ出す
 * 見ていないもの: 行ごと片側にしか居ない人月 (件数だけ) / 両方にあって額が違うもの (件数と差額の合計だけ。合否に使わない) /
 *   ② (支払用) との照合
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restAll } from "./_rest.mjs";
import {
  fixedTotal, travelFeeAmount, commuteFeeAmount, careOvertimePay, yochoAllowance, monthlyPaidLeaveAllowance, absenceDeduction,
  type MonthlyPayroll,
} from "../src/lib/payroll/payroll-calc.js";

const UPDATE = process.argv.includes("--update");
const BASELINE = new URL("./check-soukatsu-item-gap-monthly-baseline.json", import.meta.url);
const MONTHS = (process.env.MONTHS || "202603,202604,202605,202606,202607,202608").split(",");
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");
/** ① の数値。"10,000" のようなカンマ付き文字列も数値に直す */
const num = (v: unknown) => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?[\d,]+(\.\d+)?$/.test(v.trim())) return Number(v.replace(/,/g, ""));
  return 0;
};
const yen = (n: number) => `¥${Math.round(n).toLocaleString()}`;

console.log("=== check:soukatsu-item-gap-monthly (月給者の手当 当方 vs 総括表 ① 提責_社員・項目ごと・両方向) ===");
console.log("★ 当方の数字は 2026-09-23 22:17〜22:31 (UTC) の給与計算に基づく");

// ── ① ──
type L1Row = { office_number: string; employee_number: string; sheet_kind: string; row_data: Record<string, unknown> };
let L1_DIR = process.env.L1_DIR ?? "";
if (!L1_DIR) {
  L1_DIR = join(tmpdir(), "soukatsu-item-gap-l1");
  if (existsSync(L1_DIR)) rmSync(L1_DIR, { recursive: true, force: true });
  console.log("① を xlsm から再抽出しています (数分かかります)...");
  execSync("node migrations/extract_soukatsu_from_xlsm.mjs --execute", { env: { ...process.env, OUT: L1_DIR, MONTHS: MONTHS.join(",") }, stdio: "inherit" });
}
type L1 = { key: string; d: Record<string, unknown> };
const l1: L1[] = [];
for (const f of readdirSync(L1_DIR).filter((x) => /_(\d{6})\.json$/.test(x))) {
  const m = /_(\d{6})\.json$/.exec(f)![1];
  if (!MONTHS.includes(m)) continue;
  for (const r of JSON.parse(readFileSync(`${L1_DIR}/${f}`, "utf8")) as L1Row[]) {
    if (r.sheet_kind === "shaseki") l1.push({ key: `${r.office_number}|${nn(r.employee_number)}|${m}`, d: r.row_data });
  }
}

// ── 当方 (payroll_calc_results の monthly) ──
type M = MonthlyPayroll & { grand_total?: number; employee_number: string; [k: string]: unknown };
type CalcRow = { office_number: string; processing_month: string; calculated_at: string; monthly: M[] | null };
const CALC_SNAPSHOT = process.env.CALC_SNAPSHOT ?? "";
let calc: CalcRow[];
if (CALC_SNAPSHOT && existsSync(CALC_SNAPSHOT)) calc = JSON.parse(readFileSync(CALC_SNAPSHOT, "utf8")) as CalcRow[];
else {
  calc = await restAll<CalcRow>("payroll_calc_results?select=id,office_number,processing_month,calculated_at,monthly:payload->monthly");
  if (CALC_SNAPSHOT) writeFileSync(CALC_SNAPSHOT, JSON.stringify(calc));
}
const calcAt = calc.map((c) => c.calculated_at).sort();
console.log(`給与計算 ${calc.length} 事業所月 (計算日時 ${calcAt[0]} 〜 ${calcAt.at(-1)}) / ① 提責_社員 ${l1.length} 人月`);

// ── ② (① が 0 / 当方だけ の項目を ② が払っているかを見るため) ──
type L2Row = { office_number: string; employee_number: string; processing_month: string; sheet_kind: string; row_data: Record<string, unknown> };
const L2_SNAPSHOT = process.env.L2_SNAPSHOT ?? "";
let l2rows: L2Row[];
if (L2_SNAPSHOT && existsSync(L2_SNAPSHOT)) l2rows = JSON.parse(readFileSync(L2_SNAPSHOT, "utf8")) as L2Row[];
else {
  l2rows = await restAll<L2Row>("payroll_soukatsu_rows?select=id,office_number,employee_number,processing_month,sheet_kind,row_data&sheet_kind=eq.shaseki");
  if (L2_SNAPSHOT) writeFileSync(L2_SNAPSHOT, JSON.stringify(l2rows));
}
const l2 = new Map<string, Record<string, unknown>>();
for (const r of l2rows) if (r.sheet_kind === "shaseki") l2.set(`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, r.row_data);
/** 当方の項目 → ② (支払用) の列 */
const L2_COLS: Record<string, string[]> = {
  本人給: ["本人給"], 職能給: ["職能給"], 役職: ["役職手当"], 資格: ["資格手当"], 勤続: ["勤続手当"], 固定残業: ["固定残業代"],
  処遇改善: ["処遇改善手当"], 特定処遇改善: ["特別処遇改善手当", "特定処遇改善手当"], ベースアップ: ["処遇改善補助金手当"],
  出張: ["出張費"], 通勤: ["通勤費"], 育児: ["育児手当"], 介護超過: ["介護"], 夜朝深夜: ["・夜朝・深夜"], 特日: ["・特日"],
  欠勤控除: ["欠勤控除"], 残業: ["残業総額"],
};
const l2Val = (key: string, item: string): number | null => { const d = l2.get(key); return d ? L2_COLS[item].reduce((s, c) => s + Math.abs(num(d[c])), 0) : null; };

// ── 働いた記録が無い月 (check:fixed-pay-no-work と同じ定義) ──
const TOP_KEYS = ["paid_leave_allowance_override", "travel_km", "travel_km_auto", "business_trip_fee", "absence_days", "care_minutes", "office_worker_care_pay"];
const WORK_KEYS = ["recordCount", "workDays", "helperDays", "workHoursMin", "visitMinutes", "paidLeave", "halfLeave", "specialLeave",
  "hrdCount", "hrdMinutes", "meetingCount", "commuteKmTotal", "businessKmTotal", "commuteYenTotal"];
const noWork = (p: M) => WORK_KEYS.every((k) => !Number((p.summary as unknown as Record<string, unknown>)?.[k] ?? 0)) && TOP_KEYS.every((k) => !Number(p[k] ?? 0));

// ── 項目 ──
type Items = Record<string, number>;
const ITEMS = ["本人給", "職能給", "役職", "資格", "勤続", "固定残業", "処遇改善", "特定処遇改善", "ベースアップ", "出張", "通勤", "育児", "介護超過", "夜朝深夜", "特日", "欠勤控除", "残業"] as const;
const NO_L1_COLUMN = ["有給", "事務員の介護分", "泊まり", "報奨金"] as const;
function oursItems(es: M[]): Items {
  const o: Items = {};
  const add = (k: string, v: number) => { o[k] = (o[k] ?? 0) + (v || 0); };
  for (const p of es) {
    const s = p.settings;
    if (!s) continue;
    add("本人給", s.base_personal_salary); add("職能給", s.skill_salary); add("役職", s.position_allowance); add("資格", s.qualification_allowance);
    add("勤続", s.tenure_allowance); add("固定残業", s.fixed_overtime_pay); add("処遇改善", s.treatment_improvement);
    add("特定処遇改善", s.specific_treatment_improvement); add("ベースアップ", s.treatment_subsidy);
    add("出張", travelFeeAmount(p) + p.business_trip_fee); add("通勤", commuteFeeAmount(p)); add("育児", p.childcare_allowance);
    add("介護超過", careOvertimePay(p)); add("夜朝深夜", yochoAllowance(p)); add("特日", p.tokubi_allowance ?? 0);
    add("欠勤控除", absenceDeduction(p));
    add("有給", monthlyPaidLeaveAllowance(p)); add("事務員の介護分", p.office_worker_care_pay ?? 0); add("泊まり", p.overnight_allowance ?? 0);
    add("報奨金", (p.bonus_paid ? s.bonus_amount : 0) + s.special_bonus);
    // 超過残業は 総支給から他の項目を引いた残り (overtimeExcessPay は残業設定の表が要るので 保存された総支給から逆算する)
    const others = fixedTotal(s) + (p.bonus_paid ? s.bonus_amount : 0) + travelFeeAmount(p) + commuteFeeAmount(p) + p.business_trip_fee
      + (p.overnight_allowance ?? 0) + p.childcare_allowance + careOvertimePay(p) + yochoAllowance(p) + monthlyPaidLeaveAllowance(p)
      + (p.tokubi_allowance ?? 0) + (p.office_worker_care_pay ?? 0) - absenceDeduction(p) + (p.adjustment ?? 0);
    add("残業", Number(p.grand_total ?? 0) - others);
  }
  return o;
}
const l1Items = (d: Record<string, unknown>): Items => ({
  本人給: num(d["本人給"]), 職能給: num(d["職能給"]), 役職: num(d["役職手当"]), 資格: num(d["資格手当"]), 勤続: num(d["勤続手当"]),
  固定残業: num(d["固定残業手当"]), 処遇改善: num(d["処遇改善"]), 特定処遇改善: num(d["特定処遇改善"]), ベースアップ: num(d["ベースアップ加算手当"]),
  出張: num(d["出張費"]), 通勤: num(d["通勤費"]), 育児: num(d["育児手当"]), 介護超過: num(d["介護超過"]), 夜朝深夜: num(d["夜朝"]) + num(d["深夜_3"]),
  特日: num(d["特日"]), 欠勤控除: Math.abs(num(d["欠勤控除"])),
  残業: Math.max(0, num(d["残業手当総額"]) - num(d["固定残業手当"])),
});
const L1_TOTAL_TERMS = ["本人給", "職能給", "役職手当", "資格手当", "勤続手当", "固定残業手当", "処遇改善", "特定処遇改善", "ベースアップ加算手当", "出張費", "通勤費", "育児手当", "介護超過", "夜朝", "深夜_3"];
const L1_TOTAL = "総支給額（介社）";

const oursByKey = new Map<string, M[]>();
for (const c of calc) {
  if (!MONTHS.includes(c.processing_month)) continue;
  for (const p of c.monthly ?? []) {
    const k = `${c.office_number}|${nn(p.employee_number)}|${c.processing_month}`;
    oursByKey.set(k, [...(oursByKey.get(k) ?? []), p]);
  }
}
const calcMonths = new Set(calc.map((c) => `${c.office_number}|${c.processing_month}`));

type Hit = { key: string; v: number };
type Result = {
  formulaOk: number; formulaN: number; formulaBad: { key: string; diff: number }[];
  noWork: { n: number; yen: number; l1Yen: number };
  oursOnly: Record<string, Hit[]>; l1Only: Record<string, Hit[]>; bothDiff: Record<string, { n: number; net: number }>;
  rowOnlyL1: number; rowOnlyOurs: number; noColumn: Record<string, { n: number; sum: number }>;
};
function run(l1rows: L1[], ours: Map<string, M[]>): Result {
  const r: Result = { formulaOk: 0, formulaN: 0, formulaBad: [], noWork: { n: 0, yen: 0, l1Yen: 0 }, oursOnly: {}, l1Only: {}, bothDiff: {}, rowOnlyL1: 0, rowOnlyOurs: 0, noColumn: {} };
  for (const k of ITEMS) { r.oursOnly[k] = []; r.l1Only[k] = []; r.bothDiff[k] = { n: 0, net: 0 }; }
  for (const k of NO_L1_COLUMN) r.noColumn[k] = { n: 0, sum: 0 };
  const l1ByKey = new Map(l1rows.map((x) => [x.key, x.d]));
  for (const x of l1rows) {
    r.formulaN++;
    const diff = num(x.d[L1_TOTAL]) - L1_TOTAL_TERMS.reduce((s, t) => s + num(x.d[t]), 0);
    if (Math.abs(diff) < 1.5) r.formulaOk++; else r.formulaBad.push({ key: x.key, diff });
  }
  const l1Months = new Set(l1rows.map((x) => { const [on, , m] = x.key.split("|"); return `${on}|${m}`; }));
  const seen = new Set<string>();
  for (const [key, es] of ours) {
    const [on, , m] = key.split("|");
    const d = l1ByKey.get(key);
    const total = es.reduce((s, p) => s + Number(p.grand_total ?? 0), 0);
    if (es.every(noWork)) {
      if (total > 0) { r.noWork.n++; r.noWork.yen += total; r.noWork.l1Yen += d ? num(d[L1_TOTAL]) : 0; }
      if (d) seen.add(key);
      continue;
    }
    if (!d) { if (l1Months.has(`${on}|${m}`) && total > 0) r.rowOnlyOurs++; continue; }
    seen.add(key);
    const o = oursItems(es), a = l1Items(d);
    for (const k of ITEMS) {
      const ov = Math.round(o[k] ?? 0), av = Math.round(a[k] ?? 0);
      if (ov > 0 && av === 0) r.oursOnly[k].push({ key, v: ov });
      else if (av > 0 && ov === 0) r.l1Only[k].push({ key, v: av });
      else if (Math.abs(ov - av) > 1) { r.bothDiff[k].n++; r.bothDiff[k].net += ov - av; }
    }
    for (const k of NO_L1_COLUMN) if ((o[k] ?? 0) > 0) { r.noColumn[k].n++; r.noColumn[k].sum += o[k]; }
  }
  for (const x of l1rows) {
    const [on, , m] = x.key.split("|");
    if (!seen.has(x.key) && calcMonths.has(`${on}|${m}`) && num(x.d[L1_TOTAL]) > 0) r.rowOnlyL1++;
  }
  return r;
}

const r0 = run(l1, oursByKey);
if (process.env.DUMP) writeFileSync(process.env.DUMP, JSON.stringify(r0));

console.log(`\n--- ① の総支給の式: ${r0.formulaOk} / ${r0.formulaN} 人月が一致 (説明のつかない残差 ${r0.formulaBad.length} 人月)`);
for (const x of r0.formulaBad.slice(0, 8)) console.log(`    ${x.key} 残差 ${yen(x.diff)}`);
console.log(`\n--- 別掲: 働いた記録が無い月の固定給 ${r0.noWork.n} 人月 / 当方 ${yen(r0.noWork.yen)} (① の総支給 ${yen(r0.noWork.l1Yen)})。突合から除いた`);
console.log(`\n--- 項目ごと (人月が両方にあるもの)。★ 当方だけ = 当方は払い ① は 0 / ① だけ = その逆`);
console.log(`  項目            当方だけ              ① だけ                両方あり・額が違う (件数 / 当方−① の合計)`);
for (const k of ITEMS) {
  const a = r0.oursOnly[k], b = r0.l1Only[k];
  console.log(`  ${k.padEnd(7, "　")}  ${String(a.length).padStart(4)} 人月 ${yen(a.reduce((s, x) => s + x.v, 0)).padStart(11)}   ${String(b.length).padStart(4)} 人月 ${yen(b.reduce((s, x) => s + x.v, 0)).padStart(11)}   ${r0.bothDiff[k].n} / ${yen(r0.bothDiff[k].net)}`);
}
const sumOf = (rec: Record<string, Hit[]>) => ITEMS.reduce((s, k) => s + rec[k].reduce((t, x) => t + x.v, 0), 0);
console.log(`
  ★ ② (支払用) はどちらの側か (片側の人月のうち、② の値が 当方と同じ側 = 当方だけ なら ②>0 / ① だけ なら ②=0)`);
for (const k of ITEMS) {
  const a = r0.oursOnly[k], b = r0.l1Only[k];
  if (!a.length && !b.length) continue;
  const aL2 = a.filter((x) => (l2Val(x.key, k) ?? 0) > 0).length, aNo = a.filter((x) => l2Val(x.key, k) == null).length;
  const bL2 = b.filter((x) => l2Val(x.key, k) === 0).length, bNo = b.filter((x) => l2Val(x.key, k) == null).length;
  console.log(`  ${k.padEnd(7, "　")}  当方だけ ${a.length} のうち ② も払う ${aL2} (② 行なし ${aNo})   ① だけ ${b.length} のうち ② も 0 ${bL2} (② 行なし ${bNo})`);
}
/** ② が 当方と違う側にいる片側の人月 (= 当方が ② と食い違う。★ 直す候補はここ) */
const againstL2 = (res: Result) => ITEMS.flatMap((k) => [
  ...res.oursOnly[k].filter((x) => l2Val(x.key, k) === 0).map((x) => ({ item: k, key: x.key, ours: x.v, l1: 0, l2: 0 })),
  ...res.l1Only[k].filter((x) => (l2Val(x.key, k) ?? 0) > 0).map((x) => ({ item: k, key: x.key, ours: 0, l1: x.v, l2: l2Val(x.key, k) ?? 0 })),
]);
const ag = againstL2(r0);
console.log(`
  ★ ② が 当方と違う側にいる片側: ${ag.length} 人月 (当方が払い ②=0: ${ag.filter((x) => x.ours > 0).length} 人月 ${yen(ag.reduce((s, x) => s + x.ours, 0))} / ② が払い 当方=0: ${ag.filter((x) => x.ours === 0).length} 人月 ${yen(ag.reduce((s, x) => s + x.l2, 0))})`);
for (const x of ag) console.log(`    ${x.item.padEnd(6, "　")} ${x.key}  当方 ${yen(x.ours)} / ① ${yen(x.l1)} / ② ${yen(x.l2)}`);
console.log(`  合計 当方だけ ${yen(sumOf(r0.oursOnly))} / ① だけ ${yen(sumOf(r0.l1Only))}  (★ 残業・特日・欠勤控除は ① の総支給に入っていない項目)`);
console.log(`  参考 (① に列が無い): ${NO_L1_COLUMN.map((k) => `${k} ${r0.noColumn[k].n} 人月 ${yen(r0.noColumn[k].sum)}`).join(" / ")}`);
console.log(`  行ごと片側: ① だけ (総支給>0・同じ事業所月は計算済み) ${r0.rowOnlyL1} 人月 / 当方だけ ${r0.rowOnlyOurs} 人月`);

// ── 負のコントロール (写しを壊す) ──
console.log("\n--- 負のコントロール");
{
  const i = l1.findIndex((x) => { const o = oursByKey.get(x.key); return !!o && !o.every(noWork) && num(x.d["出張費"]) > 0 && oursItems(o)["出張"] > 0; });
  const copy = l1.map((x, j) => (j === i ? { ...x, d: { ...x.d, 出張費: 0 } } : x));
  const n = run(copy, oursByKey).oursOnly["出張"].length;
  expect(i >= 0 && n === r0.oursOnly["出張"].length + 1, `① の写しの 出張費 を 1 件 0 にすると 当方だけ(出張) が +1 (${r0.oursOnly["出張"].length} → ${n})`);
}
{
  const k = [...oursByKey.keys()].find((key) => { const d = l1.find((y) => y.key === key)?.d; const o = oursByKey.get(key)!; return !!d && !o.every(noWork) && num(d["職能給"]) > 0 && oursItems(o)["職能給"] > 0; });
  const copy = new Map(oursByKey);
  if (k) copy.set(k, oursByKey.get(k)!.map((p) => ({ ...p, settings: p.settings ? { ...p.settings, skill_salary: 0 } : p.settings })));
  const n = run(l1, copy).l1Only["職能給"].length;
  expect(!!k && n === r0.l1Only["職能給"].length + 1, `当方の写しの 職能給 を 1 件 0 にすると ① だけ(職能給) が +1 (${r0.l1Only["職能給"].length} → ${n})`);
}
{
  const i = l1.findIndex((x) => Math.abs(num(x.d[L1_TOTAL]) - L1_TOTAL_TERMS.reduce((s, t) => s + num(x.d[t]), 0)) < 1.5 && num(x.d[L1_TOTAL]) > 0);
  const copy = l1.map((x, j) => (j === i ? { ...x, d: { ...x.d, [L1_TOTAL]: num(x.d[L1_TOTAL]) + 1000 } } : x));
  const n = run(copy, oursByKey).formulaOk;
  expect(n === r0.formulaOk - 1, `① の写しの 総支給 を 1 件 +1,000 すると 式の一致が −1 (${r0.formulaOk} → ${n})`);
}
{
  const k = [...oursByKey.keys()].find((key) => !oursByKey.get(key)!.every(noWork) && oursByKey.get(key)!.some((p) => Number(p.grand_total ?? 0) > 0));
  const copy = new Map(oursByKey);
  if (k) copy.set(k, oursByKey.get(k)!.map((p) => ({ ...p, summary: Object.fromEntries(Object.keys(p.summary ?? {}).map((x) => [x, 0])) as unknown as M["summary"], ...Object.fromEntries(TOP_KEYS.map((t) => [t, 0])) })));
  const n = run(l1, copy).noWork.n;
  expect(!!k && n === r0.noWork.n + 1, `当方の写しの 記録のある人月を 1 つ記録なしにすると 別掲が +1 (${r0.noWork.n} → ${n})`);
}
{
  const i = l1.findIndex((x) => { const o = oursByKey.get(x.key); return !!o && !o.every(noWork) && num(x.d["職能給"]) >= 1000 && oursItems(o)["職能給"] > 0; });
  const copy = l1.map((x, j) => (j === i ? { ...x, d: { ...x.d, 職能給: num(x.d["職能給"]).toLocaleString("en-US") } } : x));
  const n = run(copy, oursByKey).l1Only["職能給"].length + run(copy, oursByKey).oursOnly["職能給"].length;
  expect(i >= 0 && typeof copy[i].d["職能給"] === "string" && n === r0.l1Only["職能給"].length + r0.oursOnly["職能給"].length, `① の写しの 職能給 を "${i >= 0 ? copy[i].d["職能給"] : ""}" (カンマ付き文字列) にしても 片側の件数が変わらない`);
}
{
  const s = "10,000";
  expect(num(s) === 10000 && num("-2,533") === -2533 && num("1:00") === 0, `① のカンマ付き文字列を数値に直している ("10,000" → ${num(s)})`);
}

// ── 基準値 ──
type Baseline = { _readme: string[]; counts: Record<string, number> };
const counts: Record<string, number> = { 説明のつかない残差: r0.formulaBad.length, 記録なしの固定給: r0.noWork.n, "行ごと片側_①だけ": r0.rowOnlyL1, "行ごと片側_当方だけ": r0.rowOnlyOurs };
for (const k of ITEMS) { counts[`当方だけ:${k}`] = r0.oursOnly[k].length; counts[`①だけ:${k}`] = r0.l1Only[k].length; }
counts["②と違う側"] = ag.length;
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
