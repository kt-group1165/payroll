/**
 * 給与計算のスナップショット (payroll_calc_results) と 総括表 (payroll_soukatsu_rows) の
 * 総支給額が 人月単位でどれだけ一致しているかを測る (2026-09-26)。★ 基準値方式。
 *
 *   npx tsx scripts/check-soukatsu-match.mts              # 基準値と比べる
 *   npx tsx scripts/check-soukatsu-match.mts --update     # 今の値を基準値として保存
 *   npx tsx scripts/check-soukatsu-match.mts --estimate   # 古い人月の「再計算後の見込み」も出す
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 * check:calc-staleness は「計算結果が古い」を出すだけで、再計算して 良くなったのか
 * 悪くなったのかは分からない。再計算の前に 一致率を基準値として残しておき、
 * 再計算のたびに 事業所×月ごとの増減を見る。
 *
 * ── 判定 ─────────────────────────────────────────────────────────────────
 *   分母 (対の数) が同じで 一致数が減った → ★ 悪化。FAIL (exit 1)
 *   分母が変わった                        → データが変わった (総括表の取込し直し・計算対象の増減)。
 *                                           FAIL にはしない。内容を見て --update する
 *   ⚠ 悪化したまま --update すると 穴を焼き付けることになる。先に原因を見ること。
 *
 * ── この検査が見ていないもの ───────────────────────────────────────────
 *   ・総支給額しか見ていない。項目ごとのずれ (残業は多いが通勤費が少ない等で相殺) は見えない
 *     → 項目ごとの突合は /verification 画面
 *   ・総括表を正としている。総括表自体が誤っている人月 (手入力の上書き・#VALUE! 等) も「不一致」に数える
 *   ・ミロク (実際の支給) とは比べていない。兼務者は総括表の事業所別の行どうしで比べる
 *   ・計算結果が古いかどうかは見ていない (check:calc-staleness を先に回す)
 *   ・税・社保の控除後の金額は見ていない
 *
 * 突合のキーは /verification 画面と同じ: 事業所番号 × 職員番号 (先頭0を落とす) × シート
 *   (時給=part / 月給=shaseki)。⚠ 職員番号は事業所をまたぐと重複するので 必ず事業所と対で引く。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const env: Record<string, string> = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY };
const UPDATE = process.argv.includes("--update");
const ESTIMATE = process.argv.includes("--estimate");
const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), "check-soukatsu-match-baseline.json");

const nn = (s: unknown): string => String(s ?? "").replace(/^0+/, "");
const numOrNull = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
  return Number.isNaN(n) ? null : n;
};
const num = (v: unknown): number => numOrNull(v) ?? 0;

async function getAll<T>(q: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${q}&order=id`, { headers: { ...H, Range: `${from}-${from + 999}` } });
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(`fetch failed for ${q}: ${JSON.stringify(j).slice(0, 300)}`);
    out.push(...(j as T[]));
    if (j.length < 1000) break;
  }
  return out;
}

type Emp = Record<string, unknown> & { employee_number: unknown; employee_name?: unknown; grand_total?: unknown };
type CalcRow = { office_number: string; processing_month: string; calculated_at: string; payload: { hourly?: Emp[]; monthly?: Emp[] } | null };
type SoukatsuRow = { processing_month: string; office_number: string; employee_number: string; employee_name: string; sheet_kind: string; row_data: Record<string, unknown> };
type MonthlyInput = { office_number: string; employee_number: string; processing_month: string; item_key: string; numeric_value: number | null; updated_at: string };

/** 1 人月の突合結果 */
type Pair = {
  office: string; month: string; emp: string; name: string; kind: "part" | "shaseki";
  ours: number; soukatsu: number | null; soukatsuRaw: unknown; calculatedAt: string; employee: Emp;
};

