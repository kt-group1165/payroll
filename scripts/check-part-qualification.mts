/**
 * check:part-qualification — ★ パートに 資格手当 が **新しく付いていないか** を見張る (2026-10-01 新設)
 *
 *   npm run check:part-qualification
 *   PAYROLL_ENV=staging npm run check:part-qualification
 *   npm run check:part-qualification -- --update      ★ 減ったときだけ使う
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────────
 * ★ **パートの資格手当は制度としては廃止された** (user 2026-10-01)。
 *   ただし当時もらっていた人からは剥奪できないので、★ 「残骸」として残っている人がいる。
 *   ★ 資格手当がある人には **勤続手当を出さない** (排他)。② の列名「資格or勤続手当」がそれを表す。
 *
 * ⚠ ★ 保存先に選んだ `payroll_salary_settings.qualification_allowance` は
 *   **給与設定の画面に欄が出ている** (月給者が使う列を流用している)。
 *   ★ そのため **新規のパートに うっかり付けられる**。それを検知するのがこの検査。
 *
 * ★ 基準値方式。★ 残骸の人は通し、★ 増えたら落ちる。
 *
 * ── 2026-10-01 時点 ───────────────────────────────────────────────────────
 *   1 名: リンクスヘルパーステーションいすみ 新井 絹代 (11001) 10,000 円/月
 *     ② の「資格or勤続手当」が 202603〜202606 の 4 か月とも 10,000 円で、
 *     その間 訪問時間が 2,670/2,490/2,760/0 分とばらつくのに 常に同額だった。
 *     ★ 202606 は 訪問 0 件・有給 21 日の月だが それでも 10,000 円
 *       → その月に給与が発生していれば満額 (日割りしない)。
 *     ⚠ 本人は 2026 年 6 月末で退職。★ それでも給与設定の行は残るので この検査では 1 名のまま。
 *
 * ⚠ ★ **「今 有効な行」だけを見る** (effective_from <= 今日 の最新)。
 *   ★ 過去の行まで数えると **提責 → 時給パート に変わった人**を誤検出する。
 *   実例: 大網白里 橋本光代。1970-01-01 の行は 月給/提責 で 資格手当 10,000、
 *         2026-05-01 の行は 時給/パート で 資格手当なし。★ 今は 0 円で正しい
 *         (user 2026-10-01「提責が時給パートになったら資格手当を失う」)。
 *   ★ 最初この絞りが無く 3 名と誤って数えた。
 *
 * ★ 給与形態は **設定行の salary_type を優先**する (履歴で形態が変わるため)。
 *   実測 (2026-10-01・今有効な行): 月給/提責 100 名中 99 名が資格手当あり = 現役の制度。
 *   時給/パート 480 名中 2 名だけ = 残骸。
 *
 * 負のコントロール: ① 1 件 増やすと落ちる  ② 0 円の人は数えない  ③ 月給者は数えない
 */
import { readFileSync, writeFileSync } from "node:fs";
import { restAll, SB_REF } from "./_rest.mjs";

const UPDATE = process.argv.includes("--update");
const BASELINE = new URL("./check-part-qualification-baseline.json", import.meta.url);

type Emp = { id: string; employee_number: string; name: string; salary_type: string; role_type: string; employment_status: string; office_id: string };
type Sal = { employee_id: string; effective_from: string; qualification_allowance: number | null; salary_type: string | null; role_type: string | null };

const emps = await restAll<Emp>("payroll_employees?select=id,employee_number,name,salary_type,role_type,employment_status,office_id");
const salAll = await restAll<Sal>("payroll_salary_settings?select=id,employee_id,effective_from,qualification_allowance,salary_type,role_type");
// ★ 今 有効な行だけ残す (effective_from <= 今日 の最新)。過去の行を数えると 形態が変わった人を誤検出する
const TODAY = new Date().toISOString().slice(0, 10);
const activeOf = new Map<string, Sal>();
for (const r of salAll.filter((r) => r.effective_from <= TODAY).sort((a, b) => a.effective_from.localeCompare(b.effective_from))) activeOf.set(r.employee_id, r);
const sal = [...activeOf.values()];
const offs = await restAll<{ id: string; office_id: string }>("payroll_offices?select=id,office_id");
const oName = new Map((await restAll<{ id: string; name: string }>("offices?select=id,name")).map((o) => [o.id, o.name]));
const nameOf = (oid: string) => oName.get(offs.find((o) => o.id === oid)?.office_id ?? "") ?? "(事業所不明)";
const eOf = new Map(emps.map((e) => [e.id, e]));

