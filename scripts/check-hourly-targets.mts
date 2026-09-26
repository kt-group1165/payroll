/**
 * check:hourly-targets — 時給者の計算対象の集合 (src/lib/payroll/hourly-targets.ts) を fixture で検査する。
 * ★ DB を読まない。再計算しなくても「手入力しか無い人が落ちない」ことを確かめられる。
 *
 *   npx tsx scripts/check-hourly-targets.mts
 *
 * 何を見るか
 *   1. 集合: 手入力の ★ 項目ごとに 1 ケース。その項目しか無い人が 入る (理由付きの除外項目なら 入らない)
 *      + 有給管理簿の当月日数だけの人 / A1 の 5 名 (杉尾は 一般化の後も 付け替えた場合も 入ること)
 *   2. 金額: 手入力を ライブラリの関数に通すと 総括表 ① の値になる (実データ 3 人月から写した固定値)
 *   3. 配線: page.tsx が この関数を呼び、手入力を項目を列挙せずに渡している。
 *      時給者の計算が読む手入力の項目が すべて payroll_monthly_inputs の読み込みに入っている
 * 負のコントロール: ★ 項目ごとに その項目を外すと その人が落ちる / 726d07b より前の集合で A1 の 5 名が落ちる /
 *   除外項目を 除外リストに無い名前にすると 入ってしまう / page.tsx の写しを壊すと 3. が鳴る
 * 見ていないもの
 *   - 集合に入った後の 月給者の除外 (switchByNum)・職員マスタに居ない番号の除外 (roleMap)・
 *     退職者の除外 (社員の読み込み) は page.tsx の中。
 *     ★ 2026-09-27 に実データで dry-run: 一般化で新しく候補になるのは 6 人月だけで、全員 退職者の月給者 (浅井裕作 absence_days)。
 *       absence_days は除外項目なので そもそも入らない。入ったとしても 社員の読み込みで落ちる
 *   - 処遇改善・通信手当 (fixture の 3 人月では どれも 0 円。① でも 0)
 *   - 出張単価の月ごとの履歴 (fixture には ① の出張費単価をそのまま書いてある)
 */
import { readFileSync } from "node:fs";
import { hourlyTargetEmployeeNumbers, HOURLY_TARGET_EXCLUDED_ITEMS, type HourlyTargetSources } from "../src/lib/payroll/hourly-targets.js";
import { trainingPayAmount, hourlyBusinessTripFeeAmount, TRAINING_RATE_PER_HOUR } from "../src/lib/payroll/payroll-calc.js";

let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };

type Case = {
  who: string; month: string; num: string;
  /** 手入力 項目 → 値 */
  manual?: Record<string, number>; ledgerDays?: number;
  /** 入るべきか (既定 true) */
  expectIn?: boolean;
  l1?: { amount: number; travelUnitPrice: number; note: string };
};
/** 時給者の計算 (page.tsx の時給者のループ) が読む手入力。★ 時給者の計算が新しい項目を読み始めたら ここにも足すこと */
const HOURLY_ITEMS = ["office_work_minutes", "training_minutes", "business_km", "commute_yen", "childcare_allowance", "adjustment", "shoninsha_training_minutes"];
const EXCLUDED = Object.keys(HOURLY_TARGET_EXCLUDED_ITEMS);
const CASES: Case[] = [
  // ── 実データ (2026-09-27 時点の payroll_monthly_inputs と 総括表 ①)。A1 = check:manual-input-dropped ──
  { who: "岩田ゆきよ (A1)", month: "202604", num: "260409", manual: { training_minutes: 120, business_km: 1.7 }, l1: { amount: 2321, travelUnitPrice: 12.3, note: "① 総支給 2,321 (出張費 21)" } },
  { who: "江波戸祐子 (A1)", month: "202607", num: "260704", manual: { training_minutes: 60 }, l1: { amount: 1150, travelUnitPrice: 12.6, note: "① 総支給 1,150" } },
  // ⚠ ① の 初任者研修費 64,975 と一致。① の総支給 45,875 は 25,875 の頭打ち (② は 64,975 を払う)
  { who: "杉尾加奈子 (A1・社保の旗つき)", month: "202606", num: "260603", manual: { training_minutes: 3390, social_insurance: 1 }, l1: { amount: 64975, travelUnitPrice: 12.6, note: "① 初任者研修費 64,975" } },
  { who: "杉尾加奈子 (初任者の項目に付け替えた場合)", month: "202606", num: "260603", manual: { shoninsha_training_minutes: 3390, social_insurance: 1 } },
  { who: "木村江利 (A1)", month: "202607", num: "260803", manual: { training_minutes: 1050 } },
  { who: "岩坪恵 (A1)", month: "202607", num: "260802", manual: { business_km: 58.7 } },
  { who: "有給管理簿のみ (作り例)", month: "202605", num: "999001", ledgerDays: 2 },
  // ── 項目ごとに 1 ケース (番号は作り例) ──
  ...HOURLY_ITEMS.map((k, i): Case => ({ who: `${k} のみ`, month: "202606", num: `9100${String(i).padStart(2, "0")}`, manual: { [k]: 100 } })),
  ...EXCLUDED.map((k, i): Case => ({ who: `${k} のみ (除外項目)`, month: "202606", num: `9200${String(i).padStart(2, "0")}`, manual: { [k]: 1 }, expectIn: false })),
];

