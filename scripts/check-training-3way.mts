/**
 * check:training-3way — パートの 研修・HRD研修・会議 の手当を 当方 / ② / ① の 3 つで突き合わせ、ずれを型に分ける (2026-09-27 給与C)。★ 基準値方式。
 *
 *   SOUKATSU1_DIR=<① の抽出物> npm run check:training-3way
 *   SOUKATSU1_DIR=<dir> npm run check:training-3way -- --update
 *   SOUKATSU1_DIR=<dir> npm run check:training-3way -- --detail=当方だけ:分がずれる
 *   SNAPSHOT=<path.json>   ②・計算結果を DB から読まず保存済みを使う (check:soukatsu-cause と同じ形式)
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 * 袖ケ浦 1273400844 202603 の 4 人月が「当方 863 / ② 1,150」で 0.75 掛けに見えたが、実際は 研修の時間 (当方 45 分 / ② 60 分) の差だった
 * (指示役 2026-09-27)。事業所書式の研修時間が 全体的に ② とずれているのか、この 4 人月だけかを 全数で見る。
 * ★ 「書式が正」「② が正」を決めつけないため ① も並べる (ちはら台の出張km で「書式が正」と思い込みかけた前例)。
 *
 * ── 何を比べるか ─────────────────────────────────────────────────────────
 *   金額 (円) で比べる。項目の対応は scripts/_soukatsu-items.mts の「研修会議」:
 *     当方 = training_pay − shoninsha_pay + meeting_fee / ① = その他手当計 / ② = その他手当 (無ければ HRD研修 + 研修)
 *   ⚠ 分で比べない: ② の「内研修時間」は 事業所によって 会議の時間を含み (111 人月で 差 = ① の会議時間)、
 *     東郷では 0 のまま (② HRD研修 の円は入っている) で、分の列として当てにならない (2026-09-27 実測)。
 *   ⚠ ② の「研修」列には 事業所によって会議費が入る → 研修・HRD・会議を合計で比べる (給与D の check:no-source-data と同じ)。
 *
 * ── 型 (1 人月 1 つ) ─────────────────────────────────────────────────────
 *   一致                     当方 = ② = ①
 *   片側に行が無い            ① か ② に その人月の行が無い
 *   ②だけ違う               当方 = ① ≠ ②。② の手入力 → 直さない
 *   ①だけ違う               当方 = ② ≠ ①
 *   当方だけ:書式に行が無い   ② = ① で 当方 0 (書式にも手入力にも研修が無い)
 *   当方だけ:当方にだけある   ② = ① = 0 で 当方にだけ額がある (初任者研修を 研修として持っている 等)
 *   当方だけ:会議あり         ② = ① で 会議がある月 (会議は 件数単価 + 時給で 分に直せない)
 *   当方だけ:分がずれる       ② = ① で 差を 1,150 円/時で分に直すと 15 分の倍数 (書式の研修時間が ① ② と違う)
 *   当方だけ:その他           上のどれでもない
 *   3つとも違う
 *
 * ── この検査が見ていないもの ─────────────────────────────────────────────
 *   ・初任者研修 (別の項目。check:soukatsu-cause の PZ / 初任者研修調整は check:shoninsha-adjustment)
 *   ・月給者 (事業所書式の研修は 時給者の手当)
 *   ・どちらが正しいか。型は「どこがずれているか」の分類で、書式・② のどちらを直すかは人が決める
 *   ・当方の値は その時の payroll_calc_results。手入力のあと再計算していない月は 古い値で数える
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { restAll, empKey } from "./_rest.mjs";
import { hourlyItems, l1HourlyItems, num } from "./_soukatsu-items.mjs";
import { TRAINING_RATE_PER_HOUR, type HourlyPayroll } from "../src/lib/payroll/payroll-calc.js";

const UPDATE = process.argv.includes("--update");
const DETAIL = process.argv.find((a) => a.startsWith("--detail="))?.split("=")[1];
const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), "check-training-3way-baseline.json");

export type Tri = { key: string; name: string; ours: number; l2: number | null; l1: number | null; meeting: boolean };
const eq = (a: number | null, b: number | null) => a != null && b != null && Math.abs(a - b) <= 1;

export function classifyTri(t: Tri): string | null {
  const { ours: o, l2, l1 } = t;
  if (!o && !l2 && !l1) return null;
  if (eq(o, l2) && (l1 == null || eq(l2, l1))) return "一致";
  if (l2 == null || l1 == null) return "片側に行が無い";
  if (eq(l2, l1)) {
    if (o === 0) return "当方だけ:書式に行が無い";
    if (l2 === 0) return "当方だけ:当方にだけある";
    if (t.meeting) return "当方だけ:会議あり";
    const mins = ((o - l2) / TRAINING_RATE_PER_HOUR) * 60;
    if (Math.abs(mins - Math.round(mins)) < 0.05 && Math.round(mins) % 15 === 0) return "当方だけ:分がずれる";
    return "当方だけ:その他";
  }
  if (eq(o, l1)) return "②だけ違う";
  if (eq(o, l2)) return "①だけ違う";
  return "3つとも違う";
}

type Calc = { office_number: string; processing_month: string; payload: { hourly?: (HourlyPayroll & { employee_number: string; employee_name?: string })[] } | null };
type R2 = { office_number: string; employee_number: string; processing_month: string; sheet_kind: string; row_data: Record<string, unknown> };

export function buildTris(calc: Calc[], l2rows: R2[], l1: Map<string, Record<string, unknown>>): Tri[] {
  const l2 = new Map<string, Record<string, unknown>>();
  for (const r of l2rows) if (r.sheet_kind === "part") l2.set(`${empKey(r.office_number, r.employee_number)}|${r.processing_month}`, r.row_data);
  const out: Tri[] = [];
  for (const c of calc) for (const e of c.payload?.hourly ?? []) {
    const k = `${empKey(c.office_number, e.employee_number)}|${c.processing_month}`;
    const d2 = l2.get(k), d1 = l1.get(k);
    out.push({
      key: k, name: String(e.employee_name ?? "").replace(/\s+/g, " "),
      ours: hourlyItems([e])["研修会議"] ?? 0,
      l2: d2 ? (num(d2["その他手当"]) || num(d2["HRD研修"]) + num(d2["研修"])) : null,
      l1: d1 ? l1HourlyItems(d1)["研修会議"] : null,
      meeting: (e.meeting_fee ?? 0) > 0 || (!!d1 && num(d1["会議費"]) > 0) || (!!d2 && num(d2["会議費"]) > 0),
    });
  }
  return out;
}

const countOf = (tris: Tri[]) => { const c: Record<string, number> = {}; for (const t of tris) { const k = classifyTri(t); if (k) c[k] = (c[k] ?? 0) + 1; } return c; };

function negativeControl(tris: Tri[]) {
  const lines: string[] = [];
  const base = tris.find((t) => classifyTri(t) === "一致" && t.ours > 0 && !t.meeting);
  if (!base) return { ok: false, lines: ["一致している人月が無く 負のコントロールを作れない"] };
  const cases: [string, Tri, string][] = [
    ["当方の研修を 15 分減らす", { ...base, ours: base.ours - Math.round(TRAINING_RATE_PER_HOUR / 4) }, "当方だけ:分がずれる"],
    ["当方を 0 にする", { ...base, ours: 0 }, "当方だけ:書式に行が無い"],
    ["② だけ +500", { ...base, l2: (base.l2 ?? 0) + 500 }, "②だけ違う"],
    ["① だけ +500", { ...base, l1: (base.l1 ?? 0) + 500 }, "①だけ違う"],
    ["① の行を消す", { ...base, l1: null, ours: base.ours + 100 }, "片側に行が無い"],
    ["当方だけ +37 (分に直せない)", { ...base, ours: base.ours + 37 }, "当方だけ:その他"],
  ];
  let ok = true;
  for (const [label, t, want] of cases) { const got = classifyTri(t); if (got !== want) ok = false; lines.push(`${label} → ${got}${got === want ? "  OK" : `  ★ NG (期待 ${want})`}`); }
  const worse = (countOf([...tris, { ...base, key: "neg", ours: 0 }])["当方だけ:書式に行が無い"] ?? 0) > (countOf(tris)["当方だけ:書式に行が無い"] ?? 0);
  if (!worse) ok = false;
  lines.push(`1 人月足すと 件数が増える: ${worse ? "OK" : "★ NG"}`);
  return { ok, lines };
}

/**
 * 入力を壊して buildTris から通す負のコントロール (2026-09-27 追加)。
 * 上の negativeControl は型の分け方だけを見る。こちらは「突き合わせのキー」と「項目の取り違え」が 件数に出るかを見る。
 *   (a) ② の 1 行の職員番号を壊す → 当方と ② が結び付かず「片側に行が無い」が増える
 *   (b) 当方の初任者研修を研修として持たせる (shoninsha_pay を 0 に。training_pay はそのまま)
 *       → ① ② に研修が無い人月は「当方にだけある」が増える (今井・杉尾・江波戸 と同じ壊れ方)
 */
