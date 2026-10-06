/**
 * check:office-input-roundtrip — 事業所書式の「ファイルの値を画面の入力に写す」で 給与計算の結果が変わらないか (2026-10-06 新設・読み取り専用)
 *
 *   npm run check:office-input-roundtrip
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────────
 * /office-input に「画面で直す」(ファイル取込の値を そのまま画面の入力に写す) を付けた。
 * 写した後は (職員 × 項目) 単位で 画面の入力がファイルに勝つ (to-form-records.ts mergeOfficeFormSources)。
 * ★ 写しただけで金額が変わったら 事故。★ 実データ全件 (payroll_office_form_records) で
 *   「元のファイルの行」と「ファイル → 写す (from-form-records) → 給与計算の形 (to-form-records) → 合流」を
 *   給与計算の関数に通して 同じ値になるかを見る。
 *
 * 比べるもの (= 事業所書式を読む関数すべて。逐語コピーせず本番の関数を呼ぶ):
 *   computeSummary (有給・半有給・特休・欠勤・通勤km・出張km・研修の日次 …) /
 *   trainingMinutes / hrdTrainingMinutes / shoninshaTrainingMinutes / allTrainingMinutes / meetingMinutes /
 *   computeMeetingFee / officeFormPaidLeaveDays / trainingMinutesByDay / legalWithinOvertimeMinutes (出勤簿は空) /
 *   computeChildcareAllowance (時給・月給)
 *
 * ── この検査が見ていないもの ─────────────────────────────────────────────
 *   ・写せない形 (canAdopt=false。日時項目で 1 行に日付が複数 など) は 写さないので 比べない (件数だけ出す)
 *   ・前月以前の有給 (usedBefore) の数え方 — 月ごとに独立に比べている
 */
import { restAll, normEmpNo } from "./_rest.mjs";
import {
  computeSummary, trainingMinutes, hrdTrainingMinutes, shoninshaTrainingMinutes, allTrainingMinutes, meetingMinutes,
  computeMeetingFee, officeFormPaidLeaveDays, trainingMinutesByDay, legalWithinOvertimeMinutes, computeChildcareAllowance,
  type OfficeFormRecord,
} from "../src/lib/payroll/payroll-calc.js";
import { planAdoptFromFormRecords } from "../src/lib/office-input/from-form-records.js";
import { officeInputEntriesToFormRecords, mergeOfficeFormSources, processingToBillingMonth } from "../src/lib/office-input/to-form-records.js";
import type { OfficeInputEntry } from "../src/lib/office-input/types.js";

let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };

type Row = OfficeFormRecord & { office_number: string; processing_month: string };
const all = await restAll<Row>("payroll_office_form_records?select=id,office_number,processing_month,employee_number,record_type,item_name,item_date,numeric_value,start_time,end_time,break_time,year_month,child_name,amount");

/** 給与計算が事業所書式から読む値を 1 つの文字列にする (比べる用) */
function fingerprint(recs: OfficeFormRecord[], ym: string, empNum: string): string {
  const s = computeSummary([], [], recs, "office_form_first", new Set(), ym);
  const byDay = [...trainingMinutesByDay(recs, ym)].sort();
  const visits = new Map<string, number>([[`${empNum}:${ym}`, 6000]]);
  return JSON.stringify({
    s, byDay,
    // 出張km は computeSummary ではなく page.tsx の tripKmOf が 事業所書式から足して読む
    trip: recs.filter((r) => r.record_type === "km" && r.item_name === "出張km").reduce((t, r) => t + (r.numeric_value ?? 0), 0),
    t: trainingMinutes(recs), h: hrdTrainingMinutes(recs), sh: shoninshaTrainingMinutes(recs), at: allTrainingMinutes(recs),
    mm: meetingMinutes(recs), mf: computeMeetingFee(recs, 1000), pl: officeFormPaidLeaveDays(recs),
    lw: legalWithinOvertimeMinutes([], recs),
    ccH: computeChildcareAllowance(recs, "時給", visits, empNum, ym),
    ccM: computeChildcareAllowance(recs, "月給", visits, empNum, ym),
  });
}

