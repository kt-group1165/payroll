/**
 * check:monthly-paid-leave — 月給者の有給休暇手当を 当方 / ② で 月ごと と 人ごとの通算 で突き合わせる
 * (2026-09-27 給与C 新設・読み取り専用)。
 *
 *   SOUKATSU1_DIR=<① の抽出物のある dir> npm run check:monthly-paid-leave
 *   ... SNAPSHOT=<{calc, soukatsu} の json>   # DB を読まず 保存済みを使う
 *   ... -- --detail   /   -- --update   (★ 悪化したまま更新しない)
 *
 * 【なぜ】
 * ① (旧システム出力) に 月給者の有給休暇手当の列が無い (日数の列「有給取得日数」はある)。
 * そのため 3 者突合では「判定できない」に落ち、★ 当方が多い = 過払いの向きの差が見えていなかった。
 * ★ 2 材料が揃わないので ② が 0 だから当方を 0 にする、はしない。見えるようにするだけ。
 *
 * 【比べ方】
 *   当方 = monthlyPaidLeaveAllowance(payload の monthly)  ★ 計算と同じ関数・同じ入力
 *   ②   = 提責_社員 シートの「有給休暇手当」
 *   日数 = 当方 paidLeaveDays(summary) / ② 「有給・特休・欠勤」(無ければ「有給」) / ① 「有給取得日数」
 *   ★ 月ごとに見ると「② は単価が空の月を 0 円で置き 後の月にまとめて精算する」(memory payroll_paid_leave_unpaid_carryover)
 *     ので 人ごとの通算 (対象月の合計) でも見る。★ 通算で一致すれば タイミングの差で 金額の差ではない
 *
 * ── 型 ─────────────────────────────────────────────────────────────────
 *   月ごと: 一致 (±1 円) / 当方だけ (② 0) / ②だけ (当方 0) / 額が違う / ② 行なし
 *   人ごとの通算 (月ごとに一致以外がある人): 通算一致 / 当方が多い (★ 過払いの向き) / ② が多い
 *
 * ── この検査が見ていないもの ─────────────────────────────────────────────
 *   ・対象月の外 (202609 以降) で ② が精算しているか。★ 当方が多い人は 次の月の ② で相殺される可能性がある
 *   ・時給者の有給 (別の計算。check:soukatsu-item-gap の 有給 は ① に列が無く件数だけ)
 *   ・有給管理簿の単価 (付与ごとの日当) そのものの正しさ
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { restAll } from "./_rest.mjs";
import { num } from "./_soukatsu-items.mjs";
import { monthlyPaidLeaveAllowance, paidLeaveDays, type MonthlyPayroll } from "../src/lib/payroll/payroll-calc.js";

const UPDATE = process.argv.includes("--update");
const DETAIL = process.argv.includes("--detail");
const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), "check-monthly-paid-leave-baseline.json");
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");

type Calc = { office_number: string; processing_month: string; payload: { monthly?: (MonthlyPayroll & { employee_number: string; employee_name?: string })[] } | null };
type R2 = { office_number: string; employee_number: string; processing_month: string; sheet_kind: string; row_data: Record<string, unknown> };
export type Pm = { key: string; person: string; name: string; ours: number; l2: number | null; days: number; l2days: number | null; l1days: number | null; type: string };

export function monthType(ours: number, l2: number | null): string | null {
  if (l2 == null) return ours > 0 ? "② 行なし" : null;
  if (!ours && !l2) return null;
  if (Math.abs(ours - l2) <= 1) return "一致";
  if (!l2) return "当方だけ";
  if (!ours) return "②だけ";
  return "額が違う";
}

export function build(calc: Calc[], l2rows: R2[], l1: Map<string, Record<string, unknown>>): Pm[] {
  const l2 = new Map<string, Record<string, unknown>>();
  for (const r of l2rows) if (r.sheet_kind !== "part") l2.set(`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, r.row_data);
  const out: Pm[] = [];
  for (const c of calc) for (const p of c.payload?.monthly ?? []) {
    const person = `${c.office_number}|${nn(p.employee_number)}`;
    const key = `${person}|${c.processing_month}`;
    const ours = monthlyPaidLeaveAllowance(p);
    const d2 = l2.get(key), d1 = l1.get(key);
    const l2v = d2 ? num(d2["有給休暇手当"]) : null;
    const type = monthType(ours, l2v);
    if (!type) continue;
    out.push({
      key, person, name: String(p.employee_name ?? "").replace(/\s+/g, " "), ours, l2: l2v,
      days: paidLeaveDays(p.summary?.paidLeave ?? 0, p.summary?.halfLeave ?? 0),
      l2days: d2 ? num(d2["有給・特休・欠勤"] ?? d2["有給"]) : null, l1days: d1 ? num(d1["有給取得日数"]) : null, type,
    });
  }
  return out;
}

/** 月ごとに一致以外がある人の 通算 (その人の対象月の合計) */
export function persons(pms: Pm[]) {
  const bad = new Set(pms.filter((x) => x.type !== "一致").map((x) => x.person));
  return [...bad].map((person) => {
    const h = pms.filter((x) => x.person === person);
    const ours = h.reduce((s, x) => s + x.ours, 0), l2 = h.reduce((s, x) => s + (x.l2 ?? 0), 0);
    const type = Math.abs(ours - l2) <= 1 ? "通算一致" : ours > l2 ? "当方が多い" : "② が多い";
    return { person, name: h[0].name, ours, l2, diff: ours - l2, type, months: h.map((x) => `${x.key.slice(-2)}:${x.ours}/${x.l2 ?? "-"}`).join(" ") };
  });
}

