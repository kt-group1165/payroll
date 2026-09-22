/**
 * 事業所書式 / 出勤簿の出張km と 総括表の 距離(出) が違う人のうち、
 * 「実際に払った額 (総括表の出張費) が 総括表の距離で計算されている」ものを
 * 月ごとの手入力「出張km (精算書)」(item_key=business_km) で 総括表の距離にそろえる (2026-09-23)。
 *
 * 判定 (単価 = 事業所の出張単価):
 *   A 総括の距離 × 単価 ≒ 出張費 かつ 書式の距離 × 単価 ≠ 出張費 → 総括表が正 (書式が途中の版・打ち間違い)。手入力する
 *     例) 山武 5・6月 (書式 170km 前後 / 払ったのは 905〜1,772km。同じ PDF の松井・佐瀬の運転日報は総括表と一致)
 *         五井 白鳥 6月 (書式 9,494 = 打ち間違い / 払ったのは 949.4)
 *   B 書式の距離 × 単価 ≒ 出張費 → 書式が正 (総括表の距離欄の打ち間違い)。触らない  例) 高品 櫻井 6月 総括 13,974
 *   C どちらでも出張費にならない (単価が月で違う等) → 触らない。一覧に出す
 * 「≒」は ±1 円。
 *
 *   SP=<scratchpad> node migrations/set_business_km_paid_from_soukatsu.mjs            # DRY RUN
 *   SP=<scratchpad> node migrations/set_business_km_paid_from_soukatsu.mjs --execute
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const SP = process.env.SP;
if (!SP) { console.error("SP=<soukatsu<YYYYMM>/extract.json のある作業フォルダ> を指定"); process.exit(1); }
const MONTHS = ["202603", "202604", "202605", "202606", "202607", "202608"];
const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
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
const num = (v) => (typeof v === "number" ? v : Number(v) || 0);
const nn = (s) => String(s ?? "").replace(/^0+/, "");
const r1 = (x) => Math.round(x * 10) / 10;
const feeOf = (km, unit) => Math.round(Number((km * unit).toFixed(6)));

const offices = await get("payroll_offices?select=id,office_number,travel_unit_price");
const unitOf = new Map(offices.map((o) => [o.office_number, num(o.travel_unit_price)]));
const ops = [], keepB = [], unknownC = [];
for (const m of MONTHS) {
  const y = Number(m.slice(0, 4)), mo = Number(m.slice(4));
  for (const f of JSON.parse(readFileSync(`${SP}/soukatsu${m}/extract.json`, "utf8"))) {
    const on = OFF[f.office];
    if (!on || f.kind === "part") continue;
    const rows = f.rows.filter((r) => num(r["距離(出)"]) > 0 && !String(r._code).includes("合計"));
    if (rows.length === 0) continue;
    const unit = unitOf.get(on) ?? 0;
    const [ofRecs, attRecs, existing] = await Promise.all([
      get(`payroll_office_form_records?select=id,employee_number,numeric_value&office_number=eq.${on}&processing_month=eq.${m}&record_type=eq.km&item_name=eq.出張km`),
      get(`payroll_attendance_records?select=id,employee_number,business_km&office_number=eq.${on}&year=eq.${y}&month=eq.${mo}`),
      get(`payroll_monthly_inputs?select=id,employee_number,numeric_value&office_number=eq.${on}&processing_month=eq.${m}&item_key=eq.business_km`),
    ]);
    const sumBy = (recs, key) => { const mp = new Map(); for (const r of recs) mp.set(nn(r.employee_number), (mp.get(nn(r.employee_number)) ?? 0) + num(r[key])); return mp; };
    const ofKm = sumBy(ofRecs, "numeric_value"), attKm = sumBy(attRecs, "business_km");
    const exist = new Map(existing.map((r) => [nn(r.employee_number), r]));
    const seen = new Set();
    for (const r of rows) {
      const code = nn(r._code);
      if (seen.has(code)) continue; seen.add(code);
      const sk = r1(num(r["距離(出)"])), fee = num(r["出張費"]);
      const o = ofKm.get(code) ?? 0, a = attKm.get(code) ?? 0;
      const src = o > 0 ? o : a;
      if (src <= 0) continue;                 // 元が無い人は set_business_km_from_soukatsu.mjs の範囲
      if (Math.abs(src - sk) <= 0.05) continue; // 一致
      const label = `${f.office} ${m} ${code} ${r["氏名"]}: 総括 ${sk} / ${o > 0 ? "書式" : "出勤簿"} ${r1(src)} / 出張費 ${fee} (単価 ${unit})`;
      const skOk = Math.abs(feeOf(sk, unit) - fee) <= 1, srcOk = Math.abs(feeOf(src, unit) - fee) <= 1;
      if (srcOk) { keepB.push(label); continue; }
      if (!skOk) { unknownC.push(label); continue; }
      const ex = exist.get(code);
      if (ex && num(ex.numeric_value) === sk) continue;
      if (ops.some((x) => x.office_number === on && nn(x.employee_number) === code && x.processing_month === m)) continue; // 総括表の別シートに同じ人 (おゆみ野 福山 4月)
      ops.push({ office_number: on, employee_number: r._code, processing_month: m, item_key: "business_km", numeric_value: sk,
        note: `総括表 距離(出) より (払った出張費 ${fee} = 距離 × ${unit}。${o > 0 ? "書式" : "出勤簿"} ${r1(src)}km は途中の版/打ち間違い) 2026-09-23`, label });
    }
  }
}
console.log(`=== A 総括表にそろえる ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${ops.length} 件 ===`);
for (const o of ops) console.log("  " + o.label);
console.log(`--- B 書式/出勤簿が正 (総括表の距離欄の打ち間違い) ${keepB.length} 件 — 触らない`);
for (const s of keepB) console.log("  " + s);
console.log(`--- C どちらでも出張費にならない ${unknownC.length} 件 — 触らない`);
for (const s of unknownC) console.log("  " + s);
if (!EXECUTE || ops.length === 0) process.exit(0);
const body = ops.map(({ label, ...r }) => { void label; return r; });
const res = await fetch(`${SB_URL}/rest/v1/payroll_monthly_inputs?on_conflict=office_number,employee_number,processing_month,item_key`, {
  method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body) });
const b = await res.json();
if (!res.ok || !Array.isArray(b) || b.length !== body.length) { console.error("★ 書き込みに失敗:", b); process.exit(1); }
console.log(`  反映 ${b.length} 件`);
