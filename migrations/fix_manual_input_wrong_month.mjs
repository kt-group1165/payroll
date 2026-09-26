/**
 * 月を間違えて入った手入力 (payroll_monthly_inputs) を直す (2026-09-27 給与D)
 *
 *   node migrations/fix_manual_input_wrong_month.mjs              # DRY RUN (既定。何も書かない)
 *   node migrations/fix_manual_input_wrong_month.mjs --execute    # 書き込む
 *
 * 【なぜ】 木村江利 (五井 260803・8 月入社) の 研修 1,050 分 と 岩坪恵 (五井 260802) の 出張 58.7km が 7 月に入っていた。
 *   総括表 ② は どちらも 8 月に同じ値で払っている。このまま再計算すると 7 月に払う。
 *   ★ しかも 8 月の事業所書式には 既に同じ分がある (木村: 初任者研修 8/25・8/27・8/28 = 1,050 分 / 岩坪: 出張km 58.7)。
 *     研修の手入力は 事業所書式の研修時間に「足される」ので、8 月に「移す」と ★ 8 月が二重になる。
 *
 * 【対象】 scripts/check-manual-input-month.mts の M (月違い) と同じ判定で、さらに次を全部満たすもの:
 *   - 手入力の月が 在籍期間の外 (入社より前 / 退職より後)
 *   - 総括表 ② の対応欄と一致する月が ちょうど 1 つ
 * 【どう直すか】 (移す先の月 = ② と一致した月)
 *   - 移す先の月の事業所書式に 同じ値が既にある → ★ 手入力を 0 にする (重複。消さずに 0 + note で残すので戻せる)
 *   - 無い → 手入力の月を 移す先の月に付け替える
 *   - 移す先の月に 同じ項目の手入力が既にある → 触らずに知らせる (UNIQUE (事業所, 職員, 月, 項目) にぶつかる)
 * マーカー: note の末尾に「[月違い是正 2026-09-27]」
 * 冪等: 直した後に もう一度 DRY RUN すると 0 件 (0 にした行・移した行は 条件に当たらなくなる)
 */
