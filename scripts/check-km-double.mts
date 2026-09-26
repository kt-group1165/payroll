/**
 * check:km-double — 同じ km を 出張 と 通勤 の両方で払っている人月 (二重払い) が 0 であることを 元データから確かめる (2026-09-27 給与D)
 *
 *   npm run check:km-double
 *   SNAPSHOT=<path.json> npm run check:km-double       1 回目は保存し 2 回目から使い回す
 *
 * ── 何を見るか ─────────────────────────────────────────────────────────
 *   給与計算は 出張km と 通勤km を別の元から取る:
 *     出張km = 手入力 business_km > 事業所書式「出張km」> 出勤簿 business_km (page.tsx tripKmOf)
 *     通勤km = 事務員は 書式「通勤km」優先 / それ以外は 出勤簿 commute_km 優先 (payroll-calc.ts)。手入力 commute_yen があれば円で上書き
 *   ★ 2026-09-27 に tripKmExcludingCommute (payroll-calc.ts) を入れ、出張km が 払う通勤km と同じ値なら 出張を 0 にした (通勤に寄せる)。
 *   この検査は 元データ (事業所書式・出勤簿・手入力) から 払う通勤km を組み立て、その関数を通した後に 二重が 0 かを見る。
 *   ★ payload (payroll_calc_results) ではなく 元データを読む。計算の後に直された分・増えた分も入る。
 *
 * ── 0 を目指す検査 ─────────────────────────────────────────────────────
 *   以前は 4 人月 (江尻 1270906546|917|202608 63km / 福田 1270402116|221006|202604 48km /
 *   根本カオリ 1272401967|231106|202606 16km / 五十嵐 1272603851|250207|202604 100.8km。計 ¥2,837)。
 *   (b) で 0 にした。★ 0 でなくなったら 二重が再発している (関数を通らない経路ができた)。
 *   入力の段階の一致 (関数を通す前) は 参考として件数を出す (入力を直すかは別の話。合否には使わない)。
 *
 * ── なぜ 通勤に寄せたか (★ 当方の判断。user が覆せる) ─────────────────────
 *   同じ人の別の月と比べると 出張km に入っていた値は どれも その人の「いつもの通勤km」だった
 *   (670 組中 9 組が一致し、9 組とも この形) = 通勤の km が 出張の欄に入り込んでいる。② は 通勤 3 / 出張 1。
 *   ★ 出張単価と通勤単価は 全事業所×全月 (360 通り) で同じなので どちらに寄せても金額は同じ (欄が変わるだけ)。
 *
 * 負のコントロール: ① 関数を「何もしない」に差し替えると 二重が 4 に戻る
 *   ② 二重でない人月に 出張km と同じ値の通勤km を足すと (関数なしなら) +1 / ③ page.tsx の写しから 関数の呼び出しを消すと 配線の検査が鳴る
 * 見ていないもの: 出勤簿 commute_km が 1 日 COMMUTE_KM_AS_YEN_DAILY 以上 / 書式 通勤km が 月 COMMUTE_KM_AS_YEN_MONTHLY 以上
 *   (給与計算が円とみなす値) は通勤km に数えない。「足し算で一致」(一部だけ重なる) は見ていない。
 *   参考: 出張km が その人の 別の月の通勤km と同じ (その月は通勤が 0 なので二重ではないが 出張として払っている可能性)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { restAll } from "./_rest.mjs";
import { COMMUTE_KM_AS_YEN_DAILY, COMMUTE_KM_AS_YEN_MONTHLY, tripKmExcludingCommute } from "../src/lib/payroll/payroll-calc.js";

let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");

type Att = { office_number: string; employee_number: string; year: number; month: number; commute_km: number | null; business_km: number | null };
type Form = { office_number: string; employee_number: string; processing_month: string; item_name: string; numeric_value: number | null };
type MI = { office_number: string; employee_number: string; processing_month: string; item_key: string; numeric_value: number | null };
type Office = { id: string; office_number: string; travel_unit_price: number | null };
type Oup = { office_id: string; effective_from: string; travel_unit_price: number | null };
type Emp = { office_id: string; employee_number: string; role_type: string | null; is_office_worker: boolean | null };
type Snap = { att: Att[]; form: Form[]; mi: MI[]; offices: Office[]; oup: Oup[]; emps: Emp[] };
const SNAPSHOT = process.env.SNAPSHOT ?? "";
let snap: Snap;
if (SNAPSHOT && existsSync(SNAPSHOT)) snap = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snap;
else {
  snap = {
    att: await restAll<Att>("payroll_attendance_records?select=id,office_number,employee_number,year,month,commute_km,business_km&or=(commute_km.gt.0,business_km.gt.0)"),
    form: await restAll<Form>("payroll_office_form_records?select=id,office_number,employee_number,processing_month,item_name,numeric_value&record_type=eq.km"),
    mi: await restAll<MI>("payroll_monthly_inputs?select=id,office_number,employee_number,processing_month,item_key,numeric_value&item_key=in.(business_km,commute_yen)"),
    offices: await restAll<Office>("payroll_offices?select=id,office_number,travel_unit_price"),
    oup: await restAll<Oup>("payroll_office_unit_prices?select=id,office_id,effective_from,travel_unit_price"),
    emps: await restAll<Emp>("payroll_employees?select=id,office_id,employee_number,role_type,is_office_worker"),
  };
  if (SNAPSHOT) writeFileSync(SNAPSHOT, JSON.stringify(snap));
}
if (!snap.emps || !snap.offices) { console.log("★ SNAPSHOT が古い形式です (emps / offices が無い)。消して取り直してください"); process.exit(1); }

const YEN_DAILY = COMMUTE_KM_AS_YEN_DAILY, YEN_MONTHLY = COMMUTE_KM_AS_YEN_MONTHLY;
const offByNum = new Map(snap.offices.map((o) => [o.office_number, o]));
const offNumById = new Map(snap.offices.map((o) => [o.id, o.office_number]));
const officeWorker = new Set(snap.emps.filter((e) => e.role_type === "事務員" || e.is_office_worker).map((e) => `${offNumById.get(e.office_id)}|${nn(e.employee_number)}`));
const travelPriceAt = (on: string, m: string) => {
  const o = offByNum.get(on); if (!o) return 0;
  const d = `${m.slice(0, 4)}-${m.slice(4)}-01`;
  const h = snap.oup.filter((x) => x.office_id === o.id && x.effective_from <= d).sort((a, b) => a.effective_from.localeCompare(b.effective_from)).at(-1);
  return Number(h?.travel_unit_price ?? o.travel_unit_price ?? 0);
};

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
type Hit = { key: string; km: number; tripFrom: string; commuteFrom: string; yen: number };
type Dedupe = (trip: number, paidCommute: number, overridden: boolean) => number;
/** 元データから 払う出張km と 払う通勤km を組み立て、dedupe を通した後に 同じ値で両方払う人月 */
function run(s: Snap, dedupe: Dedupe) {
  const pm = build(s);
  let denom = 0;
  const hits: Hit[] = [];
  for (const [key, x] of pm) {
    const [on, num, m] = key.split("|");
    const tripRaw = x.manualTrip ?? (x.formTrip > 0 ? x.formTrip : x.attBiz);
    // 払う通勤km (payroll-calc.ts と同じ: 事務員は書式優先 / それ以外は出勤簿優先。どちらも無ければもう一方)
    const useForm = officeWorker.has(`${on}|${num}`) ? (x.formCommute > 0 || !(x.attCommute > 0)) : (!(x.attCommute > 0) && x.formCommute > 0);
    const paidCommute = x.manualCommuteYen ? 0 : useForm ? x.formCommute : x.attCommute;
    if (!(tripRaw > 0) || !(paidCommute > 0)) continue;
    denom++;
    const trip = dedupe(tripRaw, paidCommute, !!x.manualCommuteYen);
    if (trip > 0 && Math.abs(trip - paidCommute) < 0.05) {
      hits.push({ key, km: Math.round(trip * 100) / 100, tripFrom: x.manualTrip != null ? "手入力" : x.formTrip > 0 ? "事業所書式" : "出勤簿", commuteFrom: useForm ? "事業所書式" : "出勤簿", yen: Math.ceil(trip * travelPriceAt(on, m) - 1e-6) });
    }
  }
  return { denom, hits };
}
const identity: Dedupe = (trip) => trip;

