/**
 * check:non-care-records — 介護時間・訪問時間に 訪問でない実績 (会議・面談・契約・担当者会議・健康診断) を数えないこと (2026-09-27 給与D)
 *
 *   npm run check:non-care-records
 *   SNAPSHOT=<path.json> npm run check:non-care-records     1 回目は保存し 2 回目から使い回す
 *
 * 何を見るか
 *   1. 種別ごと (fixture): NON_CARE_SERVICE_TYPES の 5 種は外れる / 研修・HRD研修・キャンセル・ドタキャン・モニタリング・
 *      移動支援・自費 は外れない (payroll-calc.ts の定数のコメントに 入れない理由がある)
 *   2. 関数 (fixture): careMinutesFromRecords (月給の介護時間・特日) と computeSummary (時給・月給の訪問時間・件数・土日祝・特日) が
 *      同じ定数で外す
 *   3. 配線 (静的): page.tsx の実績の読み込みが service_type を取っている (取らないと 全部「訪問」扱いになり 黙って効かない)
 *   4. 実データ (★ 9/23 の給与計算に基づく): 外した介護時間が ② (支払用) の「120h以上対象時間」と一致する人月の数
 *      (2026-09-27: 5 種の行がある 14 人月で 外す前 0 → 外した後 9) と 動く金額 (月給の介護超過 −¥5,000 / 時給 0)
 * 負のコントロール: 定数を空にしたのと同じ判定では 一致が 外す前の数に戻る / 研修も外す判定にすると 研修のケースが落ちる
 * 見ていないもの: 時給の訪問ごとの支払い (類型で決まる。対象外は払わない) / 時給の残業 (hourlyOvertimeMinutes は実績をそのまま使う)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { restAll } from "./_rest.mjs";
import {
  NON_CARE_SERVICE_TYPES, isCareRecord, careMinutesFromRecords, computeSummary, careOvertimePay,
  type VisitServiceRecord, type MonthlyPayroll,
} from "../src/lib/payroll/payroll-calc.js";

let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^-?[\d,]+(\.\d+)?$/.test(v.trim()) ? Number(v.replace(/,/g, "")) : 0);

console.log("=== check:non-care-records (介護時間・訪問時間に 訪問でない実績を数えない) ===");
console.log(`外す種別: ${NON_CARE_SERVICE_TYPES.join(" / ")}`);

// ── 1. 種別ごと ──
type Pred = (r: { service_type?: string | null }) => boolean;
const EXCLUDE = ["会議", "面談", "契約", "担当者会議", "健康診断"];
const KEEP = ["研修", "HRD研修", "キャンセル", "ドタキャン", "モニタリング", "移動身あり1", "自費（生活）", "身体介護(自立)"];
function typeCases(pred: Pred) {
  const bad: string[] = [];
  for (const t of EXCLUDE) if (pred({ service_type: t })) bad.push(`${t} が外れない`);
  for (const t of KEEP) if (!pred({ service_type: t })) bad.push(`${t} が外れる`);
  return bad;
}
console.log("\n--- 1. 種別ごと");
{
  const bad = typeCases(isCareRecord);
  for (const t of EXCLUDE) expect(!bad.includes(`${t} が外れない`), `${t} は 介護時間に数えない`);
  for (const t of KEEP) expect(!bad.includes(`${t} が外れる`), `${t} は 数える`);
  expect(isCareRecord({ service_type: " 会議 " }) === false && isCareRecord({}) === true, "前後の空白は無視 / 種別が無い行は 訪問として数える");
}

// ── 2. 関数 ──
console.log("\n--- 2. 関数 (fixture)");
const rec = (service_type: string, calc_duration: string, service_date = "2026/06/08"): VisitServiceRecord => ({
  id: service_type + calc_duration + service_date, employee_number: "1", employee_name: "x", service_date, calc_duration, service_code: "000000",
  office_number: "0", accompanied_visit: "", client_number: "", dispatch_start_time: "", dispatch_end_time: "", time_period: "日中", holiday_type: "平日", service_type,
});
const fixture = [rec("身体介護(自立)", "001:00"), rec("会議", "001:00"), rec("面談", "000:30"), rec("研修", "000:45"), rec("健康診断", "001:00", "2026/06/07")];
{
  const care = careMinutesFromRecords(fixture, () => false);
  expect(care === 105, `careMinutesFromRecords: 訪問 60 + 研修 45 = 105 分 (会議・面談・健康診断は外す) (実際 ${care})`);
  const s = computeSummary(fixture, [], []);
  expect(s.visitMinutes === 105 && s.recordCount === 2, `computeSummary: 訪問時間 105 分・件数 2 (実際 ${s.visitMinutes} 分・${s.recordCount} 件)`);
  expect(s.weekendHolidayMinutes === 0, `computeSummary: 日曜 (6/7) の健康診断は (他は平日 6/8) 土日祝の時間に数えない (実際 ${s.weekendHolidayMinutes})`);
  expect(s.workDays >= 0, "computeSummary が落ちない");
}

// ── 3. 配線 ──
console.log("\n--- 3. 配線 (静的)");
const page = readFileSync(new URL("../src/app/payroll/page.tsx", import.meta.url), "utf8");
const calcSrc = readFileSync(new URL("../src/lib/payroll/payroll-calc.ts", import.meta.url), "utf8");
const selectHasType = (p: string) => /from\("payroll_service_records"\)\s*\.select\("id,employee_number,employee_name,service_date,[^"]*\bservice_type\b[^"]*"\)/.test(p);
const careWired = (c: string) => /export function careMinutesFromRecords[\s\S]{0,300}?records\.filter\(isCareRecord\)/.test(c);
const summaryWired = (c: string) => /const careRecs = empRecs\.filter\(isCareRecord\);[\s\S]{0,400}const visitMinutes = careRecs\./.test(c);
expect(selectHasType(page), "page.tsx の実績の読み込み (給与計算に使う本体) が service_type を取っている");
expect(careWired(calcSrc), "careMinutesFromRecords (月給の介護時間・特日) が isCareRecord を通す");
expect(summaryWired(calcSrc), "computeSummary (訪問時間・件数・土日祝・特日) が isCareRecord を通す");

// ── 4. 実データ ──
console.log("\n--- 4. 実データ (★ 2026-09-23 の給与計算に基づく)");
type R = { office_number: string; employee_number: string; processing_month: string; service_type: string; calc_duration: string };
type Snap = { recs: R[]; calc: { office_number: string; processing_month: string; calculated_at: string; monthly: (MonthlyPayroll & { employee_number: string; employee_name: string })[] | null }[]; l2: { office_number: string; employee_number: string; processing_month: string; care: string | null }[] };
const SNAPSHOT = process.env.SNAPSHOT ?? "";
let snap: Snap;
if (SNAPSHOT && existsSync(SNAPSHOT)) snap = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snap;
else {
  const types = [...new Set([...NON_CARE_SERVICE_TYPES, ...EXCLUDE, "研修"])].join(",");
  snap = {
    recs: await restAll<R>(`payroll_service_records?select=id,office_number,employee_number,processing_month,service_type,calc_duration&service_type=in.(${types})`),
    calc: await restAll("payroll_calc_results?select=id,office_number,processing_month,calculated_at,monthly:payload->monthly"),
    l2: await restAll("payroll_soukatsu_rows?select=id,office_number,employee_number,processing_month,care:row_data->>120h以上対象時間&sheet_kind=eq.shaseki"),
  };
  if (SNAPSHOT) writeFileSync(SNAPSHOT, JSON.stringify(snap));
}
const l2care = new Map(snap.l2.map((r) => [`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, num(r.care)]));
const pd = (s: string) => { const t = String(s ?? "").trim(); if (!t.includes(":")) return 0; const [h, m] = t.split(":").map(Number); const v = (h || 0) * 60 + (m || 0); return v >= 1440 ? 0 : v; };
/** 9/23 の care_minutes (外す前) から pred で外れる行の分を引く */
function realData(pred: Pred) {
  const removed = new Map<string, number>();
  for (const r of snap.recs) if (!pred(r)) { const k = `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`; removed.set(k, (removed.get(k) ?? 0) + pd(r.calc_duration)); }
  let n = 0, agree = 0, yen = 0; const moved: string[] = [];
  for (const c of snap.calc) for (const p of c.monthly ?? []) {
    const k = `${c.office_number}|${nn(p.employee_number)}|${c.processing_month}`;
    const rm = removed.get(k); if (!rm || !p.settings) continue;
    n++;
    const care = (p.care_minutes ?? p.summary.visitMinutes) - rm;
    const l2 = l2care.get(k); if (l2 && Math.abs(care - l2) < 1) agree++;
    const d = careOvertimePay({ ...p, care_minutes: care }) - careOvertimePay(p);
    if (d !== 0) { yen += d; moved.push(`${k} ${p.employee_name} −${rm}分 介護超過 ${d}`); }
  }
  return { n, agree, yen, moved };
}
const after = realData(isCareRecord);
const before = realData(() => true);
console.log(`  5 種の行がある月給の人月: ${after.n} / ② の120h対象時間と一致: 外した後 ${after.agree} (2026-09-27: 14 人月中 外す前 0 → 外した後 9)`);
console.log(`  介護超過が動く人月 ${after.moved.length} / 計 ¥${after.yen.toLocaleString()} (★ 9/23 の計算に基づく)`);
for (const m of after.moved) console.log(`    ${m}`);

