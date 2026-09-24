/**
 * 入浴の数え方 / 会議1・2・3 の単価 を事業所ごとに登録する (2026-09-24 user)。
 *
 *   node migrations/set_bath_and_meeting_settings.mjs            # DRY RUN
 *   node migrations/set_bath_and_meeting_settings.mjs --execute
 *
 * 【入浴】bath_care_modes = { 事業所番号: "minutes" | "count" | "none" }
 *   minutes … 総括表に 入浴時間(分) の列がある。分をそのまま足す
 *   count   … 件数しか無い。1 件 = 1.12h (既定)
 *   実測: 入浴時間の列に値があるのは **リンクス茂原 (1271500942) の 4 行だけ**。
 *         おゆみ野 (1270501180) は 件数しか無く 37 人月ぶん入っている。
 *   ⚠ 両方の手入力があると二重に足されるので、方式で択一にする。
 *
 * 【会議】meeting_unit_prices = { 事業所番号: { 会議1, 会議2, 会議3 } }
 *   実測 (総括表からの逆算): 会議1 = 1,500 が 21 事業所 263 行で一致。
 *   会議2/3 を使うのは 3 事業所だけで、同じ「会議3」でも単価が違う。
 *     ムツミ  (1272400829) 会議2 = 500     マスタは 1,500 → 5 件 ¥5,000 の過大
 *     おゆみ野(1270501180) 会議2 = 1,150 / 会議3 = 1,150
 *     八千代  (1272603851) 会議3 = 1,500
 *   ⚠ おゆみ野の会議3 は 202605 だけ 1,500 だが、根拠が 2 名 6 件しか無いので 月の切替は入れない。
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

const PLAN = [
  ["bath_care_modes", { modes: { "1271500942": "minutes", "1270501180": "count" } }],
  ["meeting_unit_prices", { prices: {
    "1272400829": { "会議2": 500 },
    "1270501180": { "会議2": 1150, "会議3": 1150 },
    "1272603851": { "会議3": 1500 },
  } }],
];

console.log(`=== 事業所ごとの設定 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
const ops = [];
for (const [key, value] of PLAN) {
  const cur = (await get(`payroll_app_settings?select=value&key=eq.${key}`))[0]?.value ?? null;
  const same = JSON.stringify(cur) === JSON.stringify(value);
  console.log(`  ${key}`);
  console.log(`     いま: ${JSON.stringify(cur)}`);
  console.log(`     入れる: ${JSON.stringify(value)}  ${same ? "(同じなので触らない)" : ""}`);
  if (!same) ops.push({ key, value, updated_at: new Date().toISOString() });
}
if (!EXECUTE || ops.length === 0) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }
const res = await fetch(`${SB}/rest/v1/payroll_app_settings?on_conflict=key`, {
  method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(ops) });
const b = await res.json();
if (!res.ok || !Array.isArray(b) || b.length !== ops.length) { console.error("★ 書き込みに失敗:", JSON.stringify(b).slice(0, 400)); process.exit(1); }
console.log(`  反映 ${b.length} 件`);