/** 一致の判定。総括表側が数値でない (#VALUE! 等) ものは一致に数えない */
const isExact = (p: { ours: number; soukatsu: number | null }) => p.soukatsu != null && Math.abs(p.ours - p.soukatsu) <= 1;
const isWithin1pct = (p: { ours: number; soukatsu: number | null }) =>
  p.soukatsu != null && (p.soukatsu === 0 ? Math.abs(p.ours) <= 1 : Math.abs(p.ours - p.soukatsu) / Math.abs(p.soukatsu) <= 0.01);

/** 見込みで総括表の 残業単価 を引くための索引 (main で作る) */
const soukatsuCache = new Map<string, Record<string, unknown>>();
const soukatsuRowOf = (p: Pair) => soukatsuCache.get(`${p.office}|${p.month}|${p.emp}|${p.kind}`);

type Cell = { pairs: number; exact: number; within1pct: number; soukatsuNotNumber: number; onlyOurs: number; onlySoukatsu: number };
const emptyCell = (): Cell => ({ pairs: 0, exact: 0, within1pct: 0, soukatsuNotNumber: 0, onlyOurs: 0, onlySoukatsu: 0 });

function buildPairs(calc: CalcRow[], soukatsu: SoukatsuRow[]) {
  const sMap = new Map<string, SoukatsuRow>();
  for (const s of soukatsu) sMap.set(`${s.office_number}|${s.processing_month}|${nn(s.employee_number)}|${s.sheet_kind}`, s);
  const pairs: Pair[] = [];
  const cells = new Map<string, Cell>();
  const cellOf = (k: string) => { if (!cells.has(k)) cells.set(k, emptyCell()); return cells.get(k)!; };
  const seen = new Set<string>();

  for (const c of calc) {
    if (!c.payload) continue;
    const ck = `${c.office_number}|${c.processing_month}`;
    for (const [kind, list] of [["part", c.payload.hourly ?? []], ["shaseki", c.payload.monthly ?? []]] as const) {
      for (const e of list) {
        const emp = nn(e.employee_number);
        const key = `${c.office_number}|${c.processing_month}|${emp}|${kind}`;
        const s = sMap.get(key);
        if (!s) { cellOf(ck).onlyOurs++; continue; }
        seen.add(key);
        const raw = s.row_data["総支給額"];
        pairs.push({
          office: c.office_number, month: c.processing_month, emp, name: String(e.employee_name ?? s.employee_name),
          kind, ours: typeof e.grand_total === "number" ? e.grand_total : 0,
          soukatsu: numOrNull(raw), soukatsuRaw: raw, calculatedAt: c.calculated_at, employee: e,
        });
      }
    }
  }
  // 総括表にだけある人 (総支給額 > 0 のものだけ。/verification と同じ)。計算していない事業所×月は数えない
  const calcKeys = new Set(calc.map((c) => `${c.office_number}|${c.processing_month}`));
  for (const s of soukatsu) {
    const ck = `${s.office_number}|${s.processing_month}`;
    if (!calcKeys.has(ck)) continue;
    const key = `${ck}|${nn(s.employee_number)}|${s.sheet_kind}`;
    if (seen.has(key)) continue;
    if ((numOrNull(s.row_data["総支給額"]) ?? 0) > 0) cellOf(ck).onlySoukatsu++;
  }
  for (const p of pairs) {
    const cell = cellOf(`${p.office}|${p.month}`);
    cell.pairs++;
    if (p.soukatsu == null) cell.soukatsuNotNumber++;
    if (isExact(p)) cell.exact++;
    if (isWithin1pct(p)) cell.within1pct++;
  }
  return { pairs, cells };
}

const total = (cells: Map<string, Cell>): Cell => {
  const t = emptyCell();
  for (const c of cells.values()) for (const k of Object.keys(t) as (keyof Cell)[]) t[k] += c[k];
  return t;
};
const pct = (a: number, b: number) => (b === 0 ? "-" : `${((100 * a) / b).toFixed(1)}%`);

