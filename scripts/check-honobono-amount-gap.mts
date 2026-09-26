/**
 * check:honobono-amount — ほのぼのが「同じ条件の訪問なのに一部だけ賃金を払っていない」ところを見つける。
 *
 * 【なぜ作ったか】(2026-09-26 に サービス記録一覧の画面を作っていて見つけた)
 * payroll_service_records.amount = MEISAI (賃金集計【明細】) の「金額」列 = ★ ほのぼのがヘルパーに払った賃金。
 * 全 284,342 行のうち 21,570 行 (7.6%) が空だったので、何が空になるのかを実データで分けた:
 *
 * ```
 * 1272403534 / 202608 の実測 (実績 2,244 行 / 職員 25 名)
 *   ★ 月給 10 名  … その月の行が 全部空 (1,295 行)   → ほのぼのは月給者に訪問ごとの賃金を持たない。設計どおり
 *   時給  9 名  … 全部あり (421 行)
 *   時給  6 名  … ★ 混在 (528 行中 22 行だけ空)
 * ```
 *
 * 混在の 22 行をさらに分けると:
 * ```
 * 013052 ドタキャン / 010999 同行ドタキャン   そのコードは常に空 → ドタキャン手当で別に払う。設計どおり
 * 013001 自費 生2,500*0.5 / 013025 重1 120  そのコードは常に空 → 自費・独自サービス。設計どおり
 * ★ 021002 家事援助(自立)  あり 13 / 空 7   ← ★ 同じ事業所・同じ月・同じコードで 払われた行と 払われていない行が混ざる
 * ```
 *
 * ★ 最後の型だけが 説明の付かない空白 = **ほのぼの側の払い漏れの芽**。ここを数える。
 *
 * 【数え方】分母の定義を必ず読むこと
 *   分母  payroll_service_records の全行
 *   除外① その職員の その事業所×月の行が **100% 空** → 月給者の型。設計どおりなので数えない
 *         ⚠ 職員マスタの salary_type ではなく **実データの形**で判定する。
 *           salary_type は「今の値」で、過去の月に時給→月給の切替があると取り違えるため。
 *           (参考として salary_type との一致率も出す)
 *   除外② その 事業所×月×サービスコード が **100% 空** → ドタキャン・自費の型。設計どおりなので数えない
 *   数える 残り = 同じ 事業所×月×サービスコード に 「あり」と「空」が混ざっている行のうち、空の側
 *
 * 【基準値方式】0 を目指す検査ではない。★ いまの件数を固定し、**増えたら落ちる**。
 *   ★ なぜ 0 にできないか: 当方のデータではなく **ほのぼの側の出力**なので、当方からは直せない。
 *     直るのは ほのぼのが払い直したとき、または移行が終わって MEISAI を使わなくなったとき。
 *   ★ --update は 原因を潰してからにすること。悪化したまま更新すると穴を焼き付ける。
 *
 * 【負のコントロール】全部通る検査は「効いていない検査」と区別が付かないので、わざと壊して鳴ることを確かめた。
 * ```
 * SNAPSHOT の 111111 (身1) で 金額のある行を 1 つだけ空にする
 *   → 1,908 → 1,909 行 / exit 1 / 「111111 が 427 → 428 に増えました」と名指しで出た (2026-09-26)
 * ```
 * ★ DB は壊していない。SNAPSHOT (取得結果の写し) を壊して確かめている。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { restAll, normEmpNo } from "./_rest.mjs";

const BASELINE = new URL("./check-honobono-amount-gap-baseline.json", import.meta.url);
const UPDATE = process.argv.includes("--update");

type Rec = {
  employee_number: string; office_number: string; processing_month: string;
  service_code: string; service_type: string | null; amount: number | null;
};

console.log("=== check:honobono-amount  ほのぼのが一部だけ賃金を払っていない訪問 ===\n");

/**
 * ★ 284,342 行を読むので、他セッションと DB 読みが重なると詰まります。
 *   `SNAPSHOT=<path.json>` を付けると 1 回目は保存し、2 回目からはそれを使い回します。
 */
