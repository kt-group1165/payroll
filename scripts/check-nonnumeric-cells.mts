/**
 * 総括表の「数値のはずのセルが 数値でない」を 型ごとに数える (2026-09-27 給与C)。★ 基準値方式。
 *
 *   npm run check:nonnumeric-cells                       # 基準値と比べる
 *   npm run check:nonnumeric-cells -- --update           # 今の件数を基準値として保存
 *   npm run check:nonnumeric-cells -- --detail=カンマ付き   # その型のセルを列・事業所ごとに出す
 *   SNAPSHOT=<path.json> npm run check:nonnumeric-cells  # DB を読まず 保存済みの取得結果を使う (無ければ取得して保存)
 *     (check:soukatsu-cause の SNAPSHOT と同じ形式。soukatsu キーだけ使う)
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 * 2026-09-26〜27 に 同じ family の不具合が 1 つずつ見つかっていた:
 *   ・① (xlsm) の 1272403534 に "10,000" のカンマ付き文字列 (給与D)
 *   ・② の 誤差列に "#VALUE!" が 155 行 (給与C)
 * 1 つ直すと別が残る。先に全部を挙げるための検査。直すのはその後。
 * ★ Number("10,000") は NaN → 0 に倒れる。★ parseFloat("10,000") は 10 になる。
 *   ★ 10 になるほうが 0 より危ない (もっともらしい値になるので気づけない)。
 *
 * ── 何を数えるか ─────────────────────────────────────────────────────────
 *   対象: payroll_soukatsu_rows (★ ② 支払用シート) の row_data の全列。
 *   「数値の列」= その列の 値がある行のうち 8 割以上が 数値として素直に読める列 (数値型 / "123" / "-1.5")。
 *   数値の列の中で 素直に読めない値を 型に分ける (下の TYPES)。文字の列 (氏名 等) は数えない。
 *   ① (旧システムの出力 xlsm) は SOUKATSU1_DIR=<dir> を渡したときだけ数える。dir には
 *     migrations/extract_soukatsu_from_xlsm.mjs の出力 soukatsu_extract_YYYYMM.json を置く (給与D の抽出物と同じ形)。
 *     抽出器は exceljs の値をほぼ生で入れる: エラー値は {error:"#VALUE!"} / リッチテキストは {richText:[…]} のオブジェクト。
 *   ⚠ xlsm の再抽出はしない (重い・Box は読み取りのみ)。抽出物が古ければ その時点の値で数える
 *
 * ── 判定 (基準値方式) ─────────────────────────────────────────────────────
 *   ② の総行数が基準値と同じで、ある (列, 型) の件数が増えた → ★ 悪化。FAIL
 *   総行数が変わった → 総括表を取り込み直した。FAIL にしない。中身を見てから --update
 *   ⚠ 悪化したまま --update すると 穴を焼き付ける
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { restAll } from "./_rest.mjs";

const UPDATE = process.argv.includes("--update");
const DETAIL = process.argv.find((a) => a.startsWith("--detail="))?.split("=")[1];
const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), "check-nonnumeric-cells-baseline.json");

export const TYPES = [
  "カンマ付き", "全角数字", "エラー値", "ハイフン", "空白のみ", "前後に空白", "単位付き", "括弧の負数", "改行混じり",
  "時刻文字列", "数式オブジェクト", "リッチテキスト", "真偽値", "その他の文字列",
] as const;
export type CellType = (typeof TYPES)[number];

/** 数値として素直に読める (= 型に数えない) か */
const PLAIN_NUM = /^-?\d+(\.\d+)?$/;
const ERROR_VAL = /^#(VALUE!|REF!|DIV\/0!|N\/A|NAME\?|NUM!|NULL!|SPILL!|CALC!)$/i;
const FULLWIDTH = /[０-９，．－]/;

