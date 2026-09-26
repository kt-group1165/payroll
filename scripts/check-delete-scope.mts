/**
 * check:delete-scope — DELETE の絞り込みが足りないコードを、消す前に (コードを読んで) 見つける (2026-09-27)
 *
 *   npx tsx scripts/check-delete-scope.mts            # 基準値と比べる
 *   npx tsx scripts/check-delete-scope.mts --update   # 今の一覧を基準値にする
 *   npx tsx scripts/check-delete-scope.mts --all      # 絞れている DELETE も全部出す
 *
 * 【なぜ要るか】check:office-form-shrink は「消えた後」を見る。こちらは **消すコードの作り**を見る。
 * 2026-09-27 に 2 本の script が 書式の行を巻き込んで消していた:
 *   ・import_soukatsu_meeting_counts.mjs  事業所×月×項目名 で DELETE。import_batch_id を見ていなかった
 *   ・import_legacy_office_form.mjs       事業所×月 で丸ごと DELETE。同上
 * どちらも「月スコープ・事業所スコープは付いている」ので、見た目は丁寧だった。
 * ★ 複数の経路 (書式 CSV / 総括表① / 旧システム / 手入力) で行が入る表では、
 *   **どの経路で入った行か** で絞らないと 他の経路の行を巻き込む。
 *
 * 【判定】DELETE 1 か所ごとに、対象の表と 絞りの条件を読む。
 *   巻き込まない  id / import_batch_id / マーカー (notes の [fake…] 等) のどれかで絞っている
 *   ★要確認       複数経路の表 (MULTI_SOURCE) なのに 上のどれも無い
 *   ★月スコープ無し 月で区切る表なのに 月の条件も id・バッチ・マーカーも無い (前月分まで消える型)
 *   ★全件         条件が無い / `.neq("id", "000…")` (表を丸ごと消す書き方)
 *   それ以外       単一経路の表を 事業所・月・項目で絞っている (巻き込まない)
 *
 * 【基準値方式】今ある ★ は基準値に入れる (0 を目指さない)。
 *   ★ なぜ 0 にできないか: 画面の「この月の書式を削除」ボタンのように、**経路を問わず消すのが意図**の
 *     DELETE がある。それを経路で絞ると 利用者が消したいものが消えなくなる。どれが意図かは人が決める。
 *   ★ 新しく ★ の DELETE が増えたら落ちる。★ 行番号ではなく (ファイル, 表, 条件) で覚えるので、
 *     周りを編集しても落ちない。条件を足して ★ が消えたぶんには落ちない。
 *
 * 【負のコントロール】毎回、わざと絞りの無い DELETE の断片を読ませて ★ と判定されることを確かめる。
 *
 * ⚠ 見ていないもの:
 *   ・コードの読み取りは正規表現。条件を変数に入れてから渡している場合 (const q = `...`) は 変数の中身まで追う
 *     (同じファイルの const 定義だけ)。関数をまたいだ組み立ては追えない
 *   ・SQL (Supabase SQL Editor で手で流すもの) — ファイルに無い
 *   ・upsert の上書き (後勝ち) — 行は消えないが値が消える。import_soukatsu_rows.mjs の過誤版上書きはこの型
 *   ・実際に何行消えるか — それは check:office-form-shrink (消えた後) が見る
 */
import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const BASELINE = new URL("./check-delete-scope-baseline.json", import.meta.url);
const UPDATE = process.argv.includes("--update");
const ALL = process.argv.includes("--all");
const DIRS = ["migrations", "scripts", "src"];

/** 複数の経路で行が入る表。経路 (import_batch_id 等) で絞らないと他経路の行を巻き込む */
const MULTI_SOURCE = new Set([
  "payroll_office_form_records",   // 書式 CSV (batch あり) / 総括表① / 旧システム事業所入力 / 手入力補完
  "payroll_service_records",       // ほのぼの MEISAI / kaigo-app snapshot / 画面取込
  "payroll_attendance_records",    // 出勤簿 CSV (batch) / 手当て直し
]);
/** 月で区切って持つ表 */
const MONTHLY = new Set([...MULTI_SOURCE, "payroll_monthly_inputs", "payroll_billing_amount_items", "payroll_billing_unit_items", "payroll_billing_daily_items", "payroll_soukatsu_rows", "payroll_calc_results"]);

