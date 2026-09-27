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
 *   ── その他 (PZ / SZ) の 3 者比較 (2026-09-27。SOUKATSU1_DIR=<① の抽出物> を渡したときだけ) ──
 *   項目ごとに 当方 / ② / ① を並べ、当方 ≠ ② の項目が 全部「当方 = ①」なら ② の手入力、
 *   1 つでも「② = ①」(当方だけ違う) があり 判定できない項目が無ければ 直す候補、それ以外は 判定できない。
 *     PZ② / SZ②  ② だけ違う → 直さない
 *     PZ当 / SZ当  ★ 当方だけ違う → 直す候補 (出力に 項目ごとの件数と 当方 − ② の合計)
 *     PZ? / SZ?   判定できない (3 つとも違う / ① に行が無い / ① に比べる列が無い 有給・遅刻早退 / 項目では説明できない)
 *   ★ 基準値は ① ありで作ってある。① なしで回すと 分け方が違うので止まる
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
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { restAll, empKey, normEmpNo } from "./_rest.mjs";
import { careOvertimePay, yochoAllowance, commuteFeeAmount } from "../src/lib/payroll/payroll-calc.js";
import { soukatsuAdjustmentParts } from "../src/lib/payroll/soukatsu-diff.js";
import type { MonthlyPayroll } from "../src/lib/payroll/payroll-calc.js";
import { monthlyPaidLeaveAllowance, lateEarlyDeduction } from "../src/lib/payroll/payroll-calc.js";
import { hourlyItems, l1HourlyItems, monthlyItems, l1MonthlyItems, L2_MONTHLY_COLS, l2Pick, num as numL } from "./_soukatsu-items.mjs";

const UPDATE = process.argv.includes("--update");
const DETAIL = process.argv.find((a) => a.startsWith("--detail="))?.split("=")[1];
const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), "check-soukatsu-cause-baseline.json");

export const TYPES = ["STALE", "NaN", "A", "B", "B2", "AB", "C", "PZ", "T", "UO", "UC", "UY", "UT", "UM", "SZ", "PZ②", "PZ当", "PZ?", "SZ②", "SZ当", "SZ?"] as const;
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
  "PZ②": "パート その他: ② だけ違う (当方 = ①)。② の手入力 → 直さない",
  "PZ当": "パート その他: 当方だけ違う (② = ①) → ★ 直す候補",
  "PZ?": "パート その他: 判定できない (3 つとも違う / ① が無い / 項目で説明できない)",
  "SZ②": "月給 その他: ② だけ違う (当方 = ①)。② の手入力 → 直さない",
  "SZ当": "月給 その他: 当方だけ違う (② = ①) → ★ 直す候補",
  "SZ?": "月給 その他: 判定できない (3 つとも違う / ① が無い / 項目で説明できない)",
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

export type Pair = { office: string; month: string; emp: string; name: string; kind: "part" | "shaseki"; ours: number; soukatsu: number | null; stale: boolean; e: Emp; row: Record<string, unknown>;
  /** ① (旧システムの出力) の行。SOUKATSU1_DIR を渡したときだけ。あれば その他 (PZ / SZ) を 3 者比較で分ける */
  l1?: Record<string, unknown> | null };

/**
 * その他 (PZ / SZ) を分けるための 項目ごとの 当方 / ② / ① (2026-09-27 給与C)。
 * 対応は scripts/_soukatsu-items.mts (給与D の check:soukatsu-item-gap の定義を共通にしたもの) + ② の列。
 * ★ ② の列の対応は「総支給が一致している人月で 項目も一致するか」で確かめた (パート 1,952 / 月給 1,109 人月):
 *   パートは どの項目も 99.8% 以上 / 月給は 介護超過 96.0% (② の介護列は 調整手当に畳まれるため) 以外 99.5% 以上。
 *   → 月給の 介護超過・夜朝深夜・特日 は ② の「調整手当」(畳み込み) と 合計で比べる。
 * ⚠ パートの「事務」(office_work_pay) は ② に対応する列が無いので比べない。
 * ⚠ ① に列が無い項目 (有給・遅刻早退) は ① = null (判定できない側に倒れる)。
 */
