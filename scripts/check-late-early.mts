/**
 * check:late-early — 遅刻早退控除 (lateEarlyDeduction) の検査 (2026-09-27 給与C)。
 *
 *   npm run check:late-early
 *   SNAPSHOT=<path.json> npm run check:late-early   # ② を DB から読まず 保存済みの取得結果を使う (check:soukatsu-cause と同じ形式)
 *
 * ── 何を見るか ─────────────────────────────────────────────────────────────
 *   ① 境界値 (fixture・DB 不要): 0 分 / 事務員 159h / それ以外 168h / 切り捨て
 *   ② 実データ 4 件 (総括表 ② の 遅刻早退金額) と 1 円一致: 小原 / 牛来 / 池谷 / 黒田
 *      ★ 熊谷明日香 202607 は 既知の不一致として別掲 (② が 単価 1,194 でなく 1,283 = 残業の時間単価で掛けている。
 *        1 件では規則か誤りか決まらないので 合わせに行かない)
 *   ③ 欠勤控除と 同じ母数 (deductionBase) を使っているか
 *   ④ 入れ漏れ: ② に遅刻早退金額があるのに 手入力 (payroll_monthly_inputs late_early_minutes) が無い人月の件数 (DB を読む)
 *      ★ これは 0 を目指す検査ではない。実装直後は 5 件 (5 人月とも手入力が無い)。合否には使わない
 *
 * ── 負のコントロール (わざと壊して 鳴ることを確かめる) ───────────────────────
 *   事務員に 168h を使う / 単価を round にする / 母数に 処遇改善補助金を入れる → それぞれ 実データ 4 件のどれかが外れること
 *
 * ── この検査が見ていないもの ───────────────────────────────────────────────
 *   ・分の入力そのものの正しさ (出勤簿から出せないので 手入力を信じる)
 *   ・端数の丸め (実データ 5 件は 30 分単位で端数が出ず 決まらない。欠勤控除に揃えて切り捨て)
 *   ・八千代の「遅刻早退単価は補助金込み」(② の単価列 36/36)。お金として効いた例が 0 件なので採っていない
 *   ・時給者 (② のパートシートに遅刻早退の列が無い)
 */
import { readFileSync, existsSync } from "node:fs";
import { lateEarlyDeduction, absenceDeduction, deductionBase, type MonthlyPayroll } from "../src/lib/payroll/payroll-calc.js";
import { restAll, empKey } from "./_rest.mjs";

