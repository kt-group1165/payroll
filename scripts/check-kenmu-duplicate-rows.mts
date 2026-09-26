/**
 * payroll_soukatsu_rows 全件から「兼務者」タグが付いた行、および
 * 同一人物(氏名正規化)の複数office行で 総支給額が完全一致する行(=行ごとコピーの疑い)を洗い出す。
 * DB書換なし。読み取りのみ。
 *
 *   npx tsx scripts/check-kenmu-duplicate-rows.mts
 */
import { readFileSync } from "node:fs";
const env: Record<string, string> = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY };

type Row = { office_number: string; processing_month: string; employee_number: string; employee_name: string; sheet_kind: string; row_data: Record<string, unknown> };

async function getAll(): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/payroll_soukatsu_rows?select=office_number,processing_month,employee_number,employee_name,sheet_kind,row_data&order=id`, { headers: { ...H, Range: `${from}-${from + 999}` } });
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(JSON.stringify(j));
    out.push(...j);
    if (j.length < 1000) break;
  }
  return out;
}
const norm = (s: unknown) => String(s ?? "").normalize("NFKC").replace(/\s+/g, "");

async function main() {
  const rows = await getAll();
  console.log("payroll_soukatsu_rows 総行数:", rows.length);

  // ① 兼務者タグが付いた行
  const tagged = rows.filter((r) => r.row_data["兼務者"] != null && String(r.row_data["兼務者"]).trim() !== "");
  const taggedNames = new Set(tagged.map((r) => `${norm(r.employee_name)}|${r.employee_number}`));
  console.log(`\n=== ① 兼務者タグが付いた行 (母数: 総行数${rows.length}) ===`);
  console.log(`該当行数: ${tagged.length} / 対象人数(氏名+職員番号ベース): ${taggedNames.size}`);
  for (const r of tagged) {
    console.log(`  ${r.employee_name}(${r.employee_number}) office=${r.office_number} ${r.processing_month} 兼務者タグ=${r.row_data["兼務者"]} 総支給額=${r.row_data["総支給額"]}`);
  }

  // ② 職員番号 (氏名の "_高品" 等サフィックスに影響されない) で同一人物とみなし、
  //   複数officeに登場し、かつ総支給額が完全一致する組
  const byName = new Map<string, Row[]>();
  for (const r of rows) {
    const key = String(r.employee_number) + "|" + r.sheet_kind;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(r);
  }
  const dupCandidates: { name: string; month: string; rows: Row[] }[] = [];
  for (const [, list] of byName) {
    const byMonth = new Map<string, Row[]>();
    for (const r of list) { if (!byMonth.has(r.processing_month)) byMonth.set(r.processing_month, []); byMonth.get(r.processing_month)!.push(r); }
    for (const [month, monthRows] of byMonth) {
      const offices = new Set(monthRows.map((r) => r.office_number));
      if (offices.size < 2) continue;
      const totals = monthRows.map((r) => Number(r.row_data["総支給額"] ?? 0));
      if (totals.every((t) => t > 0) && new Set(totals).size === 1) {
        dupCandidates.push({ name: monthRows[0].employee_name, month, rows: monthRows });
      }
    }
  }
  console.log(`\n=== ② 同一氏名・同月で複数office かつ 総支給額が完全一致 (行コピー疑い) ===`);
  console.log(`母数: 氏名+シート種別グループ ${byName.size} / 該当(人×月): ${dupCandidates.length}`);
  const uniqueNames = new Set(dupCandidates.map((c) => c.name));
  console.log(`対象人数(ユニーク氏名): ${uniqueNames.size}`);
  for (const c of dupCandidates) {
    console.log(`  ${c.name} ${c.month}: ${c.rows.map((r) => `${r.office_number}=¥${r.row_data["総支給額"]}`).join(" / ")}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
