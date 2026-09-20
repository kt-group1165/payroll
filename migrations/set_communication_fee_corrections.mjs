/**
 * 通信費の是正 (2026-09-21)。前提 SQL: migrations/payroll_employees_communication_fee_from.sql
 *
 *   node migrations/set_communication_fee_corrections.mjs            # DRY RUN
 *   node migrations/set_communication_fee_corrections.mjs --execute
 *
 * ① communication_fee_from: スマホ貸与の負担 (-1,700 円) が始まった月。総括表 2026-03〜07 で確認
 *      高品 菊池 亜希 (4095) 4 月から / 高品 中村 美果 (4081) 6 月から
 *      (高品 西田 道子 は 3 月から = 制限なしなので入れない)
 * ② 兼務の職員は 通信手当を 1 事業所でしか受け取らない。
 *      松元 綾子 は 高品 (4089) が lend で 0 円、花見川 (4089) が none で 1,000 円 になっていた。
 *      総括表は 花見川も 0 円 なので 花見川側も lend にする (3〜7 月の 5 人月)。
 * 職員は (事業所番号, 社員番号) で引く。冪等。
 */
import { readFileSync } from "node:fs";
const EXECUTE = process.argv.includes("--execute");

/** [事業所番号, 社員番号, 列, 値, 説明] */
const FIXES = [
  ["1270402116", "4095", "communication_fee_from", "2026-04-01", "菊池 亜希 (高品) 貸与負担は4月から"],
  ["1270402116", "4081", "communication_fee_from", "2026-06-01", "中村 美果 (高品) 貸与負担は6月から"],
  ["1270201930", "4089", "communication_fee_type", "lend", "松元 綾子 (花見川) 兼務。通信手当は高品側だけ"],
];

const env = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL + "/rest/v1/";
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };

const offRes = await fetch(`${SB}payroll_offices?select=id,office_number`, { headers: H });
if (!offRes.ok) { console.error(`✗ 事業所の読み込みに失敗: ${await offRes.text()}`); process.exit(1); }
const offices = new Map((await offRes.json()).map((o) => [o.office_number, o.id]));

const plan = [];
for (const [officeNumber, empNumber, col, value, note] of FIXES) {
  const officeId = offices.get(officeNumber);
  if (!officeId) { console.error(`✗ 事業所 ${officeNumber} が無い`); process.exit(1); }
  const r = await fetch(`${SB}payroll_employees?select=id,employee_number,name,communication_fee_type,communication_fee_from&office_id=eq.${officeId}&employee_number=eq.${empNumber}`, { headers: H });
  if (!r.ok) { console.error(`✗ 職員の読み込みに失敗: ${await r.text()}`); process.exit(1); }
  const rows = await r.json();
  if (rows.length !== 1) { console.error(`✗ ${officeNumber} ${empNumber} が ${rows.length} 件。(事業所, 社員番号) で 1 件に決まらない`); process.exit(1); }
  const e = rows[0];
  const before = e[col] ?? "(空)";
  if (String(before) === String(value)) { console.log(`= ${note}: すでに ${value}`); continue; }
  plan.push({ id: e.id, col, value, label: `${note}: ${e.name} ${col} ${before} → ${value}` });
}
for (const p of plan) console.log("→", p.label);
console.log(`\n更新 ${plan.length} 件`);
if (!EXECUTE) { console.log("DRY RUN (--execute で書き込み)"); process.exit(0); }
for (const p of plan) {
  const r = await fetch(`${SB}payroll_employees?id=eq.${p.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ [p.col]: p.value }) });
  if (!r.ok) { console.error(`✗ 更新失敗 ${p.label}: ${await r.text()}`); process.exit(1); }
}
console.log(`完了 ${plan.length} 件`);
