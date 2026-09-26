/**
 * 遅刻早退の分を ② (支払用の総括表) から取り込む (2026-09-27)。
 *
 *   node migrations/import_late_early_minutes_from_soukatsu.mjs            # DRY RUN
 *   node migrations/import_late_early_minutes_from_soukatsu.mjs --execute  # 本番
 *   node migrations/import_late_early_minutes_from_soukatsu.mjs --delete --execute   # 撤去
 *
 * 【なぜ】
 * ★ 遅刻早退は当方に項目が無く、★ 実装しても **手入力が 0 件なので誰の支給も変わらない**。
 *   分の出どころは ★ 出勤簿からは出せない (遅刻・早退の注記が 0 件 / 半休と区別できない /
 *   対象者の 1 人は出勤簿自体が無い)。★ ② が分を持っているので そこから写す。
 *
 * 【② の列】遅刻早退 (分) / 遅刻早退単価 (円/時・負) / 遅刻早退金額 (円・負)
 * ★ 分が 0 でない行だけを入れる。★ 2026-09-27 時点で 5 人月・全員 事務員・月給。
 *
 * ⚠ 熊谷明日香 202607 は ② が別の単価 (残業の時間単価 1,283) で掛けていて、
 *   当方の式では 2,388 円になる (② は 2,566 円)。★ 1 件では規則か誤りか決まらないので
 *   **分だけ写し、金額は当方の式に任せる**。差 178 円は既知として残す。
 *
 * ⚠ 入れても payroll_calc_results は変わらない。★ 138 件の再計算をするまで 支給額は動かない。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");
const BACKUP = "migrations/_backup_late_early_minutes_20260927.json";
const NOTE = "[遅刻早退の分を②から取込 2026-09-27]";
const ITEM = "late_early_minutes";
const MIN_KEY = "遅刻早退";          // 分
const YEN_KEY = "遅刻早退金額";       // 円 (負)

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
async function all(q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB}/rest/v1/${q}${q.includes("?") ? "&" : "?"}order=id&offset=${from}&limit=1000`, { headers: H });
    if (!r.ok) throw new Error(`${r.status} ${q.slice(0, 60)}: ${await r.text()}`);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(`配列でない: ${JSON.stringify(j).slice(0, 200)}`);
    out.push(...j);
    if (j.length < 1000) break;
  }
  return out;
}

if (DELETE) {
  if (!existsSync(BACKUP)) { console.error(`★ 控え ${BACKUP} がありません。撤去できません`); process.exit(1); }
  const ids = JSON.parse(readFileSync(BACKUP, "utf8")).inserted_ids ?? [];
  console.log(`撤去対象 ${ids.length} 行`);
  if (!EXECUTE) { console.log("DRY RUN。--delete --execute で消します"); process.exit(0); }
  const r = await fetch(`${SB}/rest/v1/payroll_monthly_inputs?id=in.(${ids.join(",")})`, { method: "DELETE", headers: H });
  if (!r.ok) throw new Error(`削除に失敗: ${await r.text()}`);
  console.log(`${ids.length} 行を消しました`);
  process.exit(0);
}

const offs = await all("payroll_offices?select=id,office_number");
const offNumOfId = new Map(offs.map((o) => [o.id, o.office_number]));
const emps = await all("payroll_employees?select=office_id,employee_number,name,salary_type,role_type");
const empOf = new Map(emps.map((e) => [`${offNumOfId.get(e.office_id) ?? ""}|${nn(e.employee_number)}`, e]));

// 既にその人月に手入力があれば 触らない (上書きしない)
const existing = new Set(
  (await all(`payroll_monthly_inputs?select=office_number,employee_number,processing_month&item_key=eq.${ITEM}`))
    .map((m) => `${m.office_number}|${nn(m.employee_number)}|${m.processing_month}`),
);

const s2 = await all("payroll_soukatsu_rows?select=office_number,processing_month,row_data");
const rows = [], skipped = [];
for (const r of s2) {
  const min = num(r.row_data?.[MIN_KEY]);
  if (min <= 0) continue;
  const n = nn(r.row_data?._code ?? r.row_data?.["№"] ?? r.row_data?.["社員番号"] ?? "");
  if (!n) { skipped.push(`  ${r.processing_month} ${r.office_number} 職員番号が読めない (分=${min})`); continue; }
  const k = `${r.office_number}|${n}`;
  const e = empOf.get(k);
  const label = `${r.processing_month} ${r.office_number} ${n} ${e?.name ?? "★ 職員マスタに無い"}`;
  if (!e) { skipped.push(`  ${label}  分=${min}`); continue; }
  if (existing.has(`${k}|${r.processing_month}`)) { skipped.push(`  ${label}  ★ 既に手入力がある (上書きしない)`); continue; }
  rows.push({
    office_number: r.office_number, employee_number: n, processing_month: r.processing_month,
    item_key: ITEM, numeric_value: min, note: NOTE,
    _label: label, _yen: num(r.row_data?.[YEN_KEY]), _type: `${e.salary_type}/${e.role_type}`,
  });
}
rows.sort((a, b) => a._label.localeCompare(b._label));

console.log(`=== 遅刻早退の分を ② から取り込む ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===\n`);
console.log(`--- 入れる ${rows.length} 件`);
for (const r of rows) console.log(`  ${r._label}  ${r.numeric_value} 分  (② の金額 ${r._yen}円)  ${r._type}`);
if (skipped.length) {
  console.log(`\n--- 入れない ${skipped.length} 件`);
  for (const s of skipped) console.log(s);
}

if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }
if (rows.length === 0) { console.log("\n対象がありません"); process.exit(0); }

const payload = rows.map((x) => ({
  office_number: x.office_number, employee_number: x.employee_number,
  processing_month: x.processing_month, item_key: x.item_key,
  numeric_value: x.numeric_value, note: x.note,
}));
const res = await fetch(`${SB}/rest/v1/payroll_monthly_inputs`, {
  method: "POST", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(payload),
});
if (!res.ok) { console.error(`★ 書き込みに失敗: ${await res.text()}`); process.exit(1); }
const inserted = await res.json();
writeFileSync(BACKUP, JSON.stringify({ at: new Date().toISOString(), note: NOTE, inserted_ids: inserted.map((x) => x.id), rows: payload }, null, 2));
console.log(`\n${inserted.length} 行を入れました。控え: ${BACKUP}`);
if (inserted.length !== rows.length) { console.error(`★ 件数が合いません (期待 ${rows.length})`); process.exit(2); }
console.log(`\n⚠ 支給額はまだ変わっていません。138 事業所月の再計算をするまで payload は古いままです。
★ 撤去: node migrations/import_late_early_minutes_from_soukatsu.mjs --delete --execute`);