function negativeControlInputs(calc: Calc[], l2rows: R2[], l1: Map<string, Record<string, unknown>>, tris: Tri[]) {
  const lines: string[] = [];
  let ok = true;
  const c0 = countOf(tris);
  const base = tris.find((t) => classifyTri(t) === "一致" && t.ours > 0 && t.l2 != null);
  const idx = base ? l2rows.findIndex((r) => r.sheet_kind === "part" && `${empKey(r.office_number, r.employee_number)}|${r.processing_month}` === base.key) : -1;
  if (idx < 0) { ok = false; lines.push("(a) 一致していて ② に行がある人月が無く 作れない  ★ NG"); }
  else {
    const broken = l2rows.map((r, i) => (i === idx ? { ...r, employee_number: "999999999" } : r));
    const c = countOf(buildTris(calc, broken, l1));
    const up = (c["片側に行が無い"] ?? 0) > (c0["片側に行が無い"] ?? 0) && (c["一致"] ?? 0) < (c0["一致"] ?? 0);
    if (!up) ok = false;
    lines.push(`(a) ② の職員番号を 1 行壊す (${base!.key}) → 片側に行が無い ${c0["片側に行が無い"] ?? 0}→${c["片側に行が無い"] ?? 0}${up ? "  OK" : "  ★ NG"}`);
  }
  let hit: { ci: number; ei: number; key: string } | null = null;
  for (let ci = 0; ci < calc.length && !hit; ci++) {
    const es = calc[ci].payload?.hourly ?? [];
    for (let ei = 0; ei < es.length; ei++) {
      const e = es[ei];
      if (!((e.shoninsha_pay ?? 0) > 0)) continue;
      const key = `${empKey(calc[ci].office_number, e.employee_number)}|${calc[ci].processing_month}`;
      const t = tris.find((x) => x.key === key);
      if (t && t.ours === 0 && t.l2 === 0 && t.l1 === 0 && !t.meeting) { hit = { ci, ei, key }; break; }
    }
  }
  if (!hit) { ok = false; lines.push("(b) 初任者研修があり 研修が 3 つとも 0 の人月が無く 作れない  ★ NG"); }
  else {
    const broken = calc.map((c, ci) => ci !== hit!.ci ? c : {
      ...c, payload: { ...c.payload, hourly: (c.payload?.hourly ?? []).map((e, ei) => (ei === hit!.ei ? { ...e, shoninsha_pay: 0 } : e)) },
    });
    const c = countOf(buildTris(broken, l2rows, l1));
    const k = "当方だけ:当方にだけある";
    const up = (c[k] ?? 0) === (c0[k] ?? 0) + 1;
    if (!up) ok = false;
    lines.push(`(b) 初任者研修を研修として持たせる (${hit.key}) → 当方にだけある ${c0[k] ?? 0}→${c[k] ?? 0}${up ? "  OK" : "  ★ NG"}`);
  }
  return { ok, lines };
}

