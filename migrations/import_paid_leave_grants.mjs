/**
 * 有給ファイル (Box 03_有給/<法人>/<年度>/<事業所>.xlsm) の個人シートから、付与ごとの日当を
 * payroll_paid_leave_grants に入れる (2026-09-18)。
 *
 *   node migrations/import_paid_leave_grants.mjs <grants.json>            # DRY RUN
 *   node migrations/import_paid_leave_grants.mjs <grants.json> --execute
 *
 * <grants.json> は xlsm を scratchpad にコピーして openpyxl で読んだもの (Box の元ファイルには触らない)。
 *   個人シート: B2 社員番号 / B3 氏名 / A1 年度の付与日 / T4 前年度繰越日数 / X4 今年度付与日数 /
 *               E29 (無ければ B14) 今年度日当 / B11 前年度日当 (空なら 1 つ前の年度の今年度日当)
 * 職員は (社員番号, 氏名) で引く。同じ人が 2 事業所に登録されていれば両方に入れる (兼務)。
 * 前提 SQL: migrations/payroll_paid_leave_grants.sql
 * 冪等 (upsert employee_id + grant_date)。
 */
import { readFileSync } from "node:fs";

const [SRC] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const EXECUTE = process.argv.includes("--execute");
if (!SRC) { console.error("grants.json を指定してください"); process.exit(1); }

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
const nn = (s) => String(s ?? "").trim().replace(/^0+/, "");
const nm = (s) => String(s ?? "").split("\n")[0].replace(/[\s　]/g, "").replace(/\(.*?\)|（.*?）/g, "");

const src = JSON.parse(readFileSync(SRC, "utf8"));
const emps = await getAll("payroll_employees?select=id,employee_number,name");
const have = new Map((await getAll("payroll_paid_leave_grants?select=id,employee_id,grant_date,carry_days,prev_rate,cur_rate"))
  .map((g) => [`${g.employee_id}|${g.grant_date}`, g]));

const rows = [];
let unmatched = 0;
const unmatchedList = [];
for (const g of src) {
  const hits = emps.filter((e) => nn(e.employee_number) === nn(g.employee_number) && nm(e.name) === nm(g.name));
  if (hits.length === 0) { unmatched++; if (unmatchedList.length < 20) unmatchedList.push(`${g.employee_number} ${g.name} (${g.file})`); continue; }
  for (const e of hits) {
    const row = { employee_id: e.id, grant_date: g.grant_date, carry_days: g.carry ?? 0, grant_days: g.grant ?? null,
      prev_rate: g.prev ?? null, cur_rate: g.cur ?? null, source: g.file, updated_at: new Date().toISOString() };
    const cur = have.get(`${e.id}|${g.grant_date}`);
    if (cur && Number(cur.carry_days) === Number(row.carry_days) && (cur.prev_rate ?? null) === row.prev_rate && (cur.cur_rate ?? null) === row.cur_rate) continue;
    rows.push(row);
  }
}
console.log(`有給ファイルの行 ${src.length} / 書き込み ${rows.length} / 職員が見つからない ${unmatched}`);
for (const u of unmatchedList) console.log(`  見つからない: ${u}`);
for (const r of rows.slice(0, 5)) console.log("  例", JSON.stringify(r));
if (!EXECUTE) { console.log("DRY RUN (--execute で書き込み)"); process.exit(0); }
for (let i = 0; i < rows.length; i += 500) {
  const r = await fetch(`${SB}/rest/v1/payroll_paid_leave_grants?on_conflict=employee_id,grant_date`, {
    method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows.slice(i, i + 500)) });
  if (!r.ok) { console.error(`★ 失敗: ${await r.text()}`); process.exit(1); }
}
console.log(`完了 ${rows.length} 件`);