/** 1 セルを型に振り分ける。null = 数値として素直に読める / undefined = 空 (値が無い) */
export function classifyCell(v: unknown): CellType | null | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? null : "その他の文字列";
  if (typeof v === "boolean") return "真偽値";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("error" in o) return "エラー値";                     // ① の抽出器: {error:"#VALUE!"}
    if ("richText" in o) return "リッチテキスト";            // ① の抽出器: {richText:[…]}
    return "数式オブジェクト";                                // ExcelJS の {formula, result} がそのまま入ったもの
  }
  const s = String(v);
  if (s.trim() === "") return "空白のみ";
  if (/[\r\n]/.test(s)) return "改行混じり";
  const t = s.trim();
  if (ERROR_VAL.test(t)) return "エラー値";
  if (/^[-－―ー‐]$/.test(t)) return "ハイフン";
  if (FULLWIDTH.test(t)) return "全角数字";
  if (/^\(\s*-?[\d,]+(\.\d+)?\s*\)$/.test(t)) return "括弧の負数";
  if (/^-?[\d,]+(\.\d+)?\s*(円|分|時間|h|km|日|件|回|%)$/i.test(t)) return "単位付き";
  if (/^-?\d{1,3}:\d{2}(:\d{2})?$/.test(t)) return "時刻文字列";
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return s === t ? "カンマ付き" : "前後に空白";
  if (PLAIN_NUM.test(t)) return s === t ? null : "前後に空白";
  return "その他の文字列";
}

/** 今のコードで どう読まれるか (説明用)。pickSoukatsu は soukatsu-diff.ts と同じ読み方 */
export function readers(v: unknown): { Number: number; parseFloat: number; pickSoukatsu: number } {
  const z = (n: number) => (Number.isNaN(n) ? 0 : n);
  const s = String(v);
  return {
    Number: z(Number(v)),
    parseFloat: z(parseFloat(s)),
    pickSoukatsu: typeof v === "number" ? v : z(parseFloat(s.replace(/,/g, ""))),
  };
}

type Row = { processing_month: string; office_number: string; employee_number: string; sheet_kind: string; row_data: Record<string, unknown> };
type Hit = { col: string; type: CellType; office: string; month: string; emp: string; value: unknown };

/**
 * 「数字として書かれている」型。列が数値の列かを決めるときは これらも数字に数える。
 * ★ 素直な数値だけで 8 割を判定すると、カンマ付きが大半の列 (① の 時間外割増賃金 等) が
 *   「文字の列」に落ちて 丸ごと数えられない (2026-09-27 初版で踏んだ。① のカンマ 1,589 → 124 と過少に出た)
 */
const NUMBER_LIKE = new Set<CellType | null>([null, "カンマ付き", "前後に空白", "全角数字", "単位付き", "括弧の負数"]);

/** 数値の列を決める: 値がある行のうち 8 割以上が 数字として書かれている列 (エラー値・空白は分母から外す) */
export function numericColumns(rows: Row[]): Map<string, { filled: number; plain: number }> {
  const st = new Map<string, { filled: number; plain: number; judged: number; numLike: number }>();
  for (const r of rows) for (const [k, v] of Object.entries(r.row_data)) {
    const c = classifyCell(v);
    if (c === undefined) continue;
    const s = st.get(k) ?? { filled: 0, plain: 0, judged: 0, numLike: 0 };
    s.filled++; if (c === null) s.plain++;
    if (c !== "エラー値" && c !== "空白のみ") { s.judged++; if (NUMBER_LIKE.has(c)) s.numLike++; }
    st.set(k, s);
  }
  return new Map([...st].filter(([, s]) => s.judged > 0 && s.numLike / s.judged >= 0.8).map(([k, s]) => [k, { filled: s.filled, plain: s.plain }]));
}

export function scan(rows: Row[], cols: Map<string, unknown>): Hit[] {
  const hits: Hit[] = [];
  for (const r of rows) for (const [k, v] of Object.entries(r.row_data)) {
    if (!cols.has(k)) continue;
    const c = classifyCell(v);
    if (c) hits.push({ col: k, type: c, office: r.office_number, month: r.processing_month, emp: r.employee_number, value: v });
  }
  return hits;
}

type Counts = Record<string, number>;   // "列|型" → 件数
const countOf = (hits: Hit[]): Counts => {
  const c: Counts = {};
  for (const h of hits) c[`${h.col}|${h.type}`] = (c[`${h.col}|${h.type}`] ?? 0) + 1;
  return c;
};

