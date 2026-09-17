/**
 * 重度訪問の時給を総括表に合わせる。
 *
 *   node migrations/set_juho_categories_and_rates_202607.mjs <tanka_table1.json>            # DRY RUN
 *   node migrations/set_juho_categories_and_rates_202607.mjs <tanka_table1.json> --execute
 *
 * 総括表の単価確認用 (2026-07) では 重度の賃金区分ごとに時給が違う:
 *   重度7.5% (8.5% 表記のコードも同じ区分) 1,650円 (花見川・高品・中央) / おゆみ野 は 1,700円と 1,650円が混在
 *   重度15% 1,800円 (おゆみ野・中央)
 *   重度加算なし 船橋 1,700円 / ちはら台 1,500円、重度介護（自立支援）やわた・五井 ≒1,500円
 * 検算: 花見川 朝比奈 2026-07 重度133.5h を 1,650円 にすると総括表の小計との差 -1,598円 (1,700円なら +5,400円)。
 *
 * やること:
 *   1. 区分「重度15%」を作り、テーブル1 で 重度15% のコードをその区分に付け替える
 *   2. 事業所ごとの「重度訪問」「重度15%」の時給を入れる
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const TABLE = args.find((a) => !a.startsWith("--"));
if (!TABLE) { console.error("tanka_table1.json を指定してください"); process.exit(1); }
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
const get = async (path) => { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: H }); if (!r.ok) throw new Error(`${path}: ${await r.text()}`); return r.json(); };
const write = async (method, path, body) => {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { method, headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: ${await r.text()}`);
  return r.json();
};

const JUHO = { "1270201930": 1650, "1270402116": 1650, "1270105271": 1650, "1270906546": 1700, "1272403534": 1500, "1272404508": 1500, "1272401967": 1500 }; // 重度訪問 (7.5% 系・加算なし・自立支援)
const JUHO15 = { "1270501180": 1800, "1270105271": 1800 };

const table = JSON.parse(readFileSync(TABLE, "utf8"));
const codes15 = new Set(Object.entries(table).filter(([, v]) => v.cat === "重度15%").map(([c]) => c));
const cats = await get("payroll_service_categories?select=*");
const juho = cats.find((c) => c.name === "重度訪問");
let c15 = cats.find((c) => c.name === "重度15%");
const maps = await get("payroll_service_type_mappings?select=id,service_code,category_id&limit=5000");
const remap = maps.filter((m) => codes15.has(String(m.service_code).replace(/^0+/, "")) && (!c15 || m.category_id !== c15.id));
const offices = await get(`payroll_offices?select=id,office_number&office_number=in.(${[...new Set([...Object.keys(JUHO), ...Object.keys(JUHO15)])].join(",")})`);
const rates = await get("payroll_category_hourly_rates?select=id,office_id,category_id,hourly_rate&limit=5000");

const plan = [];
if (!c15) plan.push("区分「重度15%」を作る");
for (const m of remap) plan.push(`コード ${m.service_code} を 重度15% に付け替え`);
const rateOps = [];
for (const [tbl, catName] of [[JUHO, "重度訪問"], [JUHO15, "重度15%"]]) {
  for (const [no, rate] of Object.entries(tbl)) {
    const o = offices.find((x) => x.office_number === no);
    rateOps.push({ o, no, rate, catName });
    const catId = catName === "重度訪問" ? juho.id : c15?.id;
    const cur = catId ? rates.find((r) => r.office_id === o.id && r.category_id === catId) : null;
    if (!cur) plan.push(`${no} ${catName} 追加 ${rate}`);
    else if (cur.hourly_rate !== rate) plan.push(`${no} ${catName} ${cur.hourly_rate} → ${rate}`);
  }
}
console.log(`=== 重度の区分と時給 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${plan.length} 件 ===`);
for (const p of plan) console.log(`  ${p}`);
if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }

if (!c15) {
  const base = Object.fromEntries(Object.entries(juho).filter(([k]) => !["id", "created_at", "updated_at", "name"].includes(k)));
  [c15] = await write("POST", "payroll_service_categories", { ...base, name: "重度15%" });
}
for (const m of remap) {
  const rows = await write("PATCH", `payroll_service_type_mappings?id=eq.${m.id}`, { category_id: c15.id });
  if (rows.length !== 1) throw new Error(`付け替え ${m.service_code} ${rows.length} 行`);
}
const rates2 = await get("payroll_category_hourly_rates?select=id,office_id,category_id,hourly_rate&limit=5000");
for (const { o, rate, catName } of rateOps) {
  const catId = catName === "重度訪問" ? juho.id : c15.id;
  const cur = rates2.find((r) => r.office_id === o.id && r.category_id === catId);
  if (!cur) await write("POST", "payroll_category_hourly_rates", { office_id: o.id, category_id: catId, hourly_rate: rate });
  else if (cur.hourly_rate !== rate) await write("PATCH", `payroll_category_hourly_rates?id=eq.${cur.id}`, { hourly_rate: rate });
}
console.log(`完了 ${plan.length} 件`);