const countOf = (xs: { type: string }[]) => { const c: Record<string, number> = {}; for (const x of xs) c[x.type] = (c[x.type] ?? 0) + 1; return c; };

function negativeControl(calc: Calc[], l2rows: R2[], l1: Map<string, Record<string, unknown>>, base: Pm[]) {
  const lines: string[] = [];
  let ok = true;
  const b0 = countOf(base), p0 = countOf(persons(base));
  const hit = base.find((x) => x.type === "一致" && x.ours > 0 && x.l2 != null);
  if (!hit) return { ok: false, lines: ["一致している人月が無く 作れない  ★ NG"] };
  const zeroL2 = l2rows.map((r) => (r.sheet_kind !== "part" && `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}` === hit.key ? { ...r, row_data: { ...r.row_data, 有給休暇手当: 0 } } : r));
  const t = (label: string, rs: Pm[], field: "month" | "person", type: string, want: number) => {
    const c = field === "month" ? countOf(rs) : countOf(persons(rs));
    const b = field === "month" ? b0 : p0;
    const got = (c[type] ?? 0) - (b[type] ?? 0);
    const p = got === want;
    if (!p) ok = false;
    lines.push(`${label} → ${type} +${got}${p ? "  OK" : `  ★ NG (期待 +${want})`}`);
  };
  const r1 = build(calc, zeroL2, l1);
  t(`② の有給休暇手当を 0 にする (${hit.key})`, r1, "month", "当方だけ", 1);
  t("  その人は 通算でも当方が多くなる", r1, "person", "当方が多い", 1);
  // 翌月の ② に 同じ額を足す (= 後の月でまとめて精算) → 通算一致
  const next = base.find((x) => x.person === hit.person && x.key > hit.key && x.l2 != null);
  if (next) {
    const settled = zeroL2.map((r) => (r.sheet_kind !== "part" && `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}` === next.key
      ? { ...r, row_data: { ...r.row_data, 有給休暇手当: num(r.row_data["有給休暇手当"]) + hit.ours } } : r));
    t("  さらに後の月の ② にその額を足す (まとめて精算) → 通算一致", build(calc, settled, l1), "person", "通算一致", 1);
  } else { ok = false; lines.push("後の月が無く 精算のコントロールを作れない  ★ NG"); }
  return { ok, lines };
}