export function compare(base: { rows: number; counts: Counts }, rows: number, cur: Counts) {
  if (base.rows !== rows) return { worse: [] as string[], better: [] as string[], dataChanged: `② の総行数 ${base.rows}→${rows}` };
  const worse: string[] = [], better: string[] = [];
  for (const k of new Set([...Object.keys(base.counts), ...Object.keys(cur)])) {
    const b = base.counts[k] ?? 0, c = cur[k] ?? 0;
    if (c > b) worse.push(`${k} ${b}→${c}`); else if (c < b) better.push(`${k} ${b}→${c}`);
  }
  return { worse, better, dataChanged: null as string | null };
}

/** 負のコントロール: 型ごとに 1 本。数値の列 1 つに その型の値を 1 セル足して、その型が 1 増えるか */
const SAMPLES: Record<CellType, unknown> = {
  カンマ付き: "10,000", 全角数字: "１０", エラー値: "#VALUE!", ハイフン: "-", 空白のみ: "  ", 前後に空白: " 1200 ",
  単位付き: "10,000円", 括弧の負数: "(1,000)", 改行混じり: "1200\n", 時刻文字列: "1:30",
  数式オブジェクト: { formula: "A1", result: 1 }, リッチテキスト: { richText: [{ text: "1,000" }] },
  真偽値: true, その他の文字列: "abc",
};
function negativeControl(rows: Row[], cols: Map<string, unknown>) {
  const lines: string[] = [];
  const col = [...cols.keys()].find((k) => k === "総支給額") ?? [...cols.keys()][0];
  const baseHits = countOf(scan(rows, cols));
  let ok = true;
  for (const t of TYPES) {
    const inj: Row = { processing_month: "000000", office_number: "neg", employee_number: "0", sheet_kind: "part", row_data: { [col]: SAMPLES[t] } };
    const got = countOf(scan([...rows, inj], cols));
    const hit = (got[`${col}|${t}`] ?? 0) === (baseHits[`${col}|${t}`] ?? 0) + 1;
    const worse = compare({ rows: rows.length + 1, counts: baseHits }, rows.length + 1, got).worse.length > 0;
    if (!hit || !worse) ok = false;
    lines.push(`${t.padEnd(8)} ${JSON.stringify(SAMPLES[t]).padEnd(24)} → +1: ${hit ? "OK" : "★ NG"} / 悪化を出す: ${worse ? "OK" : "★ NG"}`);
  }
  // ① の抽出器の形 {error:"#VALUE!"} も エラー値に入るか
  {
    const inj: Row = { processing_month: "000000", office_number: "neg", employee_number: "0", sheet_kind: "part", row_data: { [col]: { error: "#VALUE!" } } };
    const hit = (countOf(scan([...rows, inj], cols))[`${col}|エラー値`] ?? 0) === (baseHits[`${col}|エラー値`] ?? 0) + 1;
    if (!hit) ok = false;
    lines.push(`エラー値   {"error":"#VALUE!"} (①の形)  → +1: ${hit ? "OK" : "★ NG"}`);
  }
  // 列の選び方: 全部がカンマ付きの列も「数値の列」として数えるか (★ 初版はここで ① の 1,589 セルを取りこぼした)
  {
    const inj: Row[] = Array.from({ length: 5 }, (_, i) => ({ processing_month: "000000", office_number: "neg", employee_number: String(i), sheet_kind: "part", row_data: { 負のコントロール列: "1,000" } }));
    const all = [...rows, ...inj];
    const n = countOf(scan(all, numericColumns(all)))["負のコントロール列|カンマ付き"] ?? 0;
    if (n !== 5) ok = false;
    lines.push(`全部がカンマ付きの列 (5 セル) を 数値の列として 5 件数える: ${n === 5 ? "OK" : `★ NG (${n})`}`);
  }
  // 逆向き: 素直な数値 (数値型 / "1200" / "-3.5") は 数えない
  const plain: Row = { processing_month: "000000", office_number: "neg", employee_number: "0", sheet_kind: "part", row_data: { [col]: "-3.5" } };
  const noHit = JSON.stringify(countOf(scan([...rows, plain], cols))) === JSON.stringify(baseHits);
  if (!noHit) ok = false;
  lines.push(`素直な数値 "-3.5" は数えない: ${noHit ? "OK" : "★ NG"}`);
  return { ok, lines };
}

