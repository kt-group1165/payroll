/**
 * check:km-double — 同じ km を 出張 と 通勤 の両方で払っている人月 (二重払い) を 元データから数える (2026-09-27 給与D)
 *
 *   npm run check:km-double
 *   SNAPSHOT=<path.json> npm run check:km-double       1 回目は保存し 2 回目から使い回す
 *   npm run check:km-double -- --update               ★ 基準値方式の数だけ更新
 *
 * ── 何を見るか ─────────────────────────────────────────────────────────
 *   給与計算は 出張km と 通勤km を別の元から取る (payroll-calc.ts / page.tsx の tripKmOf):
 *     出張km = 手入力 business_km > 事業所書式「出張km」> 出勤簿 business_km
 *     通勤km = 事業所書式「通勤km」 / 出勤簿 commute_km (職種で優先が違う)。手入力 commute_yen があれば円で上書き
 *   出張km の値が 同じ人月の 通勤km (書式 or 出勤簿) と一致したら 二重とみなす。
 *   ★ payload (payroll_calc_results) ではなく 元データを読む。計算の後に直された分・増えた分も入る。
 *
 * ── なぜ「値の一致」で判定してよいか (2026-09-27 実測) ─────────────────────
 *   分母 (出張km>0 かつ 通勤km>0 の人月) 83 のうち 一致 4。
 *   偶然一致の目安として「同じ人の 別の月の 出張km と 通勤km」を比べると 9/670 一致したが、
 *   9 件とも その人の いつもの通勤km が 出張km に入っている (江尻 63 / 福田 69 / 根本 16 / 五十嵐 100.8) = 偶然ではなく入れ間違い。
 *   → 値がたまたま同じになる例は 実データで見つからなかった。
 *   ② (支払用) は 4 件とも 片方だけ払っている (通勤 3 / 出張 1)。
 *   出張単価 と 通勤単価 は 全事業所×全月 (360) で同じ → どちらに寄せても金額は同じ (二重の分だけ減る)。
 *
 * ── 基準値方式 ─────────────────────────────────────────────────────────
 *   2026-09-27 時点 4 人月。★ どちらに寄せるか (出張 / 通勤) は user 判断待ち。決まったら直して減らす。
 * 負のコントロール: 写しの 1 人月の通勤km を出張km と同じ値にすると +1 / 一致している 1 人月の通勤km を 1km ずらすと −1
 * 見ていないもの: 出勤簿 commute_km が 1 日 COMMUTE_KM_AS_YEN_DAILY 以上 / 書式 通勤km が 月 COMMUTE_KM_AS_YEN_MONTHLY 以上 (給与計算が円とみなす値) は通勤km に数えない。
 *   手入力 commute_yen がある人月は 通勤を円で払うので対象外。出張と通勤の「足し算で一致」(一部だけ重なる) は見ていない
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { restAll } from "./_rest.mjs";
import { COMMUTE_KM_AS_YEN_DAILY, COMMUTE_KM_AS_YEN_MONTHLY } from "../src/lib/payroll/payroll-calc.js";

const UPDATE = process.argv.includes("--update");
const BASELINE = new URL("./check-km-double-baseline.json", import.meta.url);
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");

type Att = { office_number: string; employee_number: string; year: number; month: number; commute_km: number | null; business_km: number | null };
type Form = { office_number: string; employee_number: string; processing_month: string; item_name: string; numeric_value: number | null };
type MI = { office_number: string; employee_number: string; processing_month: string; item_key: string; numeric_value: number | null };
type Snap = { att: Att[]; form: Form[]; mi: MI[] };
const SNAPSHOT = process.env.SNAPSHOT ?? "";
let snap: Snap;
if (SNAPSHOT && existsSync(SNAPSHOT)) snap = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snap;
else {
  snap = {
    att: await restAll<Att>("payroll_attendance_records?select=id,office_number,employee_number,year,month,commute_km,business_km&or=(commute_km.gt.0,business_km.gt.0)"),
    form: await restAll<Form>("payroll_office_form_records?select=id,office_number,employee_number,processing_month,item_name,numeric_value&record_type=eq.km"),
    mi: await restAll<MI>("payroll_monthly_inputs?select=id,office_number,employee_number,processing_month,item_key,numeric_value&item_key=in.(business_km,commute_yen)"),
  };
  if (SNAPSHOT) writeFileSync(SNAPSHOT, JSON.stringify(snap));
}

/** 給与計算と同じ閾値 (これ以上は km ではなく 円 とみなす) */
const YEN_DAILY = COMMUTE_KM_AS_YEN_DAILY, YEN_MONTHLY = COMMUTE_KM_AS_YEN_MONTHLY;
type PM = { attCommute: number; attBiz: number; formTrip: number; formCommute: number; manualTrip: number | null; manualCommuteYen: number | null };
function build(s: Snap): Map<string, PM> {
  const pm = new Map<string, PM>();
  const g = (k: string) => { if (!pm.has(k)) pm.set(k, { attCommute: 0, attBiz: 0, formTrip: 0, formCommute: 0, manualTrip: null, manualCommuteYen: null }); return pm.get(k)!; };
  for (const r of s.att) {
    const x = g(`${r.office_number}|${nn(r.employee_number)}|${r.year}${String(r.month).padStart(2, "0")}`);
    const c = Number(r.commute_km) || 0;
    if (c < YEN_DAILY) x.attCommute += c;
    x.attBiz += Number(r.business_km) || 0;
  }
  for (const r of s.form) {
    const x = g(`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`);
    const v = Number(r.numeric_value) || 0;
    if (r.item_name === "出張km") x.formTrip += v;
    else if (r.item_name === "通勤km" && v < YEN_MONTHLY) x.formCommute += v;
  }
  for (const r of s.mi) {
    const x = g(`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`);
    const v = Number(r.numeric_value) || 0;
    if (r.item_key === "business_km" && v > 0) x.manualTrip = v;
    if (r.item_key === "commute_yen" && v > 0) x.manualCommuteYen = v;
  }
  return pm;
}
type Hit = { key: string; km: number; tripFrom: string; commuteFrom: string };
function run(s: Snap) {
  const pm = build(s);
  let denom = 0;
  const hits: Hit[] = [];
  for (const [key, x] of pm) {
    const trip = x.manualTrip ?? (x.formTrip > 0 ? x.formTrip : x.attBiz);
    if (!(trip > 0) || x.manualCommuteYen || !(x.formCommute > 0 || x.attCommute > 0)) continue;
    denom++;
    const tripFrom = x.manualTrip != null ? "手入力" : x.formTrip > 0 ? "事業所書式" : "出勤簿";
    for (const [commuteFrom, c] of [["事業所書式", x.formCommute], ["出勤簿", x.attCommute]] as const) {
      if (c > 0 && Math.abs(trip - c) < 0.05) { hits.push({ key, km: Math.round(trip * 100) / 100, tripFrom, commuteFrom }); break; }
    }
  }
  return { denom, hits };
}

