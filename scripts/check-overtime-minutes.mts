/**
 * check:overtime-minutes — 月給者の残業の「分」を 当方 / ② / ① の 3 つで突き合わせる (入口側)
 * (2026-09-27 給与C 新設・読み取り専用)。
 *
 *   SOUKATSU1_DIR=<① の抽出物のある dir> npm run check:overtime-minutes
 *   ... SNAPSHOT=<{calc, soukatsu} の json>   # DB を読まず 保存済みを使う
 *   ... -- --detail=<型>   /   -- --update   (★ 悪化したまま更新しない)
 *
 * 【給与D の検査との関係 (★ 統合しない・2026-09-27 指示役の裁定)】
 *   給与D (出口側)  残業総額 (円) の不一致 89 / うち原因が分の違い 69 = 「直すと金額が動く」一覧
 *   この検査 (入口側) 分そのものが違う人月 (397) = 「入力が合っているか」一覧
 *   69 ⊂ 397。差は 金額に出ていない (提責の超過抑制・固定残業代・控除で吸収) だけで、★ 規則が変わると一斉に金額に出る。
 *   → 各行に「★ 総支給に効くか」(verificationItems の 残業総額 が ② と違うか) を付けて 2 つの検査が同じ世界を指すようにする。
 *
 * 【比べるもの】
 *   当方 = payload の overtime_minutes_override (手入力) があればそれ、無ければ summary.overtimeMinutes (computeOvertimePay と同じ)
 *   ②   = 提責_社員 シートの「残業」(分)
 *   ①   = 旧システム出力の「残業時間合計」(h:mm)
 *   出どころ = 手入力 / 旧日計 (legacy_used に 残業時間) / 推定 (estimated_used = 出勤簿なし) / 出勤簿
 *   役職・月給か は その月の計算 (payload.monthly の role_type)。★ 職員マスタの今の値では分けない
 *
 * 【型】一致 / ★当方だけ違う (① = ②) / ②だけ違う (当方 = ①) / ①だけ違う (当方 = ②) / 3つとも違う / ①無し・②と違う
 *   ★ 提責は 別掲 (「提責:意味が違う」)。当方は 法定外 (日8h・週40h 超) を数え、①② の「残業」は 所定超の全量に近いものを
 *     数えている規模の差 (浦邉 当方 27 分 / ①② 2,077 分)。★ 差ではなく別のものを数えている。★ 当方を寄せない (法定外は労基法どおり)。
 *     ★ 提責は超過を払わないので 総支給には出ていない。混ぜると 239 件が分母を支配して 事務員・社員の型が見えなくなる
 *
 * ── この検査が見ていないもの ─────────────────────────────────────────────
 *   ・割増の種類 (深夜 1.5 / 法定休日 1.35 / 深夜 0.25)。当方は全部 1.25 (user 判断待ち・着手しない)
 *   ・時給者の残業 / 残業の金額そのもの (給与D の出口側の検査)
 *   ・どれが正しいか (事務員の出勤時間は「時刻を正」が user 判断済み)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { restAll } from "./_rest.mjs";
import { num } from "./_soukatsu-items.mjs";
import type { OvertimeSetting } from "../src/lib/payroll/payroll-calc.js";
import { verificationItems } from "../src/lib/payroll/verification-items.js";

const UPDATE = process.argv.includes("--update");
const DETAIL = process.argv.find((a) => a.startsWith("--detail="))?.split("=")[1];
const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), "check-overtime-minutes-baseline.json");
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");
const hm = (v: unknown): number | null => {
  const t = String(v ?? "").trim();
  if (!t) return null;
  if (t.includes(":")) { const [h, m] = t.split(":"); return (Number(h) || 0) * 60 + (Number(m) || 0); }
  const f = parseFloat(t);
  return isNaN(f) ? null : Math.round(f * 60);
};

type M = Record<string, unknown> & { employee_number: string; employee_name?: string; role_type?: string; overtime_minutes_override?: number; summary?: { overtimeMinutes?: number }; legacy_used?: string[]; estimated_used?: string[] };
type Calc = { office_number: string; processing_month: string; payload: { monthly?: M[]; overtime_settings?: unknown[] } | null };
type R2 = { office_number: string; employee_number: string; processing_month: string; sheet_kind: string; row_data: Record<string, unknown> };
export type Row = { key: string; name: string; role: string; src: string; ours: number; l2: number; l1: number | null; money: boolean; type: string };

export function classify(ours: number, l2: number, l1: number | null, role: string): string | null {
  if (!ours && !l2 && !l1) return null;
  let t: string;
  if (ours === l2 && (l1 == null || l1 === ours)) t = "一致";
  else if (l1 == null) t = ours === l2 ? "一致" : "①無し・②と違う";
  else if (ours === l1 && ours !== l2) t = "②だけ違う";
  else if (ours === l2) t = "①だけ違う";
  else if (l1 === l2) t = "★当方だけ違う";
  else t = "3つとも違う";
  if (t !== "一致" && role === "提責") return "提責:意味が違う (別掲)";
  return t;
}

export function build(calc: Calc[], l2rows: R2[], l1: Map<string, Record<string, unknown>>): Row[] {
  const l2 = new Map<string, Record<string, unknown>>();
  for (const r of l2rows) if (r.sheet_kind !== "part") l2.set(`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, r.row_data);
  const out: Row[] = [];
  for (const c of calc) {
    const ot = new Map(((c.payload?.overtime_settings ?? []) as OvertimeSetting[]).map((r) => [r.job_type, r]));
    for (const p of c.payload?.monthly ?? []) {
      const key = `${c.office_number}|${nn(p.employee_number)}|${c.processing_month}`;
      const d2 = l2.get(key);
      if (!d2) continue;
      const manual = (p.overtime_minutes_override ?? 0) > 0;
      const ours = manual ? p.overtime_minutes_override! : (p.summary?.overtimeMinutes ?? 0);
      const l2m = num(d2["残業"]);
      const d1 = l1.get(key);
      const l1m = d1 ? hm(d1["残業時間合計"]) : null;
      const role = String(p.role_type ?? "");
      const type = classify(ours, l2m, l1m, role);
      if (!type) continue;
      const src = manual ? "手入力" : (p.legacy_used ?? []).includes("残業時間") ? "旧日計" : (p.estimated_used ?? []).length ? "推定" : "出勤簿";
      const it = verificationItems(p, "shaseki", ot, d2).items.find((x) => x.item === "残業総額");
      out.push({ key, name: String(p.employee_name ?? "").replace(/\s+/g, " "), role, src, ours, l2: l2m, l1: l1m, money: !!it && Math.abs(it.ours - it.soukatsu) > 1, type });
    }
  }
  return out;
}

const countOf = (rs: Row[], f: (r: Row) => string) => { const c: Record<string, number> = {}; for (const r of rs) { const k = f(r); c[k] = (c[k] ?? 0) + 1; } return c; };

function negativeControl(calc: Calc[], l2rows: R2[], l1: Map<string, Record<string, unknown>>, base: Row[]) {
  const lines: string[] = [];
  let ok = true;
  const c0 = countOf(base, (r) => r.type);
  const hit = base.find((r) => r.type === "一致" && r.role !== "提責" && r.ours > 0 && r.l1 != null);
  const hitT = base.find((r) => r.type === "一致" && r.role === "提責" && r.ours > 0);
  if (!hit || !hitT) return { ok: false, lines: ["一致している 提責以外 / 提責 の人月が無く 作れない  ★ NG"] };
  const setL2 = (k: string, v: number) => l2rows.map((r) => (r.sheet_kind !== "part" && `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}` === k ? { ...r, row_data: { ...r.row_data, 残業: v } } : r));
  const setL1 = (k: string, v: string) => new Map([...l1].map(([kk, d]) => [kk, kk === k ? { ...d, 残業時間合計: v } : d]));
  const setOurs = (k: string, v: number) => calc.map((c) => ({ ...c, payload: c.payload && { ...c.payload, monthly: (c.payload.monthly ?? []).map((p) =>
    `${c.office_number}|${nn(p.employee_number)}|${c.processing_month}` === k ? { ...p, overtime_minutes_override: undefined, summary: { ...(p.summary ?? {}), overtimeMinutes: v } } : p) } }));
  const hmOf = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
  const cases: [string, Row[], string][] = [
    ["当方の分を +60 (① ② はそのまま)", build(setOurs(hit.key, hit.ours + 60), l2rows, l1), "★当方だけ違う"],
    ["② の分を +60", build(calc, setL2(hit.key, hit.l2 + 60), l1), "②だけ違う"],
    ["① の分を +60", build(calc, l2rows, setL1(hit.key, hmOf((hit.l1 ?? 0) + 60))), "①だけ違う"],
    ["提責の 当方の分を +60 → 別掲に入る", build(setOurs(hitT.key, hitT.ours + 60), l2rows, l1), "提責:意味が違う (別掲)"],
  ];
  for (const [label, rs, want] of cases) {
    const c = countOf(rs, (r) => r.type);
    const got = (c[want] ?? 0) - (c0[want] ?? 0);
    const p = got === 1;
    if (!p) ok = false;
    lines.push(`${label} → ${want} +${got}${p ? "  OK" : "  ★ NG (期待 +1)"}`);
  }
  return { ok, lines };
}

async function main() {
  console.log("=== check:overtime-minutes (月給者の残業の分 当方 / ② / ①・入口側) 2026-09-27 新設・読み取り専用 ===");
  console.log("★ check:all には入れていない (意図的)。金額に効くかは列で示すが 合否は分の件数で見る診断系");
  console.log("★ この検査が見ていないもの: 割増の種類 (深夜・法定休日。user 判断待ち) / 時給者 / 残業の金額そのもの (給与D の出口側) / どれが正しいか");
  const dir = process.env.SOUKATSU1_DIR;
  if (!dir) { console.log("★ SOUKATSU1_DIR=<① の抽出物のある dir> が要る"); process.exit(1); }
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
  const rows = build(calc, l2rows, l1);
  const monthly = calc.reduce((s, c) => s + (c.payload?.monthly?.length ?? 0), 0);
  if (!monthly) { console.log("★ 月給者の人月が 0 件 (0 件と出さない)"); process.exit(1); }

  const neg = negativeControl(calc, l2rows, l1, rows);
  console.log("\n負のコントロール (読み込んだ写しを壊す。DB もファイルも触らない):");
  for (const l of neg.lines) console.log("  " + l);

  const mis = rows.filter((r) => r.ours !== r.l2);
  console.log("\n母数 (★ 定義ごとに出す):");
  console.log(`  月給者の人月 ${monthly} / ② 行あり ${l2rows.filter((r) => r.sheet_kind !== "part").length} 行 / 当方・②・① のどれかに残業がある ${rows.length}`);
  console.log(`  ★ 当方と ② で分が違う ${mis.length} (当方が短い ${mis.filter((r) => r.ours < r.l2).length} / 長い ${mis.filter((r) => r.ours > r.l2).length})  うち ★ 総支給に効く (残業総額が ② と違う) ${mis.filter((r) => r.money).length}`);
  console.log("\n型 × 役職 (その月の計算) × 出どころ   件数 (うち総支給に効く):");
  const g = countOf(rows.filter((r) => r.type !== "一致"), (r) => `${r.type} | ${r.role} | ${r.src}`);
  const gm = countOf(rows.filter((r) => r.type !== "一致" && r.money), (r) => `${r.type} | ${r.role} | ${r.src}`);
  for (const k of Object.keys(g).sort()) console.log(`  ${k.padEnd(34)} ${String(g[k]).padStart(4)} (${gm[k] ?? 0})`);
  const types = countOf(rows, (r) => r.type);
  console.log("型の合計:"); for (const [k, v] of Object.entries(types).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(22)} ${String(v).padStart(4)}  うち総支給に効く ${rows.filter((r) => r.type === k && r.money).length}`);
  if (DETAIL) {
    console.log(`\n--- ${DETAIL}`);
    for (const r of rows.filter((r) => r.type === DETAIL)) console.log(`  ${r.key} ${r.name} ${r.role} ${r.src} 当方 ${r.ours} / ② ${r.l2} / ① ${r.l1 ?? "-"}${r.money ? "  ★総支給に効く" : ""}`);
  }

  const counts = { types, money: countOf(rows.filter((r) => r.money), (r) => r.type) };
  let failed = false;
  if (existsSync(BASELINE_PATH) && !UPDATE) {
    const b = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    console.log("\n--- 基準値との比較");
    const worse: string[] = [];
    for (const k of new Set([...Object.keys(b.counts.types), ...Object.keys(types)])) {
      if (k === "一致") continue;
      if ((types[k] ?? 0) > (b.counts.types[k] ?? 0)) worse.push(`${k} ${b.counts.types[k] ?? 0}→${types[k]}`);
      if ((counts.money[k] ?? 0) > (b.counts.money[k] ?? 0)) worse.push(`${k} の総支給に効く ${b.counts.money[k] ?? 0}→${counts.money[k]}`);
    }
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
  if (failed) { console.log("★ FAIL: 一致以外の型 か その総支給に効く件数 が増えました。--detail=<型> で見てください"); process.exit(1); }
  console.log("PASS (★ 0 件 PASS ではない。基準値の件数を許容したうえでの PASS)");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e); process.exit(1); });
