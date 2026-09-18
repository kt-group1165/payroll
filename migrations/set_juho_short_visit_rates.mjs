/**
 * 重度訪問の時給を 訪問の長さで分ける (2026-09-18)。
 *
 *   node migrations/set_juho_short_visit_rates.mjs            # DRY RUN
 *   node migrations/set_juho_short_visit_rates.mjs --execute
 *
 * 1 回の訪問が 1.5 時間以下なら短時間の時給、それより長ければ区分の時給を訪問全体に掛ける。
 * 根拠: 旧システムの確認用ブック (01_実績データ確認用.xlsm 202608) の 訪問ごとのシステム単価
 *   (Box から scratchpad にコピーして読んだもの)。2026-07 の総括表で おゆみ野 3/10 → 10/10・やわた 1/3 → 3/3 人一致。
 *   五井は 8 月のブックでは同じ形だが 7 月の総括表とは合わないので入れない。
 * すること:
 *   1. payroll_app_settings juho_short_visit_rates に 短時間の時給を入れる
 *   2. おゆみ野 の 重度訪問 の区分の時給 1,700 → 1,650 (1,700 は短時間の時給だった)
 * 冪等。
 */
import { readFileSync } from "node:fs";
const EXECUTE = process.argv.includes("--execute");
const env = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "return=representation" };
async function req(method, p, body) {
  const r = await fetch(`${SB}/rest/v1/${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${p}: ${await r.text()}`);
  return r.json();
}

const want = {
  "1270501180": { "重度訪問": 1700, "重度15%": 1850 }, // おゆみ野
  "1270105271": { "重度訪問": 1700, "重度15%": 1850 }, // 中央
  "1270402116": { "重度15%": 1850 },                   // 高品
  "1272404508": { "重度訪問": 1550 },                   // やわた
  "1270201930": { "重度訪問": 1700 },                   // 花見川 (1.5h 夜朝 = 1,700 × 1.25 = 2,125。朝比奈 2026-07 一致)
};
const LONG = [["1270501180", "重度訪問", 1700, 1650]]; // [事業所, 区分, 今, 正]

const ops = [];
const [cur] = await req("GET", "payroll_app_settings?select=key,value&key=eq.juho_short_visit_rates");
const norm = (v) => JSON.stringify(Object.fromEntries(Object.entries(v ?? {}).sort().map(([k, x]) => [k, Object.fromEntries(Object.entries(x).sort())])));
if (norm(cur?.value) !== norm(want)) {
  ops.push([`juho_short_visit_rates: ${JSON.stringify(cur?.value ?? null)} → ${JSON.stringify(want)}`,
    () => fetch(`${SB}/rest/v1/payroll_app_settings?on_conflict=key`, { method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ key: "juho_short_visit_rates", value: want, updated_at: new Date().toISOString() }) })]);
}
const cats = await req("GET", "payroll_service_categories?select=id,name");
for (const [off, cat, from, to] of LONG) {
  const [o] = await req("GET", `payroll_offices?select=id&office_number=eq.${off}`);
  const c = cats.find((x) => x.name === cat);
  const rows = await req("GET", `payroll_category_hourly_rates?select=id,hourly_rate&office_id=eq.${o.id}&category_id=eq.${c.id}`);
  if (rows.length !== 1) { console.error(`★ ${off} ${cat} の時給が ${rows.length} 行`); process.exit(2); }
  if (rows[0].hourly_rate === to) continue;
  if (rows[0].hourly_rate !== from) { console.error(`★ ${off} ${cat} の時給が想定と違う (${rows[0].hourly_rate})`); process.exit(2); }
  ops.push([`${off} ${cat} の時給 ${from} → ${to}`, () => req("PATCH", `payroll_category_hourly_rates?id=eq.${rows[0].id}`, { hourly_rate: to })]);
}
for (const [l] of ops) console.log(l);
console.log(`書き込み ${ops.length} 件`);
if (!EXECUTE) { console.log("DRY RUN (--execute で書き込み)"); process.exit(0); }
for (const [, run] of ops) { const r = await run(); if (r && r.ok === false) { console.error(await r.text()); process.exit(1); } }
console.log("完了");