export type ItemTriple = { item: string; ours: number; l2: number; l1: number | null };
export function itemTriples(p: Pair): ItemTriple[] {
  const r = p.row, l1 = p.l1 ?? null;
  if (p.kind === "part") {
    const o = hourlyItems([p.e as never]);
    const a = l1 ? l1HourlyItems(l1) : null;
    const L2: Record<string, number> = {
      本人給系: numL(r["集計項目小計"]) + numL(r["土日祝"]) + numL(r["ドタキャン"]) + numL(r["特日"]),
      初任者: numL(r["初任者研修費"]) + numL(r["初任者研修調整費"]),
      研修会議: numL(r["その他手当"]) || numL(r["HRD研修"]) + numL(r["研修"]),   // ★ ② の研修列には会議費が入る事業所がある (給与D の check:no-source-data と同じ扱い)
      勤続: l2Pick(r, ["勤続手当", "勤続手当2", "資格or勤続手当", "・勤続手当・資格手当"]),
      処遇改善: numL(r["処遇改善補助金手当"]), 移動: numL(r["移動手当"]), 通信: numL(r["通信手当"]), 残業: numL(r["残業総額"]),
      育児: numL(r["育児手当"]), 通勤: numL(r["通勤費"]), 出張: numL(r["出張費"]), 有給: numL(r["有給休暇手当"]),
    };
    return Object.keys(L2).map((k) => ({ item: k, ours: o[k] ?? 0, l2: L2[k], l1: a && k in a ? a[k] : null }));
  }
  const mp = p.e as unknown as MonthlyPayroll;
  const o = monthlyItems([mp]);
  const a = l1 ? l1MonthlyItems(l1) : null;
  const out: ItemTriple[] = [];
  for (const k of Object.keys(L2_MONTHLY_COLS)) {
    if (k === "介護超過" || k === "夜朝深夜" || k === "特日") continue;
    out.push({ item: k, ours: o[k] ?? 0, l2: l2Pick(r, L2_MONTHLY_COLS[k]), l1: a ? a[k] ?? 0 : null });
  }
  out.push({ item: "調整手当(介護超過+夜朝深夜+特日)", ours: (o["介護超過"] ?? 0) + (o["夜朝深夜"] ?? 0) + (o["特日"] ?? 0), l2: numL(r["調整手当"]),
    l1: a ? (a["介護超過"] ?? 0) + (a["夜朝深夜"] ?? 0) + (a["特日"] ?? 0) : null });
  out.push({ item: "有給", ours: monthlyPaidLeaveAllowance(mp), l2: numL(r["有給休暇手当"]), l1: null });
  out.push({ item: "遅刻早退", ours: lateEarlyDeduction(mp), l2: Math.abs(numL(r["遅刻早退金額"])), l1: null });
  return out;
}

/** その他を 3 者比較で分ける。① が無ければ null (PZ / SZ のまま) */
export function splitOther(p: Pair): "②" | "当" | "?" | null {
  if (p.l1 === undefined) return null;
  const diffs = itemTriples(p).filter((x) => !within1(x.ours - x.l2));
  if (!diffs.length || !p.l1) return "?";
  const v = diffs.map((x) => (x.l1 == null ? "?" : within1(x.l2 - x.l1) ? "当" : within1(x.ours - x.l1) ? "②" : "?"));
  if (v.every((x) => x === "②")) return "②";
  if (v.includes("当") && !v.includes("?")) return "当";
  return "?";
}

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
    const sp = splitOther(p);
    return sp ? (`PZ${sp}` as CauseType) : "PZ";
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
  const so = splitOther(p);
  return so ? (`SZ${so}` as CauseType) : "SZ";
}

