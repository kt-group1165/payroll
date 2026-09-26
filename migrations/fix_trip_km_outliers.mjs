/**
 * 事業所書式の 出張km が 総括表と桁違いにズレている人月を、月ごとの手入力で是正する (2026-09-26)。
 *
 *   node migrations/fix_trip_km_outliers.mjs              # DRY RUN
 *   node migrations/fix_trip_km_outliers.mjs --execute
 *
 * 【なぜ】
 * 当方の出張費は **事業所書式 (payroll_office_form_records) の出張km** から計算している。
 * 総括表は読んでいない。そのため書式の入力ミスがそのまま金額になる。
 *
 * 2026-09-26 に全社で測ったところ、書式の出張km が 総括表の距離(出) と 5 倍以上ズレる人月が 9 件あった。
 * 6 ヶ月並べると どちらが誤りか はっきりする:
 *
 *   白鳥梨恵 (五井・社員)        総括表 930〜1,010km で安定 / 書式 202606 だけ 9,494  → ★書式が 10 倍
 *   菊地恵・谷口悦子・萩原美樹     総括表 1,100〜2,100km で安定 / 書式 202606 だけ 169〜176 → ★書式が 1/10
 *     (山武・提責 3 名。3 名とも同じ月だけ おかしい = その月の取込の問題)
 *   鎗田裕子 (ちはら台・事務員)   総括表 8〜51km (事務員らしい小ささ)
 *     書式 202603〜06 の **出張km 欄に 880〜1,080km** が入っている
 *     ★ 202607・202608 は 出張km=16/13・通勤km=1,020.6/874.8 と **正しい形**になっている
 *     → 202603〜06 だけ **通勤km と 出張km が入れ替わっている**
 *     ⚠ user のルール: 事務員は 家と事業所の往復 = 通勤距離。役所に行った分だけ出張距離も出る。
 *       事務員が 月 1,000km の出張をするのは実態に合わない
 *
 * 【なぜ総括表を正とするか】
 * 総括表は 9 件すべてで **距離 × 単価 = 出張費** が内部整合している (櫻井さとみ 202606 だけ
 * 距離列が 10 倍の誤記だが、金額は 1,397.4 で計算されていて正しい → 当方と一致するので対象外)。
 * さらに 6 ヶ月の推移を見ると 総括表側は一貫しており、書式側だけが 1 ヶ月だけ外れる。
 *
 * 【なぜ payroll_office_form_records を直さないか】
 * 書式は取込のたびに入れ直されるので、直しても次の取込で元に戻る。
 * 既にある月ごとの手入力 `business_km` (「入れた月は 事業所書式・出勤簿の出張km より優先」) を使う。
 * ★ 再取込しても消えない。
 *
 * ⚠ 鎗田裕子は 出張km を直すだけでは足りない。通勤km も入れ替わっているので
 *   通勤費が 過少になっている。通勤側は `commute_yen` に 総括表の通勤費を入れる。
 * ⚠ 職員番号は事業所をまたぐと重複するので、必ず (office_number, employee_number) の対で引く。
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
const all = async (q) => {
  let out = [], from = 0;
  for (;;) {
    const r = await fetch(`${SB}/rest/v1/${q}&order=id&offset=${from}&limit=1000`, { headers: H });
    const j = await r.json();
    if (!Array.isArray(j)) { console.error("★ 読み込みに失敗:", JSON.stringify(j).slice(0, 300)); process.exit(1); }
    out = out.concat(j); if (j.length < 1000) break; from += 1000;
  }
  return out;
};
const nn = (s) => String(s ?? "").replace(/^0+/, "");
const N = (v) => { if (v == null || v === "") return null; const n = Number(String(v).replace(/[, ]/g, "")); return Number.isFinite(n) ? n : null; };

/** 書式と総括表がこの倍率以上ズレたら「桁違い」とみなす */
const RATIO = 5;