/** 月給者の欠勤控除 (payroll-calc.ts absenceDeduction と同じ規則。見込み用) */
function projectedAbsenceDeduction(e: Emp, days: number): number | null {
  const s = e.settings as Record<string, number> | undefined;
  if (!s || days <= 0) return null;
  const summary = (e.summary ?? {}) as Record<string, number>;
  const fixed = num(s.base_personal_salary) + num(s.skill_salary) + num(s.position_allowance) + num(s.qualification_allowance) +
    num(s.tenure_allowance) + num(s.treatment_improvement) + num(s.specific_treatment_improvement) + num(s.treatment_subsidy) +
    num(s.fixed_overtime_pay) + num(s.special_bonus);
  if (num(summary.workDays) <= 0 && num(summary.visitMinutes) <= 0) return fixed;
  const hours = e.is_office_worker_for_deduction ? 159 : 168;
  return Math.floor(((num(s.base_personal_salary) + num(s.skill_salary)) / hours) * 8 * days + 1e-6);
}

async function main() {
  const [calc, soukatsu] = await Promise.all([
    getAll<CalcRow>("payroll_calc_results?select=office_number,processing_month,calculated_at,payload"),
    getAll<SoukatsuRow>("payroll_soukatsu_rows?select=processing_month,office_number,employee_number,employee_name,sheet_kind,row_data"),
  ]);
  const { pairs, cells } = buildPairs(calc, soukatsu);
  const t = total(cells);
  for (const s of soukatsu) soukatsuCache.set(`${s.office_number}|${s.processing_month}|${nn(s.employee_number)}|${s.sheet_kind}`, s.row_data);

  // ── 負のコントロール: 一致している 1 人月の当方の値を +10,000 円ずらすと 一致が 1 減るか ──
  const target = pairs.find(isExact);
  let negOk = false;
  if (target) {
    const shifted = pairs.map((p) => (p === target ? { ...p, ours: p.ours + 10000 } : p));
    negOk = shifted.filter(isExact).length === pairs.filter(isExact).length - 1;
  }

  console.log("=== 総括表との一致率 (人月・総支給額) 2026-09-26 新設・読み取り専用 ===");
  console.log("");
  console.log("★ この検査が見ていないもの:");
  console.log("  ・総支給額だけ。項目ごとのずれが相殺されて一致しているものは見えない (→ /verification)");
  console.log("  ・総括表を正としている。総括表側の誤り (#VALUE!・手入力の上書き) も不一致に数える");
  console.log("  ・ミロク (実際の支給) とは比べていない / 控除後の金額は見ていない");
  console.log("  ・計算結果が古いかどうかは見ていない (先に npm run check:calc-staleness)");
  console.log("");
  console.log(`負のコントロール (一致している1人月を +10,000円ずらすと不一致になるか): ${negOk ? "OK" : "★ NG"}`);
  console.log("");
  console.log(`計算結果 ${calc.length} 件 (事業所×月) / 対になった人月 ${t.pairs}`);
  console.log(`  完全一致 (差±1円)   ${t.exact} / ${t.pairs} = ${pct(t.exact, t.pairs)}`);
  console.log(`  1%以内              ${t.within1pct} / ${t.pairs} = ${pct(t.within1pct, t.pairs)}`);
  console.log(`  総括表が数値でない  ${t.soukatsuNotNumber} (#VALUE! 等。一致に数えない)`);
  console.log(`  当方にだけいる      ${t.onlyOurs} / 総括表にだけいる(総支給>0) ${t.onlySoukatsu}  ← 分母の外`);
  console.log("");

  // 月別
  const byMonth = new Map<string, Cell>();
  for (const [k, c] of cells) {
    const m = k.split("|")[1];
    if (!byMonth.has(m)) byMonth.set(m, emptyCell());
    const b = byMonth.get(m)!;
    for (const kk of Object.keys(b) as (keyof Cell)[]) b[kk] += c[kk];
  }
  console.log("--- 月別 (完全一致 / 対) ---");
  for (const [m, c] of [...byMonth.entries()].sort()) console.log(`  ${m}  ${c.exact}/${c.pairs} = ${pct(c.exact, c.pairs)}  (1%以内 ${pct(c.within1pct, c.pairs)})`);
  console.log("");

  // ── 基準値との比較 ──
  const current: Record<string, Cell> = Object.fromEntries([...cells.entries()].sort());
  let failed = false;
  if (existsSync(BASELINE_PATH) && !UPDATE) {
    const base = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as { cells: Record<string, Cell> };
    const worse: string[] = [], better: string[] = [], changedDenom: string[] = [];
    for (const [k, c] of Object.entries(current)) {
      const b = base.cells[k];
      if (!b) { changedDenom.push(`${k} (新規 ${c.exact}/${c.pairs})`); continue; }
      if (b.pairs !== c.pairs) changedDenom.push(`${k} 対 ${b.pairs}→${c.pairs} / 一致 ${b.exact}→${c.exact}`);
      else if (c.exact < b.exact) worse.push(`${k} 一致 ${b.exact}→${c.exact} / ${c.pairs}`);
      else if (c.exact > b.exact) better.push(`${k} 一致 ${b.exact}→${c.exact} / ${c.pairs}`);
    }
    for (const k of Object.keys(base.cells)) if (!current[k]) changedDenom.push(`${k} (計算結果が無くなった)`);
    console.log("--- 基準値との比較 ---");
    console.log(`  良くなった ${better.length} / ★ 悪くなった ${worse.length} / 分母が変わった ${changedDenom.length}`);
    for (const s of worse) console.log(`  ★ 悪化  ${s}`);
    for (const s of better) console.log(`  改善    ${s}`);
    for (const s of changedDenom) console.log(`  分母変化 ${s}`);
    if (worse.length) failed = true;
    console.log("");
  } else if (!existsSync(BASELINE_PATH) && !UPDATE) {
    console.log("基準値ファイルがありません。--update で作成してください");
  }
  if (UPDATE) {
    writeFileSync(BASELINE_PATH, JSON.stringify({
      _readme: "check-soukatsu-match の基準値。事業所番号|処理月 ごとの 対の数・完全一致数など。悪化したまま --update しないこと (穴を焼き付ける)",
      updated_at: new Date().toISOString(),
      total: t,
      cells: current,
    }, null, 2) + "\n");
    console.log(`基準値を更新しました: ${BASELINE_PATH}`);
  }

  if (ESTIMATE) await estimate(pairs);

  if (!negOk) { console.log("★ 負のコントロールが通らないので PASS を出しません"); process.exit(1); }
  if (failed) { console.log("★ FAIL: 分母が同じで一致数が減った事業所×月があります"); process.exit(1); }
  console.log("PASS");
}

