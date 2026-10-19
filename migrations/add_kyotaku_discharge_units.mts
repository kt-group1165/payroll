/**
 * 居宅の加算手当の 単位数の表 (payroll_kyotaku_service_units) に 退院退所加算の Ⅰ２・Ⅱ１・Ⅱ２・Ⅲ を足す (2026-10-19)。
 *
 *   npx tsx migrations/add_kyotaku_discharge_units.mts            # DRY RUN
 *   npx tsx migrations/add_kyotaku_discharge_units.mts --execute
 *
 * 表には Ⅰ１ (450) しか無く、2026-06 に 3 件・2026-07 に 5 件ある 600 単位の退院退所加算が 加算手当 (単位 × 10 円) に入っていなかった。
 * 単位数は 介護アプリのサービスコード表 (kaigo_service_codes 436143〜436146、2024-06 と 2026-06 で同じ) の値。
 * 名前は 既にある行と同じ形 (「居宅支援」を外す)。同じ名前の行があれば 足さない。
 */
import { readFileSync } from "node:fs";
import { restAll } from "../scripts/_rest.mjs";

const EXECUTE = process.argv.includes("--execute");
const ADD = [
  { item_name: "退院退所加算Ⅰ２", unit_count: 600 },
  { item_name: "退院退所加算Ⅱ１", unit_count: 600 },
  { item_name: "退院退所加算Ⅱ２", unit_count: 750 },
  { item_name: "退院退所加算Ⅲ", unit_count: 900 },
];
const cur = await restAll<{ id: string; tenant_id: string; item_name: string; unit_count: number; display_order: number | null; is_addition: boolean; is_office_addition: boolean; effective_from: string | null }>(
  "payroll_kyotaku_service_units?select=id,tenant_id,item_name,unit_count,display_order,is_addition,is_office_addition,effective_from");
const base = cur.find((u) => u.item_name === "退院退所加算Ⅰ１");
if (!base) { console.error("退院退所加算Ⅰ１ の行が無いので 形が決められない"); process.exit(1); }
const maxOrder = Math.max(0, ...cur.map((u) => u.display_order ?? 0));
const rows = ADD.filter((a) => !cur.some((u) => u.item_name === a.item_name)).map((a, i) => ({
  tenant_id: base.tenant_id, item_name: a.item_name, unit_count: a.unit_count, display_order: maxOrder + 1 + i,
  is_addition: true, is_office_addition: false, effective_from: base.effective_from,
}));
console.log(`今の表 ${cur.length} 行 / 足す ${rows.length} 行 (既にある分は足さない)`);
for (const r of rows) console.log(`  ${r.item_name} ${r.unit_count} 単位 (並び ${r.display_order} / 有効 ${r.effective_from ?? "空"})`);
if (!EXECUTE) { console.log("\nDRY RUN。書き込むときは --execute"); process.exit(0); }
if (rows.length === 0) process.exit(0);

const env: Record<string, string> = {};
for (const f of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const r = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/payroll_kyotaku_service_units`, {
  method: "POST", body: JSON.stringify(rows),
  headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
});
if (!r.ok) { console.error(`書き込み失敗: ${r.status} ${await r.text()}`); process.exit(1); }
const after = await restAll<{ item_name: string }>("payroll_kyotaku_service_units?select=id,item_name");
const missing = ADD.filter((a) => !after.some((u) => u.item_name === a.item_name));
console.log(`確認: 表 ${after.length} 行 / 入っていない ${missing.length}`);
if (missing.length) process.exit(1);
