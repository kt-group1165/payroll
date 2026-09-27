/**
 * check:shoninsha-adjustment — 初任者研修調整 (無資格の減額 shoninshaAdjustmentAmount) の検査 (2026-09-27 給与C)。
 *
 *   npm run check:shoninsha-adjustment
 *   SNAPSHOT=<path.json> npm run check:shoninsha-adjustment   # ②・計算結果を DB から読まず 保存済みを使う (check:soukatsu-cause と同じ形式)
 *
 * ── 何を見るか ─────────────────────────────────────────────────────────────
 *   ① 境界値 (fixture・DB 不要): 旗なし → 0 / 訪問 0 分 → 0 / 切り捨て / 同行は含めない (summary の同行を除く分だけ読む)
 *   ② 実データ: 総括表 ② の「初任者研修調整費」がある人月を、② の「実績」(同行を除く訪問の分) から 当方の式で出して 1 円一致
 *      さらに 当方の計算結果 (payload) の summary.visitMinutesExcludingAccompanied から出しても一致するか (★ 当方のデータだけで出せるか)
 *   ③ 旗を入れたときに 時給者の総支給がマイナスにならないか (payload の総支給 − 調整)
 *   ④ 入れ漏れ: ② に調整があるのに 旗 (payroll_monthly_inputs shoninsha_adjustment) が無い人月の件数。★ 合否に使わない
 *
 * ── 負のコントロール ───────────────────────────────────────────────────────
 *   切り捨てを round にする / 同行を含めた訪問分で掛ける / 100 円を 90 円にする → それぞれ 実データで外れること
 *
 * ── この検査が見ていないもの ───────────────────────────────────────────────
 *   ・誰に掛けるか (旗) の正しさ。資格の登録からは決まらないので 人が入れた旗を信じる
 *   ・旧システムの意図 (「無資格の時給を 100 円下げる代わり」は当方の解釈)
 *   ・payload が古い月: ② の実績と当方の訪問分がずれていれば ②-b で出る (合否に使う)
 */
import { readFileSync, existsSync } from "node:fs";
import { shoninshaAdjustmentAmount, shoninshaAdjustmentOf, UNCERTIFIED_RATE_CUT_PER_HOUR, hourlyTotalPay, type HourlyPayroll } from "../src/lib/payroll/payroll-calc.js";
import { restAll, empKey } from "./_rest.mjs";