console.log("=== check:km-double (同じ km を 出張 と 通勤 の両方で払っている人月・元データ) ===");
const r0 = run(snap);
console.log(`分母 (出張km>0 かつ 通勤km>0・通勤を円で上書きしていない人月): ${r0.denom} / 二重: ${r0.hits.length}`);
for (const h of r0.hits) console.log(`  ${h.key}  ${h.km}km  出張=${h.tripFrom} / 通勤=${h.commuteFrom}`);
console.log("  ★ 出張単価と通勤単価は同じなので どちらに寄せても金額は同じ。寄せ先は user 判断待ち");

console.log("\n--- 負のコントロール (写しを壊す)");
{
  // 二重でない人月に 出張km と同じ値の 書式「通勤km」を足す
  const pm = build(snap);
  const hitKeys = new Set(r0.hits.map((h) => h.key));
  const target = [...pm].find(([k, x]) => !hitKeys.has(k) && !x.manualCommuteYen && x.manualTrip == null && x.formTrip > 0 && x.formTrip < YEN_MONTHLY && x.formCommute === 0 && x.attCommute === 0);
  let n = -1;
  if (target) {
    const [k, x] = target; const [on, num, m] = k.split("|");
    n = run({ ...snap, form: [...snap.form, { office_number: on, employee_number: num, processing_month: m, item_name: "通勤km", numeric_value: x.formTrip }] }).hits.length;
  }
  expect(!!target && n === r0.hits.length + 1, `二重でない 1 人月に 出張km と同じ値の通勤km を足すと ${r0.hits.length} → ${r0.hits.length + 1} (実際 ${n})`);
}
{
  const h = r0.hits.find((x) => x.commuteFrom === "事業所書式");
  let n = -1;
  if (h) {
    const [on, num, m] = h.key.split("|");
    const form = snap.form.map((r) => (r.office_number === on && nn(r.employee_number) === num && r.processing_month === m && r.item_name === "通勤km" ? { ...r, numeric_value: (Number(r.numeric_value) || 0) + 1 } : r));
    n = run({ ...snap, form }).hits.length;
  }
  expect(!!h && n === r0.hits.length - 1, `二重の 1 人月の通勤km を 1km ずらすと ${r0.hits.length} → ${r0.hits.length - 1} (実際 ${n})`);
}

type Baseline = { _readme: string[]; hits: number; denom: number };
const baseline: Baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline : { _readme: [], hits: Number.POSITIVE_INFINITY, denom: 0 };
if (UPDATE) {
  Object.assign(baseline, { hits: r0.hits.length, denom: r0.denom });
  writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  console.log("\n基準値を更新しました");
} else {
  console.log(`\n基準値: 二重 ${baseline.hits} 人月 (分母 ${baseline.denom})`);
  expect(r0.hits.length <= baseline.hits, `二重の人月が基準値から増えていない (${r0.hits.length} <= ${baseline.hits})`);
}
console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS");
process.exit(fail ? 1 : 0);
