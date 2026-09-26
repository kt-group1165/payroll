/**
 * 欠勤日数を 月ごとの手入力に入れる (2026-09-26)。
 *
 *   node migrations/set_absence_days_from_soukatsu.mjs            # DRY RUN
 *   node migrations/set_absence_days_from_soukatsu.mjs --execute
 *
 * 【なぜ】★ 今日見つけた中で いちばん金額が大きい。
 * 総括表は「欠勤控除」で 総支給額を 0 にしているのに、当方は **欠勤を知らないので固定給を満額出していた**。
 *   金香蘭   (四街道 260204) 202603 欠22 / 202604 欠22  当方 ¥278,000 ずつ
 *   石毛博美 (おゆみ野 3032) 202604 欠21             当方 ¥348,500
 *   → 計 ¥904,500 の過大。
 * ⚠ 石毛博美は 2026-09-26 に 総括表を取込み直す (過誤版の上書きを止める) まで
 *   総支給額が #VALUE! だったので **見えていなかった**。取込を直して初めて出てきた。
 *
 * 【ロジック自体は正しかった】
 * `absenceDeduction()` は「出勤も訪問も 0 なら 固定給を全額控除」まで実装済みで、
 * コメントに実例 (おゆみ野 石毛・袖ケ浦 浅井) まで書かれている。
 * ★ 発火条件の `absence_days > 0` を満たすデータが どのソースにも無かっただけ。
 *     ① payroll_attendance_records の「欠」注記 → 当月 0 行
 *     ② payroll_office_form_records の 欠勤 / 半欠勤 → 0 件
 *
 * 【判定】総括表で **欠勤控除 < 0 かつ 総支給額 = 0** の shaseki 行を対象にする。
 *   日数は「有給・特休・欠勤」欄の "欠22" のような表記から拾う。拾えなければ 出勤日数 0 の月として
 *   ★ 1 を入れる (absenceDeduction は 出勤も訪問も 0 なら日数に関係なく固定給を全額控除するため)。
 *
 * ⚠ 退職者は当方の payload に出ないので 実害が無い (袖ケ浦 浅井裕作 6 人月はこれ)。
 *   入れても害は無いが、対象かどうかを出力に書く。
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
const emps = await all("payroll_employees?select=employee_number,name,employment_status,office_id");
const status = new Map();
for (const e of emps) { const on = onOf.get(e.office_id); if (on) status.set(`${on}|${nn(e.employee_number)}`, e.employment_status); }

const sk = await all("payroll_soukatsu_rows?select=office_number,employee_number,employee_name,processing_month,row_data&sheet_kind=eq.shaseki");
const exist = await all("payroll_monthly_inputs?select=office_number,employee_number,processing_month,numeric_value&item_key=eq.absence_days");
const have = new Map(exist.map((r) => [`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, Number(r.numeric_value)]));

const ops = [];
for (const r of sk) {
  const d = r.row_data ?? {};
  const kek = N(d["欠勤控除"]), tot = N(d["総支給額"]);
  if (kek == null || kek >= 0) continue;     // 欠勤控除がマイナスでない = 対象外
  if (tot !== 0) continue;                   // 総支給額が 0 でない = 部分欠勤。全額控除の型ではないので触らない
  const raw = han(String(d["有給・特休・欠勤"] ?? ""));
  const m = /欠\s*([0-9]+(?:\.[0-9]+)?)/.exec(raw);
  const days = m ? Number(m[1]) : 1;         // 拾えなければ 1 (全額控除の発火だけさせる)
  const name = String(r.employee_name ?? "").replace(/\s/g, "");
  const st = status.get(`${r.office_number}|${nn(r.employee_number)}`) ?? "不明";
  ops.push({ on: r.office_number, num: nn(r.employee_number), name, m: r.processing_month, days,
    guessed: !m, kek, st, raw,
    note: `2026-09-26 総括表の 欠勤控除 ${kek.toLocaleString()} / 総支給額 0 より。${m ? `「${raw}」から ${days} 日` : "日数表記が拾えないので 1 を入れて全額控除を発火させる"}` });
}
const todo = ops.filter((o) => have.get(`${o.on}|${o.num}|${o.m}`) !== o.days);

console.log(`=== 欠勤日数を手入力に入れる ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log(`  判定: 総括表 shaseki で 欠勤控除 < 0 かつ 総支給額 = 0`);
console.log(`  対象 ${ops.length} 人月 / 書くのは ${todo.length} 件`);
for (const o of todo) {
  console.log(`  ${o.name.padEnd(12)} ${o.m} ${o.on} 欠勤 ${o.days} 日${o.guessed ? " ★日数表記なし→1" : ""}  欠勤控除 ${o.kek.toLocaleString()}  在籍=${o.st}${o.st === "退職者" ? " ★当方の計算対象外なので実害なし" : ""}`);
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
