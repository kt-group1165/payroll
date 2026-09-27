/**
 * 通勤費の入れ漏れ (その月だけ 通勤km も 円の手入力も無い) を ② の額で埋める (2026-09-27 給与D)。
 *
 *   node migrations/fix_missing_commute_input.mjs            # DRY RUN
 *   node migrations/fix_missing_commute_input.mjs --execute  # 本番
 *   node migrations/fix_missing_commute_input.mjs --delete --execute   # 撤去 (控えの行だけ消す)
 *
 * 【なぜ】
 * 通勤費は 出勤簿の通勤km / 事業所書式の通勤km / 手入力 commute_yen (円) のどれかから出る
 * (payroll-calc.ts commuteFeeAmount・hourlyCommuteFeeAmount / page.tsx)。どれも無い月は 0 円になる。
 * 例: 熊谷 明日香 1272404508 202605 — 当方 0 / ② 9,200 (往復 460 円 × 20 日)。
 *   5 月だけ出勤簿の通勤km が空。4 月は円 6,900 の手入力・6〜8 月は km で ② と一致 (給与C が特定)。
 * 実測 (2026-09-27・再計算後): ② と当方の両方に居る人月で ② だけが通勤費を払っているのは 13 人月 ¥57,836。
 *   その 10 人月は その人に通勤の記録が 1 か月も無い (条件 1 を満たさない) ので 入れない。
 *
 * 【入れる条件 — ★ 全部を満たす人月だけ】
 *   1. その人に 通勤の記録 (出勤簿km / 書式km / 手入力円) がある月が 1 つ以上ある (= 通勤費をもらう人)
 *   2. その月には 通勤km も 円の手入力も **無い**
 *   3. ★ ② (支払用の総括表) が その月に通勤費を払っている → 入れる額は ② の通勤費 (円)
 *   4. その月に 出張km も無い (★ 通勤の km が 出張の欄に入っている月は 入れると二重になるので 入れない)
 *      例: 福田 八重子 1270402116 202605 — ② は通勤 87km 1,071 円 / 当方は 出張km 69 を 出張費で払っている
 *
 * ⚠ 入れる値は 円 (commute_yen)。km ではない (② の額をそのまま使う。単価の履歴に左右されない)。
 * ⚠ 入れても payroll_calc_results は変わらない。★ その事業所月を再計算するまで 支給額は動かない。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");
const BACKUP = "migrations/_backup_commute_input_20260927.json";
const NOTE = "[通勤費の入れ漏れ是正 2026-09-27]";
const MONTHS = ["202603", "202604", "202605", "202606", "202607", "202608"];

const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) { console.error("★ .env.local が読めません"); process.exit(1); }
const H = { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" };

const nn = (s) => String(s ?? "").trim().replace(/^0+/, "");
const num = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (v && typeof v === "object" && "result" in v) return num(v.result);
  const n = Number(String(v ?? "").normalize("NFKC").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
// ★ order 無しのページングは行が抜ける
async function all(q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const url = `${SB}/rest/v1/${q}${q.includes("?") ? "&" : "?"}order=id&offset=${from}&limit=1000`;
    const r = await fetch(url, { headers: H });
    if (!r.ok) throw new Error(`${r.status} ${q.slice(0, 60)}: ${await r.text()}`);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(`配列でない: ${JSON.stringify(j).slice(0, 200)}`);
    out.push(...j);
    if (j.length < 1000) break;
  }
  return out;
}

// ── 撤去 ──
if (DELETE) {
  if (!existsSync(BACKUP)) { console.error(`★ 控え ${BACKUP} がありません。撤去できません`); process.exit(1); }
  const ids = JSON.parse(readFileSync(BACKUP, "utf8")).inserted_ids ?? [];
  console.log(`撤去対象 ${ids.length} 行`);
  if (!EXECUTE) { console.log("DRY RUN。--delete --execute で消します"); process.exit(0); }
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const r = await fetch(`${SB}/rest/v1/payroll_monthly_inputs?id=in.(${chunk.join(",")})`, { method: "DELETE", headers: H });
    if (!r.ok) throw new Error(`削除に失敗: ${await r.text()}`);
  }
  console.log(`${ids.length} 行を消しました`);
  process.exit(0);
}

const offs = await all("payroll_offices?select=id,office_number");
const offNumOfId = new Map(offs.map((o) => [o.id, o.office_number]));
const emps = await all("payroll_employees?select=office_id,employee_number,name");
const nameOf = new Map(emps.map((e) => [`${offNumOfId.get(e.office_id) ?? ""}|${nn(e.employee_number)}`, e.name]));

// 通勤の記録 (人 → 月 → 出どころ)
const commute = new Map();
const addC = (on, emp, m, s) => { const k = `${on}|${nn(emp)}`; if (!commute.has(k)) commute.set(k, new Map()); const mm = commute.get(k); mm.set(m, [...(mm.get(m) ?? []), s]); };
for (const r of await all("payroll_attendance_records?select=id,office_number,employee_number,year,month,commute_km&commute_km=gt.0")) addC(r.office_number, r.employee_number, `${r.year}${String(r.month).padStart(2, "0")}`, "出勤簿km");
for (const r of await all("payroll_office_form_records?select=id,office_number,employee_number,processing_month&item_name=eq.通勤km&numeric_value=gt.0")) addC(r.office_number, r.employee_number, r.processing_month, "書式km");
const yenRows = await all("payroll_monthly_inputs?select=id,office_number,employee_number,processing_month,numeric_value&item_key=eq.commute_yen");
for (const r of yenRows) if (Number(r.numeric_value ?? 0) > 0) addC(r.office_number, r.employee_number, r.processing_month, "手入力円");
const yenAny = new Set(yenRows.map((r) => `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`)); // 0 が入っている月も「触らない」

// 出張km (手入力 / 書式 / 出勤簿)
const trip = new Set();
for (const r of await all("payroll_monthly_inputs?select=id,office_number,employee_number,processing_month&item_key=eq.business_km&numeric_value=gt.0")) trip.add(`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`);
for (const r of await all("payroll_office_form_records?select=id,office_number,employee_number,processing_month&item_name=eq.出張km&numeric_value=gt.0")) trip.add(`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`);
for (const r of await all("payroll_attendance_records?select=id,office_number,employee_number,year,month&business_km=gt.0")) trip.add(`${r.office_number}|${nn(r.employee_number)}|${r.year}${String(r.month).padStart(2, "0")}`);

// ② の通勤費
const paid = new Map();
for (const r of await all("payroll_soukatsu_rows?select=id,office_number,processing_month,row_data")) {
  const n = nn(r.row_data?._code ?? r.row_data?.["№"] ?? r.row_data?.["社員番号"] ?? "");
  if (!n) continue;
  const key = `${r.office_number}|${n}|${r.processing_month}`;
  paid.set(key, Math.max(paid.get(key) ?? 0, num(r.row_data?.["通勤費"])));
}

const rows = [], skipped = [];
for (const [key, p] of paid) {
  if (!(p > 0)) continue;                                            // 条件3
  const [on, emp, m] = key.split("|");
  if (!MONTHS.includes(m)) continue;
  const byMonth = commute.get(`${on}|${emp}`);
  const label = `${m} ${on} ${emp} ${nameOf.get(`${on}|${emp}`) ?? "?"}  ② ¥${p.toLocaleString()}`;
  if (byMonth?.has(m) || yenAny.has(key)) continue;                  // 条件2 (記録がある月 / 0 円が入っている月は触らない)
  if (!byMonth || byMonth.size === 0) { skipped.push(`  ${label}  通勤の記録がある月が 1 つも無い (条件 1)`); continue; }  // 条件1
  if (trip.has(key)) { skipped.push(`  ${label}  ★ その月に出張km がある (通勤が出張の欄に入っている可能性。入れると二重) (条件 4)`); continue; }
  rows.push({ office_number: on, employee_number: emp, processing_month: m, item_key: "commute_yen", numeric_value: p, note: NOTE, _label: label, _months: [...byMonth.keys()].sort().join(",") });
}

console.log(`=== 通勤費の入れ漏れを埋める ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log("条件: 通勤の記録がある月がある / その月は km も円も無い / ★ ② がその月に通勤費を払っている / その月に出張km が無い\n");
console.log(`--- 入れる ${rows.length} 件 (計 ¥${rows.reduce((s, r) => s + r.numeric_value, 0).toLocaleString()}。再計算した月から支給額に出る)`);
for (const r of rows) console.log(`  ${r._label}  → commute_yen ${r.numeric_value}  (通勤の記録がある月: ${r._months})`);
console.log(`\n--- 入れない ${skipped.length} 件`);
for (const s of skipped) console.log(s);

if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }
if (rows.length === 0) { console.log("\n対象がありません"); process.exit(0); }

const payload = rows.map((x) => ({
  office_number: x.office_number, employee_number: x.employee_number,
  processing_month: x.processing_month, item_key: x.item_key,
  numeric_value: x.numeric_value, note: x.note,
}));
const r = await fetch(`${SB}/rest/v1/payroll_monthly_inputs`, {
  method: "POST", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(payload),
});
if (!r.ok) { console.error(`★ 書き込みに失敗: ${await r.text()}`); process.exit(1); }
const inserted = await r.json();
writeFileSync(BACKUP, JSON.stringify({ restored_at: new Date().toISOString(), note: NOTE, inserted_ids: inserted.map((x) => x.id), rows: payload }, null, 2));
console.log(`\n${inserted.length} 行を入れました。控え: ${BACKUP}`);
if (inserted.length !== rows.length) { console.error(`★ 件数が合いません (期待 ${rows.length})`); process.exit(2); }
console.log(`\n確認 SQL:
SELECT office_number, employee_number, processing_month, numeric_value, note
  FROM payroll_monthly_inputs WHERE note = '${NOTE}' ORDER BY office_number, employee_number, processing_month;
★ 期待 ${rows.length} 行

⚠ 支給額はまだ変わっていません。その事業所月を再計算するまで payload は古いままです。
★ 撤去: node migrations/fix_missing_commute_input.mjs --delete --execute`);
