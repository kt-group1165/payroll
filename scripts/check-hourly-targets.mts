/**
 * check:hourly-targets — 時給者の計算対象の集合 (src/lib/payroll/hourly-targets.ts) を fixture で検査する。
 * ★ DB を読まない。再計算しなくても「手入力しか無い人が落ちない」ことを確かめられる。
 *
 *   npx tsx scripts/check-hourly-targets.mts
 *
 * 何を見るか
 *   1. 集合: 手入力 (研修時間・出張km・事務時間) や 有給管理簿の当月日数 しか無い人が 集合に入る
 *   2. 金額: その人の手入力を ライブラリの関数に通すと 総括表 ① の値になる (実データ 3 人月から写した固定値)
 *   3. 配線: page.tsx が この関数を呼んでいる (★ 呼ばずに インラインで集合を作り直すと この検査が無意味になる)
 * 負のコントロール: 726d07b より前の集合 (実績・出勤簿・事業所書式・事務時間の手入力だけ) で作ると
 *   A1 の 5 名が落ちること / 手入力を 1 種類ずつ外すと その人が落ちること を確かめてから PASS を出す。
 * 見ていないもの
 *   - 集合に入った後の 月給者の除外 (switchByNum)・職員マスタに居ない番号の除外 (roleMap) は page.tsx の中
 *   - 処遇改善・通信手当・通勤費 (fixture の 3 人月では どれも 0 円。① でも 0)
 *   - 出張単価の月ごとの履歴 (fixture には ① の出張費単価をそのまま書いてある)
 */
import { readFileSync } from "node:fs";
import { hourlyTargetEmployeeNumbers, type HourlyTargetSources } from "../src/lib/payroll/hourly-targets.js";
import { trainingPayAmount, hourlyBusinessTripFeeAmount, TRAINING_RATE_PER_HOUR } from "../src/lib/payroll/payroll-calc.js";

let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };

type Case = {
  who: string; month: string; num: string;
  trainingMin?: number; tripKm?: number; officeWorkMin?: number; ledgerDays?: number;
  /** ① の金額 (研修費+出張費) と 出張単価。無いものは 集合だけ見る */
  l1?: { amount: number; travelUnitPrice: number; note: string };
};
// 実データ (2026-09-27 時点の payroll_monthly_inputs と 総括表 ①) から写した。A1 = check:manual-input-dropped
const CASES: Case[] = [
  { who: "岩田ゆきよ (A1)", month: "202604", num: "260409", trainingMin: 120, tripKm: 1.7, l1: { amount: 2321, travelUnitPrice: 12.3, note: "① 総支給 2,321 (出張費 21)" } },
  { who: "江波戸祐子 (A1)", month: "202607", num: "260704", trainingMin: 60, l1: { amount: 1150, travelUnitPrice: 12.6, note: "① 総支給 1,150" } },
  // ⚠ ① の 初任者研修費 64,975 と一致。ただし ① の総支給は 45,875 で 初任者研修費がそのまま総支給に入っていない (① 側の構造。未解明)
  { who: "杉尾加奈子 (A1)", month: "202606", num: "260603", trainingMin: 3390, l1: { amount: 64975, travelUnitPrice: 12.6, note: "① 初任者研修費 64,975" } },
  { who: "木村江利 (A1)", month: "202607", num: "260803", trainingMin: 1050 },
  { who: "岩坪恵 (A1)", month: "202607", num: "260802", tripKm: 58.7 },
  { who: "根本カオリ (事務時間のみ・番号は仮)", month: "202603", num: "900001", officeWorkMin: 4562 },
  { who: "有給管理簿のみ (作り例)", month: "202605", num: "999001", ledgerDays: 2 },
];

