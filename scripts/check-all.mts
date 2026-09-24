/**
 * ★ 金額に効く検査をまとめて回す (push 前のゲート)
 *
 *   npm run check:all              全部
 *   npm run check:all -- --fast    ★ 遅いもの (Python突合) を飛ばす
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   kaigo-app の scripts/check-all.mts と同じ形。payroll-app 側にはまだ
 *   「何を回せばいいか」の入口が無かった。
 *
 * ⚠ ★ 「全部緑」は「正しい」ではありません。何を ★ 見ていないかは下の一覧に書きます。
 * ⚠ ここに無い check も価値はあります。★ 落ちても金額が動かないものは外しています。
 */
import { spawnSync } from "node:child_process";

const FAST = process.argv.includes("--fast");

/**
 * kind
 *   "strict"   ★ 0 を目指す。壊れたら (=差が出たら) 落ちる
 *   "baseline" ★ 既知の差を基準値として許容したうえでの PASS。0件PASSではない
 * knownDiff — baseline のとき、現在許容している既知差の件数 (2026-09-05 時点)。
 */
type Check = { name: string; script: string; why: string; slow?: boolean; kind?: "strict" | "baseline"; knownDiff?: number };

/** ★ 落ちたら金額に効くものだけ */
const CHECKS: Check[] = [
  { name: "overtime-boundary", script: "check:overtime-boundary", why: "労基法37条の割増率 + calcMonthlySummary の月次集計 (純関数・境界値)" },
  { name: "payroll-calc-boundary", script: "check:payroll-calc-boundary", why: "訪問介護の給与計算 (月給・時給・残業・勤続・移動手当) の境界値" },
  { name: "payroll-sample", script: "check:payroll-sample", why: "DB→集計→残業代 の経路 (手計算の期待値と突合)" },
  { name: "billing-issue", script: "check:billing-issue", why: "請求の発行・調整行ロジック (実データ + fixture)" },
  { name: "distance-calc", script: "check:distance-calc", why: "移動手当の距離・時間算出 calcDayRoute (API/DB非依存の純関数境界値)" },
  { name: "legal-holiday", script: "check:legal-holiday", why: "法定休日労働の割増 (日曜起算で7日連続勤務した週の土曜 × 0.35)。総括表①と 7/7 一致した規則を固定する" },
  { name: "tenure-rehire", script: "check:tenure-rehire", why: "退職→再入社で グループ勤続がリセットされるか。通算のままだと 勤続手当が過大になる (白石則子 6か月 ¥34,250)" },
  { name: "rate-gap", script: "check:rate-gap", why: "単価が引けず 0 円で計算される訪問 (= 過少支給)。★基準値方式。自費のマスタ設計が決まるまで 0 にはできない" },
  { name: "distance-kind", script: "check:distance-kind", why: "距離の種別 (通勤/出張)。ヘルパーの距離は出張・事務員は通勤。取り違えると 通勤費と出張費が二重に出る" },
  // 2026-09-24: 職員マスタ未登録 3 組 (2026-08 入社) を登録して 基準値が 0 になったので strict に戻した。
  // 基準値ファイル (check-office-input-flow-baseline.json) 自体は残っているが 期待値は 0 = 増えたら落ちる。
  { name: "office-input-flow", script: "check:office-input-flow", why: "★ 事業所書式 Web 入力 (/office-input) が 給与計算に届く経路。射影・合流・実データ合流 (職員マスタ未登録 0 組が期待値)" },
  { name: "kyotaku-python", script: "verify:kyotaku-python", why: "★ 居宅ケアマネ給与計算を 移植元Python実出力と突合 (基準値方式。B-2y参照)",
    kind: "baseline", knownDiff: 9 }, // 実績0件月の基本給の扱い (既知・B-2y。user判断待ち)
];

/**
 * ★ 「サンプル未投入で分母0のためPASS(exit 0)」を、出力本文の文言から機械的に検出する。
 * payroll-sample-check.mts は分母0のとき exit 0 のまま「合格とは言わない」と明示するが、
 * この一覧の PASS/FAIL 表示だけでは判別できなかった (2026-09-05 claude-06 指摘)。
 * kaigo-app 側の verify-jogen-kanri.mts / *-sample-verify.mts と同じ言い回しの規約に依存する。
 */
const NO_SAMPLE_MARKERS = ["サンプル未投入", "合格とは言わない", "合格でも不合格でもありません"];
function looksLikeNoSampleSkip(out: string): boolean {
  return NO_SAMPLE_MARKERS.some((m) => out.includes(m));
}

