/**
 * 岩坪 恵 (五井 1272401967 / 260802) 202608 の HRD研修 4 時間の入れ漏れを 手入力 training_minutes 240 で埋める (2026-09-27 給与D)。
 *
 *   node migrations/fix_missing_hrd_training_iwatsubo_202608.mjs            # DRY RUN
 *   node migrations/fix_missing_hrd_training_iwatsubo_202608.mjs --execute  # 本番
 *   node migrations/fix_missing_hrd_training_iwatsubo_202608.mjs --delete --execute   # 撤去 (控えの行だけ消す)
 *
 * 【なぜ】 ① (総括表データ) 202608: HRD研修時間 04:00 / HRD研修費 4,600 / 会議費 6,000 / 出勤 05:30 (訪問 1:30 + HRD 4:00)。
 *   ② (支払用) 202608: HRD研修 4,600・内研修時間 240・会議費 6,000・総支給 13,871 (① と同額)。4,600 ÷ 1,150 = 4h で逆算も合う。
 *   当方の 202608 の事業所書式は km の 3 行 (会議1件数・出張km・通勤km) だけで 研修の行が無い。手入力も無い。
 *   当方の会議費 6,000 は合っていて HRD研修 4h だけが元データに無い (2026-09-27 給与D。8 月入社のため前月は無い)。
 * 【入れる前に確かめること (どれか外れたら 書かずに止める)】
 *   - 202608 に この人の 手入力 training_minutes が無い / 事業所書式に 研修・HRD研修 の行が無い
 *   - ② 202608 の「HRD研修」が 4,600 / 「内研修時間」が 240
 *   - 202608 の書式に この人の km の行がある (この月に書式が入っていること)
 * ⚠ 入れても その事業所月を再計算するまで 支給額は変わらない。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");
const BACKUP = "migrations/_backup_hrd_training_iwatsubo_20260927.json";
const NOTE = "[HRD研修の入れ漏れ是正 2026-09-27] ①② とも HRD研修 4:00 ¥4,600";
const OFFICE = "1272401967", EMP = "260802", MONTH = "202608", MINUTES = 240;

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
const num = (v) => { const n = Number(String(v ?? "").normalize("NFKC").replace(/[,\s]/g, "")); return Number.isFinite(n) ? n : 0; };
async function get(q) {
  const r = await fetch(`${SB}/rest/v1/${q}`, { headers: H });
  if (!r.ok) throw new Error(`${r.status} ${q.slice(0, 60)}: ${await r.text()}`);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(`配列でない: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
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

const emp = `employee_number=in.(${EMP},0${EMP})`;
const mi = await get(`payroll_monthly_inputs?select=id,processing_month,item_key,numeric_value&office_number=eq.${OFFICE}&${emp}&item_key=eq.training_minutes`);
const kmRows = await get(`payroll_office_form_records?select=id&office_number=eq.${OFFICE}&processing_month=eq.${MONTH}&${emp}&record_type=eq.km`);
const form = await get(`payroll_office_form_records?select=id,item_name&office_number=eq.${OFFICE}&processing_month=eq.${MONTH}&${emp}&item_name=in.(研修,HRD研修)`);
const l2 = (await get(`payroll_soukatsu_rows?select=id,employee_number,row_data&office_number=eq.${OFFICE}&processing_month=eq.${MONTH}`)).filter((r) => nn(r.employee_number) === EMP);
const checks = [
  [!mi.some((r) => r.processing_month === MONTH), `${MONTH} に 手入力 training_minutes が無い`],
  [form.length === 0, `${MONTH} の事業所書式に 研修・HRD研修 の行が無い (${form.length} 行)`],
  [l2.length === 1 && num(l2[0].row_data?.["HRD研修"]) === 4600 && num(l2[0].row_data?.["内研修時間"]) === 240, `② ${MONTH} の HRD研修 4,600 / 内研修時間 240 (実際 ${l2.map((r) => `${r.row_data?.["HRD研修"]}/${r.row_data?.["内研修時間"]}`).join(",") || "行なし"})`],
  [kmRows.length > 0, `${MONTH} の書式に この人の km の行がある (${kmRows.length} 行)`],
];
console.log(`=== 岩坪 恵 ${OFFICE}|${EMP}|${MONTH} HRD研修の入れ漏れ ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
for (const [ok, msg] of checks) console.log(`  ${ok ? "o" : "★ NG"} ${msg}`);
if (checks.some(([ok]) => !ok)) { console.error("★ 前提が崩れているので 書きません"); process.exit(2); }
const row = { office_number: OFFICE, employee_number: EMP, processing_month: MONTH, item_key: "training_minutes", numeric_value: MINUTES, note: NOTE };
console.log(`\n入れる 1 行: ${JSON.stringify(row)}  (再計算後に 研修費 ¥4,600)`);
if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }

const r = await fetch(`${SB}/rest/v1/payroll_monthly_inputs`, { method: "POST", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify([row]) });
if (!r.ok) { console.error(`★ 書き込みに失敗: ${await r.text()}`); process.exit(1); }
const inserted = await r.json();
writeFileSync(BACKUP, JSON.stringify({ restored_at: new Date().toISOString(), note: NOTE, inserted_ids: inserted.map((x) => x.id), rows: [row] }, null, 2));
console.log(`\n${inserted.length} 行を入れました。控え: ${BACKUP}`);
if (inserted.length !== 1) { console.error("★ 件数が合いません (期待 1)"); process.exit(2); }
const after = await get(`payroll_monthly_inputs?select=id,numeric_value,note&office_number=eq.${OFFICE}&${emp}&processing_month=eq.${MONTH}&item_key=eq.training_minutes`);
console.log(`確認: ${MONTH} の training_minutes ${after.length} 行 ${JSON.stringify(after)}`);
console.log(`⚠ 支給額はまだ変わっていません。${OFFICE} ${MONTH} を再計算してください。★ 撤去: node migrations/fix_missing_hrd_training_iwatsubo_202608.mjs --delete --execute`);
