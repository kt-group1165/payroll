/**
 * 重度8.5% の 10.0時間 (010125) と 13.0時間 (010267) を 類型「重度訪問」に結び付ける (2026-09-22)。
 * 他の 重度8.5% (010107〜010123 / 010265 12.0時間) は全部「重度訪問」なのに この 2 つだけ抜けていて、
 * 訪問が 0 円で計算されていた (中央 福原 6/27・8/29 13時間 = 1,650円×13 = 21,450円/月 の不足と一致)。
 *
 *   node migrations/add_juho_85_13h_10h_mapping.mjs            # DRY RUN
 *   node migrations/add_juho_85_13h_10h_mapping.mjs --execute
 */
import { readFileSync } from "node:fs";
const EXECUTE = process.argv.includes("--execute");
const env = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) env[m[1]] = m[2]; }
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" };
const get = async (q) => { const r = await fetch(`${SB_URL}/rest/v1/${q}`, { headers: H }); const j = await r.json(); if (!Array.isArray(j)) throw new Error(JSON.stringify(j)); return j; };
const ADD = [["010125", "重度8.5％　10.0"], ["010267", "重度8.5%  13.0"]];
const cat = (await get("payroll_service_categories?select=id,name&name=eq.重度訪問"))[0];
if (!cat) { console.error("類型「重度訪問」が無い"); process.exit(1); }
const exist = new Set((await get(`payroll_service_type_mappings?select=service_code&service_code=in.(${ADD.map(a => a[0]).join(",")})`)).map((m) => m.service_code));
const todo = ADD.filter(([c]) => !exist.has(c));
console.log(`=== ${EXECUTE ? "【本番】" : "(DRY RUN)"} 追加 ${todo.length} 件 → 重度訪問 (${cat.id}) ===`);
for (const [c, n] of todo) console.log(`  ${c} ${n}`);
if (!EXECUTE || todo.length === 0) process.exit(0);
const r = await fetch(`${SB_URL}/rest/v1/payroll_service_type_mappings`, { method: "POST", headers: { ...H, Prefer: "return=representation" },
  body: JSON.stringify(todo.map(([service_code, service_name]) => ({ service_code, service_name, category_id: cat.id }))) });
const b = await r.json();
if (!r.ok || !Array.isArray(b) || b.length !== todo.length) { console.error("★ 失敗", b); process.exit(1); }
console.log(`  反映 ${b.length} 件`);
