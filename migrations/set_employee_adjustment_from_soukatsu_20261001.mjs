/**
 * ① の「調整手当_従業員」(職員ごとの固定調整手当) を 月ごとの手入力 (adjustment) に入れる (2026-10-01)。
 *
 *   node migrations/set_employee_adjustment_from_soukatsu_20261001.mjs             # DRY RUN
 *   node migrations/set_employee_adjustment_from_soukatsu_20261001.mjs --execute
 *   node migrations/set_employee_adjustment_from_soukatsu_20261001.mjs --delete --execute   # 入れた行だけ消す
 *
 * ── 何を見つけたか ────────────────────────────────────────────────────────
 * ① (総括表データ) に **`調整手当_従業員`** という列があり、当システムに 対応する入力が無かった。
 * ★ 2026-10-01 に ① 全 6 か月 (202603〜08) + 202512/202601 を走査した結果 **3 名だけ**:
 * ```
 *   船橋   1245 手塚 有希     +50,000 / 月   ★ ①=② が 6 か月とも一致
 *   さつき 4062 髙橋 のり子    +3,000 / 月   ★ ①=② は 202603〜05 の 3 か月だけ (以降 ② に行が無い)
 *   高品   4062 髙橋 のり子    +3,000 / 月   ⚠ ② に 1 か月も行が無い → **入れない**
 *   花見川 2176 宮﨑 麻利     -75,000 / 月   ⚠ ② は 0 で 食い違う → **入れない**
 * ```
 *
 * ── 入れる／入れないの根拠 ────────────────────────────────────────────────
 * ★ 入力の欠けは **2 つ以上の材料が一致するときだけ**埋める
 * ([[feedback_two_sources_before_filling_input]])。★ ここでは ① と ② を 2 材料とした。
 * ```
 *   入れる   ①=② が一致した 9 人月 (手塚 6 + 髙橋(さつき) 3)
 *   入れない 髙橋(高品)  ★ ② に行が無い。★ 同一人物が 2 事業所に出るので
 *                        両方に入れると **二重支給**になる (同じ 4062・同じ 3,000)
 *   入れない 宮﨑 麻利   ★ ① は −75,000 だが ② は 0。★ ② が支払の正なので 入れると 月 75,000 の過少払いになる
 * ```
 * ⚠ ★ 「① にあるから当方にも要る」ではない。★ ① は 項目を足し切っていないことがある
 *   ([[payroll_layer1_total_is_not_authoritative]])。★ 手塚は ① の総支給にも 50,000 が入っていない。
 *
 * ── 効果 (実測) ──────────────────────────────────────────────────────────
 * ★ この 9 人月は **総支給の差が ちょうど この額だけ**。他に差が無い:
 * ```
 *   髙橋(さつき) 202603 当方 443,156 / ② 446,156 (差 3,000)  ← 差はこれ 1 項目だけ
 *   手塚 202603〜07 差 ちょうど 50,000 / 202608 は 51,150 (★ 特日 2,267 の差が別にある)
 * ```
 * → ★ 一致率 3,100/3,699 → **3,109/3,699 (83.8% → 84.0%)** になる見込み。
 *
 * ── ★ 列の側から機械的に掃引して 規則にした (2026-10-01) ──────────────────────
 * 「② の 調整手当だけで 総支給の差が説明できる」人月を 全社で数えると **83 人月**。
 * ★ そのうち ① にも同額の材料がある (= 2 材料一致) のは **9 人月だけ**で、
 *   ★ 残り 74 人月は ① に何も無い = **② の手入力** (型 A。直さない)。
 *   ★ 74 のほとんどが 202605 で、既知の「5 月は ② の調整手当の手入力が急増」と一致する。
 * ★ 追加で見つかったのは 齋藤 敦子 1 件だけだった (① は `調整手当_従業員` ではなく `過誤（手入力）` 側)。
 *
 * ⚠ 手塚 202608 だけは 総支給の差が 51,150 で 50,000 と一致しない。
 *   ★ 特日 2,267 の差が別にあるため。★ 調整手当 50,000 を入れるのは正しいが
 *   ★ この月は これだけでは 一致にならない (特日の差は check:tokubi 側の案件)。
 *
 * ⚠ 入れたら **その 事業所×月 を再計算**すること (船橋 / さつきが丘 の 202603〜08)。
 *   ★ そのあと npm run check:verification-verdicts で 要確認 が減ったことを確認する。
 *
 * 冪等。既に入っている行は 触らない。--delete は この script が入れた行 (note 一致) だけ消す。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");
const NOTE = "① 調整手当_従業員 から (set_employee_adjustment_from_soukatsu_20261001.mjs)";

/** 事業所番号 | 社員番号 | 月 | 額 | 根拠 */
const TARGETS = [
  ["1270906546", "1245", "202603", 50000, "手塚 有希 (船橋)。① 調整手当_従業員 50,000 = ② 調整手当 50,000"],
  ["1270906546", "1245", "202604", 50000, "同上"],
  ["1270906546", "1245", "202605", 50000, "同上"],
  ["1270906546", "1245", "202606", 50000, "同上"],
  ["1270906546", "1245", "202607", 50000, "同上"],
  ["1270906546", "1245", "202608", 50000, "同上"],
  ["1270203191", "4062", "202603", 3000, "髙橋 のり子 (さつきが丘)。① 3,000 = ② 3,000"],
  ["1270203191", "4062", "202604", 3000, "同上"],
  ["1270203191", "4062", "202605", 3000, "同上"],
  // ★ 列の側から機械的に掃引して 追加で見つけた 1 件 (① は `過誤（手入力）` のほうに入っている)
  ["1272401967", "632", "202603", -63920, "齋藤 敦子 (五井)。① 過誤（手入力）−63,920 = ② 調整手当 −63,920。★ 総支給の差 −63,920 と 1 円一致"],
];

