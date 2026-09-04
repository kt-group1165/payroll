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

type Check = { name: string; script: string; why: string; slow?: boolean };

/** ★ 落ちたら金額に効くものだけ */
const CHECKS: Check[] = [
  { name: "overtime-boundary", script: "check:overtime-boundary", why: "労基法37条の割増率 (純関数・境界値)" },
  { name: "payroll-calc-boundary", script: "check:payroll-calc-boundary", why: "訪問介護の給与計算 (月給・時給・残業・勤続・移動手当) の境界値" },
  { name: "payroll-sample", script: "check:payroll-sample", why: "DB→集計→残業代 の経路 (手計算の期待値と突合)" },
  { name: "billing-issue", script: "check:billing-issue", why: "請求の発行・調整行ロジック (実データ + fixture)" },
  { name: "kyotaku-python", script: "verify:kyotaku-python", why: "★ 居宅ケアマネ給与計算を 移植元Python実出力と突合 (xlsx読込で遅め)", slow: true },
];

/** ★ この一覧が見ていないもの。緑でも安心しないための明示 */
const NOT_COVERED = [
  "訪問介護の勤怠集計 (AttendanceSummaryの元になる出勤簿集計) — attendance-calc-parity.mts (order-app側) が3app横断で見る",
  "移動手当の距離・時間算出 (Google Distance Matrix API 経由) — 実行していない",
  "kyotaku-calc.ts (居宅給与) の DB からの取り出し (SWR hook) と画面表示 — 純関数の入出力だけを見ている",
  "kyotaku-calc.ts の 地域区分(regional rates) — 受け取るが給与計算では使わない",
  "kaigo-app / order-app の集計 — 別アプリ。各app側で回す",
  "payroll-sample-check は サンプル未投入 (分母0) だと PASS 扱いで exit 0 になる — 「検証していない」と「合格」の区別は出力本文でしか分からない",
];

const results: { name: string; ok: boolean; ms: number; skipped?: boolean; out?: string }[] = [];
for (const c of CHECKS) {
  if (FAST && c.slow) { results.push({ name: c.name, ok: true, ms: 0, skipped: true }); continue; }
  process.stdout.write(`\n${"=".repeat(70)}\n▶ ${c.name}  — ${c.why}\n${"=".repeat(70)}\n`);
  const t = Date.now();
  // stdio:"inherit" だと tail 等に通したとき子の出力だけ落ちる (kaigo-app check-all.mts と同じ教訓)。
  const r = spawnSync("npm", ["run", c.script], { shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  process.stdout.write(out);
  results.push({ name: c.name, ok: r.status === 0, ms: Date.now() - t, out });
}

console.log(`\n${"=".repeat(70)}\n結果\n${"=".repeat(70)}`);
for (const r of results) {
  const mark = r.skipped ? "－ skip" : r.ok ? "  PASS" : "★ FAIL";
  console.log(`${mark}  ${r.name.padEnd(24)} ${r.skipped ? "" : `${(r.ms / 1000).toFixed(1)}s`}`);
}
const failed = results.filter((r) => !r.ok);
console.log("");
console.log("⚠ この一覧が ★ 見ていないもの:");
for (const n of NOT_COVERED) console.log(`   ${n}`);
console.log("");
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
