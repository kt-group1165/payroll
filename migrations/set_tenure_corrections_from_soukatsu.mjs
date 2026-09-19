/**
 * 勤続手当を 総括表 2026-03〜07 に合わせる職員マスタの修正 (2026-09-19)。前提 SQL: migrations/payroll_employees_care_qualification_from.sql
 *
 *   node migrations/set_tenure_corrections_from_soukatsu.mjs            # DRY RUN
 *   node migrations/set_tenure_corrections_from_soukatsu.mjs --execute
 *
 * ① care_qualification_from: 総括表で 勤続手当単価 が途中の月から付き始める人 (= その月に資格要件を満たした)
 * ② effective_service_months (基準月 2026-03 時点の勤続月数): 5年・10年 の区切りの月が総括表と合わない人
 *    原田 5月に 5年 (30円) → 58 / 石坂 7月まで 5年未満 (10円) → 55 / 藤岡 7月に 10年 (50円) → 116
 *    (基準月より後は 稼働のあった月だけ足す。3人とも 4〜7月 毎月稼働あり)
 * 職員は (事業所番号, 社員番号) で引く。冪等。
 */
import { readFileSync } from "node:fs";
const EXECUTE = process.argv.includes("--execute");
const QUAL = [
  ["1271101295", "220402", "2026-05-01", "原田 麗子"],
  ["1272403534", "220602", "2026-06-01", "戸谷 美紀"],
  ["1273400844", "230205", "2026-05-01", "池田 麻美"],
  ["1270501180", "240301", "2026-04-01", "石川 夕佳"],
  ["1272401561", "948", "2026-04-16", "細野 梢 (4月は半月分 25円)"],
  ["1270501180", "250406", "2026-07-01", "熊谷 千里"],
  ["1278600398", "230408", "2026-06-01", "能戸 広子"],
];
const MONTHS = [
  ["1271101295", "220402", 58, "原田 麗子"],
  ["1279000366", "211004", 55, "石坂 桂子"],
  ["1272400142", "665", 116, "藤岡 由佳"],
];
const env = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL + "/rest/v1/";
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
const get = async (p) => { const r = await fetch(SB + p, { headers: H }); if (!r.ok) throw new Error(`${p}: ${await r.text()}`); return r.json(); };
const hasCol = (await fetch(`${SB}payroll_employees?select=care_qualification_from&limit=1`, { headers: H })).ok;
const offs = await get("payroll_offices?select=id,office_number");
const offId = (n) => offs.find((o) => o.office_number === n)?.id;
const ops = [];
for (const [off, num, from, label] of QUAL) {
  const e = (await get(`payroll_employees?select=id,name${hasCol ? ",care_qualification_from" : ""}&office_id=eq.${offId(off)}&employee_number=eq.${num}`))[0];
  if (!e) { console.log(`✗ ${off} ${num} ${label}: 職員が見つからない`); continue; }
  if (e.care_qualification_from === from) continue;
  ops.push({ id: e.id, body: { care_qualification_from: from }, label: `${e.name} 資格 ${e.care_qualification_from ?? "空"} → ${from} (${label})` });
}
for (const [off, num, months, label] of MONTHS) {
  const e = (await get(`payroll_employees?select=id,name,effective_service_months&office_id=eq.${offId(off)}&employee_number=eq.${num}`))[0];
  if (!e) { console.log(`✗ ${off} ${num} ${label}: 職員が見つからない`); continue; }
  if (e.effective_service_months === months) continue;
  ops.push({ id: e.id, body: { effective_service_months: months }, label: `${e.name} 勤続月数 ${e.effective_service_months} → ${months}` });
}
for (const o of ops) console.log(o.label);
console.log(`書き込み ${ops.length} 件${hasCol ? "" : " (care_qualification_from 列がまだ無い: SQL 未適用)"}`);
if (!EXECUTE) { console.log("DRY RUN (--execute で書き込み)"); process.exit(0); }
if (!hasCol) { console.error("★ 先に SQL を適用してください"); process.exit(2); }
for (const o of ops) {
  const r = await fetch(`${SB}payroll_employees?id=eq.${o.id}`, { method: "PATCH", headers: H, body: JSON.stringify(o.body) });
  if (!r.ok) { console.error(`★ 失敗 ${o.label}: ${await r.text()}`); process.exit(1); }
}
console.log("完了");