async function main() {
  console.log("=== check:monthly-paid-leave (月給者の有給休暇手当 当方 / ②・月ごと と 人ごとの通算) 2026-09-27 新設・読み取り専用 ===");
  console.log("★ check:all には入れていない (意図的)。① に金額の列が無く 2 材料が揃わない診断系");
  console.log("★ この検査が見ていないもの: 対象月の外の精算 / 時給者の有給 / 有給管理簿の単価そのもの");
  const dir = process.env.SOUKATSU1_DIR;
  if (!dir) { console.log("★ SOUKATSU1_DIR=<① の抽出物のある dir> が要る (日数の突合に使う)"); process.exit(1); }
  const files = readdirSync(dir).filter((f) => /^soukatsu_extract_\d{6}\.json$/.test(f)).sort();
  if (!files.length) { console.log(`★ ${dir} に抽出物が 1 本もない (0 件と出さない)`); process.exit(1); }
  const l1 = new Map<string, Record<string, unknown>>();
  for (const f of files) {
    const ym = /_(\d{6})\.json$/.exec(f)![1];
    for (const r of JSON.parse(readFileSync(join(dir, f), "utf8")) as R2[]) {
      if (r.sheet_kind === "part") continue;
      const k = `${r.office_number}|${nn(r.employee_number)}|${ym}`;
      if (!l1.has(k)) l1.set(k, r.row_data);
    }
  }
  const path = process.env.SNAPSHOT;
  const snap = path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  const calc: Calc[] = snap ? snap.calc : await restAll<Calc>("payroll_calc_results?select=id,office_number,processing_month,payload");
  const l2rows: R2[] = snap ? snap.soukatsu : await restAll<R2>("payroll_soukatsu_rows?select=id,office_number,employee_number,processing_month,sheet_kind,row_data");
  const pms = build(calc, l2rows, l1);
  const monthlyTotal = calc.reduce((s, c) => s + (c.payload?.monthly?.length ?? 0), 0);
  if (!monthlyTotal) { console.log("★ 月給者の人月が 0 件 (0 件と出さない)"); process.exit(1); }

  const neg = negativeControl(calc, l2rows, l1, pms);
  console.log("\n負のコントロール (読み込んだ写しを壊す。DB もファイルも触らない):");
  for (const l of neg.lines) console.log("  " + l);

  const withDays = calc.reduce((s, c) => s + (c.payload?.monthly ?? []).filter((p) => paidLeaveDays(p.summary?.paidLeave ?? 0, p.summary?.halfLeave ?? 0) > 0).length, 0);
  const mc = countOf(pms), ps = persons(pms), pc = countOf(ps);
  const yen = (t: string) => pms.filter((x) => x.type === t).reduce((s, x) => s + x.ours - (x.l2 ?? 0), 0);
  console.log("\n母数 (★ 定義ごとに出す):");
  console.log(`  月給者の人月 ${monthlyTotal} / うち当方で有給の取得がある ${withDays} / 当方か ② に有給休暇手当がある ${pms.length}`);
  console.log("月ごと:");
  for (const [k, v] of Object.entries(mc).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(8)} ${String(v).padStart(4)}  当方 − ② ¥${yen(k).toLocaleString()}`);
  const noMatch = pms.filter((x) => x.type === "当方だけ");
  const dayEq = noMatch.filter((x) => x.l2days != null && Math.abs(x.days - x.l2days) < 0.01).length;
  console.log(`  当方だけ ${noMatch.length} のうち ② の日数欄が当方の日数と同じ ${dayEq} (= ② は日数を載せているのに 0 円 = 単価が空の月の型)`);
  console.log("人ごとの通算 (月ごとに一致以外がある人):");
  for (const [k, v] of Object.entries(pc)) console.log(`  ${k.padEnd(8)} ${String(v).padStart(3)} 人  当方 − ② ¥${ps.filter((x) => x.type === k).reduce((s, x) => s + x.diff, 0).toLocaleString()}`);
  if (DETAIL) {
    console.log("\n--- 月ごとに一致以外");
    for (const x of pms.filter((x) => x.type !== "一致")) console.log(`  ${x.key} ${x.name} ${x.type} 当方 ${x.ours} / ② ${x.l2} | 日数 当方 ${x.days} / ② ${x.l2days} / ① ${x.l1days}`);
    console.log("--- 人ごとの通算");
    for (const x of ps) console.log(`  ${x.person} ${x.name} ${x.type} 当方 ${x.ours} / ② ${x.l2} (差 ${x.diff})  ${x.months}`);
  }

  const counts = { month: mc, person: pc, overYen: ps.filter((x) => x.type === "当方が多い").reduce((s, x) => s + x.diff, 0) };
  let failed = false;
  if (existsSync(BASELINE_PATH) && !UPDATE) {
    const b = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    console.log("\n--- 基準値との比較");
    const worse: string[] = [];
    for (const k of new Set([...Object.keys(b.counts.month), ...Object.keys(mc)])) if (k !== "一致" && (mc[k] ?? 0) > (b.counts.month[k] ?? 0)) worse.push(`月ごと ${k} ${b.counts.month[k] ?? 0}→${mc[k]}`);
    if ((pc["当方が多い"] ?? 0) > (b.counts.person["当方が多い"] ?? 0)) worse.push(`人ごと 当方が多い ${b.counts.person["当方が多い"] ?? 0}→${pc["当方が多い"]}`);
    if (counts.overYen > b.counts.overYen) worse.push(`当方が多い人の差額 ¥${b.counts.overYen}→¥${counts.overYen}`);
    console.log(`  ★ 悪化 ${worse.length}`);
    for (const w of worse) console.log(`  ★ 悪化 ${w}`);
    failed = worse.length > 0;
  } else if (!UPDATE) console.log("\n基準値ファイルがありません。--update で作成してください");
  if (UPDATE) {
    const prev = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
    writeFileSync(BASELINE_PATH, JSON.stringify({ _readme: prev._readme ?? "(新規)", updated_at: new Date().toISOString(), counts }, null, 2) + "\n");
    console.log(`\n基準値を更新しました: ${BASELINE_PATH}`);
  }
  if (!neg.ok) { console.log("★ 負のコントロールが通らないので PASS を出しません"); process.exit(1); }
  if (failed) { console.log("★ FAIL: 過払いの向きの件数・額が増えました。--detail で見てください"); process.exit(1); }
  console.log("PASS (★ 0 件 PASS ではない。基準値の件数を許容したうえでの PASS)");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e); process.exit(1); });
