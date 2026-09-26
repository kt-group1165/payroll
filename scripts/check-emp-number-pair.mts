/**
 * check:emp-number-pair — 職員番号を **事業所番号と対にせず**使っている箇所を コードから静的に見張る。
 *
 * 【なぜ作ったか】
 * ★ 職員番号は事業所をまたぐと重複する。★ 2026-09-26〜27 の 1 日半で この罠を 4 回踏んだ:
 * ```
 * 指示役   加瀬真紀江→野口養子 / 稲葉香織→後藤雅代 / 五十嵐尚子→久保田明美 と取り違えた
 *          (しかも 全セッションに「対で引け」と注意して回っている最中に踏んだ)
 * 給与A    同じ罠を同日に踏んだ
 * 労働時間管理の画面  職員番号だけで職員マスタを引き、★ 121 組中 14 組 (11.6%) が別人だった
 * 出勤簿の削除        職員番号だけで DELETE。別の事業所の同じ番号の人まで消える作りだった
 * ```
 * ★ 注意文では防げない。★ 実データでは 1,091 番号のうち 184 番号が 別人と衝突している。
 *
 * 【何を見るか】
 * ★ DB を読まない。コードを読む静的な検査。
 *   Supabase の 1 つのクエリの鎖の中で `employee_number` で絞っているのに、
 *   同じ鎖に `office_number` / `office_id` の絞りが無いものを挙げる。
 *
 * 【何を見ていないか】(出力にも出す)
 *   ・Map のキーの作り方 (`new Map(xs.map(x => [x.employee_number, x]))` の型)
 *     ★ 労働時間管理の画面で実際に問題だったのは **こちら**。正規表現では安全に読めない
 *   ・関数をまたいで office を絞っているもの (呼び出し元で絞っていれば安全だが、ここからは見えない)
 *   ・1 事業所ぶんしか入っていない表 (そもそも衝突しない)
 *   ・SQL Editor で手で流すもの
 *
 * 【基準値方式】0 を目指さない。★ 正当なもの (事業所を絞る前の候補出し・1 事業所限定の画面) があるため。
 *   ★ 増えたら落ちる。--update は 中身を見てから。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ★ `new URL(...).pathname` は 日本語を %XX のままにする。このリポジトリのパスには
 *   「介護システム統合」が入るので、そのまま readdirSync に渡すと **1 ファイルも読めず**、
 *   検査は静かに「0 件」と出る。★ 実際に一度そう出した (2026-09-27)。fileURLToPath を使う。
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASELINE = new URL("./check-emp-number-pair-baseline.json", import.meta.url);
const UPDATE = process.argv.includes("--update");

const DIRS = ["src", "scripts", "migrations"];
const EXT = /\.(ts|tsx|mts|mjs|js)$/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (EXT.test(e)) out.push(p);
  }
  return out;
}

/**
 * 1 つのクエリの鎖を切り出す。`.from("...")` から、次の `.from(` か 空行 2 つ、
 * または `;` で終わる文まで。★ 完璧ではないので「見ていないもの」に書いてある。
 */
type Finding = { file: string; table: string; snippet: string };
const findings: Finding[] = [];