const SNAPSHOT = process.env.SNAPSHOT ?? "";
let rows: Rec[];
if (SNAPSHOT && existsSync(SNAPSHOT)) {
  rows = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Rec[];
  console.log(`(SNAPSHOT を使いました: ${SNAPSHOT})`);
} else {
  rows = await restAll<Rec>(
    "payroll_service_records?select=employee_number,office_number,processing_month,service_code,service_type,amount",
  );
  if (SNAPSHOT) { writeFileSync(SNAPSHOT, JSON.stringify(rows)); console.log(`(SNAPSHOT に保存しました: ${SNAPSHOT})`); }
}
console.log(`分母: payroll_service_records ${rows.length.toLocaleString()} 行`);
const nullRows = rows.filter((r) => r.amount == null);
console.log(`  うち 金額が空: ${nullRows.length.toLocaleString()} 行 (${((nullRows.length / rows.length) * 100).toFixed(1)}%)\n`);

// ── 除外① 事業所×月×職員 が 100% 空 = 月給者の型 ──
type Tally = { has: number; none: number };
const perEmp = new Map<string, Tally>();
for (const r of rows) {
  const k = `${r.office_number}|${r.processing_month}|${normEmpNo(r.employee_number)}`;
  const t = perEmp.get(k) ?? { has: 0, none: 0 };
  if (r.amount == null) t.none++; else t.has++;
  perEmp.set(k, t);
}
const monthlyLike = new Set([...perEmp.entries()].filter(([, t]) => t.has === 0).map(([k]) => k));
const excludedByEmp = [...perEmp.entries()].filter(([, t]) => t.has === 0).reduce((s, [, t]) => s + t.none, 0);
console.log(`除外① 月給者の型 (その事業所×月の行が全部空): ${monthlyLike.size.toLocaleString()} 人月 / ${excludedByEmp.toLocaleString()} 行`);

// ── 除外② 事業所×月×コード が 100% 空 = ドタキャン・自費の型 ──
const rest = rows.filter((r) => !monthlyLike.has(`${r.office_number}|${r.processing_month}|${normEmpNo(r.employee_number)}`));
const perCode = new Map<string, Tally>();
for (const r of rest) {
  const k = `${r.office_number}|${r.processing_month}|${r.service_code}`;
  const t = perCode.get(k) ?? { has: 0, none: 0 };
  if (r.amount == null) t.none++; else t.has++;
  perCode.set(k, t);
}
const alwaysNull = new Set([...perCode.entries()].filter(([, t]) => t.has === 0).map(([k]) => k));
const excludedByCode = [...perCode.entries()].filter(([, t]) => t.has === 0).reduce((s, [, t]) => s + t.none, 0);
console.log(`除外② そのコードが常に空 (ドタキャン・自費など): ${alwaysNull.size.toLocaleString()} 組 / ${excludedByCode.toLocaleString()} 行\n`);

// ── 残り = 混ざっているところの 空の側 ──
const gaps = rest.filter((r) => r.amount == null && !alwaysNull.has(`${r.office_number}|${r.processing_month}|${r.service_code}`));

const byCode = new Map<string, { n: number; label: string; offices: Set<string> }>();
for (const g of gaps) {
  const v = byCode.get(g.service_code) ?? { n: 0, label: g.service_type ?? "", offices: new Set<string>() };
  v.n++; v.offices.add(g.office_number);
  byCode.set(g.service_code, v);
}

console.log(`★ 説明の付かない空白: ${gaps.length.toLocaleString()} 行`);
console.log("  (同じ 事業所×月×サービスコード に 払われた行があるのに この行だけ払われていない)\n");
if (gaps.length > 0) {
  console.log("  サービスコード別 (上位 15):");
  for (const [code, v] of [...byCode.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 15)) {
    console.log(`    ${code.padEnd(8)} ${(v.label || "(名称なし)").padEnd(24)} ${String(v.n).padStart(5)} 行 / ${v.offices.size} 事業所`);
  }
  const byMonth = new Map<string, number>();
  for (const g of gaps) byMonth.set(g.processing_month, (byMonth.get(g.processing_month) ?? 0) + 1);
  console.log("\n  月別:");
  for (const [m, n] of [...byMonth.entries()].sort()) console.log(`    ${m}  ${n.toLocaleString()} 行`);
}