console.log("=== check:km-double (同じ km を 出張 と 通勤 の両方で払っている人月・元データ) ===");
const before = run(snap, identity);
const after = run(snap, tripKmExcludingCommute);
console.log(`分母 (払う出張km>0 かつ 払う通勤km>0 の人月): ${after.denom}`);
console.log(`参考: 入力の段階で同じ値 (関数を通す前): ${before.hits.length} 人月 → tripKmExcludingCommute で 出張を 0 にする。★ 減る額 (dry-run) 計 ¥${before.hits.reduce((s, h) => s + h.yen, 0).toLocaleString()}`);
for (const h of before.hits) console.log(`    ${h.key}  ${h.km}km  出張=${h.tripFrom} / 通勤=${h.commuteFrom}  出張費 −¥${h.yen.toLocaleString()} (通勤として 1 回だけ払う)`);
console.log("  ★ 通勤に寄せたのは当方の判断 (出張km の値が どれも本人のいつもの通勤km だった。② も通勤 3 / 出張 1)。出張単価 = 通勤単価なので 金額は寄せ先で変わらない");
expect(after.hits.length === 0, `関数を通した後の 二重: ${after.hits.length} 人月 (0 であること)`);
for (const h of after.hits) console.log(`    ★ ${h.key} ${h.km}km`);

