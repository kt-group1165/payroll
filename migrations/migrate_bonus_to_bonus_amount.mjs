/**
 * 報奨金を 新しい持ち方に移す (user 2026-09-22「金額は個人で設定、変更がない限り続く。支給する/しないは別画面」)。
 *
 *   SP=<scratchpad> node migrations/migrate_bonus_to_bonus_amount.mjs            # DRY RUN
 *   SP=<scratchpad> node migrations/migrate_bonus_to_bonus_amount.mjs --execute
 *
 * これまで: 総括表の 報奨金 を 給与設定の special_bonus (特別報奨金 = 毎月固定) に 月ごとの履歴行 で入れて合わせていた。
 * これから: 金額 = 給与設定の bonus_amount (続く) / 支給 = payroll_monthly_inputs item_key=bonus_paid (月ごと, /bonus-payments)。
 *
 * 対象: 総括表 2026-03〜08 の 提責_社員 で 報奨金 (+特別報奨金) が出ている月給者だけ (user 2026-09-22)。
 * やること:
 *   1. その人の給与設定の各行の bonus_amount = その行が有効な月のうち 報奨金が出た最後の月の額。
 *      出た月が無い行は 1 つ前の行の額を引き継ぐ (最初の行は その人の最初に出た額)。special_bonus は 0 にする
 *   2. 報奨金が出た 事業所 × 月 × 職員 に bonus_paid = 1 を入れる
 *   3. 検算: 支給の月ごとに「その月に有効な行の bonus_amount = 総括表の額」か。違えば止める (同じ行の中で額が変わる人)
 * 冪等。3〜7月の総支給は変わらないはず (再計算して確かめる)。
 */
import { readFileSync, writeFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const SP = process.env.SP;
if (!SP) { console.error("SP=<soukatsu<YYYYMM>/extract.json のある作業フォルダ> を指定"); process.exit(1); }
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
const ymOf = (d) => d.slice(0, 7).replace("-", "");

// 総括表で報奨金が出た (事業所, 職員) → { 月: 額 }
const paidBy = new Map();
for (const m of MONTHS) {
  for (const f of JSON.parse(readFileSync(`${SP}/soukatsu${m}/extract.json`, "utf8"))) {
    const on = OFF[f.office];
    if (!on || f.kind === "part") continue;
    for (const r of f.rows) {
      if (String(r._code).includes("合計") || String(r["氏名"] ?? "").includes("合計")) continue;
      const v = num(r["報奨金"]) + num(r["特別報奨金"]);
      if (v <= 0) continue;
      const k = `${on}|${nn(r._code)}`;
      if (!paidBy.has(k)) paidBy.set(k, { name: r["氏名"], months: {} });
      paidBy.get(k).months[m] = v;
    }
  }
}
const offices = await get("payroll_offices?select=id,office_number");
const offIdByNum = new Map(offices.map((o) => [o.office_number, o.id]));

const settingPatches = []; const flags = []; const problems = []; const lines = []; const backup = [];
for (const [k, { name, months }] of paidBy) {
  const [on, code] = k.split("|");
  const emps = await get(`payroll_employees?select=id,employee_number,name&office_id=eq.${offIdByNum.get(on)}`);
  const e = emps.find((x) => nn(x.employee_number) === code);
  if (!e) { problems.push(`${on} ${code} ${name}: 職員が登録されていない`); continue; }
  const rows = (await get(`payroll_salary_settings?select=id,effective_from,bonus_amount,special_bonus&employee_id=eq.${e.id}`))
    .sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  if (rows.length === 0) { problems.push(`${on} ${code} ${name}: 給与設定が無い`); continue; }
  const paidMonths = Object.keys(months).sort();
  let carry = months[paidMonths[0]];
  const planned = [];
  for (let i = 0; i < rows.length; i++) {
    const from = ymOf(rows[i].effective_from), to = rows[i + 1] ? ymOf(rows[i + 1].effective_from) : "999999";
    const inRow = paidMonths.filter((m) => m >= from && m < to);
    const amount = inRow.length ? months[inRow[inRow.length - 1]] : carry;
    carry = amount;
    planned.push({ ...rows[i], amount });
    if (num(rows[i].bonus_amount) !== amount || num(rows[i].special_bonus) !== 0) {
      backup.push(rows[i]);
      settingPatches.push({ id: rows[i].id, patch: { bonus_amount: amount, special_bonus: 0 }, label: `${on} ${code} ${name} 行 ${rows[i].effective_from}: 報奨金 ${num(rows[i].bonus_amount)}→${amount} / 特別報奨金 ${num(rows[i].special_bonus)}→0` });
    }
  }
  for (const m of paidMonths) {
    const start = `${m.slice(0, 4)}-${m.slice(4, 6)}-01`;
    const row = planned.filter((r) => r.effective_from <= start).at(-1);
    if (!row) { problems.push(`${on} ${code} ${name} ${m}: その月に有効な給与設定が無い`); continue; }
    if (row.amount !== months[m]) problems.push(`${on} ${code} ${name} ${m}: 総括 ${months[m]} / 給与設定の行 (${row.effective_from}) の額 ${row.amount}。同じ行の中で額が変わる`);
    flags.push({ office_number: on, employee_number: e.employee_number, processing_month: m, item_key: "bonus_paid", numeric_value: 1 });
  }
  lines.push(`${on} ${code} ${name}: ${paidMonths.map((m) => `${m.slice(4)}月 ${months[m]}`).join(" / ")}`);
}
console.log(`=== 報奨金の移行 ${EXECUTE ? "【本番】" : "(DRY RUN)"} 対象 ${lines.length} 名 / 給与設定 ${settingPatches.length} 行 / 支給記録 ${flags.length} 件 ===`);
for (const l of lines) console.log("  " + l);
for (const s of settingPatches) console.log("  設定 " + s.label);
if (problems.length) { console.log("--- ★ 要確認 (この場合は書き込まない)"); for (const p of problems) console.log("  " + p); }
if (!EXECUTE) { console.log("DRY RUN。--execute で書き込みます"); process.exit(0); }
if (problems.length) { console.error("★ 要確認があるので書き込みません"); process.exit(2); }
writeFileSync("migrations/_backup_bonus_settings_20260922.json", JSON.stringify(backup, null, 1));
console.log(`  退避: migrations/_backup_bonus_settings_20260922.json (${backup.length} 行)`);
for (const s of settingPatches) {
  const r = await fetch(`${SB_URL}/rest/v1/payroll_salary_settings?id=eq.${s.id}`, { method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(s.patch) });
  const b = await r.json();
  if (!r.ok || !Array.isArray(b) || b.length !== 1) { console.error("★ 給与設定の更新に失敗:", s.label, b); process.exit(1); }
}
const fr = await fetch(`${SB_URL}/rest/v1/payroll_monthly_inputs?on_conflict=office_number,employee_number,processing_month,item_key`, {
  method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(flags) });
const fb = await fr.json();
if (!fr.ok || !Array.isArray(fb) || fb.length !== flags.length) { console.error("★ 支給記録の書き込みに失敗:", fb); process.exit(1); }
console.log(`  反映: 給与設定 ${settingPatches.length} 行 / 支給記録 ${fb.length} 件`);
