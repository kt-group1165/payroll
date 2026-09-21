/**
 * 指定した 事業所 × 処理月 の 実績 (payroll_service_records) と その取込バッチを消す。画面の取込を試し直すため。
 *
 *   OFFICE=1270203191 MONTH=202608 node migrations/delete_meisai_month_office.mjs            # DRY RUN
 *   OFFICE=1270203191 MONTH=202608 node migrations/delete_meisai_month_office.mjs --execute  # 退避してから削除
 *
 * 画面 (/csv-import 介護ソフトCSV) の取込は重複チェックが無く、同じ月を入れると二重になる。
 * 2026-09-21: 8月は script (import-meisai-folder.mts) で入れてあったので、画面からの取込を検証する前に消す。
 * 退避: migrations/_backup_meisai_<OFFICE>_<MONTH>.json (後で消す)
 */
import { readFileSync, writeFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const OFFICE = process.env.OFFICE, MONTH = process.env.MONTH;
if (!/^\d{10}$/.test(OFFICE ?? "") || !/^\d{6}$/.test(MONTH ?? "")) { console.error("OFFICE=<事業所番号10桁> MONTH=<YYYYMM> を指定"); process.exit(1); }
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
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" };
const q = `office_number=eq.${OFFICE}&processing_month=eq.${MONTH}`;

const rows = [];
for (let from = 0; ; from += 1000) {
  const r = await fetch(`${SB_URL}/rest/v1/payroll_service_records?${q}&select=*&order=id`, { headers: { ...H, Range: `${from}-${from + 999}` } });
  const j = await r.json();
  if (!Array.isArray(j)) { console.error("読込失敗:", j); process.exit(1); }
  rows.push(...j);
  if (j.length < 1000) break;
}
const br = await fetch(`${SB_URL}/rest/v1/payroll_import_batches?${q}&import_type=eq.meisai&select=id,file_names,record_count,created_at`, { headers: H });
const batches = await br.json();
if (!Array.isArray(batches)) { console.error("バッチ読込失敗:", batches); process.exit(1); }
console.log(`=== 実績削除 ${OFFICE} ${MONTH} ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log(`  実績 ${rows.length} 行 / バッチ ${batches.length}: ${batches.map((b) => `${b.created_at.slice(0, 10)} ${b.record_count}件`).join(", ")}`);
if (!EXECUTE || rows.length === 0) process.exit(0);

const bk = `migrations/_backup_meisai_${OFFICE}_${MONTH}.json`;
writeFileSync(bk, JSON.stringify({ rows, batches }));
console.log(`  退避: ${bk}`);
const del = await fetch(`${SB_URL}/rest/v1/payroll_service_records?${q}`, { method: "DELETE", headers: { ...H, Prefer: "return=minimal,count=exact" } });
if (!del.ok) { console.error("削除失敗:", await del.text()); process.exit(1); }
const n = Number((del.headers.get("content-range") ?? "").split("/")[1]);
console.log(`  削除 ${n} 行`);
if (n !== rows.length) { console.error(`★ 件数不一致 (期待 ${rows.length})`); process.exit(1); }
if (batches.length) {
  const bd = await fetch(`${SB_URL}/rest/v1/payroll_import_batches?id=in.(${batches.map((b) => b.id).join(",")})`, { method: "DELETE", headers: H });
  if (!bd.ok) { console.error("バッチ削除失敗:", await bd.text()); process.exit(1); }
  console.log(`  バッチ削除 ${batches.length}`);
}