const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) { console.error("★ .env.local が読めません"); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const q = async (path, init) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: H, ...init });
  if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`);
  const body = await r.text();          // ⚠ PostgREST は return=representation が無いと本文を返さない
  return body ? JSON.parse(body) : null;
};
async function all(path) {
  const out = []; let from = 0;
  for (;;) { const j = await q(`${path}${path.includes("?") ? "&" : "?"}order=id&offset=${from}&limit=1000`); out.push(...j); if (j.length < 1000) break; from += 1000; }
  return out;
}
const nn = (s) => String(s ?? "").trim().replace(/^0+/, "");

console.log(`=== ① 調整手当_従業員 → 月ごとの手入力 (adjustment) ${DELETE ? "【削除】" : EXECUTE ? "【実行】" : "(DRY RUN)"} ===`);
const cur = await all("payroll_monthly_inputs?select=id,office_number,employee_number,processing_month,item_key,numeric_value,note&item_key=eq.adjustment");
console.log(`いまの adjustment の行 ${cur.length} 件`);
const curOf = new Map(cur.map((r) => [`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, r]));

if (DELETE) {
  const mine = cur.filter((r) => r.note === NOTE);
  console.log(`この script が入れた行 ${mine.length} 件: ${mine.map((r) => `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}=${r.numeric_value}`).join(" ")}`);
  if (!EXECUTE) { console.log("(DRY RUN。--delete --execute で消します)"); process.exit(0); }
  for (const r of mine) await q(`payroll_monthly_inputs?id=eq.${r.id}`, { method: "DELETE" });
  console.log(`${mine.length} 件を消しました。★ 対象の 事業所×月 を再計算すること`);
  process.exit(0);
}

// 職員が実在するかを必ず確かめる (番号の取り違えを 静かに通さない)
const pofs = await all("payroll_offices?select=id,office_number");
const offIdOf = new Map(pofs.map((o) => [o.office_number, o.id]));
const emps = await all("payroll_employees?select=id,employee_number,name,office_id,salary_type");
const empOf = new Map();
for (const e of emps) { const on = [...offIdOf].find(([, id]) => id === e.office_id)?.[0]; if (on) empOf.set(`${on}|${nn(e.employee_number)}`, e); }

const todo = [];
for (const [on, emp, m, yen, why] of TARGETS) {
  const e = empOf.get(`${on}|${emp}`);
  if (!e) { console.error(`★ ${on}|${emp} が payroll_employees に居ません。★ 番号を確かめること`); process.exit(2); }
  const have = curOf.get(`${on}|${emp}|${m}`);
  if (have) { console.log(`  済 ${m} ${on}|${emp} ${e.name} 既に ${have.numeric_value} が入っている (触らない)`); continue; }
  console.log(`  ★ ${m} ${on}|${emp} ${e.name} (${e.salary_type}) ← ${yen.toLocaleString()} 円`);
  console.log(`       ${why}`);
  todo.push({ office_number: on, employee_number: e.employee_number, processing_month: m, item_key: "adjustment", numeric_value: yen, note: NOTE });
}
console.log(`\n書き込む行数 ${todo.length}`);
if (!EXECUTE) { console.log("(DRY RUN。--execute で書き込みます)"); process.exit(0); }
if (todo.length) await q("payroll_monthly_inputs", { method: "POST", body: JSON.stringify(todo) });
const after = await all("payroll_monthly_inputs?select=id,note&item_key=eq.adjustment");
console.log(`${todo.length} 件を入れました。確認: adjustment の行 ${after.length} 件 (うち この script ${after.filter((r) => r.note === NOTE).length} 件)`);
console.log("★ 次に 船橋 (1270906546) と さつきが丘 (1270203191) の 202603〜202608 を再計算すること");
console.log("★ そのあと npm run check:verification-verdicts で 要確認:総支給額 が 599 → 590 に減ることを確認する");
console.log("★ 戻すときは --delete --execute");
