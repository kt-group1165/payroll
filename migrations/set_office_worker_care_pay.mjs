/**
 * 「事務員の訪問分」を払う職員を設定に足す (2026-09-24 user 了承)。
 *
 *   node migrations/set_office_worker_care_pay.mjs            # DRY RUN
 *   node migrations/set_office_worker_care_pay.mjs --execute
 *
 * 事務員の本人給は「出勤簿の時間 × 事務時給」で、訪問をしてもその分は入らない。
 * 訪問分を別途払う事務員は payroll_app_settings.office_worker_care_pay に
 * { 事業所番号: [職員番号...] } で登録する。
 *
 * 【見つけ方】総括表の「介護」列に金額があるのに 当方の office_worker_care_pay が 0 の事務員。
 *   ⚠ 社員の「介護」列は 介護超過手当 なので 事務員だけを見る
 *     (事務員の判定は role_type="事務員" または is_office_worker=true)
 *
 * 【大網白里 稲葉香織 (230702)】2026-03〜08 の 6 か月で ¥44,596。
 *   訪問実績は当方にも正しく入っている (件数・時間とも総括表と一致) が、設定に無いので 0 円だった。
 *   ⚠ この期間は 職員マスタ・給与設定とも 事務員のままで変化なし (ケアマネになったのは 2026-09 以降・user)。
 *     9 月以降は 居宅 (payroll_kyotaku_*) 側になるので この設定を外す必要がある。
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

const pofs = await get("payroll_offices?select=id,office_number,office_id&order=id");
const offs = await get("offices?select=id,name&order=id");
const onm = new Map(offs.map((o) => [o.id, o.name]));
const onOf = new Map(pofs.map((o) => [o.id, o.office_number]));
const disp = new Map(pofs.map((o) => [o.office_number, onm.get(o.office_id) ?? o.office_number]));
const emps = await get("payroll_employees?select=employee_number,name,role_type,is_office_worker,office_id&order=id");
const R = new Map(emps.map((e) => [`${onOf.get(e.office_id)}|${nn(e.employee_number)}`, e]));
const rows = await get("payroll_soukatsu_rows?select=office_number,processing_month,employee_number,row_data&order=id");
const res = await get("payroll_calc_results?select=office_number,processing_month,payload&order=id");
const OURS = new Map();
for (const r of res) { const pl = r.payload;
  for (const e of [...(pl.monthly ?? []), ...(pl.hourly ?? [])])
    OURS.set(`${r.office_number}|${nn(e.employee_number)}|${r.processing_month}`, num(e.office_worker_care_pay)); }

const cand = new Map();
for (const r of rows) {
  const e = R.get(`${r.office_number}|${nn(r.employee_number)}`);
  if (!e) continue;
  if (!(e.is_office_worker || e.role_type === "事務員")) continue;     // 事務員だけ
  const sk = num(r.row_data["介護"]); if (sk <= 0) continue;            // 総括表が払っている
  const ours = OURS.get(`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`) ?? 0;
  if (ours > 0) continue;                                              // 当方も払っている → 対象外
  const k = `${r.office_number}|${nn(r.employee_number)}`;
  const g = cand.get(k) ?? { name: e.name, office: r.office_number, months: [], yen: 0 };
  g.months.push(r.processing_month); g.yen += sk; cand.set(k, g);
}
console.log(`=== 事務員なのに 訪問分が 0 円 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
for (const [k, g] of [...cand].sort((a, b) => b[1].yen - a[1].yen))
  console.log(`  ${String(disp.get(g.office)).slice(0,18).padEnd(19)} ${g.name.padEnd(24)} (${k.split("|")[1]}) ${g.months.length}か月 ¥${g.yen.toLocaleString()}  [${g.months.sort().join(",")}]`);
console.log(`  計 ${cand.size} 名`);

const cur = (await get("payroll_app_settings?select=key,value&key=eq.office_worker_care_pay"))[0]?.value ?? { };
const next = JSON.parse(JSON.stringify(cur));
let added = 0;
for (const [k, g] of cand) {
  const [on, numStr] = k.split("|");
  next[on] = next[on] ?? [];
  if (!next[on].some((x) => nn(x) === numStr)) { next[on].push(numStr); added++; }
}
console.log(`\nいまの設定: ${JSON.stringify(cur)}`);
console.log(`足した後  : ${JSON.stringify(next)}  (追加 ${added} 名)`);
if (!EXECUTE || added === 0) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }
const r = await fetch(`${SB}/rest/v1/payroll_app_settings?key=eq.office_worker_care_pay`, {
  method: "PATCH", headers: { ...H, Prefer: "return=representation" },
  body: JSON.stringify({ value: next, updated_at: new Date().toISOString() }) });
const b = await r.json();
if (!r.ok || !Array.isArray(b) || b.length !== 1) { console.error("★ 書き込みに失敗:", JSON.stringify(b).slice(0, 300)); process.exit(1); }
console.log(`  反映しました`);
