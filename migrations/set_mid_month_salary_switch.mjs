/**
 * 月の途中で 時給 → 月給 に切り替わった人の給与設定を、切替日の行で持たせる (2026-09-18)。
 *
 *   node migrations/set_mid_month_salary_switch.mjs --employee-id <uuid> --date 2026-03-20 --from 2026-04-01            # DRY RUN
 *   node migrations/set_mid_month_salary_switch.mjs ... --execute
 *
 * すること
 *   1. 切替日より前に有効な行 (例 1970-01-01) を 時給・パート にし、月給の固定給を 0 にする
 *      (これまで sync-master は 日割り済みの金額 35,840 をこの行に入れていた。月給の側の日割りは給与計算がする)
 *   2. --from の行 (切替後の月額) を写して effective_from = 切替日 / 給与形態 = 月給 の行を作る
 * 給与計算 (page.tsx) は その月の途中に始まる行を見つけると、実績・出勤簿を切替日で分けて 2 行で計算する。
 *
 * 例: ちはら台 狩野直子 (a84c9bcf-1ee7-412e-b6b6-c7746824a01f) 2026-03-20 から月給
 *     (パートの実績は 3/16 まで、月給の実績は 3/21 から。総括表 本人給 35,840 = 560×8h×8日)
 * 冪等。⚠ sync-master-from-soukatsu.mts を流し直すと 1 の行が日割り済みの金額に戻るので、流したらこれも流し直す
 */
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const EMP = opt("--employee-id"), DATE = opt("--date"), FROM = opt("--from");
if (!EMP || !/^\d{4}-\d{2}-\d{2}$/.test(DATE ?? "") || !FROM) { console.error("--employee-id --date YYYY-MM-DD --from YYYY-MM-DD を指定"); process.exit(1); }
const env = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "return=representation" };
async function req(method, p, body) {
  const r = await fetch(`${SB}/rest/v1/${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${p}: ${await r.text()}`);
  return r.json();
}
const rows = await req("GET", `payroll_salary_settings?select=*&employee_id=eq.${EMP}&order=effective_from`);
const before = rows.filter((r) => r.effective_from < DATE).at(-1);
const from = rows.find((r) => r.effective_from === FROM);
const existing = rows.find((r) => r.effective_from === DATE);
if (!before || !from) { console.error(`★ 切替前の行 / --from の行が見つかりません (${rows.map((r) => r.effective_from).join(", ")})`); process.exit(2); }
const ZERO = { base_personal_salary: 0, skill_salary: 0, position_allowance: 0, qualification_allowance: 0, tenure_allowance: 0,
  treatment_improvement: 0, specific_treatment_improvement: 0, treatment_subsidy: 0, fixed_overtime_pay: 0, special_bonus: 0,
  care_overtime_threshold_hours: 0, care_overtime_unit_price: 0, yocho_unit_price: 0, salary_type: "時給", role_type: "パート" };
const ops = [];
if (Object.entries(ZERO).some(([k, v]) => before[k] !== v))
  ops.push([`PATCH ${before.effective_from} の行 → 時給・パート / 月給の固定給 0 (本人給 ${before.base_personal_salary} → 0)`,
    () => req("PATCH", `payroll_salary_settings?id=eq.${before.id}`, ZERO)]);
if (!existing) {
  const copy = Object.fromEntries(Object.entries(from).filter(([k]) => !["id", "created_at", "updated_at"].includes(k)));
  ops.push([`INSERT ${DATE} の行 = ${FROM} の行の写し + 月給 (本人給 ${from.base_personal_salary} / 職能給 ${from.skill_salary})`,
    () => req("POST", "payroll_salary_settings", { ...copy, effective_from: DATE, salary_type: "月給" })]);
} else if (existing.salary_type !== "月給") {
  ops.push([`PATCH ${DATE} の行 → 月給`, () => req("PATCH", `payroll_salary_settings?id=eq.${existing.id}`, { salary_type: "月給" })]);
}
for (const [l] of ops) console.log(l);
console.log(`書き込み ${ops.length} 件`);
if (!EXECUTE) { console.log("DRY RUN (--execute で書き込み)"); process.exit(0); }
for (const [, run] of ops) await run();
console.log("完了");
