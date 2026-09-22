/**
 * 出張km が 事業所書式にも出勤簿にも無いのに 総括表に「距離(出)」がある人に、
 * 月ごとの手入力「出張km (精算書)」(payroll_monthly_inputs item_key=business_km) を入れる (2026-09-23)。
 *
 * 総括表の 距離(出) は 交通費精算書 (月末提出の手書き。自宅からの移動を含む) の走行距離合計。
 *   例) 八千代 平野涼子 R8.6: 精算書 595.5km × 12.5 = 7,444円 = 総括表 (Box 02_スキャン/Ｓ11 八千代/…/R8.6 八千代 社員.pdf)
 * 事業所書式の出張km が入力漏れ (0 / 行なし) で、当システムは出張費 0 円になっていた。
 *
 *   SP=<scratchpad> node migrations/set_business_km_from_soukatsu.mjs            # DRY RUN
 *   SP=<scratchpad> node migrations/set_business_km_from_soukatsu.mjs --execute
 *
 * 対象: 総括表 (提責_社員) の 距離(出) > 0 で、当システムの 書式の出張km と 出勤簿の出張km が どちらも 0 の (事業所, 月, 職員)。
 * 書式か出勤簿に km がある人は触らない (値が違っても。そちらは別に調べる)。
 * さらに 今の計算結果 (payroll_calc_results) で 出張費 が 0 円の人だけ (別の経路で既に合っている人を触らない)。
 * note に出典を書く。冪等 (同じ値なら書き直さない)。
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

const ops = [];
const skipped = [];
for (const m of MONTHS) {
  const y = Number(m.slice(0, 4)), mo = Number(m.slice(4));
  for (const f of JSON.parse(readFileSync(`${SP}/soukatsu${m}/extract.json`, "utf8"))) {
    const on = OFF[f.office];
    if (!on || f.kind === "part") continue;
    const rows = f.rows.filter((r) => num(r["距離(出)"]) > 0 && !String(r._code).includes("合計"));
    if (rows.length === 0) continue;
    const [ofRecs, attRecs, existing, calc] = await Promise.all([
      get(`payroll_office_form_records?select=id,employee_number,numeric_value&office_number=eq.${on}&processing_month=eq.${m}&record_type=eq.km&item_name=eq.出張km`),
      get(`payroll_attendance_records?select=id,employee_number,business_km&office_number=eq.${on}&year=eq.${y}&month=eq.${mo}`),
      get(`payroll_monthly_inputs?select=id,employee_number,numeric_value&office_number=eq.${on}&processing_month=eq.${m}&item_key=eq.business_km`),
      get(`payroll_calc_results?select=id,payload&office_number=eq.${on}&processing_month=eq.${m}`),
    ]);
    // 今の計算で 出張費が出ている人 (時給: business_trip_fee / 月給: travel_km (手入力) か travel_km_auto)
    const paidTrip = new Set();
    for (const c of calc) {
      for (const e of c.payload?.hourly ?? []) if (num(e.business_trip_fee) > 0) paidTrip.add(nn(e.employee_number));
      for (const e of c.payload?.monthly ?? []) if (num(e.travel_km) > 0 || num(e.travel_km_auto) > 0 || num(e.business_trip_fee) > 0) paidTrip.add(nn(e.employee_number));
    }
    const sumBy = (recs, key) => { const mp = new Map(); for (const r of recs) mp.set(nn(r.employee_number), (mp.get(nn(r.employee_number)) ?? 0) + num(r[key])); return mp; };
    const ofKm = sumBy(ofRecs, "numeric_value"), attKm = sumBy(attRecs, "business_km");
    const exist = new Map(existing.map((r) => [nn(r.employee_number), r]));
    for (const r of rows) {
      const code = nn(r._code), km = Math.round(num(r["距離(出)"]) * 10) / 10;
      const o = ofKm.get(code) ?? 0, a = attKm.get(code) ?? 0;
      if (o > 0 || a > 0) { if (Math.abs((o > 0 ? o : a) - km) > 0.05) skipped.push(`${f.office} ${m} ${code} ${r["氏名"]}: 総括 ${km} / ${o > 0 ? "書式" : "出勤簿"} ${Math.round((o > 0 ? o : a) * 10) / 10} (元があるので触らない)`); continue; }
      const ex = exist.get(code);
      if (ex && num(ex.numeric_value) === km) continue;
      if (!ex && paidTrip.has(code)) { skipped.push(`${f.office} ${m} ${code} ${r["氏名"]}: 総括 ${km} / 今の計算で出張費あり (触らない)`); continue; }
      if (ops.some((x) => x.office_number === on && nn(x.employee_number) === code && x.processing_month === m)) continue; // 総括表に同じ人が 2 行 (世古 4月)
      ops.push({ office_number: on, employee_number: r._code, processing_month: m, item_key: "business_km", numeric_value: km,
        note: `総括表 距離(出) より (交通費精算書の合計。事業所書式の出張km 入力漏れ) 2026-09-23`, label: `${f.office} ${m} ${code} ${r["氏名"]}: ${km}km${ex ? ` (今 ${ex.numeric_value})` : ""}` });
    }
  }
}
console.log(`=== 出張km (精算書) の手入力 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${ops.length} 件 ===`);
for (const o of ops) console.log("  " + o.label);
if (skipped.length) { console.log(`--- 参考: 触らないもの ${skipped.length} 件 (書式/出勤簿に km があり総括表と違う / 今の計算で出張費あり)`); for (const s of skipped) console.log("  " + s); }
if (!EXECUTE || ops.length === 0) process.exit(0);
const body = ops.map(({ label, ...r }) => { void label; return r; });
const res = await fetch(`${SB_URL}/rest/v1/payroll_monthly_inputs?on_conflict=office_number,employee_number,processing_month,item_key`, {
  method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body) });
const b = await res.json();
if (!res.ok || !Array.isArray(b) || b.length !== body.length) { console.error("★ 書き込みに失敗:", b); process.exit(1); }
console.log(`  反映 ${b.length} 件`);