function sourcesOf(c: Case, omit: Partial<Record<keyof HourlyTargetSources, true>> = {}): HourlyTargetSources {
  const ledger = new Map<string, Map<string, number>>();
  if (c.ledgerDays && !omit.ledgerDaysByNum) ledger.set(c.num, new Map([[c.month, c.ledgerDays]]));
  // 他の月にだけ有給がある人 (入ってはいけない) と 何も無い番号 を毎回混ぜる
  ledger.set("999999", new Map([["190001", 5]]));
  const has = (k: keyof HourlyTargetSources, v: number | undefined) => (v && v > 0 && !omit[k] ? [c.num] : []);
  return {
    records: [], attendance: [], officeForms: ["888888"],
    manualOfficeWork: has("manualOfficeWork", c.officeWorkMin),
    manualTraining: has("manualTraining", c.trainingMin),
    manualTripKm: has("manualTripKm", c.tripKm),
    ledgerDaysByNum: ledger, month: c.month,
  };
}
/** 726d07b より前の集合 (負のコントロール用) */
const beforeFix = (s: HourlyTargetSources) => new Set([...s.records, ...s.attendance, ...s.officeForms, ...s.manualOfficeWork]);

console.log("=== 1. 集合に入るか ===");
for (const c of CASES) {
  const set = hourlyTargetEmployeeNumbers(sourcesOf(c));
  expect(set.has(c.num), `${c.month} ${c.who} が入る`);
  expect(!set.has("999999"), `  他の月にだけ有給がある番号は入らない`);
}

console.log("\n=== 2. 金額 (ライブラリの関数 → 総括表 ①) ===");
for (const c of CASES.filter((x) => x.l1)) {
  const amt = trainingPayAmount(c.trainingMin ?? 0, TRAINING_RATE_PER_HOUR) + hourlyBusinessTripFeeAmount(c.tripKm ?? 0, c.l1!.travelUnitPrice);
  expect(amt === c.l1!.amount, `${c.month} ${c.who}: ¥${amt} = ${c.l1!.note}`);
}

console.log("\n=== 3. page.tsx が この関数を使っている ===");
const page = readFileSync(new URL("../src/app/payroll/page.tsx", import.meta.url), "utf8");
expect(/hourlyTargetEmployeeNumbers\(\{/.test(page), "page.tsx が hourlyTargetEmployeeNumbers を呼んでいる");
expect(!/new Set\(\[\.\.\.recsByEmp\.keys\(\)/.test(page), "page.tsx に インラインの集合 (new Set([...recsByEmp.keys() …) が残っていない");

console.log("\n=== 負のコントロール ===");
const a1 = CASES.filter((c) => c.who.includes("A1"));
const dropped = a1.filter((c) => !beforeFix(sourcesOf(c)).has(c.num)).length;
expect(dropped === a1.length, `726d07b より前の集合だと A1 の ${a1.length} 名が落ちる (実際 ${dropped})`);
const omitChecks: [keyof HourlyTargetSources, (c: Case) => boolean][] = [
  ["manualTraining", (c) => !!c.trainingMin && !c.tripKm], ["manualTripKm", (c) => !!c.tripKm && !c.trainingMin],
  ["manualOfficeWork", (c) => !!c.officeWorkMin], ["ledgerDaysByNum", (c) => !!c.ledgerDays],
];
for (const [k, pick] of omitChecks) {
  const cs = CASES.filter(pick);
  const n = cs.filter((c) => !hourlyTargetEmployeeNumbers(sourcesOf(c, { [k]: true })).has(c.num)).length;
  expect(cs.length > 0 && n === cs.length, `${k} を外すと その項目しか無い ${cs.length} 名が落ちる (実際 ${n})`);
}
const broken = trainingPayAmount(120, TRAINING_RATE_PER_HOUR * 0.75) + hourlyBusinessTripFeeAmount(1.7, 12.3);
expect(broken !== 2321, `研修の時給を 0.75 掛けにすると 岩田の金額が ① と合わなくなる (¥${broken})`);
const inline = page.replace(/hourlyTargetEmployeeNumbers\(\{/g, "new Set([...recsByEmp.keys(), ({");
expect(!/hourlyTargetEmployeeNumbers\(\{/.test(inline) && /new Set\(\[\.\.\.recsByEmp\.keys\(\)/.test(inline), "page.tsx の写しをインラインに戻すと 3. の 2 項目が鳴る");

console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS");
process.exit(fail ? 1 : 0);
