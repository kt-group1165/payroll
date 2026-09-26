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
 * ⚠ **出勤簿の有無は必ず (office_number, employee_number) の対で判定する。**
 *   employee_number は事業所内でしか一意でない (CLAUDE.md 既知の罠)。
 *   実例 (2026-09-26): 稲葉香織 (大網 1275800892・230702) を対象に加えようとしたとき、
 *   employee_number だけで出勤簿の有無を見ると、**別事業所 (やわた 1272404508) の
 *   根本由香さんが同じ職員番号 230702 を持っていて出勤簿があるため、
 *   稲葉香織が「出勤簿あり」と誤判定されて対象から弾かれる**ところだった。
 *   (2026-09-26 に同じ罠を「給与E」も別の場面 (読み取り結果の突合) で踏んでいる。
 *    警告文では防げないので、コード側で office_number 込みのキーにするしかない)
 *
 * 【2026-09-26 追加】木村由伸 (250201)・HO JINAN KYLE (260403) — ちはら台 1271500942
 *   同じ「出勤簿が無く総括表だけが通勤費を払っている」パターンで新たに発見 (計 5 人月 ¥1,652)。
 *   どちらも 距離列がある → A経路 (km)。
 *
 * ⚠ 五十嵐尚子・稲葉香織は **対象にしない**。総括表とは別に通常の事業所書式CSV取込
 *   (import_batch_id が月ごとに別々に付く、2026-09-17 取込) で既に通勤km が入っており、
 *   「出勤簿が無いので総括表で補う」という本スクリプトの前提と異なる
 *   (総括表 と 事業所書式CSV という 2 つの一次ソースが食い違っているだけ。
 *    稲葉 202607: 総括表387.8km / CSV取込369.2km。
 *    五十嵐 202603: 総括表は通勤費2,280円なのに距離列が空 / CSV取込100.8km で
 *    どちらの数字とも合わない。2026-09-26 発見・給与E への申し送り事項)。
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
  ["1271500942", "250201", "木村 由伸"], ["1271500942", "260403", "HO JINAN KYLE"],
];

// 出勤簿が 1 件でもあれば触らない。⚠ office_number 込みのキーで判定する (上の注記参照)
const att = await get("payroll_attendance_records?select=office_number,employee_number&order=id");
const hasAtt = new Set(att.map((a) => `${a.office_number}|${nn(a.employee_number)}`));
const rows = await get("payroll_soukatsu_rows?select=office_number,processing_month,employee_number,row_data&order=id");
const curYen = await get("payroll_monthly_inputs?select=office_number,employee_number,processing_month,numeric_value&item_key=eq.commute_yen&order=id");
const haveYen = new Map(curYen.map((r) => [`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, num(r.numeric_value)]));
const curKm = await get("payroll_office_form_records?select=id,office_number,employee_number,processing_month,numeric_value&record_type=eq.km&item_name=eq.%E9%80%9A%E5%8B%A4km&order=id");
const haveKm = new Map(curKm.map((r) => [`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, { id: r.id, v: num(r.numeric_value) }]));

const yenOps = [], kmOps = [], skipped = [];
for (const [on, en, nm] of TARGETS) {
  if (hasAtt.has(`${on}|${en}`)) { skipped.push(`★ ${nm}: 出勤簿があるので触らない`); continue; }
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
        _empKey: `${on}|${en}`, _nm: nm,
        label: `${nm} ${m} 通勤費 ${haveYen.has(k) ? `${haveYen.get(k)} → ` : ""}¥${yen}` });
    }
  }
}

// ⚠ 同じ人の他の月と桁が違う yen は 電車代(定期代)の可能性がある (2026-09-26)。
//   例: HO JINAN KYLE 202604 ¥12,134 / 202605 ¥6,339 (他の月は ¥227 前後)。
//   金子百恵 (船橋) と同型の疑い。転記自体は正しい (総括表の値をそのまま payroll_monthly_inputs に
//   入れるのが本スクリプトの役割) が、note に残さないと誰も気づけないので中央値との比較で警告を足す。
{
  const byEmp = new Map();
  for (const o of yenOps) { const a = byEmp.get(o._empKey) ?? []; a.push(o.numeric_value); byEmp.set(o._empKey, a); }
  const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  for (const o of yenOps) {
    const vals = byEmp.get(o._empKey);
    if (vals.length < 3) continue; // 中央値の意味がある人数だけ
    const med = median(vals);
    if (med > 0 && o.numeric_value > med * 3) {
      o.note += ` ⚠ ${o._nm}の他の月(中央値¥${med})と桁が違う。電車代(定期代)の可能性あり・未検証`;
      o.label += " ⚠桁違い";
    }
  }
}
for (const o of yenOps) { delete o._empKey; delete o._nm; }

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
