/**
 * 単価が引けず 0 円で計算される訪問の 常設チェック (基準値方式)。
 *
 *   npm run check:rate-gap
 *   npm run check:rate-gap -- --update     基準値を更新する (悪化したまま更新しないこと)
 *
 * 0 円で計算された訪問は **過少支給**になる。画面 (給与計算) には警告が出るが、
 * 誰も計算を回さない月は気づけないので 実データ全体で見張る。
 *
 * ⚠ **0 件を目指す検査ではない。**現状を基準値にして「増えたら落ちる」形にする。
 *   2026-09-24 時点の 76 件は 内訳まで分かっていて、user 判断待ちのものを含む:
 *     時給なし 31 件  高品 × 重度15% 30 / 八千代 × 重度訪問 1   … 事業所の時給を入れるだけ
 *     類型なし 45 件  重度15％0.5 20 / 自費各種 10 / 面談・契約など 11 /
 *                     有料1350 1 / 身1深 1 (介護保険の正規コードの漏れ) / 行動援護(自立) 3
 *   ★ 自費は コード名に単価が入っていて (生2500 / 生3000)、類型ごとの時給では両方を持てない。
 *     マスタの作り方を決めるまで 塞げない (user と相談中)。
 *
 * ⚠ キャンセル・対象外 (有給・研修・会議) は 時給で払う類型ではないので数えない
 *   (NON_HOURLY_CATEGORIES)。2026-09-24 まで数えていて、581 件中 507 件がこれだった。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { NON_HOURLY_CATEGORIES } from "../src/lib/payroll/payroll-calc.js";

const UPDATE = process.argv.includes("--update");
const BASELINE = "scripts/rate-gap-baseline.json";

const env: Record<string, string> = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const U = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY };
const get = async (q: string): Promise<Record<string, unknown>[]> => {
  const o: Record<string, unknown>[] = [];
  for (let f = 0; ; f += 1000) {
    const r = await fetch(U + "/rest/v1/" + q, { headers: { ...H, Range: `${f}-${f + 999}` } });
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(JSON.stringify(j).slice(0, 200));
    o.push(...j); if (j.length < 1000) break;
  }
  return o;
};

const maps = await get("payroll_service_type_mappings?select=service_code,category_id&order=id");
const cats = await get("payroll_service_categories?select=id,name&order=id");
const rates = await get("payroll_category_hourly_rates?select=category_id,office_id,hourly_rate,effective_from&order=id");
const pofs = await get("payroll_offices?select=id,office_number,office_id&order=id");
const offs = await get("offices?select=id,name&order=id");
const recs = await get("payroll_service_records?select=office_number,processing_month,service_code,service_type,calc_duration&order=id");

const mapping = new Map(maps.map((m) => [String(m.service_code), m.category_id as string]));
const catName = new Map(cats.map((c) => [c.id as string, String(c.name)]));
const oname = new Map(offs.map((o) => [o.id as string, String(o.name)]));
const offIdOf = new Map(pofs.map((o) => [String(o.office_number), o.id as string]));
const dispOf = new Map(pofs.map((o) => [String(o.office_number), oname.get(o.office_id as string) ?? String(o.office_number)]));
// 事業所 × 類型 の時給 (履歴つき)。その月の月初以前で最新の行
const rateRows = rates.map((x) => ({ k: `${x.office_id}:${x.category_id}`, from: String(x.effective_from ?? "2000-01-01") }));

const acc = new Map<string, { cause: string; label: string; count: number }>();
for (const r of recs) {
  const code = String(r.service_code ?? "");
  const catId = mapping.get(code) ?? null;
  const cn = catId ? (catName.get(catId) ?? "不明") : null;
  if (cn !== null && NON_HOURLY_CATEGORIES.has(cn)) continue;
  const offId = offIdOf.get(String(r.office_number)) ?? null;
  const ms = `${String(r.processing_month).slice(0, 4)}-${String(r.processing_month).slice(4, 6)}-01`;
  const hasRate = catId !== null && offId !== null && rateRows.some((x) => x.k === `${offId}:${catId}` && x.from <= ms);
  if (catId !== null && hasRate) continue;
  const key = catId === null ? `類型なし|${code}` : `時給なし|${r.office_number}|${cn}`;
  const label = catId === null ? `コード ${code} (${r.service_type ?? ""})` : `${dispOf.get(String(r.office_number))} × ${cn}`;
  const g = acc.get(key) ?? { cause: catId === null ? "類型なし" : "時給なし", label, count: 0 };
  g.count++; acc.set(key, g);
}

const list = [...acc.entries()].sort((a, b) => b[1].count - a[1].count);
const total = list.reduce((s, [, g]) => s + g.count, 0);
const current = { total, kinds: list.length, byKey: Object.fromEntries(list.map(([k, g]) => [k, g.count])) };

console.log(`=== 単価が引けず 0 円になる訪問 ===`);
console.log(`実績 ${recs.length.toLocaleString()} 件中 ${total} 件 / ${list.length} 種類`);
for (const [, g] of list) console.log(`  ${String(g.count).padStart(5)}件  [${g.cause}] ${g.label}`);

if (UPDATE) {
  writeFileSync(BASELINE, JSON.stringify({
    _readme: "単価が引けず0円になる訪問の基準値。★0件を目指す検査ではない (自費のマスタ設計が決まるまで塞げない)。増えたら FAIL。減ったら --update で下げる",
    _measured: new Date().toISOString().slice(0, 10), ...current,
  }, null, 2) + "\n", "utf8");
  console.log(`\n基準値を更新しました (${total} 件)`);
  process.exit(0);
}

let base: { total: number; byKey: Record<string, number> };
try { base = JSON.parse(readFileSync(BASELINE, "utf8")); }
catch { console.log("\n基準値がありません。--update で作ってください"); process.exit(1); }

const worse: string[] = [];
for (const [k, g] of list) { const b = base.byKey[k] ?? 0; if (g.count > b) worse.push(`  ★ ${g.label}: ${b} → ${g.count} 件`); }
if (total < base.total) console.log(`\n○ 基準値 ${base.total} 件より ${base.total - total} 件 減りました。--update で下げてください`);
if (worse.length === 0) { console.log(`\nPASS — 基準値 ${base.total} 件を超えていません (現在 ${total} 件)`); process.exit(0); }
console.log(`\nFAIL — 増えたものがあります`); for (const w of worse) console.log(w);
process.exit(1);
