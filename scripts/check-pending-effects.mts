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
 *   [初任者研修調整の旗 2026-09-27]        13 件  → 無資格の減額が出る (② と ¥36,639 で対応)
 *   [HRD研修の入れ漏れ是正 2026-09-27]      2 件  → 研修手当が出る
 *   [通勤費の入れ漏れ是正 2026-09-27]       2 件  → 通勤費が出る
 *
 * ★ 一覧に無いマーカーが DB にあれば **自分で気づいて落ちます** (下の「見落としの自己点検」)。
 *   ★ 2026-09-27 に実際に 60 行のうち 56 行しか見ていない状態になっていた。
 *   ★ マーカーを足す側が この検査を直すのを忘れても、次に回した人に分かるようにする
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

/**
 * ★ 基準時刻は **持ちません。**行自身の payroll_monthly_inputs.updated_at と
 *   payroll_calc_results.calculated_at を 1 行ずつ比べます。
 *   ★ 以前は「入れたのは 2026-09-27」の定数 1 本で判定していましたが、
 *   種類ごとに投入時刻が違うので、先に入れた分の再計算が 後から入れた分にも
 *   「反映済み」と数えられていました (2026-09-27 に踏みかけた)。
 *   ★ 控えの "at" を書き写す案もやめました。控えに at が無いものがあり、
 *   写し間違えても誰も気づけないため。★ DB の行が自分で時刻を持っています。
 */
const MARKERS = [
  { note: "[社保の入れ漏れ是正 2026-09-27]", label: "社保の入れ漏れ", expect: 36, effect: "処遇改善が出る (+¥720,000 見込み)" },
  { note: "[遅刻早退の分を②から取込 2026-09-27]", label: "遅刻早退の分", expect: 5, effect: "控除が出る (−¥15,054 見込み)" },
  { note: "[月違い是正 2026-09-27]", label: "月違いの手入力", expect: 2, effect: "7 月と 8 月の二重が消える" },
  // ★ ② の初任者研修調整費 合計 ¥36,639 と 13/13 件で対応が取れることを実測 (2026-09-27)
  { note: "[初任者研修調整の旗 2026-09-27]", label: "初任者研修調整の旗", expect: 13, effect: "無資格の減額が出る (−¥36,639 見込み)" },
  // 童子悦 202608 / 岩坪恵 202608。どちらも ①② とも HRD研修 4:00・¥4,600 で 2 材料一致
  { note: "[HRD研修の入れ漏れ是正 2026-09-27]", label: "HRD研修の入れ漏れ", expect: 2, effect: "研修手当が出る (+¥6,900 見込み)" },
  { note: "[通勤費の入れ漏れ是正 2026-09-27]", label: "通勤費の入れ漏れ", expect: 2, effect: "通勤費が出る (+¥9,454 見込み)" },
];

// ★ 負のコントロール: DROP_MARKER=<note の一部> を付けると そのマーカーを一覧から外す。
//   ★ 「見落としの自己点検」が本当に鳴るかを確かめるための口。★ 検査を足した人は 1 回これで鳴らすこと。
//     DROP_MARKER=初任者研修調整 npx tsx scripts/check-pending-effects.mts   → exit 2 になるのが正しい
const DROP = process.env.DROP_MARKER ?? "";
const ACTIVE = DROP ? MARKERS.filter((m) => !m.note.includes(DROP)) : MARKERS;
if (DROP) console.log(`★ 負のコントロール: "${DROP}" を一覧から外しました (${MARKERS.length} → ${ACTIVE.length} 種)`);

console.log("=== check:pending-effects  入力は直したが 再計算がまだ のもの ===\n");

type MI = { office_number: string; processing_month: string; note: string | null; updated_at: string | null };
const mis = await all<MI>("payroll_monthly_inputs?select=office_number,processing_month,note,updated_at&note=not.is.null");
type Calc = { office_number: string; processing_month: string; calculated_at: string };
const calc = await all<Calc>("payroll_calc_results?select=office_number,processing_month,calculated_at");
const calcAt = new Map(calc.map((c) => [`${c.office_number}|${c.processing_month}`, c.calculated_at]));
console.log(`分母: 計算結果 ${calc.length} 事業所月 / note 付きの手入力 ${mis.length} 行\n`);
if (calc.length === 0) { console.error("★ 計算結果を 1 件も読めていません"); process.exit(2); }

// ★ 行ごとに「その行の updated_at より後に計算されているか」を見る
let pending = 0, done = 0;
for (const m of ACTIVE) {
  // ★ note は **元の文に追記される**ことがある (月違い是正がそう)。完全一致では拾えない。
  //   2026-09-27 に実際に 0 件と誤って出した。部分一致で引く
  const rows = mis.filter((x) => (x.note ?? "").includes(m.note));
  const stale = rows.filter((x) => (calcAt.get(`${x.office_number}|${x.processing_month}`) ?? "") < (x.updated_at ?? ""));
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

// ★ 見落としの自己点検: DB にある [.. YYYY-MM-DD] 形のマーカーで、MARKERS に無いものを挙げる
const known = new Set(ACTIVE.map((m) => m.note));
const seen = new Map<string, number>();
for (const r of mis) {
  for (const mm of String(r.note ?? "").matchAll(/\[[^\]]*\d{4}-\d{2}-\d{2}\]/g)) {
    seen.set(mm[0], (seen.get(mm[0]) ?? 0) + 1);
  }
}
const uncovered = [...seen].filter(([k]) => !known.has(k)).sort((a, b) => b[1] - a[1]);
const coveredRows = mis.filter((x) => ACTIVE.some((m) => (x.note ?? "").includes(m.note))).length;
console.log(`
★ 分母の内訳: マーカー付きの行 ${[...seen.values()].reduce((a, b) => a + b, 0)} / この検査が見ている ${coveredRows}`);
if (uncovered.length > 0) {
  console.error(`
★ この検査が知らないマーカーが ${uncovered.length} 種あります (MARKERS に足してください)`);
  for (const [k, v] of uncovered) console.error(`   ${String(v).padStart(4)} 件  ${k}`);
  console.error("★ 足さないと、その分の未反映が 0 件に見えます。exit 2 で終わります");
  process.exit(2);
}

if (pending > 0) {
  console.log(`\n⏳ 未反映 ${pending} 件。★ 138 事業所月を再計算すると 0 になります`);
  console.log("   ★ これは FAIL ではありません (exit 0)。再計算待ちを数えているだけです");
} else {
  console.log("\n✓ すべて反映済み。★ 金額が期待どおり動いたかは check:soukatsu-match / check:soukatsu-cause で見ること");
}
