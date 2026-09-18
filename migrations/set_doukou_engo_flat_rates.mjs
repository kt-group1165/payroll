/**
 * 同行援護 (021008) を時間によらず固定の時給で払う事業所を入れる (2026-09-18)。
 *
 *   node migrations/set_doukou_engo_flat_rates.mjs            # DRY RUN
 *   node migrations/set_doukou_engo_flat_rates.mjs --execute
 *
 * 根拠: 旧システムの確認用ブック (01_実績データ確認用.xlsm 202608) の同行援護のシステム単価。
 *   五井・やわた 1,750 / KT姉崎 2,100 (長さによらず一定)。ほかは身体介護と同じ段階式。
 *   2026-07 の総括表で 五井 0/2 → 2/2・KT姉崎 0/2 → 2/2 人一致。
 * 冪等。⚠ 給与計算の画面 (getDoukouEngoFlatRates) を先にデプロイしてから入れること。
 */
import { readFileSync } from "node:fs";
const EXECUTE = process.argv.includes("--execute");
const env = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const want = { "1272401967": 1750, "1272404508": 1750, "1272400142": 2100 }; // 五井・やわた・KT姉崎
const r = await fetch(`${SB}/rest/v1/payroll_app_settings?select=value&key=eq.doukou_engo_flat_rates`, { headers: H });
if (!r.ok) { console.error(await r.text()); process.exit(1); }
const [cur] = await r.json();
const norm = (v) => JSON.stringify(Object.fromEntries(Object.entries(v ?? {}).sort()));
console.log(`現在 ${JSON.stringify(cur?.value ?? null)} → ${JSON.stringify(want)}`);
if (norm(cur?.value) === norm(want)) { console.log("書き込み 0 件"); process.exit(0); }
console.log("書き込み 1 件");
if (!EXECUTE) { console.log("DRY RUN (--execute で書き込み)"); process.exit(0); }
const w = await fetch(`${SB}/rest/v1/payroll_app_settings?on_conflict=key`, { method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" },
  body: JSON.stringify({ key: "doukou_engo_flat_rates", value: want, updated_at: new Date().toISOString() }) });
if (!w.ok) { console.error(await w.text()); process.exit(1); }
console.log("完了");