async function loadRows2(): Promise<{ rows: Row[]; fetchedAt: string }> {
  const path = process.env.SNAPSHOT;
  if (path && existsSync(path)) {
    const s = JSON.parse(readFileSync(path, "utf8"));
    console.log(`(② 保存済みの取得結果を使用: ${path} / 取得 ${s.fetched_at})`);
    return { rows: s.soukatsu, fetchedAt: s.fetched_at };
  }
  const rows = await restAll<Row>("payroll_soukatsu_rows?select=id,processing_month,office_number,employee_number,sheet_kind,row_data");
  const fetchedAt = new Date().toISOString();
  if (path) { writeFileSync(path, JSON.stringify({ fetched_at: fetchedAt, soukatsu: rows })); console.log(`(② 取得結果を保存: ${path})`); }
  return { rows, fetchedAt };
}

/** ① の抽出物を読む。無ければ null */
function loadRows1(): { rows: Row[]; fetchedAt: string } | null {
  const dir = process.env.SOUKATSU1_DIR;
  if (!dir) return null;
  const files = readdirSync(dir).filter((f) => /^soukatsu_extract_\d{6}\.json$/.test(f)).sort();
  // ★ 走査ファイル 0 本で「0 件」と出さない (2026-09-26 に指示役がパスの %XX で踏んだ)
  if (!files.length) throw new Error(`★ SOUKATSU1_DIR=${dir} に soukatsu_extract_YYYYMM.json が 1 本もありません`);
  const rows: Row[] = [];
  let newest = 0;
  for (const f of files) {
    rows.push(...(JSON.parse(readFileSync(join(dir, f), "utf8")) as Row[]));
    newest = Math.max(newest, statSync(join(dir, f)).mtimeMs);
  }
  console.log(`(① 抽出物 ${files.length} 本を使用: ${dir} / ${files[0]}〜${files.at(-1)})`);
  return { rows, fetchedAt: new Date(newest).toISOString() };
}

type Section = { rows: number; counts: Counts; fetched_at: string };

function report(label: string, rows: Row[], fetchedAt: string, base: Section | undefined): { failed: boolean; negOk: boolean; section: Section } {
  const cols = numericColumns(rows);
  const hits = scan(rows, cols);
  const counts = countOf(hits);
  console.log(`\n================ ${label} ================`);
  const neg = negativeControl(rows, cols);
  console.log("負のコントロール (型ごとに 1 本。取得データの写しに 1 セル足す。DB もファイルも触らない):");
  for (const l of neg.lines) console.log("  " + l);
  const filledAll = [...cols.values()].reduce((a, s) => a + s.filled, 0);
  console.log(`母数: ${rows.length} 行 (取得 ${fetchedAt}) / 数値の列 ${cols.size} 列 / 数値の列で値があるセル ${filledAll}`);
  console.log(`数値として素直に読めないセル: ${hits.length}`);
  console.log("--- 型ごと (今どう読まれるか。例の値で。pickSoukatsu = soukatsu-diff.ts と同じ読み方) ---");
  for (const t of TYPES) {
    const hs = hits.filter((h) => h.type === t);
    if (!hs.length) { console.log(`  ${t.padEnd(8)}      0`); continue; }
    const ex = hs[0].value;
    const r = readers(ex);
    console.log(`  ${t.padEnd(8)} ${String(hs.length).padStart(6)}  列${new Set(hs.map((h) => h.col)).size} 事業所${new Set(hs.map((h) => h.office)).size}  例 ${JSON.stringify(ex)} → Number ${r.Number} / parseFloat ${r.parseFloat} / pickSoukatsu ${r.pickSoukatsu}`);
  }
  console.log("--- 列 × 型 (列の分母 = 値がある行数) ---");
  const byCol = new Map<string, Hit[]>();
  for (const h of hits) byCol.set(h.col, [...(byCol.get(h.col) ?? []), h]);
  for (const [c, hs] of [...byCol].sort((a, b) => b[1].length - a[1].length)) {
    const tc: Record<string, number> = {}, offs: Record<string, number> = {};
    for (const h of hs) { tc[h.type] = (tc[h.type] ?? 0) + 1; offs[h.office] = (offs[h.office] ?? 0) + 1; }
    console.log(`  ${c} (分母 ${cols.get(c)!.filled}) ${JSON.stringify(tc)} 事業所 ${JSON.stringify(offs)}`);
  }
  if (DETAIL) {
    const hs = hits.filter((h) => h.type === DETAIL);
    console.log(`--- 型 ${DETAIL} のセル (${hs.length}) ---`);
    for (const h of hs.sort((a, b) => (a.col + a.office + a.month).localeCompare(b.col + b.office + b.month)))
      console.log(`  ${h.col} ${h.month} ${h.office} ${h.emp} ${JSON.stringify(h.value)}`);
  }
  let failed = false;
  if (base && !UPDATE) {
    const { worse, better, dataChanged } = compare(base, rows.length, counts);
    console.log("--- 基準値との比較 ---");
    if (dataChanged) console.log(`  データが変わった (${dataChanged})。FAIL にしない。中身を見てから --update`);
    else console.log(`  ★ 悪化 ${worse.length} / 改善 ${better.length}`);
    for (const s of worse) console.log(`  ★ 悪化 ${s}`);
    for (const s of better) console.log(`  改善   ${s}`);
    failed = worse.length > 0;
  } else if (!UPDATE) console.log("基準値がありません。--update で作成してください");
  return { failed, negOk: neg.ok, section: { rows: rows.length, counts, fetched_at: fetchedAt } };
}

