/**
 * 資格の「いつから」を入れる (2026-09-30)。
 *
 *   SOUKATSU1_DIR=<① の抽出物の dir> node migrations/set_care_qualification_from_20260930.mjs            # DRY RUN
 *   SOUKATSU1_DIR=… node migrations/set_care_qualification_from_20260930.mjs --execute
 *   node migrations/set_care_qualification_from_20260930.mjs --revert --execute
 *
 * ── なぜ ────────────────────────────────────────────────────────────────
 * 2026-09-30 に 総括表の勤続手当から 資格の旗を 195 行立てた
 * (`set_care_qualification_from_soukatsu_20260930.mjs`)。★ そのとき **いつから**を入れなかったので、
 * ★ 総括表が まだ払っていない月にも さかのぼって勤続手当が付いた。
 *
 * ★ 実測: ①② が 0 円なのに 当方が払っている 7 人月 ¥10,120 のうち、★ この旗が原因なのは
 * ```
 *   1272404508|221010 吉田 美幸  202603 ¥1,747   ① は 202605 から払う
 *   1275800892|220502 田代 京子  202603 ¥1,153 / 202604 ¥1,220   ① は 202607 から払う
 * ```
 * ★ 残り 4 人月 (根本由香 202605-08 ¥6,000) は **月給の手入力** (`payroll_salary_settings.tenure_allowance`)
 *   なので この旗とは関係が無い。★ 触らない。
 *
 * ── なぜ この 2 名だけか ──────────────────────────────────────────────────
 * ★ 「① が 0 円の月と 払う月が混在する」人は 14 名いるが、★ 12 名は **勤続 1 年未満**で
 *   当方も 0 円になるため 影響しない (計算の結果で確かめた。人数ではなく 人月で測った)。
 * ★ 田代京子は 202604 まで パート(時給)・202605 から 社員(月給) で、★ パート時代は ① が払っていない。
 *
 * ⚠ ★ 入れる日は **① が最初に払った月の 1 日**。★ 資格の実際の取得日ではない。
 *   ★ 総括表が払い始めた時点しか分からないので それを使う (user 2026-09-30 の
 *   「総括表で勤続手当が出てるなら資格者」を 期間にも当てはめたもの)。
 *
 * 冪等。既に入っている行は 触らない。--revert は この script が入れた値だけ null に戻す。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const REVERT = process.argv.includes("--revert");

/** 事業所 | 社員番号 | いつから | 根拠 */
const TARGETS = [
  ["1272404508", "221010", "2026-05-01", "吉田 美幸 (やわた)。① は 202605 から勤続手当を払う。202603 に当方だけ ¥1,747"],
  ["1275800892", "220502", "2026-07-01", "田代 京子 (大網)。① は 202607 から。202604 まで パート(時給) で ① は払っていない。当方だけ 202603 ¥1,153 / 202604 ¥1,220"],
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

console.log(`=== 資格の「いつから」を入れる ${REVERT ? "【戻す】" : EXECUTE ? "【実行】" : "(DRY RUN)"} ===`);
const offices = await all("payroll_offices?select=id,office_number");
const offNumOfId = new Map(offices.map((o) => [o.id, o.office_number]));
const emps = await all("payroll_employees?select=id,employee_number,name,office_id,has_care_qualification,care_qualification_from,role_type,salary_type");
const byKey = new Map();
for (const e of emps) {
  const k = `${offNumOfId.get(e.office_id) ?? "?"}|${nn(e.employee_number)}`;
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(e);
}

const rows = [];
for (const [office, emp, from, why] of TARGETS) {
  const es = byKey.get(`${office}|${nn(emp)}`) ?? [];
  if (!es.length) { console.error(`★ ${office}|${emp} が payroll_employees に居ません`); process.exit(2); }
  for (const e of es) rows.push({ e, office, emp, from, why });
}
for (const r of rows) {
  const cur = r.e.care_qualification_from ?? null;
  const want = REVERT ? null : r.from;
  const skip = REVERT ? cur !== r.from : cur != null;
  console.log(`  ${skip ? "済 " : "★ "}${r.office}|${r.emp} ${r.e.name} (${r.e.role_type}/${r.e.salary_type}) 資格=${r.e.has_care_qualification} いつから ${cur ?? "null"} → ${want ?? "null"}${skip ? "  (変更なし)" : ""}`);
  if (!skip && !REVERT) console.log(`       ${r.why}`);
}
const todo = rows.filter((r) => (REVERT ? r.e.care_qualification_from === r.from : r.e.care_qualification_from == null));
console.log(`\n書き込む行数 ${todo.length}`);
if (!EXECUTE) { console.log(`(DRY RUN。${REVERT ? "--revert --execute" : "--execute"} で書き込みます)`); process.exit(0); }
for (const r of todo) await q(`payroll_employees?id=eq.${r.e.id}`, { method: "PATCH", body: JSON.stringify({ care_qualification_from: REVERT ? null : r.from }) });
console.log(`${todo.length} 行を書き換えました`);
console.log("★ 次に やわた (1272404508) と 大網 (1275800892) の 202603〜202604 を再計算すること");
console.log("★ 戻すときは --revert --execute");
