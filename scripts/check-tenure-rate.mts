/**
 * check:tenure-rate — 勤続手当を ★ 「単価 (年数・資格)」と「時間 (実績)」に分けて ① と突合する。
 *
 *   SOUKATSU1_DIR=<① の抽出物の dir> npm run check:tenure-rate
 *   SOUKATSU1_DIR=… npm run check:tenure-rate -- --update
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────────
 * 勤続手当 (パート・訪問介護) = ★ (訪問時間 − 同行) × 単価。★ 金額だけ見ると 原因が混ざる。
 *   ① は **単価そのもの**を列に持っている (「勤続手当_単価」)。★ これで 2 つに割れる:
 *     ★ 単価が違う … 年数の段 (勤続月数) か 資格 (has_care_qualification) の食い違い = ★ 入力の問題
 *     ★ 単価は同じで額が違う … 訪問時間の食い違い = ★ 実績の問題
 * 2026-09-30 に 6 件の残差を調べようとして、★ ① の列名を取り違えて「① は全員 0」と読み違えた。
 *   ★ 時給は「勤続手当（パート）」/ 月給は「勤続手当」。★ 単価は「勤続手当_単価」。
 *   ★ 二度と数え直さないように 検査にする (SESSION_START ③)。
 *
 * ── 2026-09-30 の実測で分かった 6 件の内訳 ────────────────────────────────
 *   ★ 単価が違う 1 件   西沢佳子 202604 (① 30円/h = 5年以上 / 当方 10円/h = 1〜4年)
 *   ★ 当方 0 円 4 件    米倉靖子 202603・緑川恵美 202605・鶴岡和恵 202608・木津優子 202608
 *                      → ★ 資格 false か 勤続 1 年未満で 0 になっている
 *   ★ 時間が違う 1 件   林幸子 202605 (① 3,205分 / 当方 3,220分。★ 15 分多い)
 *
 * ── ⚠ ① を正にしてはいけない (2026-09-30 に実証) ────────────────────────────
 * ★ おゆみ野 白石則子 (486) は 退職 → 再入社した人で、旧システムの group_tenure_months は
 *   178 か月のまま (退職前を通算している)。
 * ```
 *   ①  単価 50 円/h  額 7,900 円 (202603)   ← ★ xlsm が 178 か月で計算した値
 *   ②  単価 10 円/h  額 1,580 円            ← ★ 人が 手で 22 か月相当に下げている = 実際に払う額
 *   当方 単価 10 円/h                        ← ② と一致 (resolveGroupTenureMonths のリセット)
 * ```
 * ★ ① だけで測ると 6 人月・約 ¥34,000 の「欠陥」に見えるが、★ 直すと 過大払いに戻る。
 *   なので この検査は ★ ② を見出しにし、① は参考として併記する。
 *
 * ── 段の式の掃引 (2026-09-30 / 資格ありのパート訪問介護 732 人月) ────────────
 * ```
 *   A 現行  10+floor(年/5)*20  (段 1/5/10/15/20年)   ★ 720/732  ← 採用
 *   B       10+floor((年-1)/5)*20 (段 1/6/11/16/21年)   615/732
 *   C 月数  10+floor((m-12)/60)*20                      615/732
 *   D 月数  10+floor((m-1)/60)*20                       710/732
 * ```
 * ★ 現行の式が最良。★ 外れる 12 人月は 式ではなく 入力側 (白石 6 / 緑川 2 / 境界 ±1 か月 3 / ① の列の誤り 1)。
 *
 * ── この検査が見ていないもの ──────────────────────────────────────────────
 *   ・月給者の勤続手当 (節目の上げ幅。→ manualTenureWithSteps / check:soukatsu-item-gap)
 *   ・訪問入浴・居宅介護支援の勤続手当 (件数ベース)
 *   ・★ どちらが正しいか。① も ② も間違うことがある (payroll_layer1_total_is_not_authoritative)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { restAll, normEmpNo } from "./_rest.mjs";
import { computeTenureRate } from "../src/lib/payroll/payroll-calc.js";
import { soukatsuMinutes } from "../src/lib/payroll/soukatsu-time.js";

const UPDATE = process.argv.includes("--update");
const BASELINE = new URL("./check-tenure-rate-baseline.json", import.meta.url);
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };

const num = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?[\d,]+(\.\d+)?$/.test(v.trim())) return Number(v.replace(/,/g, ""));
  return 0;
};
/** ① の勤続手当の額。★ 時給は「勤続手当（パート）」(全角カッコ)・月給は「勤続手当」 */
const L1_AMOUNT_COLS = ["勤続手当（パート）", "勤続手当"] as const;
/** ★ 空欄は null を返す。★ 0 と 空欄を同じに扱うと 「相手が 0 円払った」という偽の不一致が出る (2026-09-30 に踏んだ) */
const l1Amount = (d: Record<string, unknown>): number | null => {
  for (const k of L1_AMOUNT_COLS) if (d[k] != null && String(d[k]).trim() !== "") return num(d[k]);
  return null;
};
/** ② の勤続手当の額。★ 「資格or勤続手当」に入っている行がある (木津優子 202608)。★「勤続手当2」は額ではない (1 が入る) */
const L2_AMOUNT_COLS = ["勤続手当", "資格or勤続手当"] as const;
const l2Amount = (d: Record<string, unknown>): number | null => {
  for (const k of L2_AMOUNT_COLS) if (d[k] != null && String(d[k]).trim() !== "") return num(d[k]);
  return null;
};
/** ② の単価。★ 列名は ① と違い アンダースコアが無い (「勤続手当単価」) */
const l2Rate = (d: Record<string, unknown>): number | null =>
  d["勤続手当単価"] == null || String(d["勤続手当単価"]).trim() === "" ? null : num(d["勤続手当単価"]);

