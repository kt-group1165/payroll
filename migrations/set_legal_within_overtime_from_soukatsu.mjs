/**
 * 法内残業 (所定超だが法定内 = 割増なし) を 月ごとの手入力に入れる (2026-09-26)。
 *
 *   node migrations/set_legal_within_overtime_from_soukatsu.mjs            # DRY RUN
 *   node migrations/set_legal_within_overtime_from_soukatsu.mjs --execute
 *
 * 【なぜ】
 * 総括表には「残業」と別に **「法内残業」列が shaseki 全 1,326 行に存在**する。
 *   残業総額     = 残業 ÷ 60 × 残業単価              115/115 成立 (残業単価に 1.25 倍が入っている)
 *   法内残業手当 = 法内残業 ÷ 60 × (残業単価 ÷ 1.25)  17/17 が 1 円まで一致 (割増が付かない)
 * 値が 0 でない行は 20 件 (事務員扱い 115 行のうち 17 件)。
 *
 * 当方は `legalWithinOvertimeMinutes()` で 出勤簿 (payroll_attendance_records) から計算するが、
 * ★ 出勤簿が 0 行の職員は必ず 0 を返す。事務員の一部は 出勤簿が CSV に無く スキャンPDF しかない。
 * → その人月だけ 手入力で補う。
 *
 * ⚠ **出勤簿がある人月には入れない。**入れると 出勤簿からの計算を手入力が上書きして、
 *   出勤簿が直っても反映されなくなる。★ 足場は必要な所にだけ置く。
 * ⚠ 値の出どころは総括表なので **循環参照**。note に明記する。
 *   他に出どころが無い (スキャンPDF の様式に法内残業の欄が無い事業所が多い) ため
 *   移行期の足場として割り切る。本稼働後は出勤簿から計算される。
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

const offices = await all("payroll_offices?select=id,office_number");
const onOf = new Map(offices.map((o) => [o.id, o.office_number]));
const emps = await all("payroll_employees?select=employee_number,name,role_type,is_office_worker,office_id");
const isOfficeWorker = new Set();
for (const e of emps) {
  const on = onOf.get(e.office_id); if (!on) continue;
  if (e.is_office_worker || e.role_type === "事務員") isOfficeWorker.add(`${on}|${nn(e.employee_number)}`);
}

// 出勤簿がある (事業所×職員×月) を集める。★ 職員番号だけで引くと他事業所の同番号者に当たる
const att = await all("payroll_attendance_records?select=office_number,employee_number,year,month");
const hasAtt = new Set(att.map((a) => `${a.office_number}|${nn(a.employee_number)}|${a.year}${String(a.month).padStart(2, "0")}`));

const sk = await all("payroll_soukatsu_rows?select=office_number,employee_number,employee_name,processing_month,sheet_kind,row_data");
const exist = await all("payroll_monthly_inputs?select=office_number,employee_number,processing_month,numeric_value&item_key=eq.legal_within_overtime_minutes");
const have = new Map(exist.map((r) => [`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, Number(r.numeric_value)]));

const ops = [], skipped = [];
for (const r of sk) {
  const d = r.row_data ?? {};
  const min = N(d["法内残業"]);
  if (min == null || min <= 0) continue;
  const key = `${r.office_number}|${nn(r.employee_number)}`;
  const km = `${key}|${r.processing_month}`;
  const name = String(r.employee_name ?? "").replace(/\s/g, "");
  const fee = N(d["法内残業手当"]);
  const rate = N(d["残業単価"]);
  if (!isOfficeWorker.has(key)) {
    skipped.push(`${name} ${r.processing_month} ${r.office_number} 法内残業 ${min}分: 事務員扱いでない (role_type も is_office_worker も立っていない)。★当方の計算は事務員のときだけ法内残業を足すので入れても効かない`);
    continue;
  }
  if (hasAtt.has(km)) {
    skipped.push(`${name} ${r.processing_month} ${r.office_number} 法内残業 ${min}分: 出勤簿があるので 出勤簿から計算される。手入力は入れない`);
    continue;
  }
  // 検算: 法内残業手当 = 分 ÷ 60 × (残業単価 ÷ 1.25) が総括表の中で成立しているか
  let check = "";
  if (fee != null && rate != null && rate > 0) {
    // ★ 時給を先に丸めてから掛ける (payroll-calc.ts の computeOvertimePay と同じ順序)。
    //   割ってから掛けると 本田亜美 202605 で 2 円ずれる (15,497 vs 15,499)
    const calc = Math.round((min / 60) * Math.round(rate / 1.25));
    check = Math.abs(calc - fee) <= 1 ? `検算OK (${min}分 × ${Math.round(rate / 1.25)}円/h = ¥${fee.toLocaleString()})` : `★検算NG 式=${calc} 総括表=${fee}`;
  } else check = "★ 法内残業手当 または 残業単価 が総括表に無く検算できない";
  ops.push({ on: r.office_number, num: nn(r.employee_number), name, m: r.processing_month, min, fee, check,
    note: `2026-09-26 総括表の「法内残業」列より。★出勤簿が当システムに無い人月のみ (循環参照。本稼働後は出勤簿から計算される)` });
}

const todo = ops.filter((o) => have.get(`${o.on}|${o.num}|${o.m}`) !== o.min);
console.log(`=== 法内残業を手入力に入れる ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log(`  総括表で 法内残業 > 0 の人月のうち、事務員扱い かつ 出勤簿が無い = ${ops.length} 件 / 書くのは ${todo.length} 件`);
for (const o of todo) console.log(`  ${o.name.padEnd(10)} ${o.m} ${o.on}  法内残業 ${o.min}分  ${o.check}`);
if (skipped.length) {
  console.log(`\n--- 入れない ${skipped.length} 件`);
  for (const s of skipped) console.log("  " + s);
}
if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }
if (todo.length === 0) { console.log("書き込むものがありません"); process.exit(0); }

const body = todo.map((o) => ({ office_number: o.on, employee_number: o.num, processing_month: o.m,
  item_key: "legal_within_overtime_minutes", numeric_value: o.min, note: o.note }));
const res = await fetch(`${SB}/rest/v1/payroll_monthly_inputs?on_conflict=office_number,employee_number,processing_month,item_key`, {
  method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body) });
const b = await res.json();
if (!res.ok || !Array.isArray(b) || b.length !== body.length) { console.error("★ 書き込みに失敗:", JSON.stringify(b).slice(0, 400)); process.exit(1); }
console.log(`  反映 ${b.length} 件`);