console.log("\n--- 負のコントロール");
{
  // 定数を空にしたのと同じ (何も外さない) → 5 種の行がある人月で ② と一致する数が 外す前の値に戻る
  const removedKeys = new Set(snap.recs.filter((r) => EXCLUDE.includes(String(r.service_type).trim())).map((r) => `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`));
  let agreeNone = 0;
  for (const c of snap.calc) for (const p of c.monthly ?? []) {
    const k = `${c.office_number}|${nn(p.employee_number)}|${c.processing_month}`;
    if (!removedKeys.has(k) || !p.settings) continue;
    const l2 = l2care.get(k); if (l2 && Math.abs((p.care_minutes ?? p.summary.visitMinutes) - l2) < 1) agreeNone++;
  }
  expect(agreeNone < after.agree, `定数を空にしたのと同じ判定だと ② との一致が ${after.agree} → ${agreeNone} に戻る`);
  expect(before.moved.length === 0, `何も外さない判定では 金額が動かない (実際 ${before.moved.length} 人月)`);
}
{
  const withTraining: Pred = (r) => isCareRecord(r) && String(r.service_type ?? "").trim() !== "研修";
  const bad = typeCases(withTraining);
  expect(bad.includes("研修 が外れる"), "研修も外す判定にすると 種別ごとの検査が鳴る (研修 が外れる)");
}
{
  const broken = page.replace(",holiday_type,service_type\")", ",holiday_type\")");
  expect(broken !== page && !selectHasType(broken), "page.tsx の写しの読み込みから service_type を消すと 配線の検査が鳴る");
}

console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS");
process.exit(fail ? 1 : 0);