/**
 * 計算結果より新しい手入力がある人月について、再計算後の総支給額を見込む。
 * 対象は 3 つだけ: absence_days (欠勤控除) / overtime_minutes (残業) / commute_yen (通勤費)。
 * ⚠ 見込みは当方の計算式の一部を なぞっただけ。他の項目も同時に変わる人月では当たらない。
 */
async function estimate(pairs: Pair[]) {
  const inputs = await getAll<MonthlyInput>("payroll_monthly_inputs?item_key=in.(absence_days,overtime_minutes,commute_yen)&select=office_number,employee_number,processing_month,item_key,numeric_value,updated_at");
  const pairByKey = new Map(pairs.map((p) => [`${p.office}|${p.month}|${p.emp}`, p]));
  type Est = { key: string; name: string; kind: string; ours: number; soukatsu: number | null; delta: number; parts: string[]; unknown: string[] };
  const ests = new Map<string, Est>();
  let noPair = 0;
  for (const r of inputs) {
    const k = `${r.office_number}|${r.processing_month}|${nn(r.employee_number)}`;
    const p = pairByKey.get(k);
    if (!p) { noPair++; continue; }
    if (r.updated_at <= p.calculatedAt) continue; // 計算に反映済み
    if (!ests.has(k)) ests.set(k, { key: k, name: p.name, kind: p.kind, ours: p.ours, soukatsu: p.soukatsu, delta: 0, parts: [], unknown: [] });
    const est = ests.get(k)!;
    const v = num(r.numeric_value);
    const souk = soukatsuRowOf(p);
    if (r.item_key === "absence_days") {
      const d = p.kind === "shaseki" ? projectedAbsenceDeduction(p.employee, v) : null;
      if (d == null) est.unknown.push(`欠勤${v}日 (時給者か給与設定が無く見込めない)`);
      else { est.delta -= d; est.parts.push(`欠勤${v}日 −¥${d.toLocaleString()}`); }
    } else if (r.item_key === "overtime_minutes") {
      const rate = num(souk?.["残業単価"]);
      if (rate <= 0) est.unknown.push(`残業${v}分 (残業単価が総括表に無い)`);
      else { const y = Math.round((v / 60) * rate); est.delta += y; est.parts.push(`残業${v}分 +¥${y.toLocaleString()}`); }
    } else if (r.item_key === "commute_yen") {
      const already = num(p.employee.commute_fee) || num((p.employee.summary as Record<string, unknown> | undefined)?.commuteYenTotal);
      const y = v - already;
      est.delta += y;
      est.parts.push(`通勤費 ¥${v.toLocaleString()}${already ? ` (計算済み¥${already.toLocaleString()}との差)` : ""} +¥${y.toLocaleString()}`);
    }
  }
  const list = [...ests.values()];
  const judged = list.filter((e) => e.soukatsu != null && e.unknown.length === 0);
  const hitNow = judged.filter((e) => Math.abs(e.ours - (e.soukatsu ?? 0)) <= 1).length;
  const hitAfter = judged.filter((e) => Math.abs(e.ours + e.delta - (e.soukatsu ?? 0)) <= 1).length;
  const nearAfter = judged.filter((e) => Math.abs(e.ours + e.delta - (e.soukatsu ?? 0)) <= Math.max(1, Math.abs(e.soukatsu ?? 0) * 0.01)).length;

  console.log("--- 再計算後の見込み (absence_days / overtime_minutes / commute_yen のみ) ---");
  console.log(`  計算結果より新しい入力がある人月 ${list.length} (見込めないものを含む。計算結果に居ない人の入力 ${noPair} 件は対象外)`);
  console.log(`  見込めた人月 ${judged.length}: 完全一致 いま ${hitNow} → 再計算後の見込み ${hitAfter} / 1%以内の見込み ${nearAfter}`);
  console.log("  ★ 見込みが総括表と一致する = 再計算すれば直るはず。一致しない = この3項目以外に原因がある");
  for (const e of list.sort((a, b) => a.key.localeCompare(b.key))) {
    const after = e.ours + e.delta;
    const mark = e.soukatsu == null ? "総括表が数値でない" : e.unknown.length ? "見込めず" : Math.abs(after - e.soukatsu) <= 1 ? "✓一致見込み" : `差 ¥${(after - e.soukatsu).toLocaleString()}`;
    console.log(`  ${e.key} ${e.name.replace(/\s+/g, "")} (${e.kind})  いま¥${e.ours.toLocaleString()} → 見込み¥${after.toLocaleString()} / 総括表 ${e.soukatsu == null ? "-" : "¥" + e.soukatsu.toLocaleString()}  [${mark}]`);
    for (const s of [...e.parts, ...e.unknown]) console.log(`      ${s}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error("check-soukatsu-match failed:", e);
  process.exit(1);
});
