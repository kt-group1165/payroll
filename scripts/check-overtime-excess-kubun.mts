/**
 * check:overtime-excess-kubun — 固定残業代を超えた分を払うか (総括表の「提責・事務」区分 1 / 3) を 月ごとに ② と突き合わせる
 * (2026-09-27 給与C 新設・読み取り専用)。
 *
 *   npm run check:overtime-excess-kubun
 *   SNAPSHOT=<{calc, soukatsu} の json> npm run check:overtime-excess-kubun   # DB を読まず 保存済みを使う
 *   ... -- --detail   /   -- --update   (★ 悪化したまま更新しない)
 *
 * 【なぜ】
 * 当方の設定 overtime_excess_paid_employees (payroll_app_settings) は ★ 人単位 (月を持たない)。
 *   932e7db「総括表 2026-03〜07 で 区分 1 だった 7 名」。設定に入っている提責は 全部の月で超過分を払う。
 * ② は ★ 月ごとに区分が変わる人がいる (2026-09-27 判明):
 *   茂原 吉野陽子 398      03 だけ区分 1 / 04〜08 は区分 3 (超過を払わない)
 *   大網 髙橋久江 230801   03 が区分 3 / 04 以降は区分 1
 * → 区分 3 の月に当方が超過を払う = 過払いの向き。
 *
 * 【② の区分の判定】(★ ① は区分の列を持たないので ② だけが材料。★ 2 材料ではない)
 *   差 = ② の 残業代 − 固定残業代、払 = ② の 残業総額 (無ければ 残業総額2)
 *   払 = 差 (マイナスも含む)          → 区分 1 (超過を払う。下回った月は ② がマイナスを表示する)
 *   払 = 0 で 差 ≠ 0                → 区分 3 (超過を払わない)
 *   差 = 0 / 固定残業代が無い / その他 → 判定できない
 * 【当方】verificationItems の 残業総額 (= overtimeExcessPay)。★ 月給の payload に額は無いので列を直接読まない
 *
 * ── 型 (人月) ───────────────────────────────────────────────────────────
 *   一致                 設定あり × ② 区分 1 / 設定なし × ② 区分 3
 *   ★設定あり・②は区分3   当方が超過を払い ② は払わない (差 > 0 の月は過払いの向き)
 *   ★設定なし・②は区分1   当方は払わず ② が払う (差 > 0 の月は払い不足の向き)
 *   判定できない
 *
 * ── この検査が見ていないもの ─────────────────────────────────────────────
 *   ・残業の分そのものの差 (check:overtime-minutes)
 *   ・区分をどちらにするのが正しいか (user の判断。直すなら 月ごとの区分を設定と src に持たせる変更)
 *   ・② のマイナス表示が総支給に入っているか (総支給は一致しているので 表示だけと見ている・未確認)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { restAll } from "./_rest.mjs";
import { num } from "./_soukatsu-items.mjs";
import type { OvertimeSetting } from "../src/lib/payroll/payroll-calc.js";
import { verificationItems } from "../src/lib/payroll/verification-items.js";

const UPDATE = process.argv.includes("--update");
const DETAIL = process.argv.includes("--detail");
const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), "check-overtime-excess-kubun-baseline.json");
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");

type M = Record<string, unknown> & { employee_number: string; employee_name?: string; role_type?: string };
type Calc = { office_number: string; processing_month: string; payload: { monthly?: M[]; overtime_settings?: unknown[] } | null };
type R2 = { office_number: string; employee_number: string; processing_month: string; sheet_kind: string; row_data: Record<string, unknown> };
export type Pm = { key: string; name: string; listed: boolean; kubun: 1 | 3 | null; diff: number; paid: number; ours: number; oursMinusL2: number; type: string };

export function kubunOf(d2: Record<string, unknown>): { kubun: 1 | 3 | null; diff: number; paid: number } {
  const fixed = num(d2["固定残業代"]);
  const diff = num(d2["残業代"]) - fixed;
  const raw = d2["残業総額"] != null && d2["残業総額"] !== "" ? d2["残業総額"] : d2["残業総額2"];
  const paid = num(raw);
  if (!fixed || diff === 0) return { kubun: null, diff, paid };
  if (Math.abs(paid - diff) <= 1) return { kubun: 1, diff, paid };
  if (paid === 0) return { kubun: 3, diff, paid };
  return { kubun: null, diff, paid };
}

export function typeOf(listed: boolean, kubun: 1 | 3 | null): string {
  if (kubun == null) return "判定できない";
  if (listed && kubun === 1) return "一致";
  if (!listed && kubun === 3) return "一致";
  return listed ? "★設定あり・②は区分3" : "★設定なし・②は区分1";
}

export function build(calc: Calc[], l2rows: R2[], listed: Set<string>): Pm[] {
  const l2 = new Map<string, Record<string, unknown>>();
  for (const r of l2rows) if (r.sheet_kind !== "part") l2.set(`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, r.row_data);
  const out: Pm[] = [];
  for (const c of calc) {
    const ot = new Map(((c.payload?.overtime_settings ?? []) as OvertimeSetting[]).map((r) => [r.job_type, r]));
    for (const p of c.payload?.monthly ?? []) {
      if (p.role_type !== "提責") continue;
      const person = `${c.office_number}|${nn(p.employee_number)}`;
      const key = `${person}|${c.processing_month}`;
      const d2 = l2.get(key);
      if (!d2 || !num(d2["固定残業代"])) continue;   // 固定残業代がある提責の月だけ (区分の意味があるのはここ)
      const k = kubunOf(d2);
      const it = verificationItems(p, "shaseki", ot, d2).items.find((x) => x.item === "残業総額");
      const ours = it?.ours ?? 0;
      const isListed = listed.has(person);
      out.push({ key, name: String(p.employee_name ?? "").replace(/\s+/g, " "), listed: isListed, ...k, ours, oursMinusL2: ours - Math.max(0, k.paid), type: typeOf(isListed, k.kubun) });
    }
  }
  return out;
}

const countOf = (xs: Pm[]) => { const c: Record<string, number> = {}; for (const x of xs) c[x.type] = (c[x.type] ?? 0) + 1; return c; };

async function main() {
  console.log("=== check:overtime-excess-kubun (提責の 固定残業の超過を払うか・当方の設定 (人単位) / ② (月ごと)) 2026-09-27 新設・読み取り専用 ===");
  console.log("★ check:all には入れていない (意図的)。② の区分の判定は ② だけが材料 (① に区分の列が無い) の診断系");
  console.log("★ この検査が見ていないもの: 残業の分の差 (check:overtime-minutes) / どちらの区分が正しいか (user) / ② のマイナス表示の扱い");
  const path = process.env.SNAPSHOT;
  const snap = path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  if (snap) console.log(`(写し ${path} / 取得 ${snap.fetched_at})`);
  const calc: Calc[] = snap ? snap.calc : await restAll<Calc>("payroll_calc_results?select=id,office_number,processing_month,payload");
  const l2rows: R2[] = snap ? snap.soukatsu : await restAll<R2>("payroll_soukatsu_rows?select=id,office_number,employee_number,processing_month,sheet_kind,row_data");
  const setting = await restAll<{ key: string; value: Record<string, string[]> }>("payroll_app_settings?select=key,value&key=eq.overtime_excess_paid_employees&order=key");
  const v = (setting[0]?.value ?? {}) as Record<string, unknown>;
  const map = (v.employees ?? v) as Record<string, string[]>;
  const listed = new Set(Object.entries(map).flatMap(([o, es]) => (Array.isArray(es) ? es : []).map((e) => `${o}|${nn(e)}`)));
  if (!listed.size) { console.log("★ 設定 overtime_excess_paid_employees が空 (0 件と出さない)"); process.exit(1); }
  const rows = build(calc, l2rows, listed);

  // 負のコントロール
  let negOk = true;
  const negLines: string[] = [];
  {
    const t1 = kubunOf({ 固定残業代: 50000, 残業代: 56000, 残業総額: 6000 });
    const t2 = kubunOf({ 固定残業代: 50000, 残業代: 56000, 残業総額: null, 残業総額2: 0 });
    const t3 = kubunOf({ 固定残業代: 50000, 残業代: 40000, 残業総額2: -10000 });
    const t4 = kubunOf({ 固定残業代: 50000, 残業代: 50000, 残業総額: 0 });
    const c1 = [[t1.kubun === 1, "超過 6,000 を払う → 区分 1"], [t2.kubun === 3, "超過 6,000 に 0 → 区分 3"], [t3.kubun === 1, "下回って −10,000 を表示 → 区分 1"], [t4.kubun === null, "差 0 → 判定できない"],
      [typeOf(true, 3) === "★設定あり・②は区分3", "設定あり × 区分 3 → ★設定あり・②は区分3"], [typeOf(false, 1) === "★設定なし・②は区分1", "設定なし × 区分 1 → ★設定なし・②は区分1"]] as const;
    for (const [ok, label] of c1) { if (!ok) negOk = false; negLines.push(`${label}${ok ? "  OK" : "  ★ NG"}`); }
    const hit = rows.find((r) => r.type === "一致" && r.listed);
    if (!hit) { negOk = false; negLines.push("設定あり・一致 の人月が無く 設定を外すコントロールを作れない  ★ NG"); }
    else {
      const person = hit.key.split("|").slice(0, 2).join("|");
      const rs = build(calc, l2rows, new Set([...listed].filter((x) => x !== person)));
      const moved = rs.filter((r) => r.key.startsWith(person + "|") && r.type === "★設定なし・②は区分1").length;
      const p = moved > 0;
      if (!p) negOk = false;
      negLines.push(`設定から ${person} を外す → ★設定なし・②は区分1 +${moved}${p ? "  OK" : "  ★ NG"}`);
    }
  }
  console.log("\n負のコントロール:");
  for (const l of negLines) console.log("  " + l);

  const listedPm = rows.filter((r) => r.listed);
  const persons = [...new Set(listedPm.map((r) => r.key.split("|").slice(0, 2).join("|")))];
  console.log("\n母数 (★ 定義ごとに出す):");
  console.log(`  設定の提責 ${listed.size} 名 / うち ② に固定残業代がある月がある ${persons.length} 名・${listedPm.length} 人月`);
  console.log(`  固定残業代がある提責の人月 (設定の外も含む) ${rows.length}`);
  const c = countOf(rows);
  for (const [k, n] of Object.entries(c).sort()) {
    const xs = rows.filter((r) => r.type === k);
    const over = xs.filter((r) => r.diff > 0).reduce((s, r) => s + r.oursMinusL2, 0);
    console.log(`  ${k.padEnd(20)} ${String(n).padStart(4)}  うち ② の差 > 0 の月 ${xs.filter((r) => r.diff > 0).length}  当方 − ② (差 > 0 の月) ¥${over.toLocaleString()}`);
  }
  console.log("\n設定の提責 × 月 (② の差 / ② の払 / 区分 / 当方の残業総額):");
  for (const p of persons) {
    const xs = listedPm.filter((r) => r.key.startsWith(p + "|")).sort((a, b) => a.key.localeCompare(b.key));
    console.log(`  ${p} ${xs[0].name}  ` + xs.map((r) => `${r.key.slice(-2)}:${r.diff}/${r.paid}/${r.kubun ?? "?"}${r.type.startsWith("★") ? "★" : ""}/当${r.ours}`).join("  "));
  }
  if (DETAIL) {
    console.log("\n--- ★ の人月");
    for (const r of rows.filter((r) => r.type.startsWith("★"))) console.log(`  ${r.type} ${r.key} ${r.name} ② 差 ${r.diff} 払 ${r.paid} / 当方 ${r.ours} (当方 − ② ${r.oursMinusL2})`);
  }

  const counts = countOf(rows);
  let failed = false;
  if (existsSync(BASELINE_PATH) && !UPDATE) {
    const b = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    console.log("\n--- 基準値との比較");
    const worse = Object.keys(counts).filter((k) => k.startsWith("★") && (counts[k] ?? 0) > (b.counts[k] ?? 0)).map((k) => `${k} ${b.counts[k] ?? 0}→${counts[k]}`);
    console.log(`  ★ 悪化 ${worse.length}`);
    for (const w of worse) console.log(`  ★ 悪化 ${w}`);
    failed = worse.length > 0;
  } else if (!UPDATE) console.log("\n基準値ファイルがありません。--update で作成してください");
  if (UPDATE) {
    const prev = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
    writeFileSync(BASELINE_PATH, JSON.stringify({ _readme: prev._readme ?? "(新規)", updated_at: new Date().toISOString(), counts }, null, 2) + "\n");
    console.log(`\n基準値を更新しました: ${BASELINE_PATH}`);
  }
  if (!negOk) { console.log("★ 負のコントロールが通らないので PASS を出しません"); process.exit(1); }
  if (failed) { console.log("★ FAIL: ★ の件数が増えました。--detail で見てください"); process.exit(1); }
  console.log("PASS (★ 0 件 PASS ではない。基準値の件数を許容したうえでの PASS)");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e); process.exit(1); });
