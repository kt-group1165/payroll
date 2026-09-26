/**
 * 「総括表は総支給額=0 なのに、当システムは非ゼロで計算している」パターンを全社で数える。
 * 本郷美江(さつきが丘/2052)で見つかった型が、他にもいないかを確かめるため。DB書換なし。
 *
 *   npx tsx scripts/check-zero-soukatsu-nonzero-calc.mts
 */
import { readFileSync } from "node:fs";
import { pickSoukatsu } from "../src/lib/payroll/soukatsu-diff.js";
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
const norm = (n: unknown) => String(n ?? "").replace(/^0+/, "");
const num = (v: unknown) => (typeof v === "number" ? v : 0);

async function getAll<T>(q: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${q}${q.includes("?") ? "&" : "?"}order=id`, { headers: { ...H, Range: `${from}-${from + 999}` } });
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(JSON.stringify(j));
    out.push(...j);
    if (j.length < 1000) break;
  }
  return out;
}

type SRow = { office_number: string; processing_month: string; employee_number: string; employee_name: string; row_data: Record<string, unknown> };
type CRow = { office_number: string; processing_month: string; payload: { hourly?: Record<string, unknown>[]; monthly?: Record<string, unknown>[] } };

async function main() {
  const soukatsu = await getAll<SRow>("payroll_soukatsu_rows?select=office_number,processing_month,employee_number,employee_name,row_data");
  console.log("soukatsu 総行数:", soukatsu.length);
  const calc = await getAll<CRow>("payroll_calc_results?select=office_number,processing_month,payload");
  console.log("calc_results 総行数:", calc.length);

  const calcTotal = new Map<string, number>(); // office|month|empN -> grand_total
  for (const c of calc) {
    for (const [, list] of [["part", c.payload.hourly ?? []], ["shaseki", c.payload.monthly ?? []]] as const) {
      for (const item of list) {
        const key = `${c.office_number}|${c.processing_month}|${norm(item.employee_number)}`;
        calcTotal.set(key, num(item.grand_total));
      }
    }
  }

  // 総括表 総支給額=0 の行 (母数)
  // ★ 総括表の値は pickSoukatsu で読む (カンマ付き文字列 "10,000" も数える)。
  //   以前は typeof number 以外を 0 としていて、文字列の行を「総括表 0 円」と誤って数える穴があった (2026-09-27)
  if (pickSoukatsu({ 総支給額: "10,000" }, "総支給額") !== 10000 || pickSoukatsu({ 総支給額: 10000 }, "総支給額") !== 10000) {
    console.error("★ 負のコントロール失敗: カンマ付きの値を数えられません"); process.exit(1);
  }
  const zeroRows = soukatsu.filter((r) => pickSoukatsu(r.row_data, "総支給額") === 0);
  console.log(`\n総括表で 総支給額=0 の行: ${zeroRows.length} / 全${soukatsu.length}行`);

  const flagged: { office: string; month: string; emp: string; name: string; calcTotal: number }[] = [];
  for (const r of zeroRows) {
    const key = `${r.office_number}|${r.processing_month}|${norm(r.employee_number)}`;
    const ct = calcTotal.get(key);
    if (ct != null && ct > 1000) { // 端数ノイズ除外。1,000円超だけ拾う
      flagged.push({ office: r.office_number, month: r.processing_month, emp: r.employee_number, name: r.employee_name, calcTotal: ct });
    }
  }
  console.log(`\n=== 総括表=0円 なのに 当方計算が非ゼロ(>1,000円) ===`);
  console.log(`該当: ${flagged.length}件 / 母数(総括表0円行): ${zeroRows.length}`);
  const byPerson = new Map<string, typeof flagged>();
  for (const f of flagged) {
    const k = `${f.name}|${f.emp}`;
    if (!byPerson.has(k)) byPerson.set(k, []);
    byPerson.get(k)!.push(f);
  }
  console.log(`対象ユニーク人数(氏名+職員番号ベース。事業所別で重複しうる): ${byPerson.size}`);
  for (const [k, list] of byPerson) {
    console.log(`  ${k}: ${list.length}件 (${list.map((f) => `${f.office}/${f.month}=¥${f.calcTotal.toLocaleString()}`).join(", ")})`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
