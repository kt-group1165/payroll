/**
 * 総括表との不一致 (総支給額) を 原因の型ごとに数える (2026-09-26 給与C)。★ 基準値方式。
 *
 *   npm run check:soukatsu-cause                    # 基準値と比べる
 *   npm run check:soukatsu-cause -- --update        # 今の件数を基準値として保存
 *   npm run check:soukatsu-cause -- --detail=A      # 型 A の人月を一覧で出す
 *   SNAPSHOT=<path.json> npm run check:soukatsu-cause   # DB を読まず 保存済みの取得結果を使う (無ければ取得して保存)
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 * check:soukatsu-match は「何件一致したか」しか出さない。2026-09-26 に 5月・6月だけ一致率が低い理由を
 * 1 件ずつ分解したところ、原因は月ごとに別物だった:
 *   5月 = ② (支払用シート) の「調整手当」の手入力が急増 (パート 61 人月。他の月は 2〜5)。
 *         大半が「調整手当 = −誤差」の相殺入力で、当方には対応する入力が無い
 *   6月 = 同行ありのパートの「移動手当」で当方が多い (60 人月・当方多 +53,740円)
 * この分解は一度きりの調査で終わらせると 同じ調査をまた割り当てることになる
 * (前例: 生活援助の回数制限を 2 回調査した)。常設の検査にして「どの型が増えたか」を見張る。
 *
 * ── 型の定義 (1 人月は 1 つの型にだけ入る。上から順に判定) ───────────────────
 *   STALE  当方の計算結果より 手入力 (payroll_monthly_inputs) が新しい。再計算待ち。原因の診断から外す
 *   NaN    総括表の総支給額が数値でない (#VALUE! 等)
 *   ── パート ──
 *   A      総支給額の差 = ②の「調整手当」と当方の error_adjustment の差 だけで説明できる (②の手入力)
 *   B      総支給額の差 = 移動手当の差 だけで説明できる。かつ ②に同行時間がある
 *   B2     総支給額の差 = 移動手当の差 だけで説明できる。同行時間なし
 *   AB     A と B の和で説明できる
 *   C      上のどれでもなく、②の「誤差」列が 0 でない
 *   PZ     パートのその他
 *   ── 月給 (提責・社員・事務員) ──
 *   T      総支給額の差 = 通勤費の差 だけで説明できる
 *   U*     総支給額の差 = 調整手当(内訳計: 介護超過+事務員の訪問分+夜朝+特日) の差 だけで説明できる。部品で 5 つに分ける
 *            (②の調整手当 = 介護超過(プラスのみ) + 夜朝 + 特日 − 誤差。全22事業所で同じ式 / memory: payroll_soukatsu_adjustment_parts)
 *     UO   ②の「調整手当」セルが 上の式と合わない = ② で手で上書きされている。部品 (介護・夜朝・特日・誤差) は当方と一致
 *          ★ 2026-05 に 27 件 (他の月 0〜1)。5月の月給の落ち込みの正体
 *     UC   介護超過 (事務員の訪問分を含む) の差だけ
 *     UY   夜朝深夜 の差だけ
 *     UT   特日 の差だけ
 *     UM   上の部品の 2 つ以上 (または誤差) が絡む
 *          ⚠ 0.75 換算は 介護超過と特日だけ (Hana系)。夜朝・土日祝には掛けない (memory: payroll_075_conversion_scope)
 *            当方の値は careOvertimePay / yochoAllowance をそのまま呼ぶので この規則は payroll-calc 側に従う
 *   SZ     月給のその他
 *   「だけで説明できる」は ±1 円。
 *
 * ── 判定 (基準値方式) ─────────────────────────────────────────────────────
 *   月ごとに 対の数 (分母) が基準値と同じで、ある型の件数が増えた → ★ 悪化。FAIL
 *   分母が変わった月 → データが変わった (総括表の取込し直し・計算対象の増減)。FAIL にしない
 *   STALE の増減は FAIL にしない (再計算すれば消える)
 *   ⚠ 悪化したまま --update すると 穴を焼き付ける。先に --detail で中身を見ること
 *
 * ── ★ 何と何を比べているか ───────────────────────────────────────────────
 *   当方 = payroll_calc_results (給与計算画面で最後に計算したスナップショット) の grand_total
 *   総括表 = payroll_soukatsu_rows = ★ ② 支払用シート (手入力混在)。① (旧システムの出力) ではない
 *   (memory: payroll_soukatsu_three_layers / scripts/check-soukatsu-source.mts の冒頭)。
 *   ★ 型 A・C は ② の手入力そのもの。是非の判断は ① を見ること。この検査は「②と何が違うか」の分類であって
 *     当方の誤りの件数ではない。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { restAll, empKey, normEmpNo } from "./_rest.mjs";
import { careOvertimePay, yochoAllowance, commuteFeeAmount } from "../src/lib/payroll/payroll-calc.js";
import { soukatsuAdjustmentParts } from "../src/lib/payroll/soukatsu-diff.js";
import type { MonthlyPayroll } from "../src/lib/payroll/payroll-calc.js";

const UPDATE = process.argv.includes("--update");
const DETAIL = process.argv.find((a) => a.startsWith("--detail="))?.split("=")[1];
const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), "check-soukatsu-cause-baseline.json");

export const TYPES = ["STALE", "NaN", "A", "B", "B2", "AB", "C", "PZ", "T", "UO", "UC", "UY", "UT", "UM", "SZ"] as const;
export type CauseType = (typeof TYPES)[number];
const TYPE_LABEL: Record<CauseType, string> = {
  STALE: "手入力が計算より新しい (再計算待ち)",
  NaN: "総括表の総支給額が数値でない",
  A: "パート: ②の調整手当 (手入力) だけ",
  B: "パート: 移動手当だけ・同行あり",
  B2: "パート: 移動手当だけ・同行なし",
  AB: "パート: 調整手当 + 移動手当",
  C: "パート: ②に誤差あり (上のどれでもない)",
  PZ: "パート: その他",
  T: "月給: 通勤費だけ",
  UO: "月給: ②の調整手当セルが式と違う (②の上書き)",
  UC: "月給: 調整手当のうち 介護超過だけ",
  UY: "月給: 調整手当のうち 夜朝だけ",
  UT: "月給: 調整手当のうち 特日だけ",
  UM: "月給: 調整手当の部品が複数",
  SZ: "月給: その他",
};

type Emp = Record<string, unknown> & { employee_number: unknown; grand_total?: unknown };
type CalcRow = { office_number: string; processing_month: string; calculated_at: string; payload: { hourly?: Emp[]; monthly?: Emp[] } | null };
type SoukatsuRow = { processing_month: string; office_number: string; employee_number: string; employee_name: string; sheet_kind: string; row_data: Record<string, unknown> };
type InputRow = { office_number: string; employee_number: string; processing_month: string; updated_at: string };
type Snapshot = { fetched_at: string; calc: CalcRow[]; soukatsu: SoukatsuRow[]; inputs: InputRow[] };

/** ② のセルは数値・文字列・{result} が混ざる */
export const num = (v: unknown): number => {
  const x = v && typeof v === "object" && "result" in (v as object) ? (v as { result: unknown }).result : v;
  const n = typeof x === "number" ? x : parseFloat(String(x ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => {
  const x = v && typeof v === "object" && "result" in (v as object) ? (v as { result: unknown }).result : v;
  if (x == null || x === "") return null;
  const n = typeof x === "number" ? x : parseFloat(String(x).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const within1 = (a: number) => Math.abs(a) <= 1;

export type Pair = { office: string; month: string; emp: string; name: string; kind: "part" | "shaseki"; ours: number; soukatsu: number | null; stale: boolean; e: Emp; row: Record<string, unknown> };

/** 1 人月の不一致を 型に振り分ける。一致していれば null */
export function classify(p: Pair): CauseType | null {
  if (p.soukatsu == null) return "NaN";
  const d = p.ours - p.soukatsu;
  if (within1(d)) return null;
  if (p.stale) return "STALE";
  const r = p.row, e = p.e;
  if (p.kind === "part") {
    const adj = num(e.error_adjustment) - num(r["調整手当"]);
    const tr = num(e.travel_allowance) - num(r["移動手当"]);
    if (!within1(adj) && within1(d - adj)) return "A";
    if (!within1(tr) && within1(d - tr)) return num(r["同行"]) > 0 ? "B" : "B2";
    if (!within1(adj) && !within1(tr) && within1(d - adj - tr)) return "AB";
    if (num(r["誤差"]) !== 0) return "C";
    return "PZ";
  }
  const mp = e as unknown as MonthlyPayroll;
  const commute = commuteFeeAmount(mp) - num(r["通勤費"]);
  if (!within1(commute) && within1(d - commute)) return "T";
  const oCare = careOvertimePay(mp) + num(e.office_worker_care_pay), oYocho = yochoAllowance(mp), oTok = num(e.tokubi_allowance);
  const adjParts = oCare + oYocho + oTok - num(r["調整手当"]);
  if (!within1(adjParts) && within1(d - adjParts)) {
    // ★ 先に総支給で絞ってから部品に降りる (項目差 ≠ 支給差)
    const sp = soukatsuAdjustmentParts(r);
    if (!within1(num(r["調整手当"]) - sp.total)) return "UO";
    const dc = oCare - sp.care, dy = oYocho - sp.yocho, dt = oTok - sp.tokubi;
    if (within1(sp.gosa)) {
      if (!within1(dc) && within1(adjParts - dc)) return "UC";
      if (!within1(dy) && within1(adjParts - dy)) return "UY";
      if (!within1(dt) && within1(adjParts - dt)) return "UT";
    }
    return "UM";
  }
  return "SZ";
}

export function buildPairs(s: Snapshot): Pair[] {
  const sMap = new Map<string, SoukatsuRow>();
  for (const r of s.soukatsu) sMap.set(`${empKey(r.office_number, r.employee_number)}|${r.processing_month}|${r.sheet_kind}`, r);
  const calcAt = new Map(s.calc.map((c) => [`${c.office_number}|${c.processing_month}`, c.calculated_at]));
  const stale = new Set<string>();
  for (const i of s.inputs) {
    const at = calcAt.get(`${i.office_number}|${i.processing_month}`);
    if (at && i.updated_at > at) stale.add(`${empKey(i.office_number, i.employee_number)}|${i.processing_month}`);
  }
  const pairs: Pair[] = [];
  for (const c of s.calc) {
    if (!c.payload) continue;
    for (const [kind, list] of [["part", c.payload.hourly ?? []], ["shaseki", c.payload.monthly ?? []]] as const) {
      for (const e of list) {
        const k = empKey(c.office_number, e.employee_number as string);
        const row = sMap.get(`${k}|${c.processing_month}|${kind}`);
        if (!row) continue;   // 片側にしか居ない人は check:soukatsu-match が数える
        pairs.push({
          office: c.office_number, month: c.processing_month, emp: normEmpNo(e.employee_number as string), name: row.employee_name, kind,
          ours: typeof e.grand_total === "number" ? e.grand_total : 0, soukatsu: numOrNull(row.row_data["総支給額"]),
          stale: stale.has(`${k}|${c.processing_month}`), e, row: row.row_data,
        });
      }
    }
  }
  return pairs;
}

type MonthCell = { pairs: number; exact: number } & Record<CauseType, number>;
export function tally(pairs: Pair[]): Map<string, MonthCell> {
  const m = new Map<string, MonthCell>();
  for (const p of pairs) {
    if (!m.has(p.month)) m.set(p.month, { pairs: 0, exact: 0, ...Object.fromEntries(TYPES.map((t) => [t, 0])) } as MonthCell);
    const c = m.get(p.month)!;
    c.pairs++;
    const t = classify(p);
    if (t == null) c.exact++; else c[t]++;
  }
  return m;
}

/** 基準値と比べる。悪化 = 分母が同じ月で STALE 以外のどれかの型が増えた */
export function compare(base: Record<string, MonthCell>, cur: Map<string, MonthCell>) {
  const worse: string[] = [], better: string[] = [], denom: string[] = [];
  for (const [m, c] of [...cur.entries()].sort()) {
    const b = base[m];
    if (!b) { denom.push(`${m} (新規 対${c.pairs})`); continue; }
    if (b.pairs !== c.pairs) { denom.push(`${m} 対 ${b.pairs}→${c.pairs}`); continue; }
    for (const t of TYPES) {
      if (t === "STALE") continue;
      if (b[t] === undefined) { denom.push(`${m} 型 ${t} が基準値に無い (型の定義が変わった。中身を見てから --update)`); continue; }
      if (c[t] > b[t]) worse.push(`${m} ${t} ${b[t]}→${c[t]} (${TYPE_LABEL[t]})`);
      else if (c[t] < b[t]) better.push(`${m} ${t} ${b[t]}→${c[t]}`);
    }
  }
  for (const m of Object.keys(base)) if (!cur.has(m)) denom.push(`${m} (計算結果が無くなった)`);
  return { worse, better, denom };
}

async function loadSnapshot(): Promise<Snapshot> {
  const path = process.env.SNAPSHOT;
  if (path && existsSync(path)) {
    const s = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
    console.log(`(保存済みの取得結果を使用: ${path} / 取得 ${s.fetched_at})`);
    return s;
  }
  // ★ 他セッションも同時に DB を読んでいる。並列にせず順に読む
  const calc = await restAll<CalcRow>("payroll_calc_results?select=id,office_number,processing_month,calculated_at,payload");
  const soukatsu = await restAll<SoukatsuRow>("payroll_soukatsu_rows?select=id,processing_month,office_number,employee_number,employee_name,sheet_kind,row_data");
  const inputs = await restAll<InputRow>("payroll_monthly_inputs?select=id,office_number,employee_number,processing_month,updated_at");
  const s: Snapshot = { fetched_at: new Date().toISOString(), calc, soukatsu, inputs };
  if (path) { writeFileSync(path, JSON.stringify(s)); console.log(`(取得結果を保存: ${path})`); }
  return s;
}

/**
 * 負のコントロール。本番 DB は触らず、取得したデータの写しを壊して 型の件数と判定が動くかを見る。
 *   ① 一致しているパート 1 人月の ②移動手当 を −500 し 総支給 も −500 → B か B2 が 1 増える
 *   ② 一致しているパート 1 人月の ②調整手当 を +700 し 総支給 も +700 → A が 1 増える
 *   ③ 一致している月給 1 人月の 当方 grand_total を +10,000 → SZ が 1 増え、compare が「悪化」を出す
 *   ④ 一致している月給 1 人月の ②調整手当セルを +900 し 総支給 も +900 (部品は触らない) → UO が 1 増える
 *   ⑤ ①と同じ壊し方をしたうえで ②の値を "12,345" 形式の カンマ付き文字列にしても ①と同じ件数になる
 *      (Number("10,000") は NaN / parseFloat("10,000") は 10 で どちらも静かに壊れる。2026-09-27 給与D が ① で発見)
 */
function negativeControl(pairs: Pair[]): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  const base = tally(pairs);
  const pickPart = pairs.find((p) => p.kind === "part" && !p.stale && classify(p) == null);
  const pickShaseki = pairs.find((p) => p.kind === "shaseki" && !p.stale && classify(p) == null);
  if (!pickPart || !pickShaseki) return { ok: false, lines: ["一致している人月が見つからず 負のコントロールを作れない"] };
  const mutate = (target: Pair, f: (p: Pair) => Pair) => pairs.map((p) => (p === target ? f(p) : p));
  const cnt = (ps: Pair[], m: string, t: CauseType) => tally(ps).get(m)![t];

  const p1 = mutate(pickPart, (p) => ({ ...p, soukatsu: (p.soukatsu ?? 0) - 500, row: { ...p.row, 移動手当: num(p.row["移動手当"]) - 500 } }));
  const bType: CauseType = num(pickPart.row["同行"]) > 0 ? "B" : "B2";
  const ok1 = cnt(p1, pickPart.month, bType) === base.get(pickPart.month)![bType] + 1;
  lines.push(`① ②移動手当を −500 → ${bType} +1: ${ok1 ? "OK" : "★ NG"}`);

  const p2 = mutate(pickPart, (p) => ({ ...p, soukatsu: (p.soukatsu ?? 0) + 700, row: { ...p.row, 調整手当: num(p.row["調整手当"]) + 700 } }));
  const ok2 = cnt(p2, pickPart.month, "A") === base.get(pickPart.month)!.A + 1;
  lines.push(`② ②調整手当を +700 → A +1: ${ok2 ? "OK" : "★ NG"}`);

  const p3 = mutate(pickShaseki, (p) => ({ ...p, ours: p.ours + 10000 }));
  const t3 = tally(p3);
  const ok3a = t3.get(pickShaseki.month)!.SZ === base.get(pickShaseki.month)!.SZ + 1;
  const ok3b = compare(Object.fromEntries(base), t3).worse.length > 0;
  lines.push(`③ 当方の月給 +10,000 → SZ +1: ${ok3a ? "OK" : "★ NG"} / 基準値比較が「悪化」を出す: ${ok3b ? "OK" : "★ NG"}`);
  const toComma = (v: unknown) => Math.round(num(v)).toLocaleString("en-US");
  const p5 = mutate(pickPart, (p) => ({ ...p, soukatsu: (p.soukatsu ?? 0) - 500,
    row: { ...p.row, 移動手当: toComma(num(p.row["移動手当"]) - 500), 総支給額: toComma((p.soukatsu ?? 0) - 500), 調整手当: toComma(p.row["調整手当"]) } }));
  const ok5 = cnt(p5, pickPart.month, bType) === cnt(p1, pickPart.month, bType) && typeof p5.find((p) => p.emp === pickPart.emp && p.month === pickPart.month && p.office === pickPart.office)!.row["移動手当"] === "string";
  lines.push(`⑤ ②の値をカンマ付き文字列 ("12,345") にしても ①と同じ件数: ${ok5 ? "OK" : "★ NG"}`);
  const p4 = mutate(pickShaseki, (p) => ({ ...p, soukatsu: (p.soukatsu ?? 0) + 900, row: { ...p.row, 調整手当: num(p.row["調整手当"]) + 900 } }));
  const ok4 = cnt(p4, pickShaseki.month, "UO") === base.get(pickShaseki.month)!.UO + 1;
  lines.push(`④ ②調整手当セルを +900 (部品はそのまま) → UO +1: ${ok4 ? "OK" : "★ NG"}`);
  return { ok: ok1 && ok2 && ok3a && ok3b && ok4 && ok5, lines };
}

const pct = (a: number, b: number) => (b === 0 ? "-" : `${((100 * a) / b).toFixed(1)}%`);

async function main() {
  const snap = await loadSnapshot();
  const pairs = buildPairs(snap);
  const cur = tally(pairs);

  console.log("=== 総括表との不一致の 原因の型 (人月・総支給額) 2026-09-26 新設・読み取り専用 ===");
  console.log("★ check:all には入れていない (意図的)。理由: 型 A・C・UO は ② の手入力の増減で動くので、当方のコードが正しくても FAIL しうる。診断系");
  console.log("");
  console.log("★ 比べているもの: 当方 = payroll_calc_results の grand_total / 総括表 = ★ ② 支払用シート (手入力混在)。① ではない");
  console.log("  → 型 A・C は ② の手入力そのもの。当方の誤りの件数ではない。是非の判断は ① (旧システムの出力) を見ること");
  console.log("");
  console.log("★ この検査が見ていないもの:");
  console.log("  ・総支給額だけ。項目どうしで相殺して総支給額が一致した人月は「一致」に数える (→ /verification)");
  console.log("  ・片側にしか居ない人月 (当方だけ / 総括表だけ) は数えない (→ check:soukatsu-match)");
  console.log("  ・計算結果が古い人月は STALE に分けるだけで 中身は見ない (→ check:calc-staleness のあと再計算)");
  console.log("  ・ミロク (実際の支給) とは比べていない / 控除後の金額は見ていない");
  console.log("  ・① (旧システムの出力 xlsm) は読まない。② のセルはカンマ付き文字列も数値に直して読む (負のコントロール⑤)");
  console.log("  ・② のエラー値 (#VALUE! 等) は 0 として読む。2026-09-27 時点で 誤差列に 155 行 (対になった 60 人月・うち不一致 4)。その不一致は C でなく PZ / STALE に入る");
  console.log("  ・型は「その項目の差だけで総支給の差が ±1円で説明できるか」で決める。2 項目以上が絡むと その他 (PZ / SZ) に落ちる");
  console.log("  ・月給の型 T・U* は当方の値を payroll-calc の関数で出し直している。payload に額として入っていない項目のため");
  console.log("");

  const neg = negativeControl(pairs);
  console.log("負のコントロール (取得データの写しを壊す。DB は触らない):");
  for (const l of neg.lines) console.log("  " + l);
  console.log("");

  const months = [...cur.keys()].sort();
  const tot = { pairs: 0, exact: 0 };
  for (const c of cur.values()) { tot.pairs += c.pairs; tot.exact += c.exact; }
  console.log(`母数: 当方の計算結果 ${snap.calc.length} 件 (事業所×月) と 総括表② が 対になった人月 ${tot.pairs} (片側だけの人は含まない)`);
  console.log(`完全一致 (±1円) ${tot.exact} / ${tot.pairs} = ${pct(tot.exact, tot.pairs)}`);
  console.log("");
  console.log(`--- 月別 × 型 ---`);
  console.log(`  月      対    一致率  ${TYPES.map((t) => t.padStart(5)).join("")}`);
  for (const m of months) {
    const c = cur.get(m)!;
    console.log(`  ${m} ${String(c.pairs).padStart(5)} ${pct(c.exact, c.pairs).padStart(7)}  ${TYPES.map((t) => String(c[t]).padStart(5)).join("")}`);
  }
  console.log("");
  console.log("  型の意味:");
  for (const t of TYPES) console.log(`    ${t.padEnd(5)} ${TYPE_LABEL[t]}`);
  console.log("");

  if (DETAIL) {
    const t = DETAIL as CauseType;
    const list = pairs.filter((p) => classify(p) === t);
    console.log(`--- 型 ${t} の人月 (${list.length}) ---`);
    for (const p of list.sort((a, b) => (a.month + a.office).localeCompare(b.month + b.office)))
      console.log(`  ${p.month} ${p.office} ${p.emp.padStart(6)} ${p.name.replace(/\s+/g, " ").padEnd(12)} 当方 ${p.ours} / 総括② ${p.soukatsu} (差 ${p.soukatsu == null ? "-" : p.ours - p.soukatsu})`);
    console.log("");
  }

  let failed = false;
  if (existsSync(BASELINE_PATH) && !UPDATE) {
    const base = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as { months: Record<string, MonthCell> };
    const { worse, better, denom } = compare(base.months, cur);
    console.log("--- 基準値との比較 ---");
    console.log(`  ★ 悪化 ${worse.length} / 改善 ${better.length} / 分母が変わった月 ${denom.length}`);
    for (const s of worse) console.log(`  ★ 悪化   ${s}`);
    for (const s of better) console.log(`  改善     ${s}`);
    for (const s of denom) console.log(`  分母変化 ${s}  (データが変わった。中身を見てから --update)`);
    if (worse.length) failed = true;
    console.log("");
  } else if (!UPDATE) {
    console.log("基準値ファイルがありません。--update で作成してください");
  }

  if (UPDATE) {
    const prev = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
    writeFileSync(BASELINE_PATH, JSON.stringify({
      _readme: prev._readme ?? "(新規)",
      updated_at: new Date().toISOString(),
      snapshot_fetched_at: snap.fetched_at,
      total: tot,
      months: Object.fromEntries(months.map((m) => [m, cur.get(m)])),
    }, null, 2) + "\n");
    console.log(`基準値を更新しました: ${BASELINE_PATH}`);
    console.log("★ _readme の「なぜこの件数か」を今回の件数に合わせて書き直すこと");
  }

  if (!neg.ok) { console.log("★ 負のコントロールが通らないので PASS を出しません"); process.exit(1); }
  if (failed) { console.log("★ FAIL: 分母が同じ月で ある型の件数が増えました。--detail=<型> で中身を見てください"); process.exit(1); }
  console.log("PASS (★ 0 件 PASS ではない。基準値の件数を許容したうえでの PASS)");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e); process.exit(1); });