async function main() {
  console.log("=== check:training-3way (パートの 研修・HRD研修・会議 を 当方 / ② / ① で) 2026-09-27 新設・読み取り専用 ===");
  console.log("★ check:all には入れていない (意図的)。② の手入力・① の抽出物の更新で件数が動く診断系");
  console.log("★ 比べているもの: 当方 = payroll_calc_results / ② = 支払用シート (payroll_soukatsu_rows) / ① = 旧システムの出力 (xlsm の抽出物)。円で比べる");
  console.log("★ この検査が見ていないもの: 初任者研修 / 月給者 / どちらが正しいか (型はずれている場所の分類) / 再計算していない月の手入力");
  const dir = process.env.SOUKATSU1_DIR;
  if (!dir) { console.log("★ SOUKATSU1_DIR=<① の抽出物 soukatsu_extract_YYYYMM.json のある dir> が要る (3 つで見るため)"); process.exit(1); }
  const files = readdirSync(dir).filter((f) => /^soukatsu_extract_\d{6}\.json$/.test(f)).sort();
  if (!files.length) { console.log(`★ ${dir} に soukatsu_extract_YYYYMM.json が 1 本もない (0 件と出さない)`); process.exit(1); }
  const l1 = new Map<string, Record<string, unknown>>();
  for (const f of files) {
    const ym = /_(\d{6})\.json$/.exec(f)![1];
    for (const r of JSON.parse(readFileSync(join(dir, f), "utf8")) as R2[]) {
      if (r.sheet_kind !== "part") continue;
      const k = `${empKey(r.office_number, r.employee_number)}|${ym}`;
      if (!l1.has(k)) l1.set(k, r.row_data);   // ① の写しの重複行は 先に出たほうを使う (給与D の検査と同じ)
    }
  }
  const path = process.env.SNAPSHOT;
  const snap = path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  const calc: Calc[] = snap ? snap.calc : await restAll<Calc>("payroll_calc_results?select=id,office_number,processing_month,payload");
  const l2rows: R2[] = snap ? snap.soukatsu : await restAll<R2>("payroll_soukatsu_rows?select=id,office_number,employee_number,processing_month,sheet_kind,row_data&sheet_kind=eq.part");
  const tris = buildTris(calc, l2rows, l1);

  const neg0 = negativeControl(tris);
  const negIn = negativeControlInputs(calc, l2rows, l1, tris);
  const neg = { ok: neg0.ok && negIn.ok };
  console.log("\n負のコントロール (写しを壊す。DB もファイルも触らない):");
  for (const l of neg0.lines) console.log("  " + l);
  console.log("  -- 入力を壊して突き合わせから通す --");
  for (const l of negIn.lines) console.log("  " + l);

  const counts = countOf(tris);
  const n = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`\n母数: 時給者の人月 ${tris.length} のうち 当方・②・① のどれかに 研修・HRD・会議 の額がある ${n} 人月 (① 抽出物 ${files.length} 本)`);
  for (const [k, c] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    const ts = tris.filter((t) => classifyTri(t) === k);
    const yen = ts.reduce((s, t) => s + (t.l2 != null ? t.ours - t.l2 : 0), 0);
    console.log(`  ${k.padEnd(18)} ${String(c).padStart(5)}  当方 − ② ${Math.round(yen).toLocaleString()}円`);
  }
  if (DETAIL) {
    console.log(`\n--- ${DETAIL} ---`);
    for (const t of tris.filter((t) => classifyTri(t) === DETAIL)) console.log(`  ${t.key} ${t.name} 当方 ${t.ours} / ② ${t.l2} / ① ${t.l1}${t.meeting ? " (会議あり)" : ""}`);
  }

  let failed = false;
  if (existsSync(BASELINE_PATH) && !UPDATE) {
    const base = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    console.log("\n--- 基準値との比較 ---");
    if (base.pairs !== tris.length) console.log(`  データが変わった (時給者の人月 ${base.pairs}→${tris.length})。FAIL にしない。中身を見てから --update`);
    else {
      const keys = new Set([...Object.keys(base.counts), ...Object.keys(counts)]);
      const worse = [...keys].filter((k) => k !== "一致" && (counts[k] ?? 0) > (base.counts[k] ?? 0));
      const better = [...keys].filter((k) => k !== "一致" && (counts[k] ?? 0) < (base.counts[k] ?? 0));
      console.log(`  ★ 悪化 ${worse.length} / 改善 ${better.length}`);
      for (const k of worse) console.log(`  ★ 悪化 ${k} ${base.counts[k] ?? 0}→${counts[k]}`);
      for (const k of better) console.log(`  改善   ${k} ${base.counts[k]}→${counts[k] ?? 0}`);
      failed = worse.length > 0;
    }
  } else if (!UPDATE) console.log("\n基準値ファイルがありません。--update で作成してください");
  if (UPDATE) {
    const prev = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
    writeFileSync(BASELINE_PATH, JSON.stringify({ _readme: prev._readme ?? "(新規)", updated_at: new Date().toISOString(), files, pairs: tris.length, counts }, null, 2) + "\n");
    console.log(`\n基準値を更新しました: ${BASELINE_PATH}`);
  }
  if (!neg.ok) { console.log("★ 負のコントロールが通らないので PASS を出しません"); process.exit(1); }
  if (failed) { console.log("★ FAIL: 時給者の人月が同じなのに 一致以外の型が増えました。--detail=<型> で見てください"); process.exit(1); }
  console.log("PASS (★ 0 件 PASS ではない。基準値の件数を許容したうえでの PASS)");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e); process.exit(1); });
