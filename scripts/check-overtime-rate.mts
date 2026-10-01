/**
 * check:overtime-rate — 月給者の **残業単価** だけを ② と突合する。★ 基準値方式・読み取り専用。
 *
 *   npm run check:overtime-rate
 *   npm run check:overtime-rate -- --update        … 基準値を取り直す (UPDATE_NOTE が要る)
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────────
 * 残業総額の差は **単価の差** と **時間の差** のどちらでも起きるのに、分ける手段が無かった。
 * ★ 2026-10-01 に分けたら 単価は 1,305/1,317 (99.1%) 一致していて、★ 残るのは 2 名だけだった
 * → ★ 残業総額の残り (84 人月) は **ほぼ全部 時間の話**。追う先が決まる。
 *
 * ── 何を見るか ────────────────────────────────────────────────────────────
 *   ② の「残業単価」列 ←→ 本番の overtimeHourlyRate() (= round(基礎 ÷ 所定時間 × 1.25))。
 *   ★ 逐語コピーはしない。payroll-calc.ts から import する。
 *   ★ 時間 (残業の分) は **見ない**。そちらは check:verification-verdicts の 残業総額。
 *
 * ── この検査が見ていないもの ──────────────────────────────────────────────
 *   ・時給者の残業単価 (② の列が別・計算も別)
 *   ・固定残業代を引いた後の 支給額 (→ check:verification-verdicts の 残業総額)
 *   ・★ ② に 残業単価の列が無い人月 (比べられない)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { restAll, normEmpNo } from "./_rest.mjs";
import { overtimeHourlyRate, type OvertimeSetting, type MonthlyPayroll } from "../src/lib/payroll/payroll-calc.js";

const UPDATE = process.argv.includes("--update");
const NOTE = process.env.UPDATE_NOTE ?? "";
const BASELINE = new URL("./check-overtime-rate-baseline.json", import.meta.url);
type Calc = { office_number: string; processing_month: string; payload: Record<string, unknown> };
type Souk = { office_number: string; processing_month: string; employee_number: string; row_data: Record<string, unknown> };
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };

async function main() {
  console.log("=== check:overtime-rate (月給者の残業単価 vs ②) 2026-10-01 新設・読み取り専用 ===");
  const calc = await restAll<Calc>("payroll_calc_results?select=id,office_number,processing_month,payload");
  const souk = await restAll<Souk>("payroll_soukatsu_rows?select=id,office_number,processing_month,employee_number,row_data");
  const sOf = new Map(souk.map((s) => [`${s.office_number}|${normEmpNo(s.employee_number)}|${s.processing_month}`, s.row_data]));

  let n = 0, same = 0, noRate = 0, noSettings = 0;
  const diffs: { k: string; name: string; ours: number; souk: number }[] = [];
  for (const c of calc) {
    const otMap = new Map(((c.payload.overtime_settings ?? []) as OvertimeSetting[]).map((r) => [r.job_type, r]));
    for (const e of ((c.payload.monthly ?? []) as Record<string, unknown>[])) {
      const k = `${c.office_number}|${normEmpNo(String(e.employee_number ?? ""))}|${c.processing_month}`;
      const d = sOf.get(k);
      if (!d) continue;
      const s2 = num(d["残業単価"]);
      if (s2 <= 0) { noRate++; continue; }
      const ours = overtimeHourlyRate(e as unknown as MonthlyPayroll, otMap);
      if (ours === null) { noSettings++; continue; }
      n++;
      if (Math.abs(ours - s2) <= 1) same++;
      else diffs.push({ k, name: String(e.employee_name ?? "").replace(/\s+/g, " "), ours, souk: s2 });
    }
  }
  console.log(`  比べられた ${n} 人月 / 一致 ${same} (${(same / Math.max(n, 1) * 100).toFixed(1)}%) / 不一致 ${diffs.length}`);
  console.log(`  ★ 比べていない: ② に残業単価の列が無い ${noRate} 人月 / 当方に給与設定が無い ${noSettings} 人月`);
  if (diffs.length) {
    console.log("\n--- 不一致 (差の大きい順)");
    for (const d of diffs.sort((a, b) => Math.abs(b.ours - b.souk) - Math.abs(a.ours - a.souk)))
      console.log(`  ${d.k} ${d.name.slice(0, 12).padEnd(13)} 当方 ${String(d.ours).padStart(6)} / ② ${String(d.souk).padStart(6)}  差 ${String(d.ours - d.souk).padStart(5)}`);
  }

  console.log("\n--- 負のコントロール (検査が効いていることの確認)");
  const base = { job_type: "訪問介護", role_type: "社員",
    settings: { base_personal_salary: 168000, skill_salary: 0, position_allowance: 0, qualification_allowance: 0,
      tenure_allowance: 0, treatment_improvement: 0, specific_treatment_improvement: 0, treatment_subsidy: 0,
      fixed_overtime_pay: 0, special_bonus: 0 } } as unknown as MonthlyPayroll;
  const ot = { job_type: "訪問介護", scheduled_hours_per_month: 168, include_base_personal_salary: true,
    include_skill_salary: false, include_position_allowance: false, include_qualification_allowance: false,
    include_tenure_allowance: false, include_treatment_improvement: false, include_specific_treatment: false,
    include_treatment_subsidy: false, include_fixed_overtime_pay: false, include_special_bonus: false } as unknown as OvertimeSetting;
  const m = new Map([["訪問介護", ot]]);
  expect(overtimeHourlyRate(base, m) === 1250, `★ 168,000 ÷ 168h × 1.25 = 1,250 (実測 ${overtimeHourlyRate(base, m)})`);
  const withSkill = { ...base, settings: { ...base.settings!, skill_salary: 16800 } } as MonthlyPayroll;
  expect(overtimeHourlyRate(withSkill, m) === 1250, "★ 職能給を含めない設定なら 職能給を足しても単価は動かない");
  expect(overtimeHourlyRate(withSkill, new Map([["訪問介護", { ...ot, include_skill_salary: true }]])) === 1375,
    "★ 含める設定にすると 単価が上がる (1,250 → 1,375)");
  expect(overtimeHourlyRate({ ...base, role_type: "事務員" } as MonthlyPayroll, m) === 1321,
    `★ 事務員は 所定 159h で計算する (実測 ${overtimeHourlyRate({ ...base, role_type: "事務員" } as MonthlyPayroll, m)})`);
  expect(overtimeHourlyRate({ ...base, settings: null } as unknown as MonthlyPayroll, m) === null,
    "★ 給与設定が無い人は null (0 円と区別する)");

  type Baseline = { _readme: string[]; mismatches: number; _why?: string[] };
  const baseline: Baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline
    : { _readme: [], mismatches: diffs.length };
  console.log("\n--- 基準値");
  if (UPDATE) {
    if (diffs.length > baseline.mismatches && !NOTE) {
      console.error("★ 不一致が増えているのに UPDATE_NOTE がありません。★ 悪化したまま基準値を更新しない");
      process.exit(2);
    }
    if (NOTE) (baseline._why ??= []).push(`${new Date().toISOString().slice(0, 10)} ${baseline.mismatches} → ${diffs.length}: ${NOTE}`);
    baseline.mismatches = diffs.length;
    writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n", "utf8");
    console.log(`  基準値を ${diffs.length} に更新しました`);
  } else {
    expect(diffs.length <= baseline.mismatches, `不一致 ${diffs.length} (基準値 ${baseline.mismatches})`);
  }
  console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS (★ 0 件 PASS ではない。基準値の件数を許容したうえでの PASS)");
  process.exit(fail ? 1 : 0);
}
await main();
