/**
 * 峯島しおり (おゆみ野) を ②基準 = 泊まり手当 10,000円/回 に切り替える (2026-09-24 user)。
 *
 *   node migrations/set_minejima_overnight.mjs            # DRY RUN
 *   node migrations/set_minejima_overnight.mjs --execute
 *
 * 【経緯】
 * ① (旧システムの出力) は 深夜手当 13,500円 を計算しているが、
 * ② (実際に払った額) は それを使わず **泊まり 1 回 10,000 円** に置き換えている。
 * 総支給額の再構成で確認済み: 6 か月中 5 か月が「固定給+手当+出張費+調整手当」だけで 1 円差なし
 * (深夜も残業代も乗っていない)。
 *
 * 【彼女の深夜は 泊まりの土曜側だけ】
 * 実績 221 件のうち time_period=深夜 は 30 件で、**全部が 土曜 00:00-09:00 の重度15%**。
 * 他の曜日・時間帯に深夜は 1 件も無い。よって 深夜手当を 0 にしても 泊まり以外に影響しない。
 *
 * 【やること】
 *   1. 夜朝単価を 0 にする → 夜朝・深夜とも対象外になる (単価 0 は「未設定」ではなく「対象外」)
 *      ⚠ 彼女の夜朝の時間は 0 なので、この変更で失われるのは 深夜手当だけ
 *   2. 月ごとの手入力 overnight_allowance に 泊まり手当を入れる (② の「・夜朝・深夜」と同額)
 *
 * 【入れる額 = ② の「・夜朝・深夜」列】土曜 00:00 開始の回数 × 10,000 円
 *   202603 40,000 (4回) / 202604 40,000 (4回) / 202605 50,000 (5回)
 *   202606 40,000 (4回) / 202607 40,000 (4回) / 202608 50,000 (5回)
 */
const EXECUTE = process.argv.includes("--execute");
import { readFileSync } from "node:fs";
const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" };
const get = async (q) => { const r = await fetch(`${SB}/rest/v1/${q}`, { headers: H }); const j = await r.json(); if (!Array.isArray(j)) throw new Error(JSON.stringify(j)); return j; };

const OFFICE = "1270501180", EMP_NUM = "398", NAME = "峯島";
const PLAN = { "202603": 40000, "202604": 40000, "202605": 50000, "202606": 40000, "202607": 40000, "202608": 50000 };

const offices = await get("payroll_offices?select=id,office_number");
const officeId = offices.find((o) => o.office_number === OFFICE)?.id;
if (!officeId) { console.error("★ 事業所が見つかりません"); process.exit(1); }
const emps = (await get(`payroll_employees?select=id,name,office_id&employee_number=eq.${EMP_NUM}`)).filter((e) => e.office_id === officeId);
if (emps.length !== 1 || !emps[0].name.includes(NAME)) { console.error("★ 職員を一意に特定できません:", JSON.stringify(emps)); process.exit(1); }
const emp = emps[0];

// ① 夜朝単価 (= 夜朝・深夜の対象フラグ) を 0 にする
const sal = await get(`payroll_salary_settings?select=id,effective_from,yocho_unit_price&employee_id=eq.${emp.id}&order=effective_from`);
const salOps = sal.filter((r) => Number(r.yocho_unit_price ?? 0) !== 0);
// ② 泊まり手当の手入力
const exist = await get(`payroll_monthly_inputs?select=processing_month,numeric_value&office_number=eq.${OFFICE}&employee_number=eq.${EMP_NUM}&item_key=eq.overnight_allowance`);
const already = new Map(exist.map((r) => [r.processing_month, Number(r.numeric_value ?? 0)]));
const inputOps = Object.entries(PLAN).filter(([m, v]) => already.get(m) !== v);

console.log(`=== 峯島しおり を ②基準に切替 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log(`① 夜朝単価を 0 にする (夜朝・深夜の対象外に) — ${salOps.length} 行`);
for (const r of salOps) console.log(`   ${r.effective_from} 夜朝単価 ${r.yocho_unit_price} → 0`);
console.log(`② 泊まり手当の手入力 — ${inputOps.length} 件`);
for (const [m, v] of inputOps) console.log(`   ${m} ${already.has(m) ? `${already.get(m)} → ` : ""}${v.toLocaleString()} 円`);
if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }

for (const r of salOps) {
  const res = await fetch(`${SB}/rest/v1/payroll_salary_settings?id=eq.${r.id}`, {
    method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify({ yocho_unit_price: 0 }) });
  const b = await res.json();
  if (!res.ok || !Array.isArray(b) || b.length !== 1) { console.error("★ 夜朝単価の更新に失敗:", JSON.stringify(b).slice(0, 300)); process.exit(1); }
  console.log(`   反映 ${r.effective_from} 夜朝単価 → 0`);
}
if (inputOps.length > 0) {
  const body = inputOps.map(([m, v]) => ({ office_number: OFFICE, employee_number: EMP_NUM, processing_month: m,
    item_key: "overnight_allowance", numeric_value: v,
    note: "泊まり手当 (金→土 日をまたぐ訪問) 1回10,000円 × 回数。② の「・夜朝・深夜」と同額。★規則未確定のため手入力 2026-09-24" }));
  const res = await fetch(`${SB}/rest/v1/payroll_monthly_inputs?on_conflict=office_number,employee_number,processing_month,item_key`, {
    method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body) });
  const b = await res.json();
  if (!res.ok || !Array.isArray(b) || b.length !== body.length) { console.error("★ 手入力の書き込みに失敗:", JSON.stringify(b).slice(0, 300)); process.exit(1); }
  console.log(`   反映 泊まり手当 ${b.length} 件`);
}
