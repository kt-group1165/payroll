/**
 * 訪問介護の残業単価の基礎から 勤続手当 を外す (payroll_overtime_settings job_type=訪問介護)。
 *
 *   node migrations/set_houmon_overtime_exclude_tenure.mjs            # DRY RUN
 *   node migrations/set_houmon_overtime_exclude_tenure.mjs --execute
 *
 * 根拠: 総括表 2026-07 ケイティ系 11 事業所の月給者 118 名の「単価」が
 *   round((本人給+職能給+役職+資格+処遇改善+特別処遇改善+補助金) / 168h) (事務員は 159h) で全員一致。
 *   勤続手当を含めると 31 名しか合わない。
 * 他の job_type (居宅介護支援など) は未検証なので触らない。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY がありません"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

const r = await fetch(`${SB_URL}/rest/v1/payroll_overtime_settings?select=id,job_type,include_tenure_allowance,scheduled_hours_per_month&job_type=eq.訪問介護`, { headers: H });
if (!r.ok) { console.error(await r.text()); process.exit(1); }
const rows = await r.json();
if (rows.length !== 1) { console.error(`★ 訪問介護の設定が ${rows.length} 行`); process.exit(2); }
const row = rows[0];
console.log(`=== 訪問介護 残業設定 ${EXECUTE ? "【本番】" : "(DRY RUN)"} === 所定 ${row.scheduled_hours_per_month}h / 勤続手当を含む ${row.include_tenure_allowance}`);
if (row.include_tenure_allowance === false) { console.log("既に 勤続手当を含まない。何もしない"); process.exit(0); }
if (!EXECUTE) { console.log("  → include_tenure_allowance を false にする\nDRY RUN。--execute で書き込みます"); process.exit(0); }
const w = await fetch(`${SB_URL}/rest/v1/payroll_overtime_settings?id=eq.${row.id}`, { method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify({ include_tenure_allowance: false }) });
if (!w.ok) { console.error(await w.text()); process.exit(1); }
const out = await w.json();
if (out.length !== 1 || out[0].include_tenure_allowance !== false) { console.error("★ 更新を確認できません", out); process.exit(2); }
console.log("完了: include_tenure_allowance = false");