async function main() {
  console.log("=== 総括表の「数値のはずが数値でない」セル 2026-09-27 新設・読み取り専用 ===");
  console.log("★ check:all には入れていない (意図的)。総括表の手入力・取込し直しで件数が動く診断系のため");
  console.log("★ 対象: ② 支払用シート (payroll_soukatsu_rows) は常に。① (xlsm の抽出物) は SOUKATSU1_DIR を渡したときだけ");
  console.log("★ この検査が見ていないもの:");
  console.log("  ・① を渡さなかったときの ①。① の抽出物が古ければ その時点の値 (xlsm は再抽出しない)");
  console.log("  ・文字の列 (値がある行のうち 数値として素直に読めるのが 8 割未満の列)。例: 氏名 / 有給・特休・欠勤 (\"/欠22\" のような注記)");
  console.log("  ・数値として読めるが 値そのものが誤っているもの (手入力の誤り)。→ check:soukatsu-cause / check:soukatsu-source");
  console.log("  ・どのコードがそのセルを読んでいるか (コード側の洗い出しは指示役が担当)");
  const baseAll = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
  const out: Record<string, Section> = {};
  let failed = false, negOk = true;
  const two = await loadRows2();
  const r2 = report("② 支払用シート (payroll_soukatsu_rows)", two.rows, two.fetchedAt, baseAll.src2);
  out.src2 = r2.section; failed ||= r2.failed; negOk &&= r2.negOk;
  const one = loadRows1();
  if (one) {
    const r1 = report("① 旧システムの出力 (xlsm の抽出物)", one.rows, one.fetchedAt, baseAll.src1);
    out.src1 = r1.section; failed ||= r1.failed; negOk &&= r1.negOk;
  } else {
    console.log("\n(① は SOUKATSU1_DIR が無いので数えていない。基準値の ① は比べずに残す)");
    if (baseAll.src1) out.src1 = baseAll.src1;
  }
  console.log("");
  if (UPDATE) {
    writeFileSync(BASELINE_PATH, JSON.stringify({ _readme: baseAll._readme ?? "(新規)", updated_at: new Date().toISOString(), ...out }, null, 2) + "\n");
    console.log(`基準値を更新しました: ${BASELINE_PATH}`);
    console.log("★ _readme の「なぜこの件数か」を今回の件数に合わせて書き直すこと");
  }
  if (!negOk) { console.log("★ 負のコントロールが通らないので PASS を出しません"); process.exit(1); }
  if (failed) { console.log("★ FAIL: 総行数が同じなのに 数値でないセルが増えました。--detail=<型> で見てください"); process.exit(1); }
  console.log("PASS (★ 0 件 PASS ではない。基準値の件数を許容したうえでの PASS)");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e); process.exit(1); });