function roundtrip(recs: OfficeFormRecord[], ym: string): { records: OfficeFormRecord[]; adopted: number; skipped: number } {
  const billing = processingToBillingMonth(ym);
  const { plans } = planAdoptFromFormRecords(recs, billing);
  const ok = plans.filter((p) => p.canAdopt);
  const entries: OfficeInputEntry[] = ok.flatMap((p) => p.entries.map((e, i) => ({
    id: `x${i}`, tenant_id: "kt-group", employee_id: "E", billing_month: billing,
    category: e.category, item_name: e.item_name,
    numeric_value: e.numeric_value ?? null, time_minutes: e.time_minutes ?? null, date_value: e.date_value ?? null,
    start_time: e.start_time ?? null, end_time: e.end_time ?? null, break_minutes: e.break_minutes ?? null,
    child_name: e.child_name ?? null, reference_month: e.reference_month ?? null, notes: null,
    created_at: "", updated_at: "",
  })));
  const empNum = recs[0]?.employee_number ?? "";
  const web = officeInputEntriesToFormRecords(entries, new Map([["E", empNum]])).records;
  return { records: mergeOfficeFormSources(recs, web).records, adopted: ok.length, skipped: plans.length - ok.length };
}

const groups = new Map<string, Row[]>();
for (const r of all) {
  const k = `${r.office_number}|${normEmpNo(r.employee_number)}|${r.processing_month}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k)!.push(r);
}

let same = 0, diff = 0, adopted = 0, skipped = 0;
const diffs: string[] = [];
for (const [k, recs] of groups) {
  const ym = k.split("|")[2], emp = recs[0].employee_number;
  const rt = roundtrip(recs, ym);
  adopted += rt.adopted; skipped += rt.skipped;
  const a = fingerprint(recs, ym, normEmpNo(emp)), b = fingerprint(rt.records, ym, normEmpNo(emp));
  if (a === b) same++; else { diff++; if (diffs.length < 15) diffs.push(`    ${k}  ${recs.map((r) => `${r.item_name}:${r.item_date ?? r.numeric_value ?? ""}`).join(" ").slice(0, 160)}`); }
}
const { plans: allPlans } = planAdoptFromFormRecords(all, "2026-06");
const reasons = new Map<string, number>();
for (const p of allPlans.filter((x) => !x.canAdopt)) reasons.set(p.reason ?? "?", (reasons.get(p.reason ?? "?") ?? 0) + 1);

console.log("=== check:office-input-roundtrip (ファイルの値を画面に写しても給与計算が変わらないか) 2026-10-06 新設・読み取り専用 ===");
console.log(`  ファイルの行 ${all.length} / 職員 × 月 ${groups.size} / 写す (職員 × 項目) ${adopted} / 写せない ${skipped}`);
for (const [r, n] of reasons) console.log(`    写せない理由: ${r} (${n})`);
console.log(`  給与計算の値が 同じ ${same} / ★ 違う ${diff}`);
for (const d of diffs) console.log(d);
expect(diff === 0, `写した後も 給与計算が事業所書式から読む値は 全 ${groups.size} 職員×月で同じ`);

console.log("\n--- 負のコントロール (検査が効いていることの確認)");
{
  // 有給の日を 1 日落として写すと 違いが出る
  const g = [...groups.values()].find((rs) => rs.some((r) => r.item_name === "有給" && r.item_date))!;
  const ym = g[0].processing_month, emp = normEmpNo(g[0].employee_number);
  const rt = roundtrip(g, ym).records;
  const broken = rt.filter((r, i) => !(r.item_name === "有給" && i === rt.findIndex((x) => x.item_name === "有給")));
  expect(fingerprint(g, ym, emp) !== fingerprint(broken, ym, emp), "有給を 1 日落とすと 違いが出る");
}
{
  // 研修の終了を 30 分ずらすと 違いが出る
  const g = [...groups.values()].find((rs) => rs.some((r) => r.record_type === "training" && r.end_time))!;
  const ym = g[0].processing_month, emp = normEmpNo(g[0].employee_number);
  const rt = roundtrip(g, ym).records.map((r) => (r.record_type === "training" && r.end_time ? { ...r, end_time: `${String(Number(r.end_time.slice(0, 2)) + 1).padStart(2, "0")}${r.end_time.slice(2, 5)}` } : r));
  expect(fingerprint(g, ym, emp) !== fingerprint(rt, ym, emp), "研修の終了を 1 時間ずらすと 違いが出る");
}
{
  // 出張km を 1km 増やすと 違いが出る
  const g = [...groups.values()].find((rs) => rs.some((r) => r.item_name === "出張km" && Number(r.numeric_value) > 0))!;
  const ym = g[0].processing_month, emp = normEmpNo(g[0].employee_number);
  const rt = roundtrip(g, ym).records.map((r) => (r.item_name === "出張km" ? { ...r, numeric_value: Number(r.numeric_value) + 1 } : r));
  expect(fingerprint(g, ym, emp) !== fingerprint(rt, ym, emp), "出張km を 1 増やすと 違いが出る");
}
console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS");
process.exit(fail ? 1 : 0);
