/**
 * 居宅介護支援 3 事業所の km 単価 (出張単価・通勤単価) を 総括表 (ケアマネ) の値に直す (2026-10-19 user OK「なおしていいよ」)。
 *
 *   npx tsx migrations/fix_kyotaku_km_unit_price_from_soukatsu.mts            # DRY RUN
 *   npx tsx migrations/fix_kyotaku_km_unit_price_from_soukatsu.mts --execute
 *
 * 総括表 (ケアマネ) の km 単価 (consts.単価) は 2026-01〜09 ずっと同じ値で、DB の居宅の事業所だけ違っていた
 * (DB は 1970-01-01 からの 1 行だけ)。総括表との突合 (verify-kyotaku-soukatsu 段C) で 通勤+出張 がずれていた分。
 *   Hana八千代 1272603844  0    → 12.5
 *   Hana四街道 1270303272  12.3 → 12.5
 *   姉崎ムツミ 1272400837  12.5 → 12.7
 * payroll_offices (今の値) と payroll_office_unit_prices (単価の履歴。計算は対象月の値をここから引く) の両方を直す。
 * 書き換え前の値は 出力に出す (3 事業所 × 2 列 なので ファイルには退避しない)。
 */
import { readFileSync } from "node:fs";
import { restAll } from "../scripts/_rest.mjs";

const EXECUTE = process.argv.includes("--execute");
const FIX: Record<string, number> = { "1272603844": 12.5, "1270303272": 12.5, "1272400837": 12.7 };

const offices = await restAll<{ id: string; office_number: string; office_type: string; travel_unit_price: number | null; commute_unit_price: number | null }>(
  `payroll_offices?select=id,office_number,office_type,travel_unit_price,commute_unit_price&office_number=in.(${Object.keys(FIX).join(",")})&office_type=eq.居宅介護支援`);
if (offices.length !== Object.keys(FIX).length) { console.error(`居宅の事業所が ${offices.length} 件 (${Object.keys(FIX).length} のはず)`); process.exit(1); }
const hist = await restAll<{ office_id: string; effective_from: string; travel_unit_price: number | null; commute_unit_price: number | null }>(
  `payroll_office_unit_prices?select=office_id,effective_from,travel_unit_price,commute_unit_price&office_id=in.(${offices.map((o) => o.id).join(",")})`, "office_id");
for (const o of offices) {
  const hs = hist.filter((h) => h.office_id === o.id);
  console.log(`${o.office_number}: 今 出張 ${o.travel_unit_price} / 通勤 ${o.commute_unit_price} → ${FIX[o.office_number]}`);
  for (const h of hs) console.log(`    履歴 ${h.effective_from}〜 出張 ${h.travel_unit_price} / 通勤 ${h.commute_unit_price} → ${FIX[o.office_number]}`);
  if (hs.length !== 1) { console.error(`  ✗ 履歴が ${hs.length} 行 (1 行のはず)。止めます`); process.exit(1); }
}
if (!EXECUTE) { console.log("\nDRY RUN。書き込むときは --execute"); process.exit(0); }

const env: Record<string, string> = {};
for (const f of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" };
const base = `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1`;
for (const o of offices) {
  const v = FIX[o.office_number];
  const body = JSON.stringify({ travel_unit_price: v, commute_unit_price: v });
  for (const url of [`${base}/payroll_offices?id=eq.${o.id}`, `${base}/payroll_office_unit_prices?office_id=eq.${o.id}`]) {
    const r = await fetch(url, { method: "PATCH", headers: H, body });
    if (!r.ok) { console.error(`✗ ${o.office_number} ${url.split("/").pop()?.split("?")[0]}: ${r.status} ${await r.text()}`); process.exit(1); }
    const rows = (await r.json()) as unknown[];
    if (rows.length !== 1) { console.error(`✗ ${o.office_number} 更新 ${rows.length} 行 (1 のはず)`); process.exit(1); }
  }
}
const after = await restAll<{ office_number: string; travel_unit_price: number; commute_unit_price: number }>(
  `payroll_offices?select=id,office_number,travel_unit_price,commute_unit_price&office_number=in.(${Object.keys(FIX).join(",")})&office_type=eq.居宅介護支援`);
const bad = after.filter((a) => Number(a.travel_unit_price) !== FIX[a.office_number] || Number(a.commute_unit_price) !== FIX[a.office_number]);
console.log(`確認: ${after.map((a) => `${a.office_number} ${a.travel_unit_price}/${a.commute_unit_price}`).join(" | ")}${bad.length ? " ✗ 違う行あり" : " ✓"}`);
if (bad.length) process.exit(1);