/** ★ この一覧が見ていないもの。緑でも安心しないための明示 */
const NOT_COVERED = [
  "事業所書式の 2 経路 (CSV 取込 payroll_office_form_records / Web 入力 payroll_office_input_entries) のうち、" +
    "office-input-flow が見るのは 射影 (Web → OfficeFormRecord) と 合流の優先だけ。" +
    "CSV パーサ (office-form-parser) と /office-input の画面そのものは見ていない。" +
    "また Web 入力が実データで 0 行のうちは『Web の値が給与に出る』は fixture でしか示せていない — " +
    "実データでの提示は migrations/office_input_flow_demo.mts (dry-run 付き) を手で回す",
  "AttendanceSummaryの元になる出勤簿集計の日次・週次ロジック (calcDaily/calcDailyListWithWeekly) と" +
    "calcMonthlySummaryの集計ロジック (monthFilter/total_paid_leave_days) は overtime-boundaryで境界値検証済み(2026-09-05)。" +
    "3app(kaigo/payroll/order)間で実装が食い違わないかは attendance-calc-parity.mts (order-app側) が実データで見る",
  "calcDayRoute自体 (通勤/移動の区別・2時間ギャップ除外・15分控除) は distance-calcで境界値検証済み(2026-09-05)。" +
    "ただしdistMapの中身 (Google Distance Matrix API / payroll_distance_cacheの値そのもの) と" +
    "呼出元がdistMapをどう組み立てるかは未検証",
  "kyotaku-calc.ts (居宅給与) の DB からの取り出し (SWR hook) と画面表示 — 純関数の入出力だけを見ている",
  "kyotaku-calc.ts の 地域区分(regional rates) — 受け取るが給与計算では使わない",
  "kaigo-app / order-app の集計 — 別アプリ。各app側で回す",
  "payroll-sample-check / overtime-boundary は サンプル未投入 (分母0) だと exit 0 になる — " +
    "結果表では「？ 未検証」として区別している (2026-09-05 対応済)。ただし出力本文の特定マーカー文言に" +
    "依存した検出のため、別スクリプトが同じ文言を無関係な文脈で出すと誤検出しうる " +
    "(2026-09-05 に verify-overtime-boundary.mts の disclaimer 文で実際に誤検出したのを是正済み)",
];

const results: { name: string; ok: boolean; ms: number; skipped?: boolean; out?: string; kind: "strict" | "baseline"; knownDiff?: number; noSample?: boolean }[] = [];
for (const c of CHECKS) {
  const kind = c.kind ?? "strict";
  if (FAST && c.slow) { results.push({ name: c.name, ok: true, ms: 0, skipped: true, kind, knownDiff: c.knownDiff }); continue; }
  process.stdout.write(`\n${"=".repeat(70)}\n▶ ${c.name}  — ${c.why}\n${"=".repeat(70)}\n`);
  const t = Date.now();
  // stdio:"inherit" だと tail 等に通したとき子の出力だけ落ちる (kaigo-app check-all.mts と同じ教訓)。
  const r = spawnSync("npm", ["run", c.script], { shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  process.stdout.write(out);
  results.push({ name: c.name, ok: r.status === 0, ms: Date.now() - t, out, kind, knownDiff: c.knownDiff, noSample: looksLikeNoSampleSkip(out) });
}

console.log(`\n${"=".repeat(70)}\n結果\n${"=".repeat(70)}`);
for (const r of results) {
  const mark = r.skipped ? "－ skip" : r.noSample ? "？ 未検証" : r.ok ? "  PASS" : "★ FAIL";
  const kindTag = r.kind === "baseline" ? " [基準値]" : "";
  const noSampleTag = r.noSample ? " (サンプル未投入。合格ではない)" : "";
  console.log(`${mark}  ${r.name.padEnd(24)} ${r.skipped ? "" : `${(r.ms / 1000).toFixed(1)}s`}${kindTag}${noSampleTag}`);
}
const failed = results.filter((r) => !r.ok);
console.log("");
console.log("⚠ この一覧が ★ 見ていないもの:");
for (const n of NOT_COVERED) console.log(`   ${n}`);
console.log("");

const baselineChecks = results.filter((r) => r.kind === "baseline" && !r.skipped);
if (baselineChecks.length) {
  console.log("★ 基準値方式の検査 (既知の差を許容したうえでのPASS。0件PASSではない):");
  for (const r of baselineChecks) {
    console.log(`   ${r.name.padEnd(24)} ${r.knownDiff != null ? `既知 ${r.knownDiff} 件` : "(件数は出力本文を参照)"}`);
  }
  const summable = baselineChecks.filter((r) => r.knownDiff != null);
  const total = summable.reduce((s, r) => s + (r.knownDiff ?? 0), 0);
  console.log(`   → 合計 (同一単位=既知差件数で数えられるもののみ): ${total} 件 (${summable.map((r) => r.name).join(" + ")})`);
  console.log("");
}
const noSampleChecks = results.filter((r) => r.noSample);
if (noSampleChecks.length) {
  console.log(`？ サンプル未投入で「合格」でも「不合格」でもない検査: ${noSampleChecks.map((r) => r.name).join("、")}`);
  console.log("");
}
if (failed.length) {
  const bar = "=".repeat(70);
  for (const f of failed) {
    console.log(`\n${bar}\n★ FAIL の再掲 — ${f.name}\n${bar}`);
    console.log((f.out ?? "").split("\n").slice(-40).join("\n"));
  }
  console.log(`\n★ FAIL ${failed.length} 件: ${failed.map((f) => f.name).join(" / ")}`);
  process.exit(1);
}
console.log(`PASS — ${results.filter((r) => !r.skipped).length} 本${FAST ? " (★ --fast: Python突合を飛ばしています)" : ""}`);