const offices = await all("payroll_offices?select=id,office_number,travel_unit_price,commute_unit_price");
const priceOf = new Map(offices.map((o) => [o.office_number, Number(o.travel_unit_price ?? 0)]));
const sk = await all("payroll_soukatsu_rows?select=office_number,employee_number,employee_name,processing_month,row_data");
const of2 = await all("payroll_office_form_records?select=office_number,employee_number,processing_month,item_name,numeric_value");

// 書式の 出張km / 通勤km を (事業所|職員|月) で引けるようにする
const formKm = new Map();
for (const r of of2) {
  if (r.numeric_value == null) continue;
  if (r.item_name !== "出張km" && r.item_name !== "通勤km") continue;
  const k = `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`;
  const cur = formKm.get(k) ?? { trip: null, commute: null };
  if (r.item_name === "出張km") cur.trip = Number(r.numeric_value);
  else cur.commute = Number(r.numeric_value);
  formKm.set(k, cur);
}

const tripOps = [], commuteOps = [], skipped = [];
for (const r of sk) {
  const k = `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`;
  const f = formKm.get(k);
  if (!f || f.trip == null) continue;
  const d = r.row_data ?? {};
  const soDist = N(d["距離(出)"]), soFee = N(d["出張費"]);
  if (soDist == null || soDist <= 0 || soFee == null) continue;
  const ratio = f.trip / soDist;
  if (ratio <= RATIO && ratio >= 1 / RATIO) continue;

  // ★ 総括表の 距離 × 単価 が 出張費 と合っているかを先に確かめる。
  //   合っていなければ 総括表の距離列のほうが誤記なので、当方を直す理由にならない (櫻井さとみ 202606 の型)。
  const price = priceOf.get(r.office_number) ?? 0;
  const calc = Math.ceil(soDist * price - 1e-6);
  if (price <= 0 || Math.abs(calc - soFee) > 1) {
    skipped.push(`${String(r.employee_name).replace(/\s/g, "")} ${r.processing_month} ${r.office_number}: 総括表の 距離×単価=${calc} ≠ 出張費=${soFee} → 総括表の距離列のほうが怪しい。手を出さない`);
    continue;
  }
  const name = String(r.employee_name ?? "").replace(/\s/g, "");
  tripOps.push({ on: r.office_number, num: nn(r.employee_number), name, m: r.processing_month,
    from: f.trip, to: soDist, ratio, commuteInForm: f.commute,
    note: `2026-09-26 書式の出張km ${f.trip} が総括表 ${soDist} と ${ratio >= 1 ? ratio.toFixed(1) + " 倍" : "1/" + (1 / ratio).toFixed(1)} ズレ。6ヶ月の推移で総括表側が一貫しているため総括表を採る` });

  // 通勤 km が 出張km 欄に入っている型 (事務員の入れ替わり) は 通勤費も過少になる
  const soCommuteFee = N(d["通勤費"]);
  if (soCommuteFee != null && soCommuteFee > 0) {
    const commutePrice = Number(offices.find((o) => o.office_number === r.office_number)?.commute_unit_price ?? 0);
    const mineCommute = f.commute != null && commutePrice > 0 ? Math.ceil(f.commute * commutePrice - 1e-6) : 0;
    if (Math.abs(mineCommute - soCommuteFee) > 1) {
      commuteOps.push({ on: r.office_number, num: nn(r.employee_number), name, m: r.processing_month,
        from: mineCommute, to: soCommuteFee,
        note: `2026-09-26 出張km と通勤km が入れ替わっている月。通勤費は総括表の額をそのまま入れる` });
    }
  }
}

const existTrip = await all("payroll_monthly_inputs?select=office_number,employee_number,processing_month,numeric_value&item_key=eq.business_km");
const haveTrip = new Map(existTrip.map((r) => [`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, Number(r.numeric_value)]));
const existCom = await all("payroll_monthly_inputs?select=office_number,employee_number,processing_month,numeric_value&item_key=eq.commute_yen");
const haveCom = new Map(existCom.map((r) => [`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, Number(r.numeric_value)]));