let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "OK  " : "★ NG"} ${msg}`); if (!ok) fail++; };
const num = (v: unknown) => (typeof v === "number" ? v : Number(String(v ?? "").replace(/,/g, "")) || 0);

console.log("=== check:shoninsha-adjustment (初任者研修調整・無資格の減額) ===");
console.log(`★ 式: 切り捨て(同行を除く訪問分 × ${UNCERTIFIED_RATE_CUT_PER_HOUR} ÷ 60)。旗 (手入力) がある月だけ`);

console.log("\n① 境界値");
expect(shoninshaAdjustmentAmount(2055, false) === 0, "旗なし → 0");
expect(shoninshaAdjustmentAmount(0, true) === 0, "訪問 0 分 → 0");
expect(shoninshaAdjustmentAmount(1930, true) === 3216, "1,930 分 → 3,216.67 → 3,216 (切り捨て)");
expect(shoninshaAdjustmentAmount(60, true) === 100, "60 分 → 100");
{
  const e = { summary: { visitMinutesExcludingAccompanied: 90, visitMinutes: 395 }, shoninsha_adjustment_flag: true } as unknown as HourlyPayroll;
  expect(shoninshaAdjustmentOf(e) === 150, "同行は含めない: 訪問 395 分のうち 同行を除く 90 分 → 150 (吾妻 202604 と同じ形)");
}

type R2 = { office_number: string; employee_number: string; employee_name: string; processing_month: string; sheet_kind: string; row_data: Record<string, unknown> };
type Calc = { office_number: string; processing_month: string; calculated_at: string; payload: { hourly?: (HourlyPayroll & { grand_total?: number })[] } | null };
const path = process.env.SNAPSHOT;
const snap = path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
const rows: R2[] = snap ? snap.soukatsu : await restAll<R2>("payroll_soukatsu_rows?select=id,office_number,employee_number,employee_name,processing_month,sheet_kind,row_data&sheet_kind=eq.part");
const calc: Calc[] = snap ? snap.calc : await restAll<Calc>("payroll_calc_results?select=id,office_number,processing_month,calculated_at,payload");
const real = rows.filter((r) => r.sheet_kind === "part" && num(r.row_data["初任者研修調整費"]) !== 0);
const hourlyOf = (r: R2) => calc.find((c) => c.office_number === r.office_number && c.processing_month === r.processing_month)
  ?.payload?.hourly?.find((e) => empKey(r.office_number, e.employee_number) === empKey(r.office_number, r.employee_number));

console.log(`\n② 実データ (② の初任者研修調整費がある人月 ${real.length})`);
type Impl = (visitExcl: number, visitAll: number) => number;
const ours: Impl = (x) => shoninshaAdjustmentAmount(x, true);
const okAll = (f: Impl) => real.every((r) => f(num(r.row_data["実績"]), num(r.row_data["訪問時間"])) === -num(r.row_data["初任者研修調整費"]));
for (const r of real) {
  const want = -num(r.row_data["初任者研修調整費"]);
  const v2 = ours(num(r.row_data["実績"]), 0);
  const e = hourlyOf(r);
  const vOurs = e ? shoninshaAdjustmentAmount(e.summary?.visitMinutesExcludingAccompanied ?? 0, true) : null;
  expect(v2 === want, `${r.processing_month} ${r.office_number} ${r.employee_number} ${r.employee_name.replace(/\s+/g, " ")}: ② 実績 ${num(r.row_data["実績"])}分 → ${v2} (② ${want})`);
  expect(vOurs === want, `    当方の同行を除く訪問分 ${e?.summary?.visitMinutesExcludingAccompanied ?? "(当方に行が無い)"}分 → ${vOurs ?? "-"} (② ${want})`);
}

console.log("\n③ 旗を入れても 総支給がマイナスにならないか");
for (const r of real) {
  const e = hourlyOf(r);
  if (!e) continue;
  const withFlag = hourlyTotalPay({ ...e, shoninsha_adjustment_flag: true });
  expect(withFlag >= 0, `${r.processing_month} ${r.employee_number} 旗あり総支給 ${withFlag}`);
}

console.log("\n負のコントロール (わざと壊した式が 実データで外れるか)");
expect(real.length > 0 && okAll(ours), "正しい式は 全件一致 (前提)");
expect(!okAll((x) => Math.round((x * 100) / 60)), "切り捨てを round にすると外れる (杉尾 202607 3,216 → 3,217)");
expect(!okAll((_x, all) => Math.floor((all * 100) / 60 + 1e-6)), "同行を含めた訪問分で掛けると外れる (吾妻 202604 150 → 658)");
expect(!okAll((x) => Math.floor((x * 90) / 60 + 1e-6)), "100 円を 90 円にすると外れる");

console.log("\n④ 入れ漏れ (② に調整があるのに 旗が無い人月)。★ 合否に使わない");
try {
  const inputs = await restAll<{ office_number: string; employee_number: string; processing_month: string; numeric_value: number }>(
    "payroll_monthly_inputs?select=id,office_number,employee_number,processing_month,numeric_value&item_key=eq.shoninsha_adjustment");
  const has = new Set(inputs.filter((i) => Number(i.numeric_value) > 0).map((i) => `${empKey(i.office_number, i.employee_number)}|${i.processing_month}`));
  const missing = real.filter((r) => !has.has(`${empKey(r.office_number, r.employee_number)}|${r.processing_month}`));
  console.log(`  ② に調整がある人月 ${real.length} / うち旗が無い ${missing.length}`);
  for (const r of missing) console.log(`    ${r.processing_month} ${r.office_number} ${r.employee_number} ${r.employee_name.replace(/\s+/g, " ")} (② ${num(r.row_data["初任者研修調整費"])}円)`);
} catch (e) {
  console.log(`  (DB を読めなかったので 数えていない: ${String(e).slice(0, 120)})`);
}

console.log("");
if (fail) { console.log(`★ FAIL ${fail} 件`); process.exit(1); }
console.log("PASS");
