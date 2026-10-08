/**
 * check:employment-status-sites — employment_status (今の状態 1 つ) を参照している箇所を静的に見張る (2026-09-27)。読み取りのみ・DB 不要。
 *
 *   npm run check:employment-status-sites
 *
 * なぜ: employment_status は「今の状態」しか持たない。★ 過去の月の計算・入力で これを直接見ると
 *   休職前・退職前の月まで外れる (林 美咲 202603〜05 ¥703,824 はこれ)。
 *   月ごとの判定は src/lib/payroll/employment-in-month.ts (isEmployedInMonth / leaveInMonth) に集めた。
 *
 * 規則:
 *   A. 給与計算 (src/app/payroll/**, src/lib/payroll/**) では employment_status を 比較してはいけない
 *      (=== / !== / .eq / .neq / .or / .in の中)。判定関数 employment-in-month.ts だけは例外
 *      ★ 読むだけ (select の列名・型の定義) は良い
 *   B. それ以外のファイルは 下の許可リストの件数 (行数) まで。★ 増えたら FAIL (新しい参照は 月ごとの判定が要らないか考えてから足す)
 *      減ったときは 許可リストを減らす (基準値方式)
 *
 * 負のコントロール: 給与計算のファイルに 比較の行を 1 行足した写し (メモリ上) を通すと A が鳴ること。
 * 見ていないもの: 文字列を組み立てて列名を作る書き方 / scripts/ と migrations/ / 他の app (kaigo-app は payroll_employees の状態を書いていない)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../src", import.meta.url));
const FN_FILE = "lib/payroll/employment-in-month.ts";
/** B の許可リスト: ファイル → [行数, 理由] */
const ALLOW: Record<string, [number, string]> = {
  "lib/payroll/employment-in-month.ts": [6, "判定関数そのもの"],
  "app/payroll/page.tsx": [2, "型の定義と select の列名だけ (判定は employment-in-month.ts)"],
  "types/database.ts": [1, "型の定義"],
  "app/employees/employees-list.tsx": [19, "職員マスタの編集・CSV (今の状態を直す画面)"],
  "app/bonus-payments/page.tsx": [3, "表示だけ"],
  "app/paid-leave/page.tsx": [3, "select の列名と 型・表示だけ (退職 の印・薄く出す)。付与のある人は退職者も出す (退職月までの有給は払う)"],
  "app/service-records/page.tsx": [3, "表示だけ (※退職 の印)"],
  "app/salary/salary-list.tsx": [6, "一覧と CSV 出力: 在職・休職は常に、退職者は「退職者も表示」のときだけ (2026-10-07。退職者・休職者に給与設定があるのに見えなかった) + 名前の横の 休職/退職 の印"],
  "lib/kaigo-import/build-records.ts": [3, "同じ番号が複数いるときの優先順 (在職者を優先)。影響は小"],
  // ★ 過去の月を選んで入力する画面が 今の状態で人を絞っている → 後から退職した人の過去月を直せない。
  //   isEmployedInMonth に揃える予定 (2026-09-27 時点は未着手)。揃えたら件数を減らす
  "app/office-worker-care/page.tsx": [3, "月を持たない設定画面 (払うかのステータス)。今の状態で絞るのが正しい (2026-10-06 確認)"],
  "app/monthly-inputs/page.tsx": [2, "型の定義と select の列名だけ (判定は isEmployedInMonth。2026-10-06 に揃えた)"],
  "app/distance/page.tsx": [1, "select の列名だけ (判定は isEmployedInMonth。2026-10-06 に揃えた)"],
  "lib/swr/use-kyotaku-employees.ts": [1, "対象者設定 (月を持たない設定) だけ今の状態で絞る。出勤簿の職員一覧は isEmployedInMonth (2026-10-06 に揃えた)"],
};
const CALC = (f: string) => (f.startsWith("app/payroll/") || f.startsWith("lib/payroll/")) && f !== FN_FILE;
/** 比較している行か (読むだけの行は除く) */
const COMPARE = /employment_status\s*(===|!==|==|!=)|(===|!==)\s*[A-Za-z_.?]*employment_status|\.(eq|neq|in|not|is)\(\s*["']employment_status|employment_status\.(eq|neq|in|not|is)\./;

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}
type Found = { file: string; line: number; text: string };
function scan(files: Map<string, string>): Found[] {
  const out: Found[] = [];
  for (const [file, src] of files) src.split(/\r?\n/).forEach((t, i) => { if (t.includes("employment_status")) out.push({ file, line: i + 1, text: t.trim() }); });
  return out;
}
function judge(found: Found[]): string[] {
  const errs: string[] = [];
  for (const f of found) if (CALC(f.file) && COMPARE.test(f.text)) errs.push(`A: 給与計算で employment_status を比較している ${f.file}:${f.line}  ${f.text.slice(0, 100)}`);
  const byFile = new Map<string, number>();
  for (const f of found) byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1);
  for (const [file, n] of byFile) {
    const a = ALLOW[file];
    if (!a) errs.push(`B: 許可リストに無いファイルで参照 ${file} (${n} 行)`);
    else if (n > a[0]) errs.push(`B: ${file} の参照が ${a[0]} → ${n} 行に増えた`);
  }
  return errs;
}

const files = new Map<string, string>();
for (const p of walk(ROOT)) files.set(relative(ROOT, p).replace(/\\/g, "/"), readFileSync(p, "utf8"));
const found = scan(files);
console.log("=== check:employment-status-sites ===");
console.log(`src の .ts/.tsx ${files.size} ファイル / employment_status を含む行 ${found.length} (${new Set(found.map((f) => f.file)).size} ファイル)`);

// 負のコントロール
{
  const broken = new Map(files);
  broken.set("app/payroll/page.tsx", (files.get("app/payroll/page.tsx") ?? "") + `\nconst x = emps.filter((e) => e.employment_status === "在職者");\n`);
  const errs = judge(scan(broken));
  const okNc = errs.some((e) => e.startsWith("A:"));
  console.log(`負のコントロール: 給与計算に比較の行を 1 行足すと A が鳴る … ${okNc ? "o" : "★ FAIL"}`);
  if (!okNc) process.exit(1);
}

const errs = judge(found);
for (const [file, [n, why]] of Object.entries(ALLOW)) {
  const now = found.filter((f) => f.file === file).length;
  console.log(`  ${now > n ? "★" : now < n ? "↓" : "o"} ${file.padEnd(40)} ${now}/${n} 行  ${why}${now < n ? " (減った。許可リストを減らす)" : ""}`);
}
for (const e of errs) console.log(`  ★ FAIL ${e}`);
console.log(errs.length ? `★ FAIL ${errs.length} 件` : "o 悪化なし");
console.log("見ていないもの: 文字列を組み立てた列名 / scripts・migrations / 他の app");
if (errs.length) process.exit(1);
