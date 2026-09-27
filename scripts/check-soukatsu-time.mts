/**
 * check:soukatsu-time — 総括表の時間の欄の読み方 (src/lib/payroll/soukatsu-time.ts soukatsuMinutes) を検査する (2026-09-27 給与D)
 *
 *   npm run check:soukatsu-time                       # fixture だけ (DB も xlsm も読まない)
 *   L1_DIR=<① の抽出> L2_SNAPSHOT=<② の json> npm run check:soukatsu-time    # 実データで「読めないセル」も数える
 *   npm run check:soukatsu-time -- --update           ★ 実データの 読めないセル数 (基準値) を更新
 *
 * 1. fixture: 実データにあった 4 形式 ("H:MM" / "HHH:MM:SS" / Excel 日付 / 数値) と 読めない値。値は全部 ①② から写した
 * 2. 実データ (L1_DIR / L2_SNAPSHOT を渡したときだけ): 時間の欄ごとに 空でないのに読めない (null) セルの数。基準値方式
 * 負のコントロール: ① parseFloat で読むと "35:00" が 35 分になり fixture が落ちる (今日の読み違いの型)
 *   ② 読めない値を 0 にする実装だと 「読めない」の fixture が落ちる ③ 1904 年基準を忘れると 大網の 7:15 が落ちる
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { soukatsuMinutes, type SoukatsuNumberUnit } from "../src/lib/payroll/soukatsu-time.js";

const UPDATE = process.argv.includes("--update");
const BASELINE = new URL("./check-soukatsu-time-baseline.json", import.meta.url);
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };

type Reader = (v: unknown, unit: SoukatsuNumberUnit) => number | null;
type Case = { v: unknown; unit: SoukatsuNumberUnit; want: number | null; from: string };
const CASES: Case[] = [
  { v: "04:00", unit: "minutes", want: 240, from: "① 岩坪恵 202608 HRD研修時間" },
  { v: "35:00", unit: "minutes", want: 2100, from: "② 1270203191|260102|202603 内初任者研修時間 (★ 0 と読んで ①≠② と誤った)" },
  { v: "178:30:00", unit: "minutes", want: 10710, from: "① 白石則子 202603 出勤" },
  { v: "0:00", unit: "minutes", want: 0, from: "① 残業時間合計" },
  { v: "1904-01-01T07:15:00.000Z", unit: "minutes", want: 435, from: "① 大網 伊藤瑠奈 202606 HRD研修時間 (★ 0 と読んでいた)" },
  { v: "1904-01-01T05:00:00.000Z", unit: "minutes", want: 300, from: "① 大網 河野君江 202608 HRD研修時間" },
  { v: "1904-01-02T11:00:00.000Z", unit: "minutes", want: 2100, from: "Excel 1904 年基準で 24 時間を超える値 (35:00)" },
  { v: new Date("1899-12-30T06:15:00.000Z"), unit: "minutes", want: 375, from: "Excel 1900 年基準の Date (exceljs の生の値)" },
  { v: 240, unit: "minutes", want: 240, from: "② 岩坪恵 202608 内研修時間 (数値 = 分)" },
  { v: "114.1875", unit: "hours", want: 6851.25, from: "① 峯島しおり 202603 重度（×0.75） (数値 = 時間)" },
  { v: { result: "02:00" }, unit: "minutes", want: 120, from: "数式セル (exceljs の result)" },
  { v: "", unit: "minutes", want: 0, from: "空" },
  { v: null, unit: "minutes", want: 0, from: "null" },
  { v: "-9:-15", unit: "minutes", want: -555, from: "① 介護超過手当_120h以上_時 (120h に足りない分。時も分も負)" },
  { v: "-36:-55", unit: "minutes", want: -2215, from: "① 介護超過手当_120h以上_時" },
  { v: "00:-55", unit: "minutes", want: -55, from: "① 介護超過手当_120h以上_時 (時が 00 で 分だけ負)" },
  { v: "174..00", unit: "minutes", want: null, from: "② 出勤時間 の打ち間違い (★ 読めない = null)" },
  { v: "6:75", unit: "minutes", want: null, from: "分が 60 以上" },
  { v: "2026-06-18T00:00:00.000Z", unit: "minutes", want: null, from: "本物の日付 (時間ではない)" },
  { v: "abc", unit: "minutes", want: null, from: "文字" },
];
const failures = (f: Reader) => CASES.filter((c) => { const got = f(c.v, c.unit); return c.want === null ? got !== null : got === null || Math.abs(got - c.want) > 0.001; });

console.log("=== check:soukatsu-time (総括表の時間の欄の読み方) ===");
console.log("\n--- 1. fixture (実データの値)");
const bad = failures(soukatsuMinutes);
for (const c of CASES) expect(!bad.includes(c), `${JSON.stringify(c.v instanceof Date ? c.v.toISOString() : c.v)} (${c.unit}) → ${c.want === null ? "読めない (null)" : `${c.want} 分`}  ← ${c.from}`);

console.log("\n--- 負のコントロール (わざと壊した読み方で fixture が落ちること)");
{
  const naive: Reader = (v) => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return Number.isNaN(n) ? 0 : n; };
  const b = failures(naive);
  expect(b.some((c) => c.v === "35:00"), `① parseFloat で読むと "35:00" が 35 になり 落ちる (落ちた fixture ${b.length} 件)`);
}
{
  const zeroOnFail: Reader = (v, u) => soukatsuMinutes(v, u) ?? 0;
  const b = failures(zeroOnFail);
  expect(b.some((c) => c.v === "abc") && b.some((c) => c.v === "174..00"), `② 読めない値を 0 にすると「読めない」の fixture が落ちる (${b.length} 件)`);
}
{
  const no1904: Reader = (v, u) => (typeof v === "string" && v.startsWith("1904-") ? null : soukatsuMinutes(v, u));
  const b = failures(no1904);
  expect(b.some((c) => c.v === "1904-01-01T07:15:00.000Z"), `③ 1904 年基準を読まないと 大網の 7:15 が落ちる (${b.length} 件)`);
}

// ── 2. 実データ ──
const L1_DIR = process.env.L1_DIR ?? "", L2_SNAPSHOT = process.env.L2_SNAPSHOT ?? "";
/** 時間の欄と 数値のときの単位。★ 欄を足したら ここにも足す */
const L1_COLS: Record<string, SoukatsuNumberUnit> = { HRD研修時間: "minutes", 研修時間: "minutes", 初任者研修時間: "minutes", 会議時間: "minutes", 出勤: "minutes", 訪問時間: "minutes", 訪介実績時間: "minutes", 訪介同行時間: "minutes", 残業時間合計: "minutes", 法定休日残業: "minutes", 夜朝訪介: "minutes", 深夜訪介: "minutes", "重度（×0.75）": "hours", 介護超過手当_120h以上_時: "minutes" };
const L2_COLS: Record<string, SoukatsuNumberUnit> = { 内研修時間: "minutes", 内初任者研修時間: "minutes", 出勤時間: "minutes", 訪問時間: "minutes", 実績: "minutes", 同行: "minutes", 残業: "minutes", 内残業: "minutes", 法内残業: "minutes", 固定残業時間: "minutes", "120h以上対象時間": "minutes", 深夜時間: "minutes" };
if (L1_DIR && L2_SNAPSHOT && existsSync(L1_DIR) && existsSync(L2_SNAPSHOT)) {
  console.log("\n--- 2. 実データ: 空でないのに 読めないセル");
  const counts: Record<string, number> = {}; const examples: Record<string, string[]> = {};
  const scan = (tag: string, rows: Record<string, unknown>[], cols: Record<string, SoukatsuNumberUnit>) => {
    for (const [c, u] of Object.entries(cols)) {
      let filled = 0, unread = 0;
      for (const r of rows) {
        const v = r[c]; if (v === null || v === undefined || v === "") continue;
        filled++;
        if (soukatsuMinutes(v, u) === null) { unread++; (examples[`${tag}:${c}`] ??= []).push(JSON.stringify(v)); }
      }
      counts[`${tag}:${c}`] = unread;
      if (filled) console.log(`  ${tag} ${c}: 値のあるセル ${filled} / 読めない ${unread}${unread ? `  例 ${[...new Set(examples[`${tag}:${c}`])].slice(0, 3).join(" ")}` : ""}`);
    }
  };
  const l1: Record<string, unknown>[] = [];
  for (const f of readdirSync(L1_DIR).filter((x) => /_(\d{6})\.json$/.test(x))) for (const x of JSON.parse(readFileSync(`${L1_DIR}/${f}`, "utf8"))) l1.push(x.row_data);
  const l2 = (JSON.parse(readFileSync(L2_SNAPSHOT, "utf8")) as { row_data: Record<string, unknown> }[]).map((x) => x.row_data);
  scan("①", l1, L1_COLS); scan("②", l2, L2_COLS);
  type Baseline = { _readme: string[]; counts: Record<string, number> };
  const baseline: Baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline : { _readme: [], counts: {} };
  if (UPDATE) { baseline.counts = counts; writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n", "utf8"); console.log("  基準値を更新しました"); }
  else for (const [k, v] of Object.entries(counts)) if (v > (baseline.counts[k] ?? Number.POSITIVE_INFINITY)) expect(false, `${k} の読めないセルが増えた (${v} > ${baseline.counts[k]})`);
  expect(true, `読めないセルは基準値から増えていない (${Object.values(counts).reduce((s, v) => s + v, 0)} セル)`);
} else console.log("\n(実データは L1_DIR と L2_SNAPSHOT を渡したときだけ見る。fixture だけで合否を出した)");

console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS");
process.exit(fail ? 1 : 0);