type Hit = { file: string; line: number; table: string; conds: string[]; verdict: string; sig: string; text: string };

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (/\.(mjs|mts|ts|tsx|js)$/.test(e.name) && !/check-delete-scope\.mts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 同じファイルの `const q = ` のような定義を 変数名 → 中身 で引けるようにする */
function constDefs(src: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const x of src.matchAll(/const\s+(\w+)\s*=\s*(`[^`]*`|"[^"]*"|'[^']*'|\{[^}]*\})/g)) m.set(x[1], x[2]);
  return m;
}

function classify(snippet: string, defs: Map<string, string>): { table: string; conds: string[]; verdict: string } {
  // 変数を 1 段だけ展開 (${q} / match(where) / .eq の中の変数名)
  let s = snippet;
  for (const [k, v] of defs) if (new RegExp(`\\b${k}\\b`).test(s)) s += " " + v;
  const table = /payroll_\w+/.exec(s)?.[0] ?? "(表を読めない)";
  const has = (re: RegExp) => re.test(s);
  const conds: string[] = [];
  if (has(/import_batch_id|batch\.id\b|batchIds|\bbatch_id\b/)) conds.push("バッチ");
  // ⚠ `.neq("id", "000…")` は「全件」の書き方。.eq の部分一致で id 絞りと読まないこと
  const allRows = has(/\.neq\(\s*["']id["']/);
  if (!allRows && has(/[?&]id=(eq|in)\.|(?<!n)\.eq\(\s*["']id["']|\.in\(\s*["']id["']|\bid=in\.|\bids\b/)) conds.push("id");
  if (has(/MARKER|\[fake|_sample_marker|notes["']?\s*[,=)]|notes=eq/)) conds.push("マーカー");
  if (has(/processing_month|billing_month|service_month|year_month|month_start|["']month["']|month=eq|\byear\b/)) conds.push("月");
  if (has(/office_number|office_id/)) conds.push("事業所");
  if (has(/item_name|item_key|record_type|segment|employee_number|employee_id|effective_from/)) conds.push("項目・人");
  const pinned = conds.some((c) => c === "バッチ" || c === "id" || c === "マーカー");
  let verdict = "巻き込まない";
  if (allRows || (conds.length === 0 && table.startsWith("payroll_"))) verdict = "★全件";
  else if (!pinned && MULTI_SOURCE.has(table)) verdict = "★要確認";
  else if (!pinned && MONTHLY.has(table) && !conds.includes("月")) verdict = "★月スコープ無し";
  return { table, conds, verdict };
}

function scan(file: string, src: string): Hit[] {
  const hits: Hit[] = [];
  const defs = constDefs(src);
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  const lineOf = (i: number) => src.slice(0, i).split("\n").length;
  // fetch(..., { method: "DELETE" })  → fetch( から DELETE まで
  for (const m of src.matchAll(/method:\s*["']DELETE["']/g)) {
    const start = src.lastIndexOf("fetch(", m.index!);
    if (start < 0 || m.index! - start > 600) continue;
    const snippet = src.slice(start, m.index! + m[0].length);
    const c = classify(snippet, defs);
    hits.push({ file: rel, line: lineOf(m.index!), ...c, sig: `${rel}|${c.table}|${c.conds.join("+")}`, text: snippet.replace(/\s+/g, " ").slice(0, 160) });
  }
  // supabase: .from("x").delete().eq(...)... → .from( から 文の終わり (; か 次の if/const) まで
  for (const m of src.matchAll(/\.delete\(\)/g)) {
    const start = src.lastIndexOf(".from(", m.index!);
    if (start < 0 || m.index! - start > 300) continue;
    const endRel = src.slice(m.index!).search(/;|\n\s*(if|const|let|for)\b/);
    const snippet = src.slice(start, m.index! + (endRel < 0 ? 300 : endRel));
    const c = classify(snippet, defs);
    hits.push({ file: rel, line: lineOf(m.index!), ...c, sig: `${rel}|${c.table}|${c.conds.join("+")}`, text: snippet.replace(/\s+/g, " ").slice(0, 160) });
  }
  return hits;
}

// ── 負のコントロール: 絞りの無い DELETE の断片を読ませる ──
const neg1 = scan("NEG.mjs", 'await fetch(`${SB}payroll_office_form_records?office_number=eq.${o}&processing_month=eq.${m}`, { method: "DELETE", headers: H });');
const neg2 = scan("NEG.ts", 'await supabase.from("payroll_monthly_inputs").delete().eq("office_number", o);');
const neg3 = scan("NEG.mjs", 'await fetch(`${SB}payroll_office_form_records?office_number=eq.${o}&processing_month=eq.${m}&import_batch_id=is.null`, { method: "DELETE", headers: H });');
const neg4 = scan("NEG.ts", 'await supabase.from("payroll_service_type_mappings").delete().neq("id", "00000000-0000-0000-0000-000000000000");');
const negOk = neg1[0]?.verdict === "★要確認" && neg2[0]?.verdict === "★月スコープ無し" && neg3[0]?.verdict === "巻き込まない" && neg4[0]?.verdict === "★全件";

const files = DIRS.flatMap((d) => { try { statSync(join(ROOT, d)); return walk(join(ROOT, d)); } catch { return []; } });
const hits = files.flatMap((f) => scan(f, readFileSync(f, "utf8")));
const flagged = hits.filter((h) => h.verdict.startsWith("★"));

console.log("=== check:delete-scope  DELETE の絞り込み (コードを読む・DB は読まない) ===\n");
console.log(`負のコントロール (絞り無しの断片が ★ / 経路で絞った断片が 巻き込まない と出るか): ${negOk ? "OK" : "★ NG"}`);
console.log(`\n分母: ${DIRS.join(" / ")} の ${files.length} ファイル / DELETE ${hits.length} か所`);
const byV = new Map<string, number>(); for (const h of hits) byV.set(h.verdict, (byV.get(h.verdict) ?? 0) + 1);
console.log("  " + [...byV].map(([k, v]) => `${k} ${v}`).join(" / "));

const show = ALL ? hits : flagged;
console.log(`\n--- ${ALL ? "全 DELETE" : "★ の DELETE"} ---`);
for (const h of show.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line))
  console.log(`  ${h.verdict.padEnd(8)} ${h.file}:${h.line}  ${h.table}  条件[${h.conds.join(",") || "無し"}]\n      ${h.text}`);

console.log("\n⚠ この検査が見ていないもの:");
console.log("   ・関数をまたいで組み立てた条件 (同じファイルの const だけ展開する)");
console.log("   ・SQL Editor で手で流す DELETE / upsert の上書き (後勝ち) / TRUNCATE");
console.log("   ・実際に何行消えるか (→ check:office-form-shrink)");
console.log("   ・★ が意図どおりかどうか (画面の「この月を削除」は経路を問わず消すのが意図。人が決める)");

type Baseline = { _readme: string[]; flagged: string[] };
const current: Baseline = {
  _readme: [
    "check:delete-scope の基準値。★ (経路で絞っていない / 月で区切っていない DELETE) を (ファイル|表|条件) で覚える。",
    "★ 0 を目指さない。画面の「この月の書式・実績・出勤簿を削除」ボタンは 経路を問わず消すのが意図なので ★ のまま残る。",
    "★ 新しい ★ が増えたら落ちる。★ 条件を足して ★ が消えたぶんには落ちない。",
    "★ --update は 新しい ★ が意図どおりか (巻き込んでよいか) を確かめてから。",
  ],
  flagged: [...new Set(flagged.map((h) => h.sig))].sort(),
};

if (UPDATE) {
  if (!negOk) { console.log("\n★ 負のコントロールが通らないので 基準値を更新しません"); process.exit(1); }
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + "\n");
  console.log(`\n基準値を更新しました: ★ ${current.flagged.length} 種`);
  process.exit(0);
}
let base: Baseline;
try { base = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline; }
catch { console.log("\n⚠ 基準値のファイルがありません。--update で作ってください"); process.exit(1); }
const added = current.flagged.filter((s) => !base.flagged.includes(s));
const gone = base.flagged.filter((s) => !current.flagged.includes(s));
console.log(`\n基準値 ★ ${base.flagged.length} 種 / 今回 ${current.flagged.length} 種  (消えた ${gone.length})`);
if (!negOk) { console.log("\n★ 負のコントロールが通らないので PASS を出しません"); process.exit(1); }
if (added.length) { console.log("\nFAIL — 絞りの無い DELETE が増えました"); for (const s of added) console.log("  " + s); process.exit(1); }
console.log("\nPASS — ★ の DELETE は増えていません");
