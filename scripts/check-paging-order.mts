/**
 * check:paging-order — `.range(` でページングしているのに `.order(` が無い箇所を静的に見張る。
 * ★ DB を読まない。コードを読むだけ。
 *
 * 【なぜ】
 * ★ PostgREST は **order が無いと ページ間で行の並びを保証しない**。
 *   同じ行が 2 回来たり、★ 行が丸ごと抜けたりする。落ちないので気づけない。
 *   (memory: feedback_postgrest_paging_needs_order)
 *
 * 【2026-09-27 に直した 12 箇所】
 * ```
 * ★ src/app/payroll/page.tsx  payroll_salary_settings   ← ★ 給与計算の本体が 給与設定を読むところ
 *      コメントに「将来1000件を超え得るためページング取得」と書いてありながら order が無かった。
 *      ★ 実測 947 行 = 1000 まで **残り 53 行**。給与設定は履歴 (append-only) なので
 *        給与を 1 回変えるたびに増える。★ 抜けると その人の給与設定が消えて 支給額が壊れる
 *   src/app/salary/page.tsx / salary-list.tsx           payroll_salary_settings
 *   src/app/billing/*  (5 箇所)                          payroll_billing_amount_items / payments
 *   src/components/csv/billing-importer.tsx / src/lib/import-counts.ts
 * ```
 * ★ 発見の経緯: 給与B が check:delete-scope の作業中に 1 箇所見つけ、
 *   ★ 「直していません」と報告 → 指示役が全数を走査して 12 箇所と分かった。
 *   ★ 1 箇所の報告を 全数の調査に変える、が効いた例。
 *
 * 【見ていないもの】(出力にも出す)
 *   ・`.limit()` だけでページングしているもの (range を使わない形)
 *   ・関数をまたいで order を付けているもの (呼び出し側で付けていれば安全だが ここからは見えない)
 *   ・scripts/ と migrations/ (scripts は _rest.mts の restAll が order を必ず付ける)
 *   ・order を付けた列が 一意かどうか (id 以外を指定していると 同値で並びが揺れる)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// ★ pathname は日本語を %XX のままにする。このリポジトリのパスには日本語が入る
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

const files = walk(join(ROOT, "src"));
console.log("=== check:paging-order  order 無しでページングしている箇所 ===\n");
console.log(`分母: src/ の .ts/.tsx ${files.length} ファイル`);
if (files.length === 0) {
  console.error("★ ファイルを 1 つも読めていません。ROOT の組み立てを疑うこと");
  process.exit(2);
}

type Hit = { file: string; line: number; table: string };
const hits: Hit[] = [];
for (const f of files) {
  // ★ 自分自身は見ない (説明の中の .range( が引っかかる)
  if (f.split(sep).join("/").endsWith("scripts/check-paging-order.mts")) continue;
  const src = readFileSync(f, "utf8");
  const re = /\.range\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const start = src.lastIndexOf(".from(", m.index);
    if (start < 0) continue;
    const chain = src.slice(start, m.index);
    if (/\.order\(/.test(chain)) continue;
    hits.push({
      file: f.replace(ROOT, "").split(sep).join("/"),
      line: src.slice(0, m.index).split("\n").length,
      table: (/\.from\(\s*["'`]([a-z_]+)/.exec(chain) || [])[1] ?? "(変数)",
    });
  }
}

console.log(`★ order 無しでページングしている箇所: ${hits.length} 件\n`);
for (const h of hits) console.log(`  ${h.file}:${h.line}  [${h.table}]`);

// ── 負のコントロール: 判定が効いているか (毎回) ──
{
  const withOrder = `supabase.from("t").select("*").order("id").range(0, 999)`;
  const without = `supabase.from("t").select("*").range(0, 999)`;
  const judge = (s: string) => {
    const i = s.indexOf(".range(");
    const start = s.lastIndexOf(".from(", i);
    return start >= 0 && !/\.order\(/.test(s.slice(start, i));
  };
  if (!(judge(without) && !judge(withOrder))) {
    console.error("\n★ 負のコントロールが通りませんでした。判定が効いていないので結果を信用しないこと");
    process.exit(2);
  }
  console.log("\n負のコントロール: order 付きは挙げない / 無しは挙げる — OK");
}

console.log("\n⚠ この検査が見ていないもの:");
console.log("   ・.limit() だけでページングしているもの (range を使わない形)");
console.log("   ・関数をまたいで order を付けているもの (呼び出し側で付けていれば安全だが ここからは見えない)");
console.log("   ・scripts/ と migrations/ (scripts は _rest.mts の restAll が order を必ず付ける)");
console.log("   ・order に指定した列が一意かどうか (id 以外だと 同値で並びが揺れる)");

if (hits.length > 0) {
  console.log("\nFAIL — ★ 0 を目指す検査です。`.order(\"id\")` を足してください");
  console.log("   ★ PostgREST は order が無いと ページ間で行の並びを保証しません。落ちずに 行が抜けます");
  process.exit(1);
}
console.log("\nPASS — 0 件");