type L1Row = { office_number: string; employee_number: string; sheet_kind: string; row_data: Record<string, unknown> };
type L2Row = L1Row & { processing_month: string };
type Emp = {
  employee_number: string; employee_name: string; job_type?: string | null;
  has_care_qualification?: boolean | null; effective_service_months?: number | null;
  summary?: { visitMinutesExcludingAccompanied?: number };
};
type Calc = { office_number: string; processing_month: string; payload: { hourly?: Emp[] } };

async function main() {
  console.log("=== check:tenure-rate (勤続手当を 単価 と 時間 に分けて ① と突合) 2026-09-30 新設・読み取り専用 ===");
  console.log("★ check:all には入れていない (意図的)。① の写しの dir が要る診断系");
  const dir = process.env.SOUKATSU1_DIR;
  if (!dir) { console.log("★ SOUKATSU1_DIR=<① の抽出物 soukatsu_extract_YYYYMM.json のある dir> が要る"); process.exit(1); }
  const files = readdirSync(dir).filter((f) => /^soukatsu_extract_\d{6}\.json$/.test(f)).sort();
  if (!files.length) { console.log(`★ ${dir} に soukatsu_extract_YYYYMM.json が 1 本もない (0 件と出さない)`); process.exit(1); }
  const months = files.map((f) => /_(\d{6})\.json$/.exec(f)![1]);

  const l1 = new Map<string, Record<string, unknown>>();
  for (const [i, f] of files.entries()) for (const r of JSON.parse(readFileSync(join(dir, f), "utf8")) as L1Row[]) {
    if (r.sheet_kind !== "part") continue;
    const k = `${r.office_number}|${normEmpNo(r.employee_number)}|${months[i]}`;
    if (!l1.has(k)) l1.set(k, r.row_data);
  }
  const l2 = new Map<string, Record<string, unknown>>();
  for (const r of await restAll<L2Row>("payroll_soukatsu_rows?select=id,office_number,employee_number,processing_month,sheet_kind,row_data")) {
    if (r.sheet_kind !== "part") continue;
    const k = `${r.office_number}|${normEmpNo(r.employee_number)}|${r.processing_month}`;
    if (!l2.has(k)) l2.set(k, r.row_data);
  }
  const calc = (await restAll<Calc>("payroll_calc_results?select=id,office_number,processing_month,payload")).filter((c) => months.includes(c.processing_month));

  const counts: Record<string, number> = {};
  let n = 0, rateOk = 0, amtOk = 0, noRate = 0, noAmt1 = 0;
  let n2 = 0, rate2Ok = 0, amt2Ok = 0, l1vs2 = 0, nAmt2 = 0, noAmt2 = 0;
  const badRate: string[] = [], badTime: string[] = [], oursZero: string[] = [], l1Zero: string[] = [], bad2: string[] = [], l12diff: string[] = [];
  for (const c of calc) for (const e of (c.payload?.hourly ?? [])) {
    const k = `${c.office_number}|${normEmpNo(e.employee_number)}|${c.processing_month}`;
    const d = l1.get(k); if (!d) continue;
    const job = String(e.job_type ?? "");
    if (job !== "訪問介護" && job !== "訪問看護") continue;   // ★ 件数ベース (訪問入浴・居宅) は 別式なので外す
    const r1raw = d["勤続手当_単価"];
    if (r1raw == null || String(r1raw).trim() === "") { noRate++; continue; }
    const r1 = num(r1raw);
    const rOurs = computeTenureRate(e.has_care_qualification ?? false, e.effective_service_months ?? 0, job);
    const a1raw = l1Amount(d);
    if (a1raw == null) noAmt1++;
    const a1 = a1raw ?? 0;
    // 当方の額は 保存済 payload から出す (★ 再導出しない。分母を本番と揃える)
    const minOurs = e.summary?.visitMinutesExcludingAccompanied ?? 0;
    const aOurs = rOurs === 0 ? 0 : Math.round((Math.floor((minOurs / 60) * 1e6) / 1e6) * rOurs);
    const min1 = soukatsuMinutes(d["訪介実績時間"], "minutes");
    n++;
    if (rOurs === r1) rateOk++;
    if (a1raw != null && aOurs === a1) amtOk++;
    const tag = `${k} ${e.employee_name}`;
    if (rOurs !== r1) {
      if (rOurs === 0) oursZero.push(`    ★ ${tag} ① ${r1}円/h ${a1}円 / 当方 0 円 (資格=${e.has_care_qualification} 勤続月数=${e.effective_service_months})`);
      else if (r1 === 0) l1Zero.push(`    ・${tag} ① 0円/h / 当方 ${rOurs}円/h ${aOurs}円 (勤続月数=${e.effective_service_months})`);
      else badRate.push(`    ★ ${tag} 単価 ① ${r1} / 当方 ${rOurs} (勤続月数=${e.effective_service_months} → ${Math.floor((e.effective_service_months ?? 0) / 12)}年)`);
    } else if (a1raw != null && aOurs !== a1) {
      badTime.push(`    ★ ${tag} 単価 ${r1} 一致 / 額 ① ${a1} vs 当方 ${aOurs} / 時間 ① ${min1 ?? "読めない"}分 vs 当方 ${minOurs}分 (差 ${min1 == null ? "?" : minOurs - min1}分)`);
    }
    // ── ★ 見出しは ② (実際に払う額)。① は参考 (白石則子のように ② が手で下げていることがある)
    const d2 = l2.get(k);
    if (d2) {
      const r2 = l2Rate(d2), a2 = l2Amount(d2);
      n2++;
      if (r2 != null && rOurs === r2) rate2Ok++;
      if (a2 == null) noAmt2++;
      else { nAmt2++; if (aOurs === a2) amt2Ok++; }
      if (r2 != null && r2 !== r1) { l1vs2++; l12diff.push(`    ・${tag} ★ ① ${r1}円/h ${a1raw ?? "(空)"}円 ≠ ② ${r2}円/h ${a2 ?? "(空)"}円 / 当方 ${rOurs}円/h ${aOurs}円 → ${rOurs === r2 ? "当方は ② と一致" : rOurs === r1 ? "当方は ① と一致" : "当方はどちらとも違う"}`); }
      else if (a2 != null && aOurs !== a2) bad2.push(`    ★ ${tag} ② ${r2 ?? "?"}円/h ${a2}円 / 当方 ${rOurs}円/h ${aOurs}円 (勤続${e.effective_service_months}か月 資格=${e.has_care_qualification})`);
    }
  }
  console.log(`\n分母 ${n} 人月 (訪問介護・訪問看護の時給者で ① に 勤続手当_単価 がある行。単価の列が空 ${noRate} 行は外した)`);
  console.log(`  ★ 額が ② と一致  ${amt2Ok}/${nAmt2}   単価が ② と一致 ${rate2Ok}/${n2}   ← ★ 見出し (② = 実際に払う額)`);
  console.log(`    額が ① と一致  ${amtOk}/${n - noAmt1}   単価が ① と一致 ${rateOk}/${n}   (参考)`);
  console.log(`    ★ 額の列が空: ① ${noAmt1} 行 / ② ${noAmt2} 行 → ★ 分母から外した (空 ≠ 0 円)`);
  console.log(`    ★ ① と ② の単価が食い違う ${l1vs2} 人月 = ★ ① に対する天井はここまで下がる`);
  console.log(`\n--- ★ ① と ② が食い違う ${l12diff.length} 人月 (★ ① を正にしてはいけない実例)`);
  for (const l of l12diff.slice(0, 12)) console.log(l);
  if (l12diff.length > 12) console.log(`      … ほか ${l12diff.length - 12} 人月`);
  console.log(`\n--- ★ ② と額が違う: ${bad2.length} 人月 (★ ① ② が一致している行だけ)`);
  for (const l of bad2.slice(0, 15)) console.log(l);
  if (bad2.length > 15) console.log(`      … ほか ${bad2.length - 15} 人月`);
  console.log(`\n--- ★ 当方が 0 円 (① は払っている): ${oursZero.length} 人月`);
  for (const l of oursZero.slice(0, 15)) console.log(l);
  if (oursZero.length > 15) console.log(`      … ほか ${oursZero.length - 15} 人月`);
  console.log(`\n--- ★ 単価の段が違う: ${badRate.length} 人月`);
  for (const l of badRate.slice(0, 15)) console.log(l);
  if (badRate.length > 15) console.log(`      … ほか ${badRate.length - 15} 人月`);
  console.log(`\n--- 単価は一致で 時間が違う: ${badTime.length} 人月`);
  for (const l of badTime.slice(0, 15)) console.log(l);
  if (badTime.length > 15) console.log(`      … ほか ${badTime.length - 15} 人月`);
  console.log(`\n--- ① が 0 円 で 当方が払っている: ${l1Zero.length} 人月`);
  for (const l of l1Zero.slice(0, 10)) console.log(l);
  if (l1Zero.length > 10) console.log(`      … ほか ${l1Zero.length - 10} 人月`);

  counts["★ ②と額が違う人月"] = nAmt2 - amt2Ok;
  counts["★ ②と単価が違う人月"] = n2 - rate2Ok;
  counts["①と②が食い違う人月"] = l1vs2;
  counts["単価が違う人月"] = n - rateOk;
  counts["額が違う人月"] = n - noAmt1 - amtOk;
  counts["当方が0円の人月"] = oursZero.length;
  counts["単価の段が違う人月"] = badRate.length;
  counts["時間だけ違う人月"] = badTime.length;
  counts["①が0円で当方が払う人月"] = l1Zero.length;

  console.log("\n--- 負のコントロール");
  expect(computeTenureRate(true, 12, "訪問介護") === 10, "資格あり・1年 → 10円/h");
  expect(computeTenureRate(true, 60, "訪問介護") === 30, "資格あり・5年 → 30円/h (★ 59か月なら 10円/h)");
  expect(computeTenureRate(true, 59, "訪問介護") === 10, "資格あり・59か月 → 10円/h (段の境界)");
  expect(computeTenureRate(false, 120, "訪問介護") === 0, "★ 資格が無ければ 何年でも 0 円");
  expect(computeTenureRate(true, 11, "訪問介護") === 0, "★ 1年未満は 0 円");
  expect(l1Amount({ "勤続手当（パート）": 1018 }) === 1018, "① の時給の額は 「勤続手当（パート）」(全角カッコ) から引く");
  expect(l1Amount({}) === null && l2Amount({}) === null, "★ 額の列が無い行は null (0 円と区別する)");
  expect(l1Amount({ "勤続手当（パート）": 0 }) === 0, "★ 0 が書いてある行は 0 (null ではない)");
  expect(l1Amount({ 勤続手当: 500 }) === 500, "① の月給の額は 「勤続手当」から引く");
  expect(l1Amount({ 勤続手当2: 1 }) === null, "★ 「勤続手当2」は 額ではない (1 が入る) ので 拾わない");
  expect(l2Amount({ 資格or勤続手当: 533 }) === 533, "② は 「資格or勤続手当」に入っている行がある (木津優子 202608)");
  expect(l2Rate({ 勤続手当単価: 10 }) === 10 && l2Rate({ 勤続手当_単価: 50 }) === null, "★ ② の単価の列は アンダースコア無し (「勤続手当単価」)。① の列名では引けない");
  expect(soukatsuMinutes("101:45", "minutes") === 6105, "① の時間は H:MM で読める (101:45 = 6,105分)");
  expect(soukatsuMinutes("1904-01-01T07:15:00.000Z", "minutes") === 435, "★ Excel の 1904 年基準の時刻も 分に読める (7:15 = 435分)");

  type Baseline = { _readme: string[]; counts: Record<string, number> };
  const baseline: Baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline : { _readme: [], counts: {} };
  if (UPDATE) {
    baseline.counts = counts;
    writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n", "utf8");
    console.log("\n基準値を更新しました");
  } else {
    console.log("\n--- 基準値");
    for (const [k, v] of Object.entries(counts)) {
      const b = baseline.counts[k];
      if (b == null) { console.log(`  ・${k} = ${v} (基準値なし)`); continue; }
      if (v > b) expect(false, `${k} が基準値から増えた (${v} > ${b})`);
      else console.log(`  o ${k} = ${v} (基準値 ${b})`);
    }
  }
  console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS (★ 0 件 PASS ではない。基準値の件数を許容したうえでの PASS)");
  process.exit(fail ? 1 : 0);
}
await main();
