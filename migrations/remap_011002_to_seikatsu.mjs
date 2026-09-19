/**
 * サービスコード 011002「移動支援（身体介護を伴わない）」の給与区分を 身体介護 → 生活援助 にする (2026-09-19)。
 *
 *   node migrations/remap_011002_to_seikatsu.mjs            # DRY RUN
 *   node migrations/remap_011002_to_seikatsu.mjs --execute
 *
 * 根拠: いすみ 久貝 2026-03〜07 の 本人給の差 1,100/1,650/2,200/1,100/1,650 円 = 011002 の分数 (120/180/240/120/180) × (2,100 − 1,550) 円/時。
 *   011001「移動支援（伴う）」= 身体介護を伴う は 身体介護 のまま (差に出ない)。
 * 対象: payroll_service_type_mappings の 011002 (全事業所共通)。冪等。
 */
import { readFileSync } from "node:fs";
const EXECUTE = process.argv.includes("--execute");
const env = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL + "/rest/v1/";
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
const get = async (p) => { const r = await fetch(SB + p, { headers: H }); if (!r.ok) throw new Error(`${p}: ${await r.text()}`); return r.json(); };
const cats = await get("payroll_service_categories?select=id,name");
const seikatsu = cats.find((c) => c.name === "生活援助");
const rows = await get("payroll_service_type_mappings?select=id,service_code,service_name,category_id&service_code=eq.011002");
for (const r of rows) console.log(`011002 ${r.service_name}: ${cats.find((c) => c.id === r.category_id)?.name} → 生活援助`);
const ops = rows.filter((r) => r.category_id !== seikatsu.id);
console.log(`書き込み ${ops.length} 件`);
if (!EXECUTE) { console.log("DRY RUN (--execute で書き込み)"); process.exit(0); }
for (const r of ops) {
  const w = await fetch(`${SB}payroll_service_type_mappings?id=eq.${r.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ category_id: seikatsu.id }) });
  if (!w.ok) { console.error(`★ 失敗: ${await w.text()}`); process.exit(1); }
}
console.log("完了");