// 参考: 出張km が その人の 別の月の通勤km と同じ (その月は通勤が 0 か 別の値 = 二重ではない)
{
  const pm = build(snap);
  const byPerson = new Map<string, { m: string; x: PM }[]>();
  for (const [k, x] of pm) { const [on, num, m] = k.split("|"); const p = `${on}|${num}`; byPerson.set(p, [...(byPerson.get(p) ?? []), { m, x }]); }
  const ref: string[] = [];
  for (const [p, arr] of byPerson) for (const a of arr) {
    const trip = a.x.manualTrip ?? (a.x.formTrip > 0 ? a.x.formTrip : a.x.attBiz);
    if (!(trip > 0) || Math.abs(trip - a.x.formCommute) < 0.05 || Math.abs(trip - a.x.attCommute) < 0.05) continue;
    const other = arr.find((b) => b.m !== a.m && [b.x.formCommute, b.x.attCommute].some((c) => c > 0 && Math.abs(c - trip) < 0.05));
    if (other) ref.push(`${p}|${a.m} 出張 ${Math.round(trip * 100) / 100}km = ${other.m} の通勤km`);
  }
  console.log(`\n参考 (合否に使わない): 出張km が その人の別の月の通勤km と同じ: ${ref.length} 人月 (出張として払っているが 通勤の入れ間違いかもしれない)`);
  for (const l of ref) console.log(`    ${l}`);
}

console.log("\n--- 配線 (出張km のどの段から来ても 関数を通る)");
const page = readFileSync(new URL("../src/app/payroll/page.tsx", import.meta.url), "utf8");
const calcSrc = readFileSync(new URL("../src/lib/payroll/payroll-calc.ts", import.meta.url), "utf8");
const wiredHourly = (p: string) => /hourlyBusinessTripFeeAmount\(\s*tripKmExcludingCommute\(tripKmOf\(/.test(p);
const wiredMonthly = (c: string) => /export function effectiveTravelKm[^{]*\{\s*return tripKmExcludingCommute\(/.test(c);
expect(wiredHourly(page), "時給: page.tsx の出張費が tripKmExcludingCommute(tripKmOf(...)) を通っている");
expect(wiredMonthly(calcSrc), "月給: effectiveTravelKm (出張費・移動費の全表示が使う) が tripKmExcludingCommute を通っている");

console.log("\n--- 負のコントロール (写しを壊す)");
expect(before.hits.length > 0, `① 関数を「何もしない」に差し替えると 二重が ${before.hits.length} 人月に戻る (0 より大きい)`);
{
  const pm = build(snap);
  const hitKeys = new Set(before.hits.map((h) => h.key));
  const target = [...pm].find(([k, x]) => { const [on, num] = k.split("|"); return !hitKeys.has(k) && !x.manualCommuteYen && x.manualTrip == null && x.formTrip > 0 && x.formTrip < YEN_MONTHLY && x.formCommute === 0 && x.attCommute === 0 && officeWorker.has(`${on}|${num}`); });
  let nRaw = -1, nFixed = -1;
  if (target) {
    const [k, x] = target; const [on, num, m] = k.split("|");
    const s2 = { ...snap, form: [...snap.form, { office_number: on, employee_number: num, processing_month: m, item_name: "通勤km", numeric_value: x.formTrip }] };
    nRaw = run(s2, identity).hits.length; nFixed = run(s2, tripKmExcludingCommute).hits.length;
  }
  expect(!!target && nRaw === before.hits.length + 1 && nFixed === 0, `② 二重でない人月に 出張km と同じ値の通勤km を足すと 関数なし ${before.hits.length} → ${nRaw} / 関数あり 0 → ${nFixed}`);
}
{
  const brokenPage = page.replace(/tripKmExcludingCommute\(tripKmOf\(empNum, empSummary\.businessKmTotal\), [^)]*\)\)/, "tripKmOf(empNum, empSummary.businessKmTotal)");
  expect(brokenPage !== page && !wiredHourly(brokenPage), "③ page.tsx の写しから 関数の呼び出しを消すと 配線 (時給) が鳴る");
}

console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS");
process.exit(fail ? 1 : 0);