for (const d of DIRS) {
  for (const f of walk(join(ROOT, d))) {
    // ★ 自分自身は見ない (負のコントロール用の文字列が引っかかるため)
    if (f.replace(/\\/g, "/").endsWith("scripts/check-emp-number-pair.mts")) continue;
    const src = readFileSync(f, "utf8");
    if (!src.includes("employee_number")) continue;
    // `.from("表")` ごとに、そこから 1,200 文字ぶんを鎖とみなす (次の .from( で切る)
    const re = /\.from\(\s*["'`]([a-z_]+)["'`]\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const start = m.index;
      const nextFrom = src.slice(start + m[0].length).search(/\.from\(\s*["'`]/);
      const end = nextFrom >= 0 ? start + m[0].length + nextFrom : Math.min(src.length, start + 1200);
      const chain = src.slice(start, Math.min(end, start + 1200));
      if (!/employee_number/.test(chain)) continue;
      // employee_number で **絞って** いるか (select に並べただけは対象外)
      const filtersEmp = /\.(eq|in|neq|like|ilike|filter)\(\s*["'`]employee_number["'`]/.test(chain)
        || /employee_number=(eq|in)\./.test(chain);
      if (!filtersEmp) continue;
      const filtersOffice = /\.(eq|in|filter)\(\s*["'`]office_(number|id)["'`]/.test(chain)
        || /office_(number|id)=(eq|in)\./.test(chain);
      if (filtersOffice) continue;
      const line = src.slice(0, start).split("\n").length;
      findings.push({
        file: `${relative(ROOT, f).replace(/\\/g, "/")}:${line}`,
        table: m[1],
        snippet: chain.replace(/\s+/g, " ").slice(0, 110),
      });
    }
  }
}

console.log("=== check:emp-number-pair  職員番号を事業所と対にせず絞っている箇所 ===\n");
// ★ 分母を必ず出す。0 件のとき「本当に無い」のか「読めていない」のかを見分けるため。
//   ★ 実際に ROOT の組み立てを間違えて 0 ファイルのまま「0 件」と出した (2026-09-27)
const scanned = DIRS.reduce((n, d) => n + walk(join(ROOT, d)).length, 0);
console.log(`分母: ${DIRS.join(" / ")} を走査 ${scanned} ファイル (うち employee_number を含むものを見る)`);
if (scanned === 0) {
  console.error("★ ファイルを 1 つも読めていません。ROOT の組み立てを疑うこと");
  process.exit(2);
}
console.log(`★ 見つかった鎖: ${findings.length} 件\n`);
for (const f of findings) console.log(`  ${f.file}  [${f.table}]\n      ${f.snippet}`);

// ── 負のコントロール: わざと当てはまる/当てはまらない文字列を食わせて 判定が効くか ──
{
  const good = `.from("payroll_employees").select("*").eq("office_number", o).eq("employee_number", n)`;
  const bad = `.from("payroll_employees").select("*").eq("employee_number", n)`;
  const emp = /\.(eq|in|neq|like|ilike|filter)\(\s*["'`]employee_number["'`]/;
  const off = /\.(eq|in|filter)\(\s*["'`]office_(number|id)["'`]/;
  const ok = emp.test(bad) && !off.test(bad) && emp.test(good) && off.test(good);
  if (!ok) { console.error("\n★ 負のコントロールが通りませんでした。判定が効いていないので結果を信用しないこと"); process.exit(2); }
  console.log("\n負のコントロール: 対で絞った鎖は挙げない / 番号だけの鎖は挙げる — OK");
}

console.log("\n⚠ この検査が見ていないもの:");
console.log("   ・Map のキーの作り方 (new Map(xs.map(x => [x.employee_number, x]))) — ★ 労働時間管理で");
console.log("     実際に問題だったのはこちら。正規表現では安全に読めないので 人が見るしかない");
console.log("   ・関数をまたいで office を絞っているもの (呼び出し元で絞っていれば安全だが ここからは見えない)");
console.log("   ・1 事業所ぶんしか入っていない表 (そもそも衝突しない)");
console.log("   ・SQL Editor で手で流すもの");

type Baseline = { _readme: string[]; keys: string[] };
const keys = findings.map((f) => `${f.file.split(":")[0]}|${f.table}`).sort();
const current: Baseline = {
  _readme: [
    "check:emp-number-pair の基準値。★ 0 を目指す検査ではない。",
    "★ なぜ 0 にできないか: 事業所を絞る前の候補出しや、1 事業所ぶんしか入っていない表への",
    "   問い合わせは 番号だけで正しい。全部を対にするのは やり過ぎになる。",
    "★ 行番号では覚えない (ファイル|表 で覚える)。周りを編集しても落ちないようにするため。",
    "★ 増えた = 新しく 番号だけで絞る鎖が足された、が読み。--update は中身を見てから。",
    "★ 実データ: 職員マスタ 1,091 番号のうち 184 番号が別人と衝突している (2026-09-27 実測)。",
  ],
  keys: [...new Set(keys)],
};

if (UPDATE) {
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + "\n");
  console.log(`\n基準値を更新しました: ${current.keys.length} 種`);
  process.exit(0);
}

let base: Baseline;
try { base = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline; }
catch { console.log("\n⚠ 基準値がありません。`npm run check:emp-number-pair -- --update` で作ってください"); process.exit(1); }

const known = new Set(base.keys);
const added = current.keys.filter((k) => !known.has(k));
console.log(`\n基準値 ${base.keys.length} 種 / 今回 ${current.keys.length} 種`);
if (added.length > 0) {
  console.log("\nFAIL — 新しく 番号だけで絞る鎖が増えました");
  for (const a of added) console.log("  ★ " + a);
  console.log("\n★ 事業所で絞れるなら絞る。絞らないのが正しいなら 理由をコメントに書いてから --update する");
  process.exit(1);
}
const gone = base.keys.filter((k) => !current.keys.includes(k));
if (gone.length > 0) console.log(`  (直った/消えた: ${gone.length} 種 — 落ち着いたら --update してよい)`);
console.log("\nPASS — 基準値より増えていません");
