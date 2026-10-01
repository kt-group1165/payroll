/**
 * 新井 絹代 (リンクスいすみ・パート) の 資格手当 10,000 円を 給与設定に入れる (2026-10-01)。
 *
 *   node migrations/set_arai_qualification_allowance_20261001.mjs              # DRY RUN
 *   node migrations/set_arai_qualification_allowance_20261001.mjs --execute
 *   PAYROLL_ENV=staging node migrations/... --execute
 *
 * ── なぜ ────────────────────────────────────────────────────────────────
 * ★ パートの資格手当は **制度としては廃止された**が、当時もらっていた人からは剥奪できないので
 *   残っている (user 2026-10-01)。★ 資格手当がある人には **勤続手当を出さない** (排他)。
 *   ② の列名「資格or勤続手当」がそのまま排他を表している。
 *
 * ★ 全 2,489 行のパートシートを調べて、★ 該当は **この 1 名だけ**だった。
 *   他の 15 名は 同じ列を使っていても 金額が月ごとに変わる = 勤続手当そのもの。
 *
 * ── 金額の根拠 ──────────────────────────────────────────────────────────
 *   ② 「資格or勤続手当」= 10,000 円。202603〜202606 の 4 か月とも同額。
 *   ★ その間の訪問時間は 2,670 / 2,490 / 2,760 / 0 分とばらつくのに 常に 10,000。
 *   ★ 202606 は 訪問 0 件・有給 21 日の月だが それでも 10,000 円
 *     → **その月に給与が発生していれば満額** (日割りしない。user 2026-10-01「A」)。
 *
 * ⚠ 本人は **2026 年 6 月末で退職** (user 2026-10-01)。202607 以降 ② に行が無いのと整合する。
 *   ⚠ ただし 職員マスタは employment_status="在職者" / resignation_date=null のまま。別途入力が要る。
 *
 * ⚠ 投入後に /payroll で リンクスいすみ の 2026年3〜6月を **再計算**すること。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const STAGING = process.env.PAYROLL_ENV === "staging";
const env = {};
for (const p of STAGING ? [".env.staging"] : ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) { console.error("★ 接続情報が読めません"); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
console.log(`[DB] ${STAGING ? "staging" : "本番"} ${/https:\/\/([a-z0-9]+)\./.exec(SB)?.[1]}`);

const EMP_NUMBER = "11001";       // 新井 絹代 (リンクスいすみ)
const AMOUNT = 10000;
const NOTE = "パートの資格手当 (廃止された制度の残骸)。② の「資格or勤続手当」10,000 円より。資格手当がある人は勤続手当を出さない (排他)。user 2026-10-01";

const q = async (path, init) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: H, ...init });
  const body = await r.text();
  if (!r.ok) throw new Error(`${path} ${r.status} ${body}`);
  return body ? JSON.parse(body) : null;
};

const emps = await q(`payroll_employees?select=id,name,employee_number,salary_type,role_type&employee_number=eq.${EMP_NUMBER}`);
if (emps.length !== 1) { console.error(`★ 職員が 1 人に決まりません (${emps.length} 件)`); process.exit(2); }
const emp = emps[0];
console.log(`\n対象: ${emp.name} (${emp.employee_number}) ${emp.salary_type}/${emp.role_type}`);
if (emp.salary_type !== "時給") { console.error("★ 時給者ではありません。中止します"); process.exit(2); }

const rows = await q(`payroll_salary_settings?select=id,effective_from,qualification_allowance&employee_id=eq.${emp.id}&order=effective_from`);
console.log(`給与設定 ${rows.length} 行`);
for (const r of rows) console.log(`  ${r.effective_from}  資格手当 ${r.qualification_allowance ?? "(null)"}`);
if (rows.length !== 1) { console.error("★ 行が 1 本に決まりません。手で確認してください"); process.exit(2); }
const row = rows[0];
if (Number(row.qualification_allowance ?? 0) === AMOUNT) { console.log("\n既に入っています。何もしません"); process.exit(0); }

console.log(`\n${row.effective_from} の行の 資格手当 を ${row.qualification_allowance ?? "(null)"} → ${AMOUNT} にします`);
if (!EXECUTE) { console.log("\n(DRY RUN。--execute で実行します)"); process.exit(0); }

await q(`payroll_salary_settings?id=eq.${row.id}`, { method: "PATCH", body: JSON.stringify({ qualification_allowance: AMOUNT, note: NOTE }) });
const after = await q(`payroll_salary_settings?select=effective_from,qualification_allowance&employee_id=eq.${emp.id}`);
console.log("入れた後:", JSON.stringify(after));
console.log("\n⚠ /payroll で リンクスヘルパーステーションいすみ の 2026年3月〜6月 を再計算してください。");
