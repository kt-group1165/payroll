/**
 * check:travel-legacy-gap — 時給者の移動手当を 当方 / 旧日計 / 総括表 ① / ② で突き合わせ、型に分ける (2026-09-27 給与D)。★ 基準値方式
 *
 *   npm run check:travel-legacy-gap
 *   L1_DIR=<① の抽出> CALC_SNAPSHOT=<json> L2_SNAPSHOT=<json> LEGACY_SNAPSHOT=<json> npm run check:travel-legacy-gap
 *       再読込をせずに使い回す (無ければ取得して保存する。L1_DIR だけは必須)
 *   npm run check:travel-legacy-gap -- --update       ★ 基準値を更新 (先に中身を見ること)
 *   npm run check:travel-legacy-gap -- --detail=旧側   その型の人月を一覧で出す
 *
 * ── 型 (1 人月は 1 つだけ。上から順に判定。「一致」は ±1 円) ─────────────────────
 *   当方=①          当方の移動手当 = ① の移動手当
 *   旧日計なし       旧日計 (payroll_legacy_travel_daily) にその人月の行が無い → 当方は Google の推定
 *   旧は月給         旧日計の給与形態が月給 (旧は移動手当を付けない)
 *   ★ 当方≠旧日計    旧日計があるのに 当方 ≠ 旧日計の「移動手当」列の合計 → ★ 当方の取込か計算の誤り。★ 本物のバグ候補
 *   旧側の食い違い   当方 = 旧日計の列の合計 かつ ① ≠ 旧日計 → 旧システムの中で 日計と ① が食い違っている
 *                  さらに ① = ② / ① ≠ ② で分けて出す
 *   ★ 「追わない箱」ではない。条件 (当方 = 旧日計 かつ ① ≠ 旧日計) が崩れた人月は 自動で他の型に移る
 *
 * ── 旧側の食い違い について (2026-09-27 実測。_readme にも同じ数字) ───────────
 *   ★ 移行期にしか無い。移行後は 日計が無くなり 当方が自分の実績から移動を出すので この食い違いは消える。
 *   ★ いま ① に合わせ込むと 移行後に逆にずれる (TJ 時刻補正・KM_DEDUPE_FROM と同じ「足場を追わない」判断)。
 *   ★ ただし「当方が正しい」でもない。① = ② の人月は ① が実際に払った額で、当方の多くは ① より多い (本稼働なら過払いの向き)。
 *   → 一致率の床 (当方が直せない分) として数える。
 * 否定した仮説 (2026-09-27、負のコントロール付き):
 *   (b) 旧日計に無い日を Google で埋めている → 0 件 (page.tsx: 旧日計がある人は Google を混ぜない)
 *   (a)(c) ① は同行の区間の移動を払わない → 否定。2026-07 の Gmap 区間明細で 196 人月に当てると
 *          「同行区間の分を引く」は いま一致している同行あり 69 人月を 69/69 外し、不一致 25 のうち 2 しか直らない
 *   ★ ただし 同行との相関は強い (同行区間あり 不一致 25/94 = 27% / なし 2/102 = 2%)。規則にならなかっただけで無相関ではない
 * 負のコントロール: 写しを壊して ① +20 円 → 旧側の食い違い +1 / 当方 +20 円 → ★ 当方≠旧日計 +1 になること
 * 見ていないもの: 月給者 / ① に行が無い人月 / 当方に行が無い人月 / 旧日計の日ごとの中身 (合計だけ見る)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { restAll } from "./_rest.mjs";

const UPDATE = process.argv.includes("--update");
const DETAIL = process.argv.find((a) => a.startsWith("--detail="))?.slice(9) ?? "";
const BASELINE = new URL("./check-travel-legacy-gap-baseline.json", import.meta.url);
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");
const num = (v: unknown): number => {
  const x = v && typeof v === "object" && "result" in (v as object) ? (v as { result: unknown }).result : v;
  const n = typeof x === "number" ? x : parseFloat(String(x ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const eq = (a: number, b: number) => Math.abs(a - b) <= 1;

console.log("=== check:travel-legacy-gap (時給者の移動手当 当方 / 旧日計 / ① / ②) ===");

// ── 入力 ──
const L1_DIR = process.env.L1_DIR ?? "";
if (!L1_DIR || !existsSync(L1_DIR)) {
  console.log("★ L1_DIR (① の抽出物。migrations/extract_soukatsu_from_xlsm.mjs の OUT) を渡してください。① が無いと型を分けられない");
  process.exit(1);
}
async function cached<T>(envName: string, path: string): Promise<T[]> {
  const p = process.env[envName] ?? "";
  if (p && existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as T[];
  const rows = await restAll<T>(path);
  if (p) writeFileSync(p, JSON.stringify(rows));
  return rows;
}
type CalcRow = { office_number: string; processing_month: string; calculated_at: string; hourly: { employee_number: string; travel_allowance?: number }[] | null };
type L2Row = { office_number: string; employee_number: string; processing_month: string; sheet_kind: string; row_data: Record<string, unknown> };
type LegRow = { office_number: string; employee_number: string; processing_month: string; pay_type: string | null; travel_allowance: number | null };
const calc = await cached<CalcRow>("CALC_SNAPSHOT", "payroll_calc_results?select=id,office_number,processing_month,calculated_at,hourly:payload->hourly");
const l2rows = await cached<L2Row>("L2_SNAPSHOT", "payroll_soukatsu_rows?select=id,office_number,employee_number,processing_month,sheet_kind,row_data&sheet_kind=eq.part");
const legRows = await cached<LegRow>("LEGACY_SNAPSHOT", "payroll_legacy_travel_daily?select=id,office_number,employee_number,processing_month,pay_type,travel_allowance");

const l1 = new Map<string, number>();
for (const f of readdirSync(L1_DIR).filter((x) => /_(\d{6})\.json$/.test(x))) {
  const m = /_(\d{6})\.json$/.exec(f)![1];
  for (const r of JSON.parse(readFileSync(`${L1_DIR}/${f}`, "utf8")) as { office_number: string; employee_number: string; sheet_kind: string; row_data: Record<string, unknown> }[]) {
    if (r.sheet_kind !== "part") continue;
    const k = `${r.office_number}|${nn(r.employee_number)}|${m}`;
    if (!l1.has(k)) l1.set(k, num(r.row_data["移動手当"]));   // 写しの重複行は先に読んだ行 (check:soukatsu-item-gap と同じ)
  }
}
const l2 = new Map<string, number>();
for (const r of l2rows) if (r.sheet_kind === "part") l2.set(`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, num(r.row_data["移動手当"]));
// 旧日計は page.tsx と同じ集め方 (事業所 × 月 × 職員番号で 移動手当の列を足す。月給の行が 1 つでもあれば 旧は月給)
const leg = new Map<string, { allowance: number; monthly: boolean }>();
for (const r of legRows) {
  const k = `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`;
  const x = leg.get(k) ?? { allowance: 0, monthly: false };
  x.allowance += r.travel_allowance ?? 0;
  if (r.pay_type === "月給") x.monthly = true;
  leg.set(k, x);
}
type P = { key: string; ours: number; l1: number; l2: number | null; leg: { allowance: number; monthly: boolean } | null };
const pairs: P[] = [];
for (const c of calc) for (const e of c.hourly ?? []) {
  const key = `${c.office_number}|${nn(e.employee_number)}|${c.processing_month}`;
  if (!l1.has(key)) continue;
  pairs.push({ key, ours: e.travel_allowance ?? 0, l1: l1.get(key)!, l2: l2.get(key) ?? null, leg: leg.get(key) ?? null });
}
const calcAt = calc.map((c) => c.calculated_at).sort();
console.log(`母数: 当方 (時給) と ① (パート) の両方に居る人月 ${pairs.length} / 給与計算 ${calc.length} 事業所月 (計算 ${calcAt[0]} 〜 ${calcAt.at(-1)}) / 旧日計 ${legRows.length} 行`);

// ── 型 ──
const TYPES = ["当方=①", "旧日計なし", "旧は月給", "★当方≠旧日計", "旧側(①=②)", "旧側(①≠②)"] as const;
type T = (typeof TYPES)[number];
function classify(p: P): T {
  if (eq(p.ours, p.l1)) return "当方=①";
  if (!p.leg) return "旧日計なし";
  if (p.leg.monthly) return "旧は月給";
  if (!eq(p.ours, p.leg.allowance)) return "★当方≠旧日計";
  return p.l2 != null && eq(p.l1, p.l2) ? "旧側(①=②)" : "旧側(①≠②)";
}
const count = (ps: P[]) => { const c = Object.fromEntries(TYPES.map((t) => [t, 0])) as Record<T, number>; for (const p of ps) c[classify(p)]++; return c; };
const counts = count(pairs);
const months = [...new Set(pairs.map((p) => p.key.split("|")[2]))].sort();
console.log("\n--- 型ごとの人月");
for (const t of TYPES) console.log(`  ${t.padEnd(10)} ${String(counts[t]).padStart(5)}`);
console.log("\n--- 月別 (旧側 = 旧側(①=②) + 旧側(①≠②))");
for (const m of months) {
  const c = count(pairs.filter((p) => p.key.endsWith(`|${m}`)));
  console.log(`  ${m}  対 ${String(TYPES.reduce((s, t) => s + c[t], 0)).padStart(4)}  旧側 ${String(c["旧側(①=②)"] + c["旧側(①≠②)"]).padStart(3)}  ★当方≠旧日計 ${c["★当方≠旧日計"]}  旧日計なし ${c["旧日計なし"]}`);
}
const side = pairs.filter((p) => classify(p).startsWith("旧側"));
const over = side.filter((p) => p.ours > p.l1);
console.log(`\n旧側の食い違い ${side.length} 人月: 当方が ① より多い ${over.length} (計 ¥${over.reduce((s, p) => s + p.ours - p.l1, 0).toLocaleString()}) / 少ない ${side.length - over.length} (計 ¥${side.filter((p) => p.ours < p.l1).reduce((s, p) => s + p.l1 - p.ours, 0).toLocaleString()})`);
console.log("  ★ 移行期にしか無い (移行後は日計が無くなる)。★ ① に合わせ込まない");
if (DETAIL) for (const p of pairs.filter((p) => classify(p).includes(DETAIL))) console.log(`  ${classify(p)} ${p.key} 当方 ${p.ours} / 旧日計 ${p.leg?.allowance ?? "-"} / ① ${p.l1} / ② ${p.l2 ?? "-"}`);

// ── 負のコントロール ──
console.log("\n--- 負のコントロール");
{
  const base = pairs.find((p) => classify(p) === "当方=①" && p.leg && !p.leg.monthly && eq(p.ours, p.leg.allowance) && p.l2 != null && eq(p.l1, p.l2));
  if (!base) expect(false, "壊す元 (当方 = ① = 旧日計 = ②) の人月が見つからない");
  else {
    const swap = (q: P) => pairs.map((p) => (p === base ? q : p));
    const a = count(swap({ ...base, l1: base.l1 + 20, l2: base.l2! + 20 }));
    expect(a["旧側(①=②)"] === counts["旧側(①=②)"] + 1, `① と ② を +20 円 → 旧側(①=②) +1 (${counts["旧側(①=②)"]} → ${a["旧側(①=②)"]})`);
    const b = count(swap({ ...base, ours: base.ours + 20 }));
    expect(b["★当方≠旧日計"] === counts["★当方≠旧日計"] + 1, `当方を +20 円 → ★当方≠旧日計 +1 (${counts["★当方≠旧日計"]} → ${b["★当方≠旧日計"]})`);
    const c = count(swap({ ...base, leg: null, ours: base.ours + 20 }));
    expect(c["旧日計なし"] === counts["旧日計なし"] + 1, `旧日計を消して当方 +20 円 → 旧日計なし +1 (旧側に吸い込まれない)`);
  }
}

// ── 基準値 ──
type Baseline = { _readme: string[]; pairs: number; counts: Record<string, number> };
const baseline: Baseline | null = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline : null;
console.log("\n--- 基準値");
if (UPDATE || !baseline) {
  const b: Baseline = { _readme: baseline?._readme ?? [], pairs: pairs.length, counts };
  writeFileSync(BASELINE, JSON.stringify(b, null, 2) + "\n", "utf8");
  console.log("  基準値を保存しました");
} else if (baseline.pairs !== pairs.length) {
  console.log(`  母数が違う (${baseline.pairs} → ${pairs.length}) = データが変わった。FAIL にしない。中身を見てから --update`);
  for (const t of TYPES) console.log(`    ${t} ${baseline.counts[t] ?? 0} → ${counts[t]}`);
} else {
  for (const t of TYPES) {
    if (t === "当方=①") continue;
    const was = baseline.counts[t] ?? 0;
    expect(counts[t] <= was, `${t} ${was} → ${counts[t]}${counts[t] > was ? "  ★ 増えた" : ""}`);
  }
}
console.log("\n見ていないもの: 月給者 / ① か当方の片側にしか居ない人月 / 旧日計の日ごとの中身 (合計だけ) / 同行の相関 (Gmap 区間明細が 202607 しか無い。_readme に数字)");
console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS");
process.exit(fail ? 1 : 0);
