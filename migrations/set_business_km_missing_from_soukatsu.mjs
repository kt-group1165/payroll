/**
 * 事業所書式の「出張km」が空で 当方の出張費が 0 円になっている人月を、総括表① の出張距離で補う (2026-09-23)。
 *
 *   SP=<scratchpad> node migrations/set_business_km_missing_from_soukatsu.mjs            # DRY RUN
 *   SP=<scratchpad> node migrations/set_business_km_missing_from_soukatsu.mjs --execute
 *
 * 出張距離は 手入力 > 事業所書式 > 出勤簿 の順に見る (tripKmOf)。
 * 3 つとも無いと 0 円になるが、① にも ② にも距離と金額が入っている人月がある = **書式の記入漏れ**。
 * 検証中の 3〜7月だけ 手入力で補う。本稼働後は 事業所書式に入れてもらう。
 *
 * 対象の条件 (すべて満たすもの):
 *   ① の出張距離 > 0 / 事業所書式の出張km が 無い か null / 月ごとの手入力が無い / 出勤簿の business_km 合計が 0
 * 冪等: 既に同じ値の手入力があれば触らない。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const SP = process.env.SP;
if (!SP) { console.error("SP=<layer1_all.json のある作業フォルダ> を指定"); process.exit(1); }

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
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" };
const get = async (q) => {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${q}&order=id`, { headers: { ...H, Range: `${from}-${from + 999}` } });
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(JSON.stringify(j));
    out.push(...j);
    if (j.length < 1000) break;
  }
  return out;
};
const OFF = { "04_おゆみ野": "1270501180", "06_さつき": "1270203191", "02_花見川": "1270201930", "05_高品": "1270402116", "11_Hana四街道": "1270303173", "06_Hana中央": "1270105271", "04_Hana船橋": "1270906546", "10_Hana八千代": "1272603851", "03_やわた": "1272404508", "03_五井": "1272401967", "01_KT姉崎": "1272400142", "05_Hanaちはら台": "1272403534", "01_姉崎ムツミ": "1272400829", "リンクス茂原": "1271500942", "08_いすみ": "1278600398", "09_山武": "1279000366", "リンクス大網": "1275800892", "03_木更津ムツミ": "1271101295", "02_市原ムツミ": "1272401561", "07_袖ケ浦": "1273400844", "14_君津": "1273001626", "13_東郷": "1271502518" };
const MONTHS = ["202603", "202604", "202605", "202606", "202607"];
const nn = (s) => String(s ?? "").replace(/^0+/, "");
const num = (v) => { const f = parseFloat(String(v ?? "").replace(/,/g, "")); return isNaN(f) ? 0 : f; };

const L1 = JSON.parse(readFileSync(`${SP}/layer1_all.json`, "utf8"));
const ops = [], skipped = [];

for (const M of MONTHS) {
  const [form, manual, att] = await Promise.all([
    get(`payroll_office_form_records?select=office_number,employee_number,item_name,numeric_value&processing_month=eq.${M}&record_type=eq.km`),
    get(`payroll_monthly_inputs?select=office_number,employee_number,numeric_value&processing_month=eq.${M}&item_key=eq.business_km`),
    get(`payroll_attendance_records?select=office_number,employee_number,business_km&year=eq.${M.slice(0, 4)}&month=eq.${Number(M.slice(4))}`),
  ]);
  const formKm = new Map();
  for (const r of form) {
    if (r.item_name !== "出張km") continue;
    const k = r.office_number + "|" + nn(r.employee_number);
    formKm.set(k, (formKm.get(k) ?? 0) + (r.numeric_value ?? 0));
  }
  const manualKm = new Map(manual.map((r) => [r.office_number + "|" + nn(r.employee_number), Number(r.numeric_value ?? 0)]));
  const attKm = new Map();
  for (const r of att) {
    const k = r.office_number + "|" + nn(r.employee_number);
    attKm.set(k, (attKm.get(k) ?? 0) + (r.business_km ?? 0));
  }
  for (const [key, a] of Object.entries(L1)) {
    const [m, office, kind, code] = key.split("|");
    if (m !== M) continue;
    const on = OFF[office];
    if (!on) continue;
    const km = num(a["出張距離"]);
    if (km <= 0) continue;
    const k = on + "|" + code;
    if ((formKm.get(k) ?? 0) > 0) continue;        // 書式にある
    if ((attKm.get(k) ?? 0) > 0) continue;         // 出勤簿にある
    if (manualKm.has(k)) {
      if (Math.abs(manualKm.get(k) - km) > 0.05) skipped.push(`${office} ${M} ${a["氏名"]}: 手入力 ${manualKm.get(k)} と ① ${km} が違う (触らない)`);
      continue;
    }
    ops.push({ office_number: on, employee_number: code, processing_month: M, item_key: "business_km", numeric_value: km,
      note: `総括表① の出張距離より (事業所書式の出張km が空のため。本稼働後は書式に入れる) 2026-09-23`,
      label: `${office} ${M} ${a["氏名"]} (${kind}) ${km} km  [① 出張費 ${a["出張費"] || "-"}]` });
  }
}

console.log(`=== 出張距離の手入力 (書式が空の人月) ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${ops.length} 件 ===`);
for (const o of ops) console.log("  " + o.label);
if (skipped.length) { console.log(`--- 触らないもの ${skipped.length} 件`); for (const s of skipped.slice(0, 20)) console.log("  " + s); }
if (!EXECUTE || ops.length === 0) { console.log("DRY RUN。--execute で書き込みます"); process.exit(0); }
const body = ops.map(({ label, ...r }) => { void label; return r; });
const res = await fetch(`${SB_URL}/rest/v1/payroll_monthly_inputs?on_conflict=office_number,employee_number,processing_month,item_key`, {
  method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body) });
const b = await res.json();
if (!res.ok || !Array.isArray(b) || b.length !== body.length) { console.error("★ 書き込みに失敗:", b); process.exit(1); }
console.log(`  反映 ${b.length} 件`);