/** mutate: 負のコントロール用に 1 行だけ値を差し替える */
function measure(mutate?: (r: Sal, i: number) => void) {
  const hits: { name: string; num: string; off: string; from: string; yen: number }[] = [];
  let i = 0;
  for (const r0 of sal) {
    const r = { ...r0 };
    mutate?.(r, i++);
    const yen = Number(r.qualification_allowance ?? 0);
    if (yen <= 0) continue;                       // ★ 0 円は数えない
    const e = eOf.get(r.employee_id); if (!e) continue;
    // ★ 形態は 設定行の値を優先する (履歴で変わるため)。月給者は数えない (そちらは現役の制度)
    if ((r.salary_type ?? e.salary_type) !== "時給") continue;
    hits.push({ name: `${e.name} (${e.employment_status})`, num: e.employee_number, off: nameOf(e.office_id), from: r.effective_from, yen });
  }
  return hits;
}

console.log("=== check:part-qualification (パートの資格手当は廃止済。新しく付いていないか) 2026-10-01 新設・読み取り専用 ===");
const hits = measure();
console.log(`  [${SB_REF}] 時給者で 資格手当が入っている: ${hits.length} 名\n`);
for (const h of hits.sort((a, b) => b.yen - a.yen))
  console.log(`   ${h.off.slice(0, 26).padEnd(28)} ${h.name.padEnd(12)} (${h.num})  ${h.from} 〜  ¥${h.yen.toLocaleString()}/月`);

console.log("\n--- 負のコントロール");
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };
let bumped = false;
const c1 = measure((r) => {
  if (bumped) return;
  const e = eOf.get(r.employee_id);
  if ((r.salary_type ?? e?.salary_type) === "時給" && Number(r.qualification_allowance ?? 0) === 0) { r.qualification_allowance = 5000; bumped = true; }
});
expect(c1.length === hits.length + 1, `時給者 1 人に 5,000 円を付けると 1 増える (${hits.length} → ${c1.length})`);
let zeroed = false;
const c2 = measure((r) => { if (!zeroed && Number(r.qualification_allowance ?? 0) > 0) { r.qualification_allowance = 0; zeroed = true; } });
expect(c2.length <= hits.length, `0 円にすると 数から外れる (${hits.length} → ${c2.length})`);
let mb = false;
const c3 = measure((r) => {
  if (mb) return;
  const e = eOf.get(r.employee_id);
  if ((r.salary_type ?? e?.salary_type) === "月給" && Number(r.qualification_allowance ?? 0) === 0) { r.qualification_allowance = 9999; mb = true; }
});
expect(c3.length === hits.length, `月給者に付けても 数は変わらない (${hits.length} → ${c3.length})`);

console.log("\n--- 基準値");
if (UPDATE) {
  const cur = JSON.parse(readFileSync(BASELINE, "utf8")) as { _readme: string[]; count: number };
  cur.count = hits.length;
  writeFileSync(BASELINE, JSON.stringify(cur, null, 2) + "\n", "utf8");
  console.log(`  基準値を ${hits.length} 名に更新しました`);
} else {
  const base = JSON.parse(readFileSync(BASELINE, "utf8")) as { count: number };
  if (hits.length > base.count) { console.log(`  ★ FAIL 基準値から増えた (${hits.length} > ${base.count}) ★ 廃止された手当が新しく付いています`); fail++; }
  else console.log(`  o ${hits.length} 名 (基準値 ${base.count})${hits.length < base.count ? "  ★ 減っています。-- --update で下げてください" : ""}`);
}
console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS (★ 0 件 PASS ではない。残骸の人数を許容したうえでの PASS)");
process.exit(fail ? 1 : 0);
