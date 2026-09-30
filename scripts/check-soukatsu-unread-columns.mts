/**
 * check:soukatsu-unread-columns — ①② の列のうち **当方が 1 度も読んでいない列**を機械的に全部出す。★ 基準値方式・読み取り専用。
 *
 *   SOUKATSU1_DIR=<① の抽出物の dir> npm run check:soukatsu-unread-columns
 *   SOUKATSU1_DIR=… npm run check:soukatsu-unread-columns -- --update
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────────
 * 2026-10-01 に ① の `調整手当_従業員` (職員ごとの固定調整手当) が **当方に無い**ことが分かった。
 * ★ 見つけ方が「不一致の大きい人を 1 人ずつ開く」だったので、★ 同じ型の抜けが他にもあれば
 * また 1 人ずつ開くまで気づけない。★ 列の側から 機械的に全部列挙する
 * (サービスコード接頭辞の事故と同じ教訓: 個別に直さず まず全部列挙する)。
 *
 * ── 何を出すか ────────────────────────────────────────────────────────────
 *   ①② に出てくる列名ぜんぶ × 「値が入っている人月」 × 「当方が読んでいるか」
 *   ★ 読んでいる = SOUKATSU_ALIASES の別名に入っている (= 画面の突合に出る)
 *   ★ 読んでいない列に 値が入っていたら **手当の取りこぼしの候補**
 *
 * ── この検査が見ていないもの ──────────────────────────────────────────────
 *   ・読んでいる列の **値が合っているか** (→ check:verification-verdicts)
 *   ・読んでいない列が 本当に支給に要るのか。★ ① は総支給に足していない列も持つ
 *     ([[payroll_layer1_total_is_not_authoritative]])。★ ② と両方に値があるかで絞る
 *   ・時間の列 (分) の妥当性 (→ check:soukatsu-time)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { restAll } from "./_rest.mjs";
import { SOUKATSU_ALIASES } from "../src/lib/payroll/soukatsu-diff.js";

const UPDATE = process.argv.includes("--update");
const BASELINE = new URL("./check-soukatsu-unread-columns-baseline.json", import.meta.url);
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };

type L1Row = { office_number: string; employee_number: string; sheet_kind: string; row_data: Record<string, unknown> };
type L2Row = { office_number: string; processing_month: string; employee_number: string; sheet_kind: string; row_data: Record<string, unknown> };

/** 円として読めて 0 でない値か (カンマ付き文字列も数値に直す) */
const nonZeroYen = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) && v !== 0 ? v : null;
  const s = String(v).normalize("NFKC").replace(/,/g, "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;      // 時間 "12:34" や 日付は ここで落ちる
  const n = Number(s);
  return Number.isFinite(n) && n !== 0 ? n : null;
};
/** 画面 (/verification) の突合が読む列 (SOUKATSU_ALIASES の別名ぜんぶ) */
const SCREEN = new Set(Object.values(SOUKATSU_ALIASES).flat());
/**
 * ★ 列名が **当方のコードのどこかに文字列として出てくるか**。
 *   ★ 突合の写像は 1 か所ではない (画面は SOUKATSU_ALIASES / check:soukatsu-item-gap は自前の MAP_PART・MAP_SHA /
 *   取込 script も それぞれ列名を持つ)。★ SOUKATSU_ALIASES だけで測ると
 *   「読んでいない」が 98 種類に膨らんで 本当の抜けが埋もれる (2026-10-01 に踏んだ)。
 * ⚠ 文字列の grep なので **動的キーは見つけられない** ([[feedback_grep_literal_misses_dynamic_key]])。
 *   ★ ただし 列名の別名は必ず literal で書くので、★ 「1 度も出てこない」= 読んでいない は成り立つ。
 */
const CODE_BLOB = (() => {
  const texts: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p2 = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p2); continue; }
      if (/\.(ts|tsx|mts|mjs|js|py)$/.test(e.name)) { try { texts.push(readFileSync(p2, "utf8")); } catch { /* 読めないファイルは飛ばす */ } }
    }
  };
  for (const r of ["src", "scripts", "migrations"]) { try { walk(r); } catch { /* dir が無い */ } }
  return texts.join("\n");
})();
const hasMention = (col: string) => CODE_BLOB.includes(col);
const READ = { has: (col: string) => SCREEN.has(col) || hasMention(col) };
/** 明らかに支給と関係ない列 (件数・日数・時間・単価・メモ)。★ 名前で除くので 新しい列が増えたら見直す */
const IGNORE = /件数|日数|時間|^出勤$|単価|従業員コード|氏名|最新再集計|労災|距離|km|ｋｍ|^年月|^月$|^年$|コード|区分|備考|メモ|^No|番号/;

