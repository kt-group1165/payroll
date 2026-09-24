/**
 * 出勤簿が当システムに無い職員の 通勤費を 総括表から入れる (2026-09-24 user 了承)。
 *
 *   node migrations/sync_commute_from_soukatsu.mjs            # DRY RUN
 *   node migrations/sync_commute_from_soukatsu.mjs --execute
 *
 * 【対象】出勤簿が 1 件も無く 総括表だけが通勤費を払っている 6 名 (44 人月 ¥351,285)。
 *   牧野美帆・髙山洋・牛来葉子・世古啓子 (おゆみ野) / 三島由佳 (花見川) / 本田亜美 (姉崎ムツミ)
 *
 * 【入れ方は 2 通り。総括表の持ち方で分かれる】
 *   A. 「距離(通)」列がある → **事業所書式の 通勤km** に入れる。km × 事業所単価 で計算される
 *        髙山洋だけ。検算: 202603 1,302km × 12.3 = 16,014.6 → 16,015 (総括表と一致)
 *   B. 距離列が無い       → **月ごとの手入力 commute_yen** に 円をそのまま入れる
 *        残り 5 名。日額 × 出勤日数 の積み上げで km に割り戻せない
 *        (三島 310円/日・牛来 252円/日・世古 209円/日・本田 127〜135円/日・牧野 定額 21,090→21,670)
 *
 * ⚠ **km に割り戻さない。**牧野 21,670 ÷ 12.3 = 1,762km/月 のような作り物の距離になる。
 * ⚠ 出勤簿が 1 件でもある職員は対象にしない (当方は出勤簿を正とする)。
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
const get = async (q) => { const o = []; for (let f = 0; ; f += 1000) {
  const r = await fetch(`${SB}/rest/v1/${q}`, { headers: { ...H, Range: `${f}-${f + 999}` } }); const j = await r.json();
  if (!Array.isArray(j)) throw new Error(JSON.stringify(j).slice(0, 250)); o.push(...j); if (j.length < 1000) break; } return o; };
const num = (v) => { if (v == null || v === "") return 0; const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, "")); return Number.isNaN(n) ? 0 : n; };
const nn = (s) => String(s ?? "").replace(/^0+/, "");

const TARGETS = [
  ["1270501180", "3328", "牧野 美帆"], ["1270501180", "11047", "髙山 洋"],
  ["1270201930", "241213", "三島 由佳"], ["1270501180", "231204", "牛来 葉子"],
  ["1270501180", "3056", "世古 啓子"], ["1272400829", "284", "本田 亜美"],
];

// 出勤簿が 1 件でもあれば触らない
const att = await get("payroll_attendance_records?select=employee_number&order=id");
const hasAtt = new Set(att.map((a) => nn(a.employee_number)));
const rows = await get("payroll_soukatsu_rows?select=office_number,processing_month,employee_number,row_data&order=id");
const curYen = await get("payroll_monthly_inputs?select=office_number,employee_number,processing_month,numeric_value&item_key=eq.commute_yen&order=id");
const haveYen = new Map(curYen.map((r) => [`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, num(r.numeric_value)]));
const curKm = await get("payroll_office_form_records?select=id,office_number,employee_number,processing_month,numeric_value&record_type=eq.km&item_name=eq.%E9%80%9A%E5%8B%A4km&order=id");
const haveKm = new Map(curKm.map((r) => [`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, { id: r.id, v: num(r.numeric_value) }]));

const yenOps = [], kmOps = [], skipped = [];
for (const [on, en, nm] of TARGETS) {
  if (hasAtt.has(en)) { skipped.push(`★ ${nm}: 出勤簿があるので触らない`); continue; }
  for (const r of rows) {
    if (String(r.office_number) !== on || nn(r.employee_number) !== en) continue;
    const d = r.row_data, m = String(r.processing_month);
    const yen = num(d["通勤費"]); if (yen <= 0) continue;
    const km = num(d["距離(通)"]);
    if (km > 0) {
      const k = `${on}|${en}|${m}`, have = haveKm.get(k);
      if (have && have.v === km) continue;
      kmOps.push({ key: k, id: have?.id ?? null, office_number: on, employee_number: en, processing_month: m, numeric_value: km,
        label: `${nm} ${m} 通勤km ${have ? `${have.v} → ` : ""}${km} (× 単価 ≒ ¥${yen})` });
    } else {
      const k = `${on}|${en}|${m}`;
      if (haveYen.get(k) === yen) continue;
      yenOps.push({ office_number: on, employee_number: en, processing_month: m, item_key: "commute_yen", numeric_value: yen,
        note: `総括表の通勤費から (sync_commute_from_soukatsu.mjs)。出勤簿が当システムに無い職員。日額 × 出勤日数 の積み上げで km に割り戻せない 2026-09-24`,
        label: `${nm} ${m} 通勤費 ${haveYen.has(k) ? `${haveYen.get(k)} → ` : ""}¥${yen}` });
    }
  }
}
console.log(`=== 通勤費 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log(`A. 事業所書式の 通勤km に入れる (距離列がある人) — ${kmOps.length} 件`);
for (const o of kmOps) console.log("   " + o.label);
console.log(`B. 月ごとの手入力 commute_yen に円で入れる — ${yenOps.length} 件`);
for (const o of yenOps) console.log("   " + o.label);
if (skipped.length) { console.log("--- 触らないもの"); for (const s of skipped) console.log("   " + s); }
if (!EXECUTE || (kmOps.length === 0 && yenOps.length === 0)) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }

if (yenOps.length > 0) {
  const body = yenOps.map(({ label, ...x }) => { void label; return x; });
  const res = await fetch(`${SB}/rest/v1/payroll_monthly_inputs?on_conflict=office_number,employee_number,processing_month,item_key`, {
    method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body) });
  const b = await res.json();
  if (!res.ok || !Array.isArray(b) || b.length !== body.length) { console.error("★ 円の書き込みに失敗:", JSON.stringify(b).slice(0, 400)); process.exit(1); }
  console.log(`  B 反映 ${b.length} 件`);
}
for (const o of kmOps) {
  const url = o.id ? `${SB}/rest/v1/payroll_office_form_records?id=eq.${o.id}` : `${SB}/rest/v1/payroll_office_form_records`;
  const res = await fetch(url, { method: o.id ? "PATCH" : "POST", headers: { ...H, Prefer: "return=representation" },
    body: JSON.stringify(o.id ? { numeric_value: o.numeric_value }
      : { office_number: o.office_number, employee_number: o.employee_number, processing_month: o.processing_month,
          record_type: "km", item_name: "通勤km", numeric_value: o.numeric_value }) });
  const b = await res.json();
  if (!res.ok || !Array.isArray(b) || b.length !== 1) { console.error("★ km の書き込みに失敗:", JSON.stringify(b).slice(0, 300)); process.exit(1); }
  console.log(`  A 反映 ${o.label}`);
}
