/**
 * 五井 西川裕美子 202604 の 事業所書式「通勤km 825.3」を 0 にする (2026-09-24 user 了承)。
 *
 *   node migrations/fix_nishikawa_commute_to_trip.mjs            # DRY RUN
 *   node migrations/fix_nishikawa_commute_to_trip.mjs --execute
 *
 * 【何が起きていたか】825.3km が **通勤費と出張費の両方**に回り ¥10,482 過大になっていた。
 *   事業所書式  通勤km 825.3 / 出張km 空     ← 欄の間違い (202604 の 1 か月だけ)
 *   月ごとの手入力 business_km 825.3          ← 2026-09-23 に「出張km の入力漏れ」として補った
 *   → 通勤費 825.3×12.7 = 10,482 と 出張費 10,482 の両方が出ていた
 *
 * 【総括表 (= 実際に払った額)】
 *   202604  距離(出) 825.3 / 出張費 10,482 / 通勤費 **0**
 *   他の 5 か月は 書式の **出張km** 欄に入っていて 通勤費は全月 0。202604 だけ欄を間違えている。
 *
 * 【なぜ書式を 0 にするか】user 2026-09-24「入力の誤りは入力で直す」。
 *   計算側に「ヘルパーの通勤距離は出張に付け替える」という例外を入れると、
 *   船橋 金子百恵 (通勤km 欄に **定期代の円**) のような別種まで巻き込む。
 *
 * ⚠ 出張km は 月ごとの手入力 (business_km) に既にあるので ここでは触らない。
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

const OFFICE = "1272401967", EMP = "260201", MONTH = "202604", EXPECT = 825.3;
const rows = await get(`payroll_office_form_records?select=id,item_name,numeric_value&office_number=eq.${OFFICE}&employee_number=eq.${EMP}&processing_month=eq.${MONTH}&item_name=eq.%E9%80%9A%E5%8B%A4km`);
const target = rows.filter((r) => Number(r.numeric_value) === EXPECT);
console.log(`=== 五井 西川裕美子 ${MONTH} 通勤km → 0 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
if (target.length !== 1) {
  console.log(`  対象が ${target.length} 件です (期待 1 件)。通勤km の行: ${JSON.stringify(rows)}`);
  console.log("  ★ 既に直っているか 値が変わっています。触りません");
  process.exit(target.length === 0 ? 0 : 2);
}
console.log(`  id=${target[0].id} 通勤km ${target[0].numeric_value} → 0`);
// 手入力の出張km が生きていることを確かめる (消してから気づく事故を防ぐ)
const mi = await get(`payroll_monthly_inputs?select=numeric_value&office_number=eq.${OFFICE}&employee_number=eq.${EMP}&processing_month=eq.${MONTH}&item_key=eq.business_km`);
if (mi.length !== 1 || Number(mi[0].numeric_value) !== EXPECT) {
  console.error(`  ★ 出張km の手入力が ${JSON.stringify(mi)} です。先に出張km を入れてから通勤kmを 0 にしてください`);
  process.exit(2);
}
console.log(`  (出張km の手入力 ${mi[0].numeric_value} は残ります)`);
if (!EXECUTE) { console.log("DRY RUN。--execute で書き込みます"); process.exit(0); }
const res = await fetch(`${SB}/rest/v1/payroll_office_form_records?id=eq.${target[0].id}`, {
  method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify({ numeric_value: 0 }) });
const b = await res.json();
if (!res.ok || !Array.isArray(b) || b.length !== 1) { console.error("★ 書き込みに失敗:", JSON.stringify(b).slice(0, 300)); process.exit(1); }
console.log("  反映しました");