// ── 参考: 除外① が 職員マスタの salary_type と どれだけ合うか ──
{
  const offs = await restAll<{ id: string; office_number: string }>("payroll_offices?select=id,office_number");
  const offNumOf = new Map(offs.map((o) => [o.id, o.office_number]));
  const emps = await restAll<{ office_id: string; employee_number: string; salary_type: string }>(
    "payroll_employees?select=office_id,employee_number,salary_type",
  );
  const typeOf = new Map(emps.map((e) => [`${offNumOf.get(e.office_id) ?? ""}|${normEmpNo(e.employee_number)}`, e.salary_type]));
  let agree = 0, disagree = 0, unknown = 0;
  for (const k of monthlyLike) {
    const [off, , num] = k.split("|");
    const st = typeOf.get(`${off}|${num}`);
    if (st === undefined) unknown++;
    else if (st === "月給") agree++;
    else disagree++;
  }
  console.log(`\n参考: 除外① と 職員マスタの salary_type の一致`);
  console.log(`  月給 ${agree} 人月 / 月給でない ${disagree} 人月 / 職員マスタに無い ${unknown} 人月`);
  console.log(`  ⚠ salary_type は「今の値」。過去に 時給→月給 の切替があると合いません。判定には使っていません`);
}

// ── 基準値 ──
type Baseline = { _readme: string[]; total_gap_rows: number; by_service_code: Record<string, number> };
const current: Baseline = {
  _readme: [
    "check:honobono-amount の基準値。★ 0 を目指す検査ではない。",
    "★ なぜ 0 にできないか: これは当方のデータではなく **ほのぼのの出力** なので当方から直せない。",
    "   直るのは ほのぼのが払い直したとき、または 移行が終わって MEISAI を使わなくなったとき。",
    "★ いつ 0 になるはずか: ほのぼのからの移行が完了して payroll_service_records を",
    "   kaigo-app の実績 snapshot だけで埋めるようになったら、この検査ごと不要になる。",
    "★ --update は 原因を潰してからにすること。悪化したまま更新すると穴を焼き付ける。",
    "★ 件数が **増えた** = 新しく取り込んだ月に 同じ型の空白が出た、が読み。減るぶんには落ちない。",
  ],
  total_gap_rows: gaps.length,
  by_service_code: Object.fromEntries([...byCode.entries()].map(([k, v]) => [k, v.n])),
};

if (UPDATE) {
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + "\n");
  console.log(`\n基準値を更新しました: ${gaps.length.toLocaleString()} 行`);
  process.exit(0);
}

let base: Baseline;
try {
  base = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;
} catch {
  console.log("\n⚠ 基準値のファイルがありません。`npm run check:honobono-amount -- --update` で作ってください");
  process.exit(1);
}

console.log(`\n基準値 ${base.total_gap_rows.toLocaleString()} 行 / 今回 ${gaps.length.toLocaleString()} 行`);
const worse: string[] = [];
if (gaps.length > base.total_gap_rows) worse.push(`合計が ${base.total_gap_rows} → ${gaps.length} に増えました`);
for (const [code, n] of Object.entries(current.by_service_code)) {
  const b = base.by_service_code[code] ?? 0;
  if (n > b) worse.push(`  ${code} が ${b} → ${n} に増えました`);
}

console.log("\n⚠ この検査が見ていないもの:");
console.log("   ・当方の金額 (visit-pay.ts) が正しいか — これは **ほのぼのが払ったか** だけを見ている");
console.log("   ・月給者の訪問 — ほのぼのは訪問ごとの賃金を持たないので 突合しようがない");
console.log("   ・ドタキャン手当・自費が 別の経路で正しく払われているか");
console.log("   ・金額の多寡 — 空か空でないかだけを見ている");

if (worse.length > 0) {
  console.log("\nFAIL — 悪化しています");
  for (const w of worse) console.log("  " + w);
  console.log("\n★ 原因を見てから --update すること。増えた月・コードを上の一覧で確かめる");
  process.exit(1);
}
console.log("\nPASS — 基準値より増えていません");