export function buildPairs(s: Snapshot, l1?: Map<string, Record<string, unknown>>): Pair[] {
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
          ...(l1 ? { l1: l1.get(`${k}|${c.processing_month}|${kind}`) ?? null } : {}),
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

/** ① (旧システムの出力) の抽出物。SOUKATSU1_DIR が無ければ undefined。キーは empKey|月|シート */
function loadL1(): Map<string, Record<string, unknown>> | undefined {
  const dir = process.env.SOUKATSU1_DIR;
  if (!dir) return undefined;
  const files = readdirSync(dir).filter((f) => /^soukatsu_extract_\d{6}\.json$/.test(f)).sort();
  if (!files.length) throw new Error(`★ SOUKATSU1_DIR=${dir} に soukatsu_extract_YYYYMM.json が 1 本もありません`);
  const m = new Map<string, Record<string, unknown>>();
  let dup = 0;
  for (const f of files) {
    const ym = /_(\d{6})\.json$/.exec(f)![1];
    for (const r of JSON.parse(readFileSync(join(dir, f), "utf8")) as { office_number: string; employee_number: string; sheet_kind: string; row_data: Record<string, unknown> }[]) {
      const k = `${empKey(r.office_number, r.employee_number)}|${ym}|${r.sheet_kind === "part" ? "part" : "shaseki"}`;
      // ① の写しには 同じ人月の行が 2 つある (事業所の総括表が 2 ファイルに出る)。先に出たほうを使う (給与D の検査と同じ)
      if (m.has(k)) { dup++; continue; }
      m.set(k, r.row_data);
    }
  }
  console.log(`(① 抽出物 ${files.length} 本・${m.size} 人月を使用: ${dir}${dup ? ` / 重複行 ${dup} を除いた` : ""})`);
  return m;
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
  // その他は ① があると SZ② / SZ当 / SZ? に分かれるので 合計で見る
  const szSum = (c: MonthCell) => c.SZ + c["SZ②"] + c["SZ当"] + c["SZ?"];
  const ok3a = szSum(t3.get(pickShaseki.month)!) === szSum(base.get(pickShaseki.month)!) + 1;
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
  // ⑥⑦ その他 (PZ / SZ) の 3 者比較。① がある時だけ
  let ok6 = true;
  // 壊す元は ① があって 項目がすべて 当方 = ② = ① の人月 (そうでないと 元から別の項目のずれが混ざる)
  const clean = (q: Pair) => !!q.l1 && classify(q) == null && itemTriples(q).every((x) => within1(x.ours - x.l2) && (x.l1 == null || within1(x.l2 - x.l1)));
  const cS = pairs.find((q) => q.kind === "shaseki" && clean(q)), cP = pairs.find((q) => q.kind === "part" && clean(q));
  if (pickShaseki.l1 !== undefined && cS && cP) {
    const withL1 = (p: Pair, l1: Record<string, unknown>) => ({ ...p, l1 });
    // ⑥ 当方だけ違う: ② と ① は同じ額のまま 当方の本人給 +3,000 → SZ当
    const e6 = { ...cS.e, settings: { ...(cS.e.settings as object), base_personal_salary: num((cS.e.settings as Record<string, unknown>)?.base_personal_salary) + 3000 } };
    const t6 = classify(withL1({ ...cS, e: e6, ours: cS.ours + 3000 }, cS.l1!));
    // ⑦ ② だけ違う: ② の本人給 +3,000 (総支給も) / ① は当方と同じ → SZ②
    const r7 = { ...cS.row, 本人給: num(cS.row["本人給"]) + 3000 };
    const t7 = classify(withL1({ ...cS, row: r7, soukatsu: (cS.soukatsu ?? 0) + 3000 }, cS.l1!));
    // ⑧ パート: ② だけ移動手当以外 (通信手当) +500 / ① は当方と同じ → PZ②
    const r8 = { ...cP.row, 通信手当: num(cP.row["通信手当"]) + 500, 誤差: 0 };
    const l1p = cP.l1!;
    const t8 = classify(withL1({ ...cP, row: r8, soukatsu: (cP.soukatsu ?? 0) + 500 }, l1p));
    ok6 = t6 === "SZ当" && t7 === "SZ②" && t8 === "PZ②";
    lines.push(`⑥ 当方だけ本人給 +3,000 → ${t6} / ⑦ ②だけ本人給 +3,000 → ${t7} / ⑧ パート ②だけ通信手当 +500 → ${t8}: ${ok6 ? "OK" : "★ NG (期待 SZ当 / SZ② / PZ②)"}`);
  } else lines.push("⑥〜⑧ (その他の 3 者比較) は ① が無い (または 壊す元になる人月が無い) ので回していない");
  return { ok: ok1 && ok2 && ok3a && ok3b && ok4 && ok5 && ok6, lines };
}

const pct = (a: number, b: number) => (b === 0 ? "-" : `${((100 * a) / b).toFixed(1)}%`);

async function main() {
  const snap = await loadSnapshot();
  const l1 = loadL1();
  const pairs = buildPairs(snap, l1);
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

  // ── その他 (PZ / SZ) の内訳 ──
  if (l1) {
    console.log("--- その他 (PZ / SZ) を ① と 3 者比較で分けた結果 (★ ① = 給与D が 2026-09-26 に抽出した旧システムの出力) ---");
    for (const kind of ["PZ", "SZ"] as const) {
      const all = pairs.filter((p) => String(classify(p) ?? "").startsWith(kind));
      console.log(`  ${kind === "PZ" ? "パート" : "月給"} その他 ${all.length} 人月: ② だけ違う (直さない) ${all.filter((p) => classify(p) === `${kind}②`).length} / ★ 当方だけ違う (直す候補) ${all.filter((p) => classify(p) === `${kind}当`).length} / 判定できない ${all.filter((p) => classify(p) === `${kind}?`).length}`);
      const byItem: Record<string, { n: number; sum: number }> = {};
      for (const p of all.filter((p) => classify(p) === `${kind}当`))
        for (const x of itemTriples(p)) if (!within1(x.ours - x.l2) && x.l1 != null && within1(x.l2 - x.l1)) {
          const b = byItem[x.item] ??= { n: 0, sum: 0 }; b.n++; b.sum += x.ours - x.l2;
        }
      for (const [k, b] of Object.entries(byItem).sort((a, b) => b[1].n - a[1].n))
        console.log(`      直す候補の項目 ${k.padEnd(12)} ${String(b.n).padStart(4)} 人月  当方 − ② の合計 ${Math.round(b.sum).toLocaleString()}円`);
    }
    console.log("");
  } else {
    console.log("(その他 PZ / SZ は ① が無いので分けていない。SOUKATSU1_DIR=<① 抽出物のdir> を渡すと 3 者比較で分ける)");
    console.log("");
  }

  if (DETAIL) {
    const t = DETAIL as CauseType;
    const list = pairs.filter((p) => classify(p) === t);
    console.log(`--- 型 ${t} の人月 (${list.length}) ---`);
    for (const p of list.sort((a, b) => (a.month + a.office).localeCompare(b.month + b.office)))
      console.log(`  ${p.month} ${p.office} ${p.emp.padStart(6)} ${p.name.replace(/\s+/g, " ").padEnd(12)} 当方 ${p.ours} / 総括② ${p.soukatsu} (差 ${p.soukatsu == null ? "-" : p.ours - p.soukatsu})`
        + (p.l1 !== undefined && /^(PZ|SZ)/.test(t) ? " | " + itemTriples(p).filter((x) => !within1(x.ours - x.l2)).map((x) => `${x.item} 当${Math.round(x.ours)}/②${Math.round(x.l2)}/①${x.l1 == null ? "-" : Math.round(x.l1)}`).join(" ") : ""));
    console.log("");
  }

  let failed = false;
  if (existsSync(BASELINE_PATH) && !UPDATE) {
    const base = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as { months: Record<string, MonthCell>; l1?: boolean };
    if (base.l1 && !l1) {
      console.log("★ 基準値は ① (SOUKATSU1_DIR) ありで作られている。① なしでは その他 (PZ / SZ) の分け方が違うので比べられない。SOUKATSU1_DIR を渡してください");
      process.exit(1);
    }
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
      l1: !!l1,
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
