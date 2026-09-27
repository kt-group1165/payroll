/**
 * check:childcare-gap — 育児手当 (保育料) が ① と合わない人月を、★ ① 側の保育料の額を逆算して分類する。
 *
 *   npm run check:childcare-gap
 *   L1_DIR=<① の抽出済みフォルダ> CALC_SNAPSHOT=<json> npm run check:childcare-gap
 *   npm run check:childcare-gap -- --update      ★ 基準値方式の件数だけ更新
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────────
 * check:soukatsu-cause は「育児 31 人月 / 当方 − ② の合計 −55 円」としか出さない。
 * ★ 金額は小さいが 人月の数が多い (残差 622 のうち 42 人月) ので、★ 理由を割ると一致率が動く。
 * 2026-09-27 に 1 件ずつ当たったところ、★ **当方のコードの誤りではなく 保育料の額そのものが違う**。
 *
 * ── 逆算のしかた ──────────────────────────────────────────────────────────
 * ★ 式は書き写さない。★ 本番の `computeChildcareAllowance` (payroll-calc.ts) を **そのまま呼ぶ**。
 * 保育料の額だけを差し替えて呼び直し、★ ① の育児手当と同じ値になる額の範囲を出す:
 *     ① の育児手当 = round(保育料 × 率 × min(参照月の訪問時間 / 120h, 1))    率: 保育料 40% / 幼稚園 20%
 *   → 逆算した保育料 ∈ [ (①−0.5) / (率 × 按分), (①+0.5) / (率 × 按分) )
 * ★ 範囲の中で いちばん丸い額 (100 円 → 50 円 → 10 円の倍数) を「① 側の額」として出す。
 * ★ 訪問時間は ① の「訪問時間」列と一致する (同行込み) ので、参照月が処理月でなくても引ける。
 *
 * ★ 前提の確認 (毎回出す・負のコントロール): 当方の書式の額で 本番の関数を呼んで
 *   payroll_calc_results の値を再現できること。★ 再現できない人月は逆算も信じない。
 *
 * ── 2026-09-27 の実測 ────────────────────────────────────────────────────
 *   端数の食い違い。★ 人ごとに一定で、複数月で同じ額に収束する:
 *     富谷いづみ  富谷双葉  書式 18,550 → ★ ① は 18,600  (4 人月すべて 18,600 ちょうど)
 *     清水亮子    清水大翔  書式 10,000 → ★ ① は  9,900
 *     松木優希    松木優雅  書式  8,000 → ★ ① は  8,100
 *     鈴木知佳    優和     書式 2,000 / 2,300 → ★ ① は 2,100 / 2,400 (4 人月とも +100)
 *     松原奈津子  朱里     書式  9,500 → ★ ① は  9,600
 *     内山怜子    穂香(学童) 書式 3,500 → ★ ① は  3,600
 *     原田麗子    明怜     書式  2,700 → ★ ① は  2,740
 *   ★ 「旧システムの保育料の額」は 2026-09-27 時点で user への依頼リストに入っている。
 *     ★ この検査があると 依頼が「額を出して」から「★ この額で合っているか」に変わる。
 *
 *   書式に 保育料ではなく **育児手当の額** が入っている疑い:
 *     柴田彩 陸 202607: 書式 2,282 = ★ ① の育児手当 2,282 と 1 円一致。当方は これを保育料として
 *     40% × 按分して 482 円しか払っていない。★ 202605 も 書式 1,981 / ① 2,061 で桁が同じ。
 *
 * ── 見ていないもの ────────────────────────────────────────────────────────
 *   ・月給者 (件数だけ出す。① の提責_社員 シートは列名が違う)
 *   ・明細が 2 件以上の人月 (額の組み合わせが一意に決まらないので 件数だけ)
 *   ・按分が 120h の上限に当たっている人月 (どの額でも同じ値になるので逆算できない)
 *   ・手入力で上書きした人月 (payroll_monthly_inputs の childcare_allowance)。逆算の対象から外す
 *   ・② (支払用シート) は見ない。★ ここは ① (旧システムの出力) との突合だけ
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restAll } from "./_rest.mjs";
// ★ 式を書き写さない。本番の関数をそのまま呼ぶ (逐語コピーは乖離源。AGENTS.md / feedback_test_verbatim_copy)
import { computeChildcareAllowance, normalizeYM, type OfficeFormRecord } from "../src/lib/payroll/payroll-calc.js";

const UPDATE = process.argv.includes("--update");
const BASELINE = new URL("./check-childcare-gap-baseline.json", import.meta.url);
const MONTHS = (process.env.MONTHS || "202603,202604,202605,202606,202607,202608").split(",");
const CEILING_MIN = 120 * 60;
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");
const yen = (n: number) => `¥${Math.round(n).toLocaleString()}`;
const num = (v: unknown) => { const n = Number(String(v ?? "").replace(/[^0-9.-]/g, "")); return Number.isFinite(n) ? n : 0; };
/** "78:15" / "78:15:00" → 分。① の時間列は文字列 */
const hhmm = (v: unknown) => { const m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(String(v ?? "").trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

console.log("=== check:childcare-gap (育児手当・当方 vs 総括表 ①・① 側の保育料を逆算) ===");

// ── ① ──
type L1Row = { office_number: string; employee_number: string; sheet_kind: string; row_data: Record<string, unknown> };
let L1_DIR = process.env.L1_DIR ?? "";
if (!L1_DIR) {
  L1_DIR = join(tmpdir(), "childcare-gap-l1");
  if (existsSync(L1_DIR)) rmSync(L1_DIR, { recursive: true, force: true });
  console.log("① を xlsm から再抽出しています (数分かかります)...");
  execSync("node migrations/extract_soukatsu_from_xlsm.mjs --execute", { env: { ...process.env, OUT: L1_DIR, MONTHS: MONTHS.join(",") }, stdio: "inherit" });
}
const l1 = new Map<string, Record<string, unknown>>();
let l1Part = 0;
for (const f of readdirSync(L1_DIR).filter((x) => /_(\d{6})\.json$/.test(x))) {
  const m = /_(\d{6})\.json$/.exec(f)![1];
  if (!MONTHS.includes(m)) continue;
  for (const r of JSON.parse(readFileSync(`${L1_DIR}/${f}`, "utf8")) as L1Row[]) {
    if (r.sheet_kind !== "part") continue;
    const key = `${r.office_number}|${nn(r.employee_number)}|${m}`;
    if (l1.has(key)) continue;  // 写しのファイルからの重複行は先に読んだほうを残す
    l1.set(key, r.row_data);
    l1Part++;
  }
}

// ── 当方 ──
type Hourly = { employee_number: string; employee_name?: string; childcare_allowance?: number; summary?: { visitMinutes?: number } };
type CalcRow = { office_number: string; processing_month: string; hourly: Hourly[] | null; monthly: Hourly[] | null };
const CALC_SNAPSHOT = process.env.CALC_SNAPSHOT ?? "";
let calc: CalcRow[];
if (CALC_SNAPSHOT && existsSync(CALC_SNAPSHOT)) calc = JSON.parse(readFileSync(CALC_SNAPSHOT, "utf8")) as CalcRow[];
else {
  calc = await restAll<CalcRow>("payroll_calc_results?select=id,office_number,processing_month,hourly:payload->hourly,monthly:payload->monthly");
  if (CALC_SNAPSHOT) writeFileSync(CALC_SNAPSHOT, JSON.stringify(calc));
}
const hourlyBy = new Map<string, Hourly>();
const monthlyNums = new Set<string>();
for (const c of calc) {
  if (!MONTHS.includes(c.processing_month)) continue;
  for (const e of c.hourly ?? []) hourlyBy.set(`${c.office_number}|${nn(e.employee_number)}|${c.processing_month}`, e);
  for (const e of c.monthly ?? []) monthlyNums.add(`${c.office_number}|${nn(e.employee_number)}|${c.processing_month}`);
}

// ── 保育料の明細 (事業所書式) ──
type FormRow = { office_number: string; processing_month: string; employee_number: string; record_type: string; item_name: string; item_date: string | null; numeric_value: number | null; start_time: string | null; end_time: string | null; year_month: string | null; child_name: string | null; amount: number | null };
const form = await restAll<FormRow>("payroll_office_form_records?select=id,office_number,processing_month,employee_number,record_type,item_name,item_date,numeric_value,start_time,end_time,year_month,child_name,amount&record_type=eq.childcare");
const formBy = new Map<string, FormRow[]>();
for (const r of form) {
  if (!MONTHS.includes(r.processing_month)) continue;
  const k = `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`;
  formBy.set(k, [...(formBy.get(k) ?? []), r]);
}

// ── 手入力の上書き (これがある人月は 書式の額から計算していない) ──
type InputRow = { office_number: string; processing_month: string; employee_number: string; numeric_value: number | null };
const manual = new Set<string>();
for (const r of await restAll<InputRow>("payroll_monthly_inputs?select=id,office_number,processing_month,employee_number,numeric_value&item_key=eq.childcare_allowance"))
  if (Number(r.numeric_value ?? 0) > 0) manual.add(`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`);

// ── 旧システムの契約 (限度額・指定割合)。★ 本番と同じものを関数に渡す ──
type ContractRow = { office_number: string; employee_number: string; childcare_limit: number | null; childcare_rate_pct: number | null; childcare_method: string | null };
const contract = new Map<string, ContractRow>();
for (const r of await restAll<ContractRow>("payroll_legacy_contract?select=id,office_number,employee_number,childcare_limit,childcare_rate_pct,childcare_method"))
  contract.set(`${r.office_number}|${nn(r.employee_number)}`, r);
const contractArg = (on: string, en: string) => {
  const c = contract.get(`${on}|${en}`);
  return { limit: c?.childcare_limit, ratePct: c?.childcare_rate_pct, method: c?.childcare_method };
};
/** 指定割合の人は按分しないので 逆算の式 (按分ありの逆) が当たらない */
const isFixedRate = (on: string, en: string) => contractArg(on, en).method === "指定割合";

console.log(`① パート ${l1Part} 人月 / 当方 時給 ${hourlyBy.size} 人月 / 保育料の明細 ${form.length} 行 (${formBy.size} 人月) / 手入力の上書き ${manual.size} 人月 / 旧の契約 ${contract.size} 名`);

/** 本番の関数に渡す 参照月ごとの訪問時間。処理月は当方の payload、他の月は ① の「訪問時間」列 */
function minutesMapFor(on: string, en: string, pm: string, e: Hourly, recs: FormRow[]): { map: Map<string, number>; missing: string[] } {
  const map = new Map<string, number>();
  const missing: string[] = [];
  map.set(`${en}:${pm}`, e.summary?.visitMinutes ?? 0);
  for (const r of recs) {
    const ym = r.year_month ? normalizeYM(r.year_month) : pm;
    if (map.has(`${en}:${ym}`)) continue;
    const m = hhmm(l1.get(`${on}|${en}|${ym}`)?.["訪問時間"]);
    if (m == null) missing.push(ym); else map.set(`${en}:${ym}`, m);
  }
  return { map, missing };
}
const toRec = (r: FormRow): OfficeFormRecord => ({ employee_number: r.employee_number, record_type: r.record_type, item_name: r.item_name, item_date: r.item_date, numeric_value: r.numeric_value, start_time: r.start_time, end_time: r.end_time, year_month: r.year_month, child_name: r.child_name, amount: r.amount });
/** 範囲の中で いちばん丸い額 */
function roundest(lo: number, hi: number): number {
  for (const step of [1000, 500, 100, 50, 10]) {
    const c = Math.ceil(lo / step) * step;
    if (c < hi) return c;
  }
  return Math.round((lo + hi) / 2);
}

type Case = {
  key: string; name: string; l1v: number; ours: number;
  ym?: string; item?: string; child?: string; formAmount?: number; implied?: number; lo?: number; hi?: number; minutes?: number;
  forwardOk?: boolean; reason?: string;
};
const gaps: Case[] = [];
const forwardBad: { key: string; name: string; fwd: number; ours: number }[] = [];
let pairs = 0, agree = 0, monthlyGap = 0, forwardN = 0, forwardOkN = 0;
for (const [key, recs] of formBy) {
  const [on, en, pm] = key.split("|");
  const d = l1.get(key);
  if (!d) { if (monthlyNums.has(key)) monthlyGap++; continue; }   // 月給者は件数だけ
  const e = hourlyBy.get(key);
  if (!e) continue;
  const l1v = num(d["育児手当"]), ours = num(e.childcare_allowance);
  pairs++;
  const name = String(e.employee_name ?? "");
  const { map, missing } = minutesMapFor(on, en, pm, e, recs);

  // ★ 逆算が使える前提: 当方の書式の額で 本番の関数を呼んで payload の値を再現できるか
  let forwardOk: boolean | undefined;
  if (missing.length === 0 && !manual.has(key)) {
    const fwd = computeChildcareAllowance(recs.map(toRec), "時給", map, en, pm, contractArg(on, en));
    forwardOk = Math.abs(fwd - ours) < 1.5;
    forwardN++;
    if (forwardOk) forwardOkN++; else forwardBad.push({ key, name, fwd, ours });
  }
  if (Math.abs(ours - l1v) < 1.5) { agree++; continue; }

  if (manual.has(key)) { gaps.push({ key, name, l1v, ours, reason: "当方は手入力で上書きしている (書式の額からの式ではない)" }); continue; }
  if (recs.length !== 1) { gaps.push({ key, name, l1v, ours, reason: `明細 ${recs.length} 件 (額の組み合わせが一意に決まらない)` }); continue; }
  if (isFixedRate(on, en)) { gaps.push({ key, name, l1v, ours, reason: "旧の契約が 指定割合 (按分しないので この逆算が当たらない)" }); continue; }
  const r = recs[0];
  const ym = r.year_month ? normalizeYM(r.year_month) : pm;
  const min = map.get(`${en}:${ym}`);
  if (min == null) { gaps.push({ key, name, l1v, ours, reason: `参照月 ${ym} の訪問時間が手元に無い` }); continue; }
  if (min >= CEILING_MIN) { gaps.push({ key, name, l1v, ours, reason: "按分が 120h の上限に当たっていて逆算できない" }); continue; }
  if (l1v <= 0 || ours <= 0) { gaps.push({ key, name, l1v, ours, ym, item: r.item_name, child: r.child_name ?? "", formAmount: r.amount ?? 0, minutes: min, reason: l1v <= 0 ? "① は払っていない" : "当方は払っていない" }); continue; }
  const c = contractArg(on, en);
  const rate = (c.ratePct ?? 0) > 0 ? (c.ratePct as number) / 100 : (r.item_name.includes("幼稚園") ? 0.2 : 0.4);
  const k = rate * (min / CEILING_MIN);
  const lo = (l1v - 0.5) / k, hi = (l1v + 0.5) / k;
  const implied = roundest(lo, hi);
  // ★ 逆算した額を 本番の関数に入れ直して ① の値になることを確かめる (逆算の自己検算)
  const back = computeChildcareAllowance([{ ...toRec(r), amount: implied }], "時給", map, en, pm, c);
  gaps.push({ key, name, l1v, ours, ym, item: r.item_name, child: r.child_name ?? "", formAmount: r.amount ?? 0, minutes: min, forwardOk, lo, hi, implied: Math.abs(back - l1v) < 1.5 ? implied : undefined, reason: Math.abs(back - l1v) < 1.5 ? undefined : `逆算した ${implied} を入れ直しても ① (${l1v}) にならない (${back})` });
}

console.log(`\n--- 突合 (① と当方の両方に行がある 時給者の人月) ---`);
console.log(`  対 ${pairs} / 一致 ${agree} / ★ 食い違い ${gaps.length}   (月給者の食い違いは別: ${monthlyGap} 人月 — この検査では見ない)`);
console.log(`  ★ 逆算が使える前提の確認: 当方の書式の額で 本番の関数を呼んで payload を再現できた ${forwardOkN} / ${forwardN} 人月`);
for (const b of forwardBad) console.log(`    ⚠ 再現できない ${b.key} ${b.name} 関数 ${yen(b.fwd)} / payload ${yen(b.ours)}`);

const solvable = gaps.filter((g) => g.implied != null);
const HASU = 200;
const hasu = solvable.filter((g) => Math.abs(g.implied! - (g.formAmount ?? 0)) <= HASU);
const big = solvable.filter((g) => Math.abs(g.implied! - (g.formAmount ?? 0)) > HASU);

console.log(`\n--- ① 側の保育料を逆算した結果 ${solvable.length} 人月 (★ 端数 ${hasu.length} / 大きく違う ${big.length}) ---`);
const byPerson = new Map<string, Case[]>();
for (const g of solvable) byPerson.set(`${g.name}|${g.child}|${g.item}`, [...(byPerson.get(`${g.name}|${g.child}|${g.item}`) ?? []), g]);
for (const [k, list] of [...byPerson].sort()) {
  const [name, child, item] = k.split("|");
  console.log(`  ${name.padEnd(10, "　")} ${child.padEnd(8, "　")} ${item}  ${list.length} 人月`);
  for (const g of list.sort((a, b) => a.key.localeCompare(b.key))) {
    const diff = g.implied! - (g.formAmount ?? 0);
    console.log(`      ${g.key} 参照 ${g.ym} 訪問 ${g.minutes} 分  ① ${yen(g.l1v)} / 当方 ${yen(g.ours)}`
      + `  書式 ${yen(g.formAmount ?? 0)} → ★ 逆算 ${yen(g.implied!)} (差 ${diff >= 0 ? "+" : ""}${Math.round(diff)} / 範囲 ${g.lo!.toFixed(1)}〜${g.hi!.toFixed(1)})${g.forwardOk === false ? " ⚠ 順方向で payload を再現できていない" : ""}`);
  }
}
console.log(`\n--- 逆算できなかった / 片側が 0 の人月 ${gaps.length - solvable.length} ---`);
for (const g of gaps.filter((x) => x.implied == null)) console.log(`  ${g.key} ${g.name.padEnd(10, "　")} ① ${yen(g.l1v)} / 当方 ${yen(g.ours)}  (${g.reason})`);

// ── 負のコントロール ──
console.log("\n--- 負のコントロール");
{
  const hit = [...formBy.keys()].find((k) => {
    const d = l1.get(k), e = hourlyBy.get(k), recs = formBy.get(k)!;
    return !!d && !!e && recs.length === 1 && num(d["育児手当"]) > 0 && Math.abs(num(e.childcare_allowance) - num(d["育児手当"])) < 1.5 && !manual.has(k);
  });
  expect(!!hit, `一致している人月 (明細 1 件) がある (壊す先: ${hit ?? "なし"})`);
  if (hit) {
    const [on, en, pm] = hit.split("|");
    const e = hourlyBy.get(hit)!, recs = formBy.get(hit)!;
    const { map } = minutesMapFor(on, en, pm, e, recs);
    const c = contractArg(on, en);
    const base = computeChildcareAllowance(recs.map(toRec), "時給", map, en, pm, c);
    const more = computeChildcareAllowance([{ ...toRec(recs[0]), amount: (recs[0].amount ?? 0) + 1000 }], "時給", map, en, pm, c);
    expect(more > base, `その人月の保育料を +1,000 円にすると 手当が増える (${yen(base)} → ${yen(more)}) = 逆算が効く向き`);
  }
}
expect(forwardN > 0 && forwardOkN === forwardN, `本番の関数で payload を全件再現できる (${forwardOkN}/${forwardN}) — 1 件でも外れたら逆算の前提が崩れている`);

// ── 基準値 ──
type Baseline = { _readme: string[]; counts: Record<string, number> };
const counts: Record<string, number> = {
  食い違い: gaps.length,
  端数の食い違い: hasu.length,
  大きく違う: big.length,
  逆算できない: gaps.length - solvable.length,
  順方向を再現できない: forwardBad.length,
  "月給者の食い違い(参考)": monthlyGap,
};
const baseline: Baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline : { _readme: [], counts: {} };
if (UPDATE) {
  baseline.counts = counts;
  writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  console.log("\n基準値を更新しました");
} else {
  console.log("\n--- 基準値");
  for (const [k, v] of Object.entries(counts)) {
    const b = baseline.counts[k] ?? Number.POSITIVE_INFINITY;
    if (v > b) expect(false, `${k} が基準値から増えた (${v} > ${b})`);
  }
  expect(Object.entries(counts).every(([k, v]) => v <= (baseline.counts[k] ?? Number.POSITIVE_INFINITY)), `どの件数も基準値から増えていない (${Object.keys(counts).length} 項目)`);
}
console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS (★ 0 件 PASS ではない。基準値の件数を許容したうえでの PASS)");
process.exit(fail ? 1 : 0);
