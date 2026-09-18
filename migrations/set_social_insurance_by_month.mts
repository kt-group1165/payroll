/**
 * パートの社会保険 (処遇改善補助金・通信手当の判定) を 月ごとに payroll_monthly_inputs (social_insurance = 1/0) に入れる (2026-09-19)。
 *
 *   npx tsx migrations/set_social_insurance_by_month.mts --extract-dir <dir> --months 202603,...            # DRY RUN
 *   npx tsx migrations/set_social_insurance_by_month.mts ... --execute
 *
 * 決め方 (sync-master-from-soukatsu と同じ): その月の総括表 (パート) に 処遇改善補助金手当 が出ていれば 社保あり。
 *   職員マスタの social_insurance は最新月の値 1 つだけなので、途中で外れた・入った人の過去月が違っていた
 *   (船橋 清水・猪垣: 3〜5 月は補助金 20,000 あり → 6・7 月なし)。
 * 職員マスタと同じ値の月は入れない (差がある月だけ)。実績の無い月 (訪問 0) は補助金も出ないので入れない。
 * 職員は (社員番号, 氏名) で引く。冪等 (upsert)。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const DIR = opt("--extract-dir");
const MONTHS = (opt("--months") ?? "").split(",").filter(Boolean);
if (!DIR || MONTHS.length === 0) { console.error("--extract-dir <dir> --months YYYYMM,..."); process.exit(1); }

const env: Record<string, string> = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
async function getAll(p: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB}/rest/v1/${p}&order=id&offset=${from}&limit=1000`, { headers: H });
    if (!r.ok) throw new Error(`${p}: ${await r.text()}`);
    const d = await r.json() as Record<string, unknown>[];
    out.push(...d);
    if (d.length < 1000) break;
  }
  return out;
}
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");
const nm = (s: unknown) => String(s ?? "").split("\n")[0].replace(/[\s　]/g, "").replace(/\(.*?\)|（.*?）/g, "");

const offices = await getAll("payroll_offices?select=id,office_number");
const offById = new Map(offices.map((o) => [String(o.id), String(o.office_number)]));
const emps = await getAll("payroll_employees?select=id,employee_number,name,office_id,social_insurance,salary_type");
const have = new Map((await getAll("payroll_monthly_inputs?select=id,office_number,employee_number,processing_month,numeric_value&item_key=eq.social_insurance"))
  .map((r) => [`${r.office_number}|${r.employee_number}|${r.processing_month}`, Number(r.numeric_value)]));

const rows: Record<string, unknown>[] = [];
const notes: string[] = [];
for (const m of MONTHS) {
  const ex = JSON.parse(readFileSync(path.join(DIR, `soukatsu${m}`, "extract.json"), "utf8")) as { office: string; kind: string; rows: Record<string, unknown>[] }[];
  for (const f of ex) {
    if (f.kind !== "part") continue;
    for (const r of f.rows) {
      const name = nm(r["氏名"]);
      if (!name || /^(合計|小計|計)$/.test(name) || name.includes("_")) continue;
      const visit = typeof r["実績"] === "number" ? (r["実績"] as number) : 0;
      if (visit <= 0) continue;
      const si = typeof r["処遇改善補助金手当"] === "number" && (r["処遇改善補助金手当"] as number) > 0 ? 1 : 0;
      const hits = emps.filter((e) => nn(e.employee_number) === nn(r._code) && nm(e.name) === name);
      if (hits.length === 0) { notes.push(`${m} ${f.office} ${r._code} ${name}: 職員が見つからない`); continue; }
      for (const e of hits) {
        const off = offById.get(String(e.office_id));
        if (!off) continue;
        const master = e.social_insurance ? 1 : 0;
        const k = `${off}|${nn(e.employee_number)}|${m}`;
        if (si === master && !have.has(k)) continue;
        if (have.get(k) === si) continue;
        rows.push({ office_number: off, employee_number: nn(e.employee_number), processing_month: m, item_key: "social_insurance",
          numeric_value: si, note: `総括表 ${m} 処遇改善補助金手当 ${si ? "あり" : "なし"} (職員マスタ ${master ? "あり" : "なし"})`, updated_at: new Date().toISOString() });
      }
    }
  }
}
for (const r of rows) console.log(`${r.processing_month} ${r.office_number} ${r.employee_number}: 社保 ${r.numeric_value ? "あり" : "なし"}`);
console.log(`書き込み ${rows.length} 件 / 職員が見つからない ${notes.length}`);
if (!EXECUTE) { console.log("DRY RUN (--execute で書き込み)"); process.exit(0); }
for (let i = 0; i < rows.length; i += 500) {
  const r = await fetch(`${SB}/rest/v1/payroll_monthly_inputs?on_conflict=office_number,employee_number,processing_month,item_key`, {
    method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows.slice(i, i + 500)) });
  if (!r.ok) { console.error(`★ 失敗: ${await r.text()}`); process.exit(1); }
}
console.log(`完了 ${rows.length} 件`);