function sourcesOf(c: Case, omitItem?: string, omitLedger = false): HourlyTargetSources {
  const ledger = new Map<string, Map<string, number>>();
  if (c.ledgerDays && !omitLedger) ledger.set(c.num, new Map([[c.month, c.ledgerDays]]));
  // 他の月にだけ有給がある番号 (入ってはいけない) を毎回混ぜる
  ledger.set("999999", new Map([["190001", 5]]));
  const manualByItem = new Map<string, string[]>();
  for (const [k, v] of Object.entries(c.manual ?? {})) if (v > 0 && k !== omitItem) manualByItem.set(k, [c.num]);
  return { records: [], attendance: [], officeForms: ["888888"], manualByItem, ledgerDaysByNum: ledger, month: c.month };
}
/** 726d07b より前の集合 (負のコントロール用) */
const beforeFix = (c: Case) => { const s = sourcesOf(c); return new Set([...s.records, ...s.attendance, ...s.officeForms, ...(s.manualByItem.get("office_work_minutes") ?? [])]); };

console.log("=== 1. 集合に入るか ===");
for (const c of CASES) {
  const set = hourlyTargetEmployeeNumbers(sourcesOf(c));
  const want = c.expectIn ?? true;
  const reason = want ? "" : ` (${HOURLY_TARGET_EXCLUDED_ITEMS[Object.keys(c.manual!)[0]]})`;
  expect(set.has(c.num) === want, `${c.month} ${c.who} が ${want ? "入る" : "入らない"}${reason}`);
  if (set.has("999999")) expect(false, "  他の月にだけ有給がある番号が入った");
}

console.log("\n=== 2. 金額 (ライブラリの関数 → 総括表 ①) ===");
for (const c of CASES.filter((x) => x.l1)) {
  const amt = trainingPayAmount(c.manual?.training_minutes ?? 0, TRAINING_RATE_PER_HOUR) + hourlyBusinessTripFeeAmount(c.manual?.business_km ?? 0, c.l1!.travelUnitPrice);
  expect(amt === c.l1!.amount, `${c.month} ${c.who}: ¥${amt} = ${c.l1!.note}`);
}

console.log("\n=== 3. page.tsx の配線 ===");
const page = readFileSync(new URL("../src/app/payroll/page.tsx", import.meta.url), "utf8");
const wired = (p: string) => /hourlyTargetEmployeeNumbers\(\{/.test(p) && /manualByItem: manualNumsByItem/.test(p) && !/new Set\(\[\.\.\.recsByEmp\.keys\(\)/.test(p);
/** 手入力の読み込み (manualNumsByItem を作る直後の .in("item_key", [...])) に 無い項目 */
const missingIn = (p: string) => {
  const list = /\.in\("item_key", \[([^\]]*)\]\)/.exec(p.slice(p.indexOf("const manualNumsByItem")))?.[1] ?? "";
  return HOURLY_ITEMS.filter((k) => !list.includes(`"${k}"`));
};
expect(wired(page), "page.tsx が hourlyTargetEmployeeNumbers に 手入力を項目ごと (manualNumsByItem) 渡している・インラインの集合が無い");
expect(missingIn(page).length === 0, `時給者の計算が読む手入力 ${HOURLY_ITEMS.length} 項目が 読み込みの item_key に全部ある${missingIn(page).length ? ` (無い: ${missingIn(page).join(",")})` : ""}`);

console.log("\n=== 負のコントロール ===");
const a1 = CASES.filter((c) => c.who.includes("(A1"));
const dropped = a1.filter((c) => !beforeFix(c).has(c.num)).length;
expect(dropped === a1.length, `726d07b より前の集合だと A1 の ${a1.length} 名が落ちる (実際 ${dropped})`);
for (const k of HOURLY_ITEMS) {
  const cs = CASES.filter((c) => c.manual?.[k] && !c.ledgerDays && Object.keys(c.manual).filter((x) => !(x in HOURLY_TARGET_EXCLUDED_ITEMS)).length === 1);
  const n = cs.filter((c) => !hourlyTargetEmployeeNumbers(sourcesOf(c, k)).has(c.num)).length;
  expect(cs.length > 0 && n === cs.length, `${k} を外すと その項目しか無い ${cs.length} 件が全部落ちる (実際 ${n})`);
}
{
  const cs = CASES.filter((c) => c.ledgerDays);
  const n = cs.filter((c) => !hourlyTargetEmployeeNumbers(sourcesOf(c, undefined, true)).has(c.num)).length;
  expect(cs.length > 0 && n === cs.length, `有給管理簿を外すと 管理簿しか無い ${cs.length} 件が落ちる (実際 ${n})`);
}
{
  const cs = CASES.filter((c) => c.expectIn === false);
  const n = cs.filter((c) => hourlyTargetEmployeeNumbers({ ...sourcesOf(c), manualByItem: new Map([[`x_${Object.keys(c.manual!)[0]}`, [c.num]]]) }).has(c.num)).length;
  expect(cs.length === EXCLUDED.length && n === cs.length, `除外項目 ${cs.length} 件を 除外リストに無い名前にすると 全部入る (= 除外リストで止めている) (実際 ${n})`);
}
const broken = trainingPayAmount(120, TRAINING_RATE_PER_HOUR * 0.75) + hourlyBusinessTripFeeAmount(1.7, 12.3);
expect(broken !== 2321, `研修の時給を 0.75 掛けにすると 岩田の金額が ① と合わなくなる (¥${broken})`);
const inline = page.replace(/hourlyTargetEmployeeNumbers\(\{/g, "new Set([...recsByEmp.keys(), ({");
expect(!wired(inline), "page.tsx の写しをインラインに戻すと 配線の検査が鳴る");
const dropItem = page.replace(/"shoninsha_training_minutes", /, "");
expect(dropItem !== page && missingIn(dropItem).includes("shoninsha_training_minutes"), "page.tsx の写しの読み込みから shoninsha_training_minutes を消すと 項目の検査が鳴る");

console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS");
process.exit(fail ? 1 : 0);