let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "OK  " : "★ NG"} ${msg}`); if (!ok) fail++; };

/** 最小の MonthlyPayroll。遅刻早退・欠勤控除が読む項目だけ入れる */
const mk = (base: number, skill: number, jimu: boolean, minutes: number, extra: Partial<MonthlyPayroll> = {}): MonthlyPayroll => ({
  settings: { base_personal_salary: base, skill_salary: skill, treatment_subsidy: 20000 },
  summary: { workDays: 20, visitMinutes: 0 },
  is_office_worker_for_deduction: jimu,
  late_early_minutes: minutes,
  ...extra,
} as unknown as MonthlyPayroll);

type Impl = (p: MonthlyPayroll) => number;
/** 実データ 4 件 (② 遅刻早退金額)。本人給 / 職能給 / 事務員か / 分 / ② の金額 */
const REAL: { who: string; base: number; skill: number; jimu: boolean; min: number; yen: number }[] = [
  { who: "202607 1271500942 438 小原奈保子", base: 100000, skill: 110000, jimu: true, min: 30, yen: 660 },
  { who: "202605 1270501180 231204 牛来葉子", base: 100000, skill: 130000, jimu: true, min: 240, yen: 5784 },
  { who: "202604 1270303173 250202 池谷百子", base: 100000, skill: 110000, jimu: true, min: 120, yen: 2640 },
  { who: "202608 1279000366 260302 黒田美和", base: 100000, skill: 90000, jimu: true, min: 180, yen: 3582 },
];
const KNOWN_MISMATCH = { who: "202607 1272404508 260402 熊谷明日香", base: 100000, skill: 90000, jimu: true, min: 120, yen: 2566 };
const realOk = (f: Impl) => REAL.every((r) => f(mk(r.base, r.skill, r.jimu, r.min)) === r.yen);

console.log("=== check:late-early (遅刻早退控除) ===");
console.log("★ check:all に入れるかは指示役と相談 (落ちたら金額に効く検査)");
console.log("\n① 境界値");
expect(lateEarlyDeduction(mk(100000, 110000, true, 0)) === 0, "0 分 → 0");
expect(lateEarlyDeduction(mk(100000, 110000, true, 30)) === 660, "事務員 210,000 ÷ 159h = 1,320.75 → 単価 1,320 (切り捨て)。30 分 → 660");
expect(lateEarlyDeduction(mk(100000, 90000, false, 60)) === 1130, "それ以外 190,000 ÷ 168h = 1,130.95 → 1,130。60 分 → 1,130");
expect(lateEarlyDeduction(mk(100000, 110000, true, 1)) === 22, "1 分 → 1,320 ÷ 60 = 22 (端数は切り捨て。欠勤控除に揃えた)");
expect(lateEarlyDeduction({ ...mk(100000, 110000, true, 30), settings: null } as unknown as MonthlyPayroll) === 0, "給与設定が無い → 0");

console.log("\n② 実データ (総括表 ② の 遅刻早退金額) と 1 円一致");
for (const r of REAL) { const v = lateEarlyDeduction(mk(r.base, r.skill, r.jimu, r.min)); expect(v === r.yen, `${r.who} ${r.min}分 → ${v} (② ${r.yen})`); }
{
  const k = KNOWN_MISMATCH, v = lateEarlyDeduction(mk(k.base, k.skill, k.jimu, k.min));
  console.log(`  (既知の不一致・合否に使わない) ${k.who} ${k.min}分 → 当方 ${v} / ② ${k.yen}。② は 単価 1,283 (残業の時間単価) で掛けている。1 件では規則か誤りか決まらない`);
}

console.log("\n③ 欠勤控除と同じ母数");
{
  const p = mk(100000, 110000, true, 30, { absence_days: 1 });
  const { base, hours } = deductionBase(p);
  expect(base === 210000 && hours === 159, "deductionBase = 本人給 + 職能給 (補助金なし) / 事務員 159h");
  expect(absenceDeduction(p) === Math.floor((base / hours) * 8 + 1e-6), "absenceDeduction も同じ母数 (1 日 = 10,566)");
  const q = mk(100000, 110000, false, 30);
  expect(deductionBase(q).hours === 168, "事務員でなければ 168h");
}

console.log("\n負のコントロール (わざと壊した実装が 実データ 4 件で落ちるか)");
const u = (p: MonthlyPayroll) => ({ s: (p.settings as unknown as Record<string, number>), m: p.late_early_minutes ?? 0 });
const wrong168: Impl = (p) => { const { s, m } = u(p); return Math.floor((m / 60) * Math.floor((s.base_personal_salary + s.skill_salary) / 168) + 1e-6); };
const wrongRound: Impl = (p) => { const { s, m } = u(p); const h = p.is_office_worker_for_deduction ? 159 : 168; return Math.floor((m / 60) * Math.round((s.base_personal_salary + s.skill_salary) / h) + 1e-6); };
const wrongSubsidy: Impl = (p) => { const { s, m } = u(p); const h = p.is_office_worker_for_deduction ? 159 : 168; return Math.floor((m / 60) * Math.floor((s.base_personal_salary + s.skill_salary + s.treatment_subsidy) / h) + 1e-6); };
expect(realOk(lateEarlyDeduction), "正しい実装は 4 件とも一致 (前提)");
expect(!realOk(wrong168), "事務員に 168h を使うと外れる (牛来 5,784 → 5,476)");
expect(!realOk(wrongRound), "単価を round にすると外れる (牛来 単価 1,446 → 1,447・5,784 → 5,788)");
expect(!realOk(wrongSubsidy), "母数に 処遇改善補助金を入れると外れる");

console.log("\n④ 入れ漏れ (② に遅刻早退金額があるのに 手入力が無い人月)。★ 合否に使わない");
try {
  type R2 = { office_number: string; employee_number: string; employee_name: string; processing_month: string; sheet_kind: string; row_data: Record<string, unknown> };
  const path = process.env.SNAPSHOT;
  const rows: R2[] = path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).soukatsu
    : await restAll<R2>("payroll_soukatsu_rows?select=id,office_number,employee_number,employee_name,processing_month,sheet_kind,row_data&sheet_kind=eq.shaseki");
  const inputs = await restAll<{ office_number: string; employee_number: string; processing_month: string; numeric_value: number }>(
    "payroll_monthly_inputs?select=id,office_number,employee_number,processing_month,numeric_value&item_key=eq.late_early_minutes");
  const has = new Set(inputs.filter((i) => Number(i.numeric_value) > 0).map((i) => `${empKey(i.office_number, i.employee_number)}|${i.processing_month}`));
  const num = (v: unknown) => (typeof v === "number" ? v : Number(String(v ?? "").replace(/,/g, "")) || 0);
  const need = rows.filter((r) => r.sheet_kind === "shaseki" && num(r.row_data["遅刻早退金額"]) !== 0);
  const missing = need.filter((r) => !has.has(`${empKey(r.office_number, r.employee_number)}|${r.processing_month}`));
  console.log(`  ② に遅刻早退金額がある人月 ${need.length} / うち手入力が無い ${missing.length}`);
  for (const r of missing) console.log(`    ${r.processing_month} ${r.office_number} ${r.employee_number} ${r.employee_name.replace(/\s+/g, " ")} 遅刻早退 ${num(r.row_data["遅刻早退"])}分 (② ${num(r.row_data["遅刻早退金額"])}円)`);
} catch (e) {
  console.log(`  (DB を読めなかったので 数えていない: ${String(e).slice(0, 120)})`);
}

console.log("");
if (fail) { console.log(`★ FAIL ${fail} 件`); process.exit(1); }
console.log("PASS");
