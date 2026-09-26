/**
 * 欠勤日数を 月ごとの手入力に入れる (2026-09-26)。全額欠勤 と 部分欠勤 の両方。
 *
 *   node migrations/set_absence_days_from_soukatsu.mjs            # DRY RUN
 *   node migrations/set_absence_days_from_soukatsu.mjs --execute
 *
 * 【なぜ】★ 今日見つけた中で いちばん金額が大きい。
 * 総括表は「欠勤控除」で減らしているのに、当方は **欠勤を知らないので固定給を満額出していた**。
 *   全額型 (総支給額 0):  金香蘭 202603・202604 (欠22) / 石毛博美 202604 (欠21)  計 ¥904,500
 *   部分型:               在原道子 202606 (欠14) ほか 7 人月                       計 ¥186,304
 * ⚠ 石毛博美は 2026-09-26 に 総括表を取込み直す (過誤版の上書きを止める) まで
 *   総支給額が #VALUE! だったので **見えていなかった**。★ 土台を直すと 隠れていた実害が出てくる。
 *
 * 【ロジック自体は正しかった】
 * `absenceDeduction()` は
 *   出勤も訪問も 0 なら 固定給を全額控除 / それ以外は floor((本人給+職能給)/時間*8*日数)
 * (時間は 事務員 159 / それ以外 168) まで実装済みで、コメントに実例まで書かれている。
 * ★ 発火条件の `absence_days > 0` を満たすデータが どのソースにも無かっただけ。
 *
 * 【日数の出どころ】優先順に 3 つ試す
 *   ① 総括表の専用「欠勤」列 (在原道子 202606 のように「有給・特休・欠勤」欄が空でもこちらには入る)
 *   ② 「有給・特休・欠勤」欄の 欠N 表記 (例 "有3/欠2.5")
 *   ③ 欠勤控除の額から逆算 = |欠勤控除| / ((本人給+職能給)/時間*8)
 * ★ ①②で決めた日数が ③の逆算と食い違う人月は **入れない**。どちらが正か決められないため。
 * ★ 決められない部分欠勤も **入れない**。埋めると誤った金額になる。
 *
 * ⚠ 退職者は当方の payload に出ないので実害が無い (袖ケ浦 浅井裕作)。入れても害は無いが出力に書く。
 * ⚠ 職員番号は事業所をまたぐと重複するので (office_number, employee_number) の対で引く。
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
/** 全角数字を半角に */
const han = (s) => String(s ?? "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

const offices = await all("payroll_offices?select=id,office_number");
const onOf = new Map(offices.map((o) => [o.id, o.office_number]));
const emps = await all("payroll_employees?select=employee_number,name,role_type,is_office_worker,employment_status,office_id");
const status = new Map(), officeWorker = new Set();
for (const e of emps) {
  const on = onOf.get(e.office_id); if (!on) continue;
  const k = `${on}|${nn(e.employee_number)}`;
  status.set(k, e.employment_status);
  if (e.is_office_worker || e.role_type === "事務員") officeWorker.add(k);
}

const sk = await all("payroll_soukatsu_rows?select=office_number,employee_number,employee_name,processing_month,row_data&sheet_kind=eq.shaseki");
const exist = await all("payroll_monthly_inputs?select=office_number,employee_number,processing_month,numeric_value&item_key=eq.absence_days");
// ★ いまの計算結果が既に同じ日数を出しているなら 手入力は置かない。
//   足場は必要な所にだけ置く。置くと 出勤簿が後から直っても 手入力が優先されて反映されなくなる。
//   ⚠ payload は 2026-09-23 のままで今日の手入力を含まないが、absence_days は
//     出勤簿 + 事業所書式から出た値なので この判定には使える。
const calc = await all("payroll_calc_results?select=office_number,processing_month,payload");
const calcAbs = new Map();
for (const c of calc) for (const mm of (c.payload?.monthly ?? [])) {
  calcAbs.set(`${c.office_number}|${nn(mm.employee_number)}|${c.processing_month}`, Number(mm.absence_days ?? 0));
}
const have = new Map(exist.map((r) => [`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, Number(r.numeric_value)]));

const ops = [], unsure = [];
for (const r of sk) {
  const d = r.row_data ?? {};
  const kek = N(d["欠勤控除"]), tot = N(d["総支給額"]);
  if (kek == null || kek >= 0) continue;   // 欠勤控除がマイナスでなければ対象外
  const full = tot === 0;                  // 総支給額 0 = 丸ごと 1 か月休んだ型
  const name = String(r.employee_name ?? "").replace(/\s/g, "");
  const key = `${r.office_number}|${nn(r.employee_number)}`;

  const col = N(d["欠勤"]);
  const raw = han(String(d["有給・特休・欠勤"] ?? ""));
  const m = /欠\s*([0-9]+(?:\.[0-9]+)?)/.exec(raw);
  const hon = N(d["本人給"]) ?? 0, shoku = N(d["職能給"]) ?? 0;
  const hours = officeWorker.has(key) ? 159 : 168;
  const perDay = hon + shoku > 0 ? ((hon + shoku) / hours) * 8 : 0;
  const backRaw = perDay > 0 ? Math.abs(kek) / perDay : null;
  // 逆算が 0.5 の倍数に十分近いときだけ採用する
  const back = backRaw != null && Math.abs(backRaw * 2 - Math.round(backRaw * 2)) < 0.02 ? Math.round(backRaw * 2) / 2 : null;

  let days = (col != null && col > 0) ? col : (m ? Number(m[1]) : back);
  let how = (col != null && col > 0) ? "欠勤列" : (m ? "欠N表記" : back != null ? "控除額から逆算" : "");

  if (days == null || days <= 0) {
    if (full) { days = 1; how = "日数不明→1 (全額控除を発火させるだけ)"; }
    else {
      unsure.push(`${name} ${r.processing_month} ${r.office_number} 欠勤控除 ${kek.toLocaleString()} だが日数が決まらない (欠勤列も欠N表記も無く、逆算 ${backRaw == null ? "不可" : backRaw.toFixed(3)} が 0.5 の倍数にならない)`);
      continue;
    }
  }
  // ★ 決めた日数が 控除額からの逆算と食い違うときは入れない (どちらが正か決められない)
  if (!full && back != null && Math.abs(back - days) > 0.01) {
    unsure.push(`${name} ${r.processing_month} ${r.office_number} ${how}=${days} だが 控除額からの逆算は ${back}。食い違うので入れない`);
    continue;
  }

  ops.push({ on: r.office_number, num: nn(r.employee_number), name, m: r.processing_month, days, how, full,
    kek, st: status.get(key) ?? "不明",
    note: `2026-09-26 総括表の 欠勤控除 ${kek.toLocaleString()} より (${how})。${full ? "総支給額 0 = 丸ごと 1 か月休んだ型" : "部分欠勤"}` });
}
const already = [], notInPayload = [];
const todo = ops.filter((o) => {
  const k = `${o.on}|${o.num}|${o.m}`;
  if (have.get(k) === o.days) return false;   // 同じ手入力が既にある
  const cur = calcAbs.get(k);
  if (cur == null) { notInPayload.push(`${o.name} ${o.m} ${o.on} (計算結果にこの職員が居ない)`); return true; }
  if (Math.abs(cur - o.days) < 0.01) { already.push(`${o.name} ${o.m} ${o.on} 既に ${cur} 日で計算できている`); return false; }
  return true;
});

console.log(`=== 欠勤日数を手入力に入れる ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log(`  判定: 総括表 shaseki で 欠勤控除 < 0 (総支給額 0 の全額型 と 部分欠勤の両方)`);
console.log(`  対象 ${ops.length} 人月 (全額型 ${ops.filter((o) => o.full).length} / 部分 ${ops.filter((o) => !o.full).length}) / 書くのは ${todo.length} 件`);
for (const o of todo.sort((a, b) => (a.name + a.m).localeCompare(b.name + b.m))) {
  console.log(`  ${o.name.slice(0, 12).padEnd(13)} ${o.m} ${o.on} 欠勤 ${String(o.days).padStart(5)} 日 [${o.how}] ${o.full ? "全額型" : "部分  "} 控除 ${o.kek.toLocaleString().padStart(9)} 在籍=${o.st}${o.st === "退職者" ? " ★計算対象外なので実害なし" : ""}`);
}
console.log(`  内訳: 既に出勤簿・書式から正しく計算できている ${already.length} 件 / 計算結果に居ない ${notInPayload.length} 件`);
if (already.length) { for (const x of already) console.log(`    - ${x}`); }
if (notInPayload.length) { console.log(`  ★ 計算結果に居ない (退職者などで計算対象外の可能性。入れても効かないが害も無い):`); for (const x of notInPayload) console.log(`    - ${x}`); }
if (unsure.length) {
  console.log(`\n--- ★ 日数が決められないので入れない ${unsure.length} 件 (埋めると誤った金額になる)`);
  for (const u of unsure) console.log("  " + u);
}
if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }
if (todo.length === 0) { console.log("書き込むものがありません"); process.exit(0); }

const body = todo.map((o) => ({ office_number: o.on, employee_number: o.num, processing_month: o.m,
  item_key: "absence_days", numeric_value: o.days, note: o.note }));
const res = await fetch(`${SB}/rest/v1/payroll_monthly_inputs?on_conflict=office_number,employee_number,processing_month,item_key`, {
  method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body) });
const b = await res.json();
if (!res.ok || !Array.isArray(b) || b.length !== body.length) { console.error("★ 書き込みに失敗:", JSON.stringify(b).slice(0, 400)); process.exit(1); }
console.log(`  反映 ${b.length} 件`);
