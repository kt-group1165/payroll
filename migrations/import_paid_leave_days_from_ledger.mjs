/**
 * 有給管理簿 (Box 03_有給/<法人>/2026/<事業所>.xlsm の「有給管理簿」シート) の月ごとの使用日数を
 * payroll_monthly_inputs (item_key = paid_leave_days) に入れる (2026-09-18)。
 *
 *   node migrations/import_paid_leave_days_from_ledger.mjs <ledger_rows.json>            # DRY RUN
 *   node migrations/import_paid_leave_days_from_ledger.mjs <ledger_rows.json> --execute
 *
 * <ledger_rows.json> は xlsm を scratchpad にコピーして openpyxl で読んだもの (Box の元ファイルには触らない)。
 *   所属名が訪問介護の人だけ、ファイルの地域の訪問介護事業所に入れる (居宅・入浴・看護・福祉用具は除く)。
 *   付与月から 2026-08 まで、使っていない月も 0 日で入れる (= 管理簿に載っている人は管理簿の日数を正とする)。
 * 根拠: 総括表 2026-04〜07 の有給日数と 967 件中 940 件一致 (事業所書式より合う。和田 7 月 25 日は書式に無く管理簿にだけある、
 *   花見川 保本・神宮司 7 月は書式に「有給」があるが管理簿は 0 日で 総括表も手当なし)。
 * 前提 SQL: migrations/payroll_monthly_inputs.sql
 * 冪等 (upsert)。
 */
import { readFileSync } from "node:fs";

const [SRC] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const EXECUTE = process.argv.includes("--execute");
if (!SRC) { console.error("ledger_rows.json を指定してください"); process.exit(1); }
const env = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
async function getAll(p) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB}/rest/v1/${p}&order=id&offset=${from}&limit=1000`, { headers: H });
    if (!r.ok) throw new Error(`${p}: ${await r.text()}`);
    const d = await r.json();
    out.push(...d);
    if (d.length < 1000) break;
  }
  return out;
}
const src = JSON.parse(readFileSync(SRC, "utf8"));
const have = new Map((await getAll("payroll_monthly_inputs?select=id,office_number,employee_number,processing_month,numeric_value&item_key=eq.paid_leave_days"))
  .map((r) => [`${r.office_number}|${r.employee_number}|${r.processing_month}`, Number(r.numeric_value)]));
const rows = src
  .filter((r) => have.get(`${r.office_number}|${r.employee_number}|${r.processing_month}`) !== Number(r.numeric_value))
  .map((r) => ({ office_number: r.office_number, employee_number: r.employee_number, processing_month: r.processing_month,
    item_key: "paid_leave_days", numeric_value: r.numeric_value, note: r.note, updated_at: new Date().toISOString() }));
console.log(`管理簿の行 ${src.length} / 書き込み ${rows.length}`);
for (const r of rows.slice(0, 5)) console.log("  例", JSON.stringify(r));
if (!EXECUTE) { console.log("DRY RUN (--execute で書き込み)"); process.exit(0); }
for (let i = 0; i < rows.length; i += 500) {
  const r = await fetch(`${SB}/rest/v1/payroll_monthly_inputs?on_conflict=office_number,employee_number,processing_month,item_key`, {
    method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows.slice(i, i + 500)) });
  if (!r.ok) { console.error(`★ 失敗: ${await r.text()}`); process.exit(1); }
}
console.log(`完了 ${rows.length} 件`);