async function main() {
  console.log("=== check:soukatsu-unread-columns (①② の列で 当方が読んでいないもの) 2026-10-01 新設・読み取り専用 ===");
  console.log("★ check:all には入れていない (① の写しの dir が要る診断系)");
  const dir = process.env.SOUKATSU1_DIR;
  if (!dir) { console.log("★ SOUKATSU1_DIR=<① の抽出物のある dir> が要る"); process.exit(1); }
  const files = readdirSync(dir).filter((f) => /^soukatsu_extract_\d{6}\.json$/.test(f)).sort();
  if (!files.length) { console.log(`★ ${dir} に soukatsu_extract_YYYYMM.json が 1 本もない (0 件と出さない)`); process.exit(1); }

  /** 列名 → { l1人月, l2人月, 例 } */
  const cols = new Map<string, { l1: number; l2: number; l1yen: number; l2yen: number; ex: string[] }>();
  const bump = (k: string, side: "l1" | "l2", yen: number, ex: string) => {
    const c = cols.get(k) ?? { l1: 0, l2: 0, l1yen: 0, l2yen: 0, ex: [] };
    c[side]++; c[`${side}yen` as "l1yen" | "l2yen"] += yen;
    if (c.ex.length < 3) c.ex.push(ex);
    cols.set(k, c);
  };
  let l1rows = 0;
  for (const f of files) {
    const m = /_(\d{6})\.json$/.exec(f)![1];
    for (const r of JSON.parse(readFileSync(join(dir, f), "utf8")) as L1Row[]) {
      l1rows++;
      for (const [k, v] of Object.entries(r.row_data)) {
        const y = nonZeroYen(v);
        if (y != null) bump(k, "l1", y, `${m} ${r.office_number}|${r.employee_number} ${y}`);
      }
    }
  }
  const l2 = await restAll<L2Row>("payroll_soukatsu_rows?select=id,office_number,processing_month,employee_number,sheet_kind,row_data");
  for (const r of l2) for (const [k, v] of Object.entries(r.row_data)) {
    const y = nonZeroYen(v);
    if (y != null) bump(k, "l2", y, `${r.processing_month} ${r.office_number}|${r.employee_number} ${y}`);
  }
  console.log(`① ${l1rows} 行 (${files.length} か月) / ② ${l2.length} 行 / 列の種類 ${cols.size}`);

  const unread = [...cols].filter(([k]) => !READ.has(k) && !IGNORE.test(k)).sort((a, b) => (b[1].l1 + b[1].l2) - (a[1].l1 + a[1].l2));
  const both = unread.filter(([, c]) => c.l1 > 0 && c.l2 > 0);
  console.log(`\n--- ★ 当方が読んでいない列で 値が入っているもの ${unread.length} 種類 (うち ①② 両方に値があるのは ${both.length})`);
  for (const [k, c] of unread) {
    console.log(`  ${(c.l1 > 0 && c.l2 > 0 ? "★ " : "  ")}${k.padEnd(24)} ① ${String(c.l1).padStart(5)} 人月 ¥${Math.round(c.l1yen).toLocaleString().padStart(12)}  / ② ${String(c.l2).padStart(5)} 人月 ¥${Math.round(c.l2yen).toLocaleString().padStart(12)}`);
    console.log(`       例: ${c.ex.join(" / ")}`);
  }
  console.log(`\n(参考) 当方が読んでいる列 ${[...cols].filter(([k]) => READ.has(k)).length} 種類 / 無視した列 ${[...cols].filter(([k]) => !READ.has(k) && IGNORE.test(k)).length} 種類`);

  console.log("\n--- 負のコントロール");
  expect(nonZeroYen("12:34") === null, "時間の書式 (12:34) は 円として読まない");
  expect(nonZeroYen("50,000") === 50000, "カンマ付きの文字列は 円として読める");
  expect(nonZeroYen(0) === null && nonZeroYen("") === null && nonZeroYen(null) === null, "0・空・null は 値が無い扱い");
  expect(nonZeroYen("#VALUE!") === null, "エラー値は 円として読まない");
  expect(!SCREEN.has("調整手当_従業員"), "★ 調整手当_従業員 は 画面の突合 (SOUKATSU_ALIASES) には 入っていない");
  expect(hasMention("総支給額（パート）"), "★ 別の検査が読む列 (総支給額（パート）) は コードに出てくると判定できる");
  // ⚠ ★ この検査自身も走査対象なので、★ 文字列を literal で書くと **自分に当たって** 制御が壊れる
  //   (2026-10-01 に踏んだ)。★ 実行時に組み立てて ソースに現れないようにする
  const absent = ["列名", "存在", "しない"].join("_") + "_" + Date.now();
  expect(!hasMention(absent), `コードに無い文字列 (${absent}) は 出てこないと判定できる`);
  expect(READ.has("移動手当") && READ.has("・特日"), "別名も 読んでいる列に数える (移動手当 / ・特日)");
  expect(IGNORE.test("出勤日数") && IGNORE.test("訪介実績時間") && !IGNORE.test("調整手当_従業員"), "件数・時間の列は 無視するが 手当の列は無視しない");

  const counts: Record<string, number> = { "コードに出てこない列 (値あり)": unread.length, "★ ①② 両方に値がある列": both.length };
  for (const [k, c] of both) counts[`両方:${k}`] = c.l1 + c.l2;

  type Baseline = { _readme: string[]; counts: Record<string, number> };
  const baseline: Baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline : { _readme: [], counts: {} };
  if (UPDATE) {
    baseline.counts = counts;
    writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n", "utf8");
    console.log("\n基準値を更新しました");
  } else {
    console.log("\n--- 基準値");
    for (const [k, v] of Object.entries(counts)) {
      const b = baseline.counts[k];
      if (b == null) { console.log(`  ・${k} = ${v} (基準値なし)`); continue; }
      if (v > b) expect(false, `${k} が基準値から増えた (${v} > ${b})`);
      else console.log(`  o ${k} = ${v} (基準値 ${b})`);
    }
  }
  console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS (★ 0 件 PASS ではない。基準値の件数を許容したうえでの PASS)");
  process.exit(fail ? 1 : 0);
}
await main();
