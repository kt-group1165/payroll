/**
 * 2026-07-14 の試しの取込 (kaigo-app snapshot) が残っていて、MEISAI の取込を止めている。
 *
 *   node migrations/delete_stale_kaigo_snapshot_batches.mjs            # DRY RUN
 *   node migrations/delete_stale_kaigo_snapshot_batches.mjs --execute
 *
 * import_type='kaigo_meisai' かつ file_names が "kaigo-app snapshot…" のバッチだけを消す。
 * ほのぼの CSV 由来のバッチ (import_type='meisai') は触らない。
 * 花見川 202605 が 4 件だけ入っていて「既に 4 件あり」で本来の 1,399 行が取り込めなかった。
 */
import { readFileSync } from "node:fs";
const EXECUTE = process.argv.includes("--execute");
const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY がありません"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const get = async (p) => { const r = await fetch(`${SB}/rest/v1/${p}`, { headers: H }); if (!r.ok) throw new Error(`${p}: ${await r.text()}`); return r.json(); };

const batches = (await get("payroll_import_batches?select=id,import_type,file_names,record_count,processing_month,office_number,created_at&order=created_at"))
  .filter((b) => (b.file_names ?? []).some((f) => String(f).includes("kaigo-app snapshot")));
console.log(`=== 古い kaigo-app snapshot のバッチ ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${batches.length} 件 ===`);
for (const b of batches) {
  const n = (await get(`payroll_service_records?select=id&import_batch_id=eq.${b.id}&limit=2000`)).length;
  console.log(`  ${b.processing_month} ${b.office_number} ${b.import_type} 明細 ${n} 件 (${String(b.created_at).slice(0, 10)})`);
  b._n = n;
}
if (!batches.length) process.exit(0);
if (!EXECUTE) { console.log("\nDRY RUN。--execute で消します"); process.exit(0); }
for (const b of batches) {
  let r = await fetch(`${SB}/rest/v1/payroll_service_records?import_batch_id=eq.${b.id}`, { method: "DELETE", headers: { ...H, Prefer: "return=representation" } });
  if (!r.ok) { console.error(await r.text()); process.exit(2); }
  const del = (await r.json()).length;
  if (del !== b._n) { console.error(`✗ ${b.processing_month} ${b.office_number} 消えた件数 ${del} ≠ ${b._n}`); process.exit(2); }
  r = await fetch(`${SB}/rest/v1/payroll_import_batches?id=eq.${b.id}`, { method: "DELETE", headers: { ...H, Prefer: "return=representation" } });
  if (!r.ok) { console.error(await r.text()); process.exit(2); }
  console.log(`  消した ${b.processing_month} ${b.office_number} ${del} 件`);
}
console.log("完了");
