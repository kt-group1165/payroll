/**
 * 訪問介護事業所の区分別時給 (payroll_category_hourly_rates) を総括表の単価表に合わせる。
 *
 *   node migrations/set_houmon_category_rates_202607.mjs            # DRY RUN
 *   node migrations/set_houmon_category_rates_202607.mjs --execute
 *
 * 根拠: 01_総括表\01_実績データ確認用.xlsm の「単価確認用」(事業所 CSV ごとの コード→時給・時間)。
 *   平均値には早朝夜間の割増や 1.5h 超の生活援助切替が混ざるので、時間が最も多い素の単価を採る。
 *   さつきが丘・高品 (身体生活 1,900) で総括表と 1 円一致を確認済み。
 * 単価表の無い 姉崎ムツミ・いわね は触らない。既存の値が同じなら何もしない。
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
const get = async (path) => {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`${path}: ${await r.text()}`);
  return r.json();
};
const write = async (method, path, body) => {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { method, headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: ${await r.text()}`);
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error(`${method} ${path}: 1 行のはずが ${rows.length} 行`);
};

const STD = { 身体介護: 2100, 身体生活: 1750, 生活援助: 1550, 同行: 1150 };
const HANA = { 身体介護: 2100, 身体生活: 1900, 生活援助: 1800, 同行: 1150 };
const TARGET = {
  "1271101295": STD, // 木更津ムツミ
  "1272401561": STD, // 市原ムツミ
  "1272401967": STD, // KT五井
  "1272404508": STD, // KTやわた
  "1272403534": STD, // ちはら台
  "1273001626": STD, // 君津ムツミ
  "1272400142": STD, // KT姉崎
  "1270906546": { 身体介護: 2250, 身体生活: 1950, 生活援助: 1750, 同行: 1150 }, // Hana船橋
  "1272603851": { 身体介護: 1950, 身体生活: 1650, 生活援助: 1450, 同行: 1150 }, // Hana八千代
  "1270201930": HANA, // 花見川
  "1270501180": HANA, // おゆみ野
  "1270303173": HANA, // 四街道
  "1270105271": HANA, // 中央
};

const offices = await get(`payroll_offices?select=id,office_number&office_number=in.(${Object.keys(TARGET).join(",")})`);
const cats = await get("payroll_service_categories?select=id,name");
const catId = Object.fromEntries(cats.map((c) => [c.name, c.id]));
const ops = [];
for (const [no, rates] of Object.entries(TARGET)) {
  const o = offices.find((x) => x.office_number === no);
  if (!o) { console.error(`★ payroll_offices に ${no} がありません`); process.exit(2); }
  const cur = await get(`payroll_category_hourly_rates?select=id,category_id,hourly_rate&office_id=eq.${o.id}`);
  for (const [cat, rate] of Object.entries(rates)) {
    if (!catId[cat]) { console.error(`★ 区分 ${cat} がありません`); process.exit(2); }
    const row = cur.filter((r) => r.category_id === catId[cat]);
    if (row.length > 1) { console.error(`★ ${no} ${cat} が ${row.length} 行`); process.exit(2); }
    if (row.length === 0) ops.push({ label: `${no} ${cat} 追加 ${rate}`, run: () => write("POST", "payroll_category_hourly_rates", { office_id: o.id, category_id: catId[cat], hourly_rate: rate }) });
    else if (row[0].hourly_rate !== rate) ops.push({ label: `${no} ${cat} ${row[0].hourly_rate} → ${rate}`, run: () => write("PATCH", `payroll_category_hourly_rates?id=eq.${row[0].id}`, { hourly_rate: rate }) });
  }
}
console.log(`=== 訪問介護 区分別時給 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${ops.length} 件 ===`);
for (const op of ops) console.log(`  ${op.label}`);
if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }
for (const op of ops) await op.run();
console.log(`完了 ${ops.length} 件`);
