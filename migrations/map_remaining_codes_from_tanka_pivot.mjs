/**
 * 単価の決まっていなかったサービスコードを、既存の区分に結び付ける (2026-09-18)。
 *
 *   node migrations/map_remaining_codes_from_tanka_pivot.mjs            # DRY RUN
 *   node migrations/map_remaining_codes_from_tanka_pivot.mjs --execute
 *
 * 根拠: 総括表の「単価確認用」(旧システムが実際に払った時給をコード×事業所で出したもの)。
 *   自費（身体） 010998/011006/014500/013008  2,100円 (袖ケ浦・いすみ・木更津)。茂原 1,962.5 / 姉ム 1,939.6 /
 *                ちはら台 2,021.7 は 1.5 時間を超えた分が生活援助の単価になる 身体介護の計算そのもの
 *   有料身あり 010420     八千代 1,950 = 八千代の身体介護 / 船橋 有料身有15 2,248 ≒ 船橋の身体介護 2,250
 *   自費（身生） 010996/011005  袖ケ浦 1,750 = 身体生活
 *   養育支援 012407        茂原 1,550 = 生活援助
 *   重度7.5%・8.5% 010119   中央 1,650 = 重度訪問
 * 事業所ごとの時給は既存の区分の時給をそのまま使う (新しい単価は作らない)。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY がありません"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const get = async (p) => { const r = await fetch(`${SB}/rest/v1/${p}`, { headers: H }); if (!r.ok) throw new Error(`${p}: ${await r.text()}`); return r.json(); };
const write = async (method, p, body) => { const r = await fetch(`${SB}/rest/v1/${p}`, { method, headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`${method} ${p}: ${await r.text()}`); const d = await r.json(); if (d.length !== 1) throw new Error(`${method} ${p}: ${d.length} 行`); return d; };

const TARGET = {
  "010998": "身体介護", "011006": "身体介護", "014500": "身体介護", "013008": "身体介護", "010420": "身体介護",
  "010996": "身体生活", "011005": "身体生活",
  "012407": "生活援助",
  "010119": "重度訪問",
};
const cats = await get("payroll_service_categories?select=id,name");
const catId = Object.fromEntries(cats.map((c) => [c.name, c.id]));
for (const n of new Set(Object.values(TARGET))) if (!catId[n]) { console.error(`区分「${n}」がありません`); process.exit(2); }
const maps = await get(`payroll_service_type_mappings?select=id,service_code,category_id&service_code=in.(${Object.keys(TARGET).join(",")})`);
const rates = await get("payroll_category_hourly_rates?select=office_id,category_id,hourly_rate&limit=5000");
const offices = await get("payroll_offices?select=id,office_number");
const offByNum = Object.fromEntries(offices.map((o) => [o.office_number, o.id]));
// 実績に出てくる事業所で、その区分の時給があるか (無いと結び付けても 0 円 = 未設定のまま)
const used = {};
for (let f = 0; ; f += 1000) {
  const d = await get(`payroll_service_records?select=service_code,office_number&service_code=in.(${Object.keys(TARGET).join(",")})&order=id&offset=${f}&limit=1000`);
  for (const r of d) (used[r.service_code] ??= new Set()).add(r.office_number);
  if (d.length < 1000) break;
}
const plan = [];
for (const [code, name] of Object.entries(TARGET)) {
  const cur = maps.find((m) => m.service_code === code);
  const offs = [...(used[code] ?? [])];
  const noRate = offs.filter((on) => !rates.some((r) => r.office_id === offByNum[on] && r.category_id === catId[name]));
  const note = `実績 ${offs.length} 事業所${noRate.length ? ` (★ 時給が無い: ${noRate.join(",")})` : ""}`;
  if (cur && cur.category_id === catId[name]) continue;
  plan.push({ label: `${code} → ${name}  ${note}`, run: () => cur ? write("PATCH", `payroll_service_type_mappings?id=eq.${cur.id}`, { category_id: catId[name] }) : write("POST", "payroll_service_type_mappings", { service_code: code, category_id: catId[name] }) });
}
console.log(`=== 残りのコードを区分に結び付ける ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${plan.length} 件 ===`);
for (const p of plan) console.log(`  ${p.label}`);
if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }
for (const p of plan) await p.run();
console.log(`完了 ${plan.length} 件`);
