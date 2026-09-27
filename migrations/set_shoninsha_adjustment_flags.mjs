/**
 * 初任者研修調整の旗を ② から立てる (2026-09-27)。
 *
 *   node migrations/set_shoninsha_adjustment_flags.mjs            # DRY RUN
 *   node migrations/set_shoninsha_adjustment_flags.mjs --execute  # 本番
 *   node migrations/set_shoninsha_adjustment_flags.mjs --delete --execute   # 撤去
 *
 * 【なぜ旗だけか】
 * ★ 式は当方のデータだけで出せる: 切り捨て(同行を除く訪問分 × 100 / 60)。
 *   ★ 13/13 で ② と 1 円一致 (給与C が確認)。★ なので **金額は写さない**。
 * ★ 決まらないのは「誰に掛けるか」だけ:
 * ```
 * 無資格で実績があるパートの人月 1,479 のうち 調整があるのは 13 だけ → 資格フラグでは決まらない
 * 初任者研修を受けた人でも掛からない人がいる (大塚史保里 / 安藤仁海 / HO JINAN KYLE)
 *   ★ HO は茂原。同じ事業所の杉尾には掛かっている
 * 始まりと終わりも人ごとに違う (吾妻は 04〜07 / 中崎は 03 だけ)
 *   → 資格を取った日で切れていると見られるが、当方にその日付が無い
 * ```
 * → ★ 月ごとの手入力で「その月は掛ける」の旗だけ持つ (遅刻早退と同じ形)。
 *
 * ⚠ 入れても その事業所月を再計算するまで支給額は変わらない。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");
const BACKUP = "migrations/_backup_shoninsha_adjustment_20260927.json";
const NOTE = "[初任者研修調整の旗 2026-09-27]";
const ITEM = "shoninsha_adjustment";
const KEY = "初任者研修調整費";

const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, K = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !K) { console.error("★ .env.local が読めません"); process.exit(1); }
const H = { apikey: K, Authorization: "Bearer " + K, "Content-Type": "application/json" };

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
  if (!existsSync(BACKUP)) { console.error(`★ 控え ${BACKUP} がありません`); process.exit(1); }
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
const emps = await all("payroll_employees?select=office_id,employee_number,name,salary_type");
const empOf = new Map(emps.map((e) => [`${offNumOfId.get(e.office_id) ?? ""}|${nn(e.employee_number)}`, e]));
const existing = new Set(
  (await all(`payroll_monthly_inputs?select=office_number,employee_number,processing_month&item_key=eq.${ITEM}`))
    .map((m) => `${m.office_number}|${nn(m.employee_number)}|${m.processing_month}`),
);

const s2 = await all("payroll_soukatsu_rows?select=office_number,processing_month,row_data");
const rows = [], skipped = [];
for (const r of s2) {
  const v = num(r.row_data?.[KEY]);
  if (v === 0) continue;                       // ★ マイナスの調整がある行だけ
  const n = nn(r.row_data?._code ?? r.row_data?.["№"] ?? r.row_data?.["社員番号"] ?? "");
  if (!n) { skipped.push(`  ${r.processing_month} ${r.office_number} 職員番号が読めない (② ${v})`); continue; }
  const k = `${r.office_number}|${n}`;
  const e = empOf.get(k);
  const label = `${r.processing_month} ${r.office_number} ${n} ${e?.name ?? "★ 職員マスタに無い"}`;
  if (!e) { skipped.push(`  ${label}  ② ${v}`); continue; }
  if (existing.has(`${k}|${r.processing_month}`)) { skipped.push(`  ${label}  ★ 既に旗がある`); continue; }
  rows.push({ office_number: r.office_number, employee_number: n, processing_month: r.processing_month, item_key: ITEM, numeric_value: 1, note: NOTE, _label: label, _yen: Math.abs(v) });
}
rows.sort((a, b) => a._label.localeCompare(b._label));

console.log(`=== 初任者研修調整の旗 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log(`★ 旗だけ立てる。金額は当方の式 (切り捨て(同行を除く訪問分 × 100 / 60)) で出る\n`);
console.log(`--- 立てる ${rows.length} 件 (② の額 計 ¥${rows.reduce((s, r) => s + r._yen, 0).toLocaleString()})`);
for (const r of rows) console.log(`  ${r._label}  ② ¥${r._yen.toLocaleString()}`);
if (skipped.length) { console.log(`\n--- 立てない ${skipped.length} 件`); for (const s of skipped) console.log(s); }

if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }
if (rows.length === 0) { console.log("\n対象がありません"); process.exit(0); }

const payload = rows.map((x) => ({ office_number: x.office_number, employee_number: x.employee_number, processing_month: x.processing_month, item_key: x.item_key, numeric_value: x.numeric_value, note: x.note }));
const res = await fetch(`${SB}/rest/v1/payroll_monthly_inputs`, { method: "POST", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(payload) });
if (!res.ok) { console.error(`★ 書き込みに失敗: ${await res.text()}`); process.exit(1); }
const ins = await res.json();
writeFileSync(BACKUP, JSON.stringify({ at: new Date().toISOString(), note: NOTE, inserted_ids: ins.map((x) => x.id), rows: payload }, null, 2));
console.log(`\n${ins.length} 行を入れました。控え: ${BACKUP}`);
if (ins.length !== rows.length) { console.error(`★ 件数が合いません (期待 ${rows.length})`); process.exit(2); }
console.log(`\n⚠ 支給額はまだ変わっていません。該当の事業所月を再計算するまで payload は古いままです。
★ 撤去: node migrations/set_shoninsha_adjustment_flags.mjs --delete --execute`);
