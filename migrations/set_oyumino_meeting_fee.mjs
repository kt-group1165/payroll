/**
 * おゆみ野の会議費 (2026-09-18)。
 *
 *   node migrations/set_oyumino_meeting_fee.mjs            # DRY RUN
 *   node migrations/set_oyumino_meeting_fee.mjs --execute
 *
 * 総括表 (おゆみ野_パート) の「研修」列 = 総括表データの 研修費 + 会議費。会議費の列が無いので 0 円扱いにしていたが誤り。
 *   会議費 = (会議2件数 + 会議3件数) × 1,150 + 会議時間 × 1,150 (同行の時給) で 2026-07 の 25 人中 23 人一致。
 * すること:
 *   1. meeting_fee_unpaid_offices から おゆみ野 を外す
 *   2. meeting_count_items に おゆみ野 = ["会議2", "会議3"]
 *   3. payroll_offices.meeting_unit_price (おゆみ野) 1,500 → 1,150
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
const setSetting = (key, value) => () => fetch(`${SB}/rest/v1/payroll_app_settings?on_conflict=key`, {
  method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" },
  body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }) });

const OFF = "1270501180";
const ops = [];
const [unpaid] = await req("GET", "payroll_app_settings?select=value&key=eq.meeting_fee_unpaid_offices");
const offices = unpaid?.value?.offices ?? [];
if (offices.includes(OFF)) ops.push([`meeting_fee_unpaid_offices から おゆみ野 を外す (${JSON.stringify(offices)})`,
  setSetting("meeting_fee_unpaid_offices", { offices: offices.filter((o) => o !== OFF) })]);
const [items] = await req("GET", "payroll_app_settings?select=value&key=eq.meeting_count_items");
const cur = items?.value ?? {};
if (JSON.stringify(cur[OFF]) !== JSON.stringify(["会議2", "会議3"])) ops.push([`meeting_count_items おゆみ野 = 会議2・会議3`,
  setSetting("meeting_count_items", { ...cur, [OFF]: ["会議2", "会議3"] })]);
const [po] = await req("GET", `payroll_offices?select=id,meeting_unit_price&office_number=eq.${OFF}`);
if (po.meeting_unit_price !== 1150) ops.push([`おゆみ野 meeting_unit_price ${po.meeting_unit_price} → 1150`,
  () => req("PATCH", `payroll_offices?id=eq.${po.id}`, { meeting_unit_price: 1150 })]);

for (const [l] of ops) console.log(l);
console.log(`書き込み ${ops.length} 件`);
if (!EXECUTE) { console.log("DRY RUN (--execute で書き込み)"); process.exit(0); }
for (const [, run] of ops) { const r = await run(); if (r && r.ok === false) { console.error(await r.text()); process.exit(1); } }
console.log("完了");