import { readFileSync, writeFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const MARKER = "[月違い是正 2026-09-27]";

const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL + "/rest/v1/";
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
async function all(q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB}${q}&order=id&offset=${from}&limit=1000`, { headers: H });
    const j = await r.json();
    if (!Array.isArray(j)) { console.error("★ 読み込み失敗:", q.slice(0, 80), JSON.stringify(j).slice(0, 300)); process.exit(1); }
    out.push(...j); if (j.length < 1000) break;
  }
  return out;
}
const nn = (s) => String(s ?? "").trim().replace(/^0+/, "");
const norm = (s) => String(s ?? "").normalize("NFKC").replace(/\s/g, "");
const toNum = (v) => { if (v == null || v === "") return null; if (typeof v === "number") return v; const t = /^(-?\d+):(\d{2})/.exec(String(v).trim()); if (t) return Number(t[1]) * 60 + Number(t[2]); const n = Number(String(v).replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
const eq = (a, b) => a != null && b != null && Math.abs(a - b) < 0.051;
const ym = (d, plusDay = 0) => { if (!d) return null; const t = new Date(`${String(d).slice(0, 10)}T00:00:00Z`); if (Number.isNaN(t.getTime())) return null; t.setUTCDate(t.getUTCDate() + plusDay); return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, "0")}`; };
/** ② の対応欄 (scripts/check-manual-input-month.mts と同じ) */
const CP = {
  training_minutes: { cols: ["内研修時間", "内初任者研修時間"], yenCols: ["研修", "初任者研修費"] },
  shoninsha_training_minutes: { cols: ["内初任者研修時間"], yenCols: ["初任者研修費"] },
  business_km: { cols: ["距離(出)", "距離"] },
  commute_yen: { cols: ["通勤費"] },
  office_work_minutes: { cols: ["出勤時間"] },
  childcare_allowance: { cols: ["育児手当"] },
  overtime_minutes: { cols: ["残業"] },
};
const distinctive = (key, v) => (key === "business_km" ? v >= 10 || v % 1 !== 0 : v >= 100 && (/minutes/.test(key) ? v % 60 !== 0 : true));
/** 事業所書式で 同じ項目がいくつ入っているか (移す先の月の重複判定に使う) */
const toMin = (t) => { const [h, m] = String(t ?? "").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const dateCount = (d) => { const s = String(d ?? "").split(/[,、]/).map((x) => x.trim()).filter(Boolean); return s.length || 1; };
function formAmount(key, recs) {
  if (/training_minutes/.test(key)) {
    const names = key === "shoninsha_training_minutes" ? ["初任者研修"] : ["研修", "HRD研修", "初任者研修"];
    return recs.filter((r) => r.record_type === "training" && names.includes(r.item_name) && r.start_time && r.end_time)
      .reduce((s, r) => s + Math.max(0, toMin(r.end_time) - toMin(r.start_time) - toMin(r.break_time)) * dateCount(r.item_date), 0);
  }
  if (key === "business_km") return recs.filter((r) => r.item_name === "出張km").reduce((s, r) => s + (Number(r.numeric_value) || 0), 0);
  if (key === "commute_yen") return null; // 事業所書式に円の欄は無い
  return null;
}

const inputs = await all("payroll_monthly_inputs?select=id,office_number,employee_number,processing_month,item_key,numeric_value,note");
const offices = await all("payroll_offices?select=id,office_number,offices(name)");
const emps = await all("payroll_employees?select=id,employee_number,name,office_id,hire_date,resignation_date");
const legacy = await all("payroll_legacy_employee?select=id,office_name,employee_number,employee_name,hire_date,quit_date");
const l2rows = await all("payroll_soukatsu_rows?select=id,office_number,employee_number,processing_month,row_data");
const offNum = new Map(offices.map((o) => [o.id, o.office_number]));
const nameToNum = new Map(offices.filter((o) => o.offices?.name).map((o) => [norm(o.offices.name), o.office_number]));
const emp = new Map(emps.map((e) => [`${offNum.get(e.office_id)}|${nn(e.employee_number)}`, e]));
const leg = new Map(); for (const r of legacy) { const on = nameToNum.get(norm(r.office_name)); if (on) leg.set(`${on}|${nn(r.employee_number)}`, r); }
const l2 = new Map(); for (const r of l2rows) { const k = `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`; l2.set(k, { ...(l2.get(k) ?? {}), ...r.row_data }); }
const l2Months = [...new Set(l2rows.map((r) => r.processing_month))].sort();
const cpMatch = (key, v, k) => { const c = CP[key]; const d = l2.get(k); if (!c || !d) return false;
  if (c.cols.some((col) => eq(toNum(d[col]), v))) return true;
  return /minutes/.test(key) && !!c.yenCols?.some((col) => eq(toNum(d[col]), Math.round(v / 60 * 1150))); };

const plan = [], skipped = [];
for (const r of inputs) {
  const v = Number(r.numeric_value ?? 0);
  if (!(v > 0) || !CP[r.item_key] || !distinctive(r.item_key, v) || !l2Months.includes(r.processing_month)) continue;
  const num = nn(r.employee_number), on = r.office_number, m = r.processing_month;
  if (cpMatch(r.item_key, v, `${on}|${num}|${m}`)) continue;
  const others = l2Months.filter((mm) => mm !== m && cpMatch(r.item_key, v, `${on}|${num}|${mm}`));
  if (others.length === 0) continue;
  const e = emp.get(`${on}|${num}`), lg = leg.get(`${on}|${num}`);
  const start = lg?.hire_date ? ym(lg.hire_date) : e?.hire_date ? ym(e.hire_date, 1) : /^\d{6}$/.test(num) ? `20${num.slice(0, 4)}` : null;
  const end = lg?.quit_date ? ym(lg.quit_date) : e?.resignation_date ? ym(e.resignation_date, 1) : null;
  const outside = (start && m < start) || (end && m > end);
  const label = `${m} ${on} ${num} ${e?.name ?? lg?.employee_name ?? ""} ${r.item_key}=${v}`;
  if (!outside) { skipped.push(`${label}: ② の ${others.join(",")} と一致するが 在籍期間の中なので 人が見る`); continue; }
  if (others.length > 1) { skipped.push(`${label}: ② の ${others.join(",")} の複数と一致。どこに移すか決められない`); continue; }
  const to = others[0];
  if (inputs.some((x) => x.office_number === on && nn(x.employee_number) === num && x.processing_month === to && x.item_key === r.item_key)) {
    skipped.push(`${label}: 移す先 ${to} に 同じ項目の手入力が既にある。触らない`); continue;
  }
  const form = await all(`payroll_office_form_records?select=id,record_type,item_name,numeric_value,item_date,start_time,end_time,break_time&office_number=eq.${on}&employee_number=in.(${num},0${num})&processing_month=eq.${to}`);
  const already = formAmount(r.item_key, form);
  if (already != null && eq(already, v)) {
    plan.push({ id: r.id, label, action: "ZERO", why: `${to} の事業所書式に 既に同じ ${already} がある (移すと二重)`, body: { numeric_value: 0, note: `${r.note ?? ""} ${MARKER} ${m} → ${to} の事業所書式と重複のため 0 (元の値 ${v})`.trim() } });
  } else {
    plan.push({ id: r.id, label, action: "MOVE", why: `${to} の事業所書式は ${already ?? "対応欄なし"}`, body: { processing_month: to, note: `${r.note ?? ""} ${MARKER} ${m} から付け替え`.trim() } });
  }
}

console.log(`=== 月違いの手入力を直す ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log(`対象の判定: 値がありふれていない / その月の総括表 ② と合わず 別の 1 か月と一致 / 在籍期間の外`);
console.log(`\n--- 直すもの ${plan.length} 件`);
for (const p of plan) console.log(`  ${p.action === "ZERO" ? "0 にする" : "付け替え"}  ${p.label}  (${p.why})`);
if (skipped.length) { console.log(`\n--- 触らないもの ${skipped.length} 件`); for (const s of skipped) console.log("  " + s); }
const confirmSql = `SELECT office_number, employee_number, processing_month, item_key, numeric_value, note
  FROM payroll_monthly_inputs WHERE note LIKE '%${MARKER}%' ORDER BY office_number, employee_number, processing_month;`;
if (!EXECUTE) { console.log(`\nDRY RUN。--execute で書き込みます。書いた後の確認 SQL:\n${confirmSql}`); process.exit(0); }

const backup = inputs.filter((r) => plan.some((p) => p.id === r.id));
const bpath = `migrations/_backup_manual_input_wrong_month_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.json`;
writeFileSync(bpath, JSON.stringify(backup, null, 1));
console.log(`\n元の行を ${bpath} に保存しました (${backup.length} 行)`);
let done = 0;
for (const p of plan) {
  const res = await fetch(`${SB}payroll_monthly_inputs?id=eq.${p.id}`, { method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(p.body) });
  const b = await res.json();
  if (!res.ok || !Array.isArray(b) || b.length !== 1) { console.error(`★ 書き込み失敗: ${p.label}\n  ${JSON.stringify(b).slice(0, 400)}`); process.exit(1); }
  done++;
}
console.log(`反映 ${done} 件。確認 SQL:\n${confirmSql}`);
