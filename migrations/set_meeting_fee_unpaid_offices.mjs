/**
 * 会議費を払わない事業所を payroll_app_settings に入れる。
 *
 *   node migrations/set_meeting_fee_unpaid_offices.mjs            # DRY RUN
 *   node migrations/set_meeting_fee_unpaid_offices.mjs --execute
 *
 * 根拠: 総括表 2026-07。おゆみ野は事業所書式に 会議2件数 24件 / 会議1件数 1件 /
 * 会議(時間) 2件 があるのに、総括表の「会議費」は 25 名全員 0 円だった。
 * 他の事業所は 件数 × 1,500円 ＋ 会議時間 × 同行の時給 で一致する。
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

const KEY_NAME = "meeting_fee_unpaid_offices";
const want = { offices: ["1270501180"] }; // おゆみ野

const r = await fetch(`${SB_URL}/rest/v1/payroll_app_settings?select=key,value&key=eq.${KEY_NAME}`, { headers: H });
if (!r.ok) { console.error(await r.text()); process.exit(1); }
const [cur] = await r.json();
console.log(`=== 会議費を払わない事業所 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log(`  現在: ${JSON.stringify(cur?.value ?? null)}`);
console.log(`  設定: ${JSON.stringify(want)}`);
if (JSON.stringify(cur?.value) === JSON.stringify(want)) { console.log("同じなので何もしない"); process.exit(0); }
if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }
const w = await fetch(`${SB_URL}/rest/v1/payroll_app_settings?on_conflict=key`, { method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify({ key: KEY_NAME, value: want, updated_at: new Date().toISOString() }) });
if (!w.ok) { console.error(await w.text()); process.exit(1); }
const rows = await w.json();
if (rows.length !== 1) { console.error(`★ ${rows.length} 行`); process.exit(2); }
console.log("完了");
