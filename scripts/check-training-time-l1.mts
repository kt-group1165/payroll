/**
 * check:training-time-l1 — パートの研修時間を ① ② と 当方の元データ (事業所書式・手入力) で突き合わせ、ずれを型に分ける (2026-09-27 給与D)
 *
 *   L1_DIR=<① の抽出> npm run check:training-time-l1
 *   L1_DIR=… L2_SNAPSHOT=<② の json> SNAPSHOT=<書式・手入力の json> npm run check:training-time-l1
 *   npm run check:training-time-l1 -- --update          ★ 基準値方式の数だけ更新
 *
 * ★ payroll_calc_results (計算結果) は読まない。元データと ① ② だけで見る (再計算の途中でも回せる)。
 * ★ 時間は全部 soukatsuMinutes (src/lib/payroll/soukatsu-time.ts) で読む。★ 読めないセルは型「読めない」に出す (0 にしない)。
 *
 * 比べるもの (人月ごと):
 *   ① 研修の時間 = HRD研修時間 + 研修時間 + 初任者研修時間
 *   ② 研修の時間 = 内研修時間 + 内初任者研修時間。★ ② の内研修時間は 事業所によって 会議時間を含むので ① の会議時間を足した値とも比べる
 *   当方 = 事業所書式の 研修・HRD研修・初任者研修 (終了 − 開始 − 休憩) × 日付の数 + 手入力 training_minutes・shoninsha_training_minutes
 * 型:
 *   一致        当方 = ①
 *   丸め        ①=② で、① が 当方の研修を 1 回 (または 1 日) ごとに 時間単位に 切り上げ/切り捨て した値と一致 (★ ① 側の手修正。直さない)
 *                 2026-09-27: 1273400844 202603 の 4 名 (45 分・30 分の HRD を 1 時間) / 1270203191|260102|202603 (初任者の日ごとの端数切り捨て)
 *                 ★ 規則ではない: 同じ事業所の他の月・他の事業所では 生の分数で一致している
 *   行なし      ①=② で ① に研修があり、当方に研修の行も手入力も 1 つも無い (岩坪恵・童子悦 の型。2026-09-27 に 2 件埋めた)
 *   時間不足    ①=② で 当方に行はあるが ① より少ない。★ 書式 CSV にも無い (大網の 2 件で CSV = DB を確認済み) = 事業所の入力漏れ。
 *                ★ ①② の時間だけで行を作らない (日付が分からず 特日・土日祝の判定に効く)
 *   当方が多い  ①=② で 当方のほうが多い
 *   ①≠②        ① と ② が合わない (会議時間を足しても)。★ 2 つの材料が揃わないので 判断待ち
 *   読めない    ① か ② の時間の欄が読めない
 * 基準値方式: 型ごとの件数を固定し 増えたら落ちる (一致 は数えない)。
 * 負のコントロール: 写しで ① 一致の人月の書式を 1 行消すと 一致から外れる ② 丸めの人月を 生の分で ① に入れ直すと 丸め が減る
 *   ③ ② の時間の読み方を parseFloat にすると ①≠② が増える (今日の "35:00" の読み違いの型)
 * 見ていないもの: 月給 (月給は研修を別に払わない) / 金額 (時間だけ。金額は check:training-money) / 会議の件数
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { restAll } from "./_rest.mjs";
import { soukatsuMinutes } from "../src/lib/payroll/soukatsu-time.js";

const UPDATE = process.argv.includes("--update");
const BASELINE = new URL("./check-training-time-l1-baseline.json", import.meta.url);
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");

type Form = { office_number: string; employee_number: string; processing_month: string; item_name: string; item_date: string | null; start_time: string | null; end_time: string | null; break_time: string | null };
type MI = { office_number: string; employee_number: string; processing_month: string; item_key: string; numeric_value: number | null };
type L2 = { office_number: string; employee_number: string; processing_month: string; sheet_kind: string; row_data: Record<string, unknown> };
type Snap = { form: Form[]; mi: MI[] };

const L1_DIR = process.env.L1_DIR ?? "";
if (!L1_DIR || !existsSync(L1_DIR)) { console.log("★ L1_DIR (① の抽出フォルダ) を渡してください (migrations/extract_soukatsu_from_xlsm.mjs の出力)"); process.exit(1); }
const L2_SNAPSHOT = process.env.L2_SNAPSHOT ?? "", SNAPSHOT = process.env.SNAPSHOT ?? "";
const l2rows: L2[] = L2_SNAPSHOT && existsSync(L2_SNAPSHOT) ? JSON.parse(readFileSync(L2_SNAPSHOT, "utf8")) : await restAll<L2>("payroll_soukatsu_rows?select=id,office_number,employee_number,processing_month,sheet_kind,row_data&sheet_kind=eq.part");
let snap: Snap;
if (SNAPSHOT && existsSync(SNAPSHOT)) snap = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snap;
else {
  snap = {
    form: await restAll<Form>("payroll_office_form_records?select=id,office_number,employee_number,processing_month,item_name,item_date,start_time,end_time,break_time&item_name=in.(研修,HRD研修,初任者研修)"),
    mi: await restAll<MI>("payroll_monthly_inputs?select=id,office_number,employee_number,processing_month,item_key,numeric_value&item_key=in.(training_minutes,shoninsha_training_minutes)"),
  };
  if (SNAPSHOT) writeFileSync(SNAPSHOT, JSON.stringify(snap));
}
const l1: { key: string; d: Record<string, unknown> }[] = [];
const seen = new Set<string>();
for (const f of readdirSync(L1_DIR).filter((x) => /_(\d{6})\.json$/.test(x))) {
  const m = /_(\d{6})\.json$/.exec(f)![1];
  for (const x of JSON.parse(readFileSync(`${L1_DIR}/${f}`, "utf8"))) {
    if (x.sheet_kind !== "part") continue;
    const key = `${x.office_number}|${nn(x.employee_number)}|${m}`;
    if (seen.has(key)) continue; // 写しのファイル (過誤_・コピー) の重複行
    seen.add(key); l1.push({ key, d: x.row_data });
  }
}

type Reader = (v: unknown) => number | null;
const minutesOf: Reader = (v) => soukatsuMinutes(v, "minutes");
const clock = (s: string | null) => soukatsuMinutes(s ?? "", "minutes") ?? 0;
const TYPES = ["丸め", "行なし", "時間不足", "当方が多い", "①≠②", "読めない"] as const;
type T = typeof TYPES[number] | "一致";

function classify(l1r: typeof l1, l2: L2[], s: Snap, read2: Reader) {
  // 当方の元データ: 人月 → 研修の 1 回ずつの分 (日付の数だけ繰り返す)
  const sessions = new Map<string, number[]>();
  for (const r of s.form) {
    if (!r.start_time || !r.end_time) continue;
    const k = `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`;
    const d = Math.max(0, clock(r.end_time) - clock(r.start_time) - clock(r.break_time));
    const n = Math.max(1, String(r.item_date ?? "").split(/[,、]/).filter((x) => x.trim()).length);
    sessions.set(k, [...(sessions.get(k) ?? []), ...Array(n).fill(d)]);
  }
  const manual = new Map<string, number>();
  for (const r of s.mi) if (Number(r.numeric_value ?? 0) > 0) { const k = `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`; manual.set(k, (manual.get(k) ?? 0) + Number(r.numeric_value)); }
  const l2m = new Map<string, Record<string, unknown>>();
  for (const r of l2) if (r.sheet_kind === "part") l2m.set(`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, r.row_data);
  const out: { key: string; type: T; detail: string }[] = [];
  for (const { key, d } of l1r) {
    const parts = [d["HRD研修時間"], d["研修時間"], d["初任者研修時間"]].map(minutesOf);
    const meet = minutesOf(d["会議時間"]);
    const ss = sessions.get(key) ?? []; const ours = ss.reduce((a, b) => a + b, 0) + (manual.get(key) ?? 0);
    if (parts.some((p) => p === null)) { out.push({ key, type: "読めない", detail: `① の時間 ${JSON.stringify([d["HRD研修時間"], d["研修時間"], d["初任者研修時間"]])}` }); continue; }
    const l1min = (parts as number[]).reduce((a, b) => a + b, 0);
    if (!l1min && !ours) continue;
    if (ours === l1min) { out.push({ key, type: "一致", detail: "" }); continue; }
    const b = l2m.get(key);
    const l2parts = b ? [read2(b["内研修時間"]), read2(b["内初任者研修時間"])] : null;
    if (l2parts && l2parts.some((p) => p === null)) { out.push({ key, type: "読めない", detail: `② の時間 ${JSON.stringify([b!["内研修時間"], b!["内初任者研修時間"]])}` }); continue; }
    const l2min = l2parts ? (l2parts as number[]).reduce((a, x) => a + x, 0) : null;
    const l1l2 = l2min !== null && (l2min === l1min || l2min === l1min + (meet ?? 0));
    const tag = `① ${l1min}分 / ② ${l2min ?? "行なし"}分 / 当方 ${ours}分 (書式 ${ss.length} 回${manual.get(key) ? ` + 手入力 ${manual.get(key)}分` : ""})`;
    if (!l1l2) { out.push({ key, type: "①≠②", detail: tag }); continue; }
    const up = ss.reduce((a, x) => a + Math.max(60, Math.ceil(x / 60) * 60), 0) + (manual.get(key) ?? 0);
    const down = ss.reduce((a, x) => a + Math.floor(x / 60) * 60, 0) + (manual.get(key) ?? 0);
    if (ss.some((x) => x % 60) && (l1min === up || l1min === down)) { out.push({ key, type: "丸め", detail: `${tag} ← ① は 1 回ごとに${l1min === up ? "切り上げ" : "切り捨て"}` }); continue; }
    if (ours === 0) { out.push({ key, type: "行なし", detail: tag }); continue; }
    out.push({ key, type: ours < l1min ? "時間不足" : "当方が多い", detail: tag });
  }
  return out;
}

console.log("=== check:training-time-l1 (パートの研修時間 ① ② と 当方の元データ) ===");
console.log("★ 計算結果は読まない。時間は soukatsuMinutes で読む。★ 時間不足・行なし は ①② の時間だけで 行を作って埋めない (日付が分からない)");
const r0 = classify(l1, l2rows, snap, minutesOf);
const count = (rs: typeof r0, t: T) => rs.filter((x) => x.type === t).length;
console.log(`\n研修の時間がある人月 ${r0.length} / 一致 ${count(r0, "一致")}`);
for (const t of TYPES) {
  const xs = r0.filter((x) => x.type === t);
  console.log(`\n--- ${t} ${xs.length}`);
  for (const x of xs) console.log(`  ${x.key} ${x.detail}`);
}

console.log("\n--- 負のコントロール (写しを壊す)");
{
  const hit = r0.find((x) => x.type === "一致" && snap.form.some((f) => `${f.office_number}|${nn(f.employee_number)}|${f.processing_month}` === x.key && f.start_time));
  let t: T | "?" = "?";
  if (hit) {
    const i = snap.form.findIndex((f) => `${f.office_number}|${nn(f.employee_number)}|${f.processing_month}` === hit.key && f.start_time);
    const r1 = classify(l1, l2rows, { ...snap, form: snap.form.filter((_, j) => j !== i) }, minutesOf);
    t = r1.find((x) => x.key === hit.key)?.type ?? "?";
  }
  expect(!!hit && t !== "一致", `① 一致の人月 (${hit?.key}) の書式を 1 行消すと 一致から外れる (→ ${t})`);
}
{
  const hit = r0.find((x) => x.type === "丸め");
  let n = -1;
  if (hit) {
    const raw = snap.form.filter((f) => `${f.office_number}|${nn(f.employee_number)}|${f.processing_month}` === hit.key && f.start_time)
      .reduce((a, f) => a + Math.max(0, clock(f.end_time) - clock(f.start_time) - clock(f.break_time)) * Math.max(1, String(f.item_date ?? "").split(/[,、]/).filter((x) => x.trim()).length), 0);
    const l1b = l1.map((x) => (x.key === hit.key ? { ...x, d: { ...x.d, HRD研修時間: `${Math.floor(raw / 60)}:${String(raw % 60).padStart(2, "0")}`, 研修時間: "", 初任者研修時間: "" } } : x));
    n = count(classify(l1b, l2rows, snap, minutesOf), "丸め");
  }
  expect(!!hit && n === count(r0, "丸め") - 1, `② 丸めの人月の ① を 当方の生の分に入れ直すと 丸め が ${count(r0, "丸め")} → ${n}`);
}
{
  const naive: Reader = (v) => { if (v === null || v === undefined || v === "") return 0; const n = parseFloat(String(v)); return Number.isNaN(n) ? 0 : n; };
  const n = count(classify(l1, l2rows, snap, naive), "①≠②");
  expect(n > count(r0, "①≠②"), `③ ② の時間を parseFloat で読むと ①≠② が ${count(r0, "①≠②")} → ${n} に増える ("35:00" の読み違いの型)`);
}

type Baseline = { _readme: string[]; counts: Record<string, number> };
const counts: Record<string, number> = Object.fromEntries(TYPES.map((t) => [t, count(r0, t)]));
const baseline: Baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline : { _readme: [], counts: {} };
if (UPDATE) { baseline.counts = counts; writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n", "utf8"); console.log("\n基準値を更新しました"); }
else {
  console.log(`\n基準値: ${JSON.stringify(baseline.counts)}`);
  for (const t of TYPES) expect(counts[t] <= (baseline.counts[t] ?? Number.POSITIVE_INFINITY), `${t} が基準値から増えていない (${counts[t]} <= ${baseline.counts[t] ?? "∞"})`);
}
console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS");
process.exit(fail ? 1 : 0);