// ★ 既に手入力があり 値も同じものは 書かない (ノイズになるし 上書きの理由も無い)。
//   実際 2026-09-22 に別セッションが 出張km 8 人月すべてを business_km で是正済みだった。
//   ⚠ 「書式が壊れている」と「金額が壊れている」は別物。**計算が実際に何を使っているか**を見ること。
//     生の書式だけ見て「¥158,544 の過大」と報告しかけたが、手入力が優先されるので実害は 0 だった。
const tripTodo = tripOps.filter((o) => haveTrip.get(`${o.on}|${o.num}|${o.m}`) !== o.to);
const commuteTodo = commuteOps.filter((o) => haveCom.get(`${o.on}|${o.num}|${o.m}`) !== o.to);
const alreadyFixed = tripOps.length - tripTodo.length;

console.log(`=== 出張km の桁違いを手入力で是正 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log(`  判定: 書式の出張km と 総括表の距離(出) が ${RATIO} 倍以上ズレる人月`);
console.log(`  ⚠ 総括表側の 距離×単価 が 出張費 と合わない人月は 対象外 (総括表の距離列の誤記なので当方を直す理由にならない)`);

console.log(`\n--- 出張km (business_km) 対象 ${tripOps.length} 件 / うち ★既に是正済み ${alreadyFixed} 件 → 書くのは ${tripTodo.length} 件`);
let over = 0, under = 0;
for (const o of tripOps) {
  const price = priceOf.get(o.on) ?? 0;
  const mineFee = Math.ceil(o.from * price - 1e-6), rightFee = Math.ceil(o.to * price - 1e-6);
  const diff = mineFee - rightFee;
  if (diff > 0) over += diff; else under += -diff;
  const prev = haveTrip.get(`${o.on}|${o.num}|${o.m}`);
  console.log(`  ${o.name.padEnd(10)} ${o.m} ${o.on}  出張km ${o.from} → ${o.to}   金額 ¥${mineFee.toLocaleString()} → ¥${rightFee.toLocaleString()} (${diff > 0 ? "過大 +" : "過少 "}${diff.toLocaleString()})${prev != null ? `  ※既に手入力 ${prev} あり` : ""}${o.commuteInForm != null ? `  書式の通勤km=${o.commuteInForm}` : ""}`);
}
console.log(`  → 当方の過大 計 ¥${over.toLocaleString()} / 過少 計 ¥${under.toLocaleString()} (差引 ${over - under >= 0 ? "+" : ""}${(over - under).toLocaleString()})`);

console.log(`\n--- 通勤費 (commute_yen) 対象 ${commuteOps.length} 件 → 書くのは ${commuteTodo.length} 件  ※出張kmと通勤kmが入れ替わっている月の 通勤側`);
for (const o of commuteOps) {
  const prev = haveCom.get(`${o.on}|${o.num}|${o.m}`);
  console.log(`  ${o.name.padEnd(10)} ${o.m} ${o.on}  通勤費 ¥${o.from.toLocaleString()} → ¥${o.to.toLocaleString()}${prev != null ? `  ※既に手入力 ¥${prev.toLocaleString()} あり` : ""}`);
}

if (skipped.length) { console.log(`\n--- 対象外 ${skipped.length} 件`); for (const s of skipped) console.log("  " + s); }
if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }

const body = [
  ...tripTodo.map((o) => ({ office_number: o.on, employee_number: o.num, processing_month: o.m, item_key: "business_km", numeric_value: o.to, note: o.note })),
  ...commuteTodo.map((o) => ({ office_number: o.on, employee_number: o.num, processing_month: o.m, item_key: "commute_yen", numeric_value: o.to, note: o.note })),
];
if (body.length === 0) { console.log("書き込むものがありません"); process.exit(0); }
const res = await fetch(`${SB}/rest/v1/payroll_monthly_inputs?on_conflict=office_number,employee_number,processing_month,item_key`, {
  method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body) });
const b = await res.json();
if (!res.ok || !Array.isArray(b) || b.length !== body.length) { console.error("★ 書き込みに失敗:", JSON.stringify(b).slice(0, 400)); process.exit(1); }
console.log(`  反映 ${b.length} 件`);
