/**
 * 通勤手当が **電車代**の職員に 通勤単価 1 円/km を入れる (2026-09-24 user)。
 *
 *   node migrations/set_kaneko_commute_unit_price.mjs            # DRY RUN
 *   node migrations/set_kaneko_commute_unit_price.mjs --execute
 *
 * Ｈａｎａ船橋 金子百恵 は 事業所書式の通勤 km 欄に **金額** (月 21,390〜25,668) を入れていて、
 * 総括表もそのまま円で通勤費として払っている。
 * いままでは「月 2,000 以上なら km でなく円」という閾値で当てていたが、
 * 本当に月 2,000km 通勤する人が出たら 気づかないまま潰れる。
 * 単価を 1 円/km にすれば 入力値がそのまま円になり、推測が要らなくなる。
 *
 * 実データ (2026-09-24): 書式の通勤km は 966 / 1,020.6 の次が 21,390。閾値が当たっているだけの状態。
 * 総括表の通勤費 2026-03〜08: 25,668 / 20,722 / 24,242 / 25,000 / 22,816 / 24,242
 *   (202604 だけ 書式 21,390 と 668 円ちがう。金額そのものの差なので 単価では説明できない)
 */
const EXECUTE = process.argv.includes("--execute");
import { readFileSync } from "node:fs";
const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" };
const get = async (q) => { const r = await fetch(`${SB_URL}/rest/v1/${q}`, { headers: H }); const j = await r.json(); if (!Array.isArray(j)) throw new Error(JSON.stringify(j)); return j; };

/** 事業所番号 / 職員番号 / 氏名の一部 / 通勤単価 */
const PLAN = [["1270906546", "1251", "金子", 1]];

const offices = await get("payroll_offices?select=id,office_number");
const idOf = new Map(offices.map((o) => [o.office_number, o.id]));
const ops = [], skipped = [];
for (const [on, num, name, rate] of PLAN) {
  const cands = (await get(`payroll_employees?select=id,name,office_id,commute_unit_price&employee_number=eq.${num}`))
    .filter((e) => e.office_id === idOf.get(on));
  if (cands.length !== 1) { skipped.push(`★ ${name} (${num}): 職員が ${cands.length} 件`); continue; }
  const e = cands[0];
  if (!e.name.includes(name)) { skipped.push(`★ ${name} (${num}): 名前が違う (${e.name})`); continue; }
  if (Number(e.commute_unit_price) === rate) { skipped.push(`  ${e.name}: すでに ${rate} 円/km`); continue; }
  ops.push({ id: e.id, label: `${e.name} (${num}) 通勤単価 ${e.commute_unit_price ?? "未設定"} → ${rate} 円/km`, rate });
}
console.log(`=== 通勤単価の設定 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${ops.length} 件 ===`);
for (const o of ops) console.log("  " + o.label);
if (skipped.length) { console.log("--- 触らないもの"); for (const s of skipped) console.log("  " + s); }
if (!EXECUTE || ops.length === 0) { console.log("DRY RUN。--execute で書き込みます"); process.exit(0); }
for (const o of ops) {
  const res = await fetch(`${SB_URL}/rest/v1/payroll_employees?id=eq.${o.id}`, {
    method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify({ commute_unit_price: o.rate }) });
  const b = await res.json();
  if (!res.ok || !Array.isArray(b) || b.length !== 1) { console.error("★ 書き込みに失敗:", JSON.stringify(b).slice(0, 300)); process.exit(1); }
  console.log("  反映 " + o.label);
}
