/**
 * check:pending-effects — ★ 入力は直したが **再計算がまだ**なので反映されていないもの を数える。
 *
 * 【なぜ】
 * 2026-09-27 に 入力側を 5 件直した。★ どれも payroll_calc_results には出ていない
 * (138 事業所月は全件 2026-09-23 の計算のまま)。
 * ★ 「直した」と「効いた」は別。★ 再計算するまでの間、★ 何が待ち状態かを数えられるようにする。
 *
 * ★ 再計算が済んだら この検査は 0 に近づく。0 になったら 反映されたということ。
 *   (0 にならない = 入れた入力が 計算に拾われていない = ★ そちらが本当のバグ)
 *
 * 【数えるもの】どれも note のマーカーで引く。DB に印が残っているものだけ
 *   [社保の入れ漏れ是正 2026-09-27]        36 件  → 処遇改善が出る見込み
 *   [遅刻早退の分を②から取込 2026-09-27]    5 件  → 控除が出る見込み
 *   [月違い是正 2026-09-27]                2 件  → 二重払いが消える
 *
 * 【見ていないもの】(出力にも出す)
 *   ・コード側の是正 (km の二重 / 介護時間 / 手入力の脱落 …) — ★ note が残らないので数えられない
 *   ・会議件数の復元 361 行 — ★ 書式の表なので note が無い。check:office-form-shrink で見る
 *   ・入社日の埋め戻し 6 名 — ★ payroll_employees.hire_date で、note 列が無い
 *   ・金額が **いくら**動くか — ここは「反映されたか」だけを見る
 */
import { readFileSync } from "node:fs";

const env: Record<string, string> = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const KEY = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!SB || !KEY) throw new Error("★ .env.local が読めません");
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function all<T>(q: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB}/rest/v1/${q}${q.includes("?") ? "&" : "?"}order=id&offset=${from}&limit=1000`, { headers: H });
    if (!r.ok) throw new Error(`${r.status} ${q.slice(0, 60)}`);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(`配列でない: ${JSON.stringify(j).slice(0, 160)}`);
    out.push(...(j as T[]));
    if (j.length < 1000) break;
  }
  return out;
}

const MARKERS = [
  { note: "[社保の入れ漏れ是正 2026-09-27]", label: "社保の入れ漏れ", expect: 36, effect: "処遇改善が出る (+¥720,000 見込み)" },
  { note: "[遅刻早退の分を②から取込 2026-09-27]", label: "遅刻早退の分", expect: 5, effect: "控除が出る (−¥15,054 見込み)" },
  { note: "[月違い是正 2026-09-27]", label: "月違いの手入力", expect: 2, effect: "7 月と 8 月の二重が消える" },
];

console.log("=== check:pending-effects  入力は直したが 再計算がまだ のもの ===\n");

type MI = { office_number: string; processing_month: string; note: string | null };
const mis = await all<MI>("payroll_monthly_inputs?select=office_number,processing_month,note&note=not.is.null");
type Calc = { office_number: string; processing_month: string; calculated_at: string };
const calc = await all<Calc>("payroll_calc_results?select=office_number,processing_month,calculated_at");
const calcAt = new Map(calc.map((c) => [`${c.office_number}|${c.processing_month}`, c.calculated_at]));
console.log(`分母: 計算結果 ${calc.length} 事業所月 / note 付きの手入力 ${mis.length} 行\n`);
if (calc.length === 0) { console.error("★ 計算結果を 1 件も読めていません"); process.exit(2); }

// 入力を入れた時刻より後に計算されているか。★ note は入れた時刻を持たないので、
//   「入れたのは 2026-09-27」を基準にする (この日より後の計算なら反映されている)
const FIXED_AT = "2026-09-26T21:00:00Z";  // 実際の投入は 2026-09-26T21:5x〜22:0x UTC
let pending = 0, done = 0;
for (const m of MARKERS) {
  // ★ note は **元の文に追記される**ことがある (月違い是正がそう)。完全一致では拾えない。
  //   2026-09-27 に実際に 0 件と誤って出した。部分一致で引く
  const rows = mis.filter((x) => (x.note ?? "").includes(m.note));
  const stale = rows.filter((x) => (calcAt.get(`${x.office_number}|${x.processing_month}`) ?? "") < FIXED_AT);
  pending += stale.length; done += rows.length - stale.length;
  const mark = rows.length === m.expect ? "" : `  ★ 件数が期待 ${m.expect} と違う`;
  console.log(`  ${m.label.padEnd(16)} ${String(rows.length).padStart(3)} 件  うち未反映 ${String(stale.length).padStart(3)} 件${mark}`);
  console.log(`      → ${m.effect}`);
  if (rows.length !== m.expect) {
    console.log(`      ⚠ 期待 ${m.expect} 件。★ 撤去した / まだ入れていない / 別の誰かが触った のいずれか`);
  }
}

console.log(`\n★ 未反映 ${pending} 件 / 反映済み ${done} 件`);
console.log("\n⚠ この検査が見ていないもの:");
console.log("   ・コード側の是正 (km の二重 / 介護時間 / 手入力の脱落 …) — note が残らないので数えられない");
console.log("   ・会議件数の復元 361 行 — 書式の表に note が無い。check:office-form-shrink で見る");
console.log("   ・入社日の埋め戻し 6 名 — payroll_employees に note 列が無い");
console.log("   ・金額が **いくら** 動くか — ここは「反映されたか」だけ");

if (pending > 0) {
  console.log(`\n⏳ 未反映 ${pending} 件。★ 138 事業所月を再計算すると 0 になります`);
  console.log("   ★ これは FAIL ではありません (exit 0)。再計算待ちを数えているだけです");
} else {
  console.log("\n✓ すべて反映済み。★ 金額が期待どおり動いたかは check:soukatsu-match / check:soukatsu-cause で見ること");
}
