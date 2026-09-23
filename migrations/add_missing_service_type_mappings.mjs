/**
 * 類型に結び付いていないサービスコードを登録する (2026-09-23)。
 *
 *   node migrations/add_missing_service_type_mappings.mjs            # DRY RUN
 *   node migrations/add_missing_service_type_mappings.mjs --execute
 *
 * 類型が無いと 時給が引けず その訪問が **0 円**になる (payroll_calc_results の pay=null)。
 * 2026-03〜07 の時給者の明細 101,467 件を数えたところ 単価が引けないのは 222 件で、
 * そのうち 210 件は キャンセル系 (別途 キャンセル手当で払うので正しい)。
 * 残る 12 件が 4 コードで、**これが「訪問の小計」の ① とのずれ ¥49,099 をほぼ全額説明していた**。
 *
 * ```
 * 015110 有料1350　150   花見川 松元綾子 202603 ×2 (150分)      → 類型 有料1350
 * 015124 有料1350　360   花見川 大島拓也 202603 (360分)          → 類型 有料1350
 *                        四街道 篠原麻奈 202605 (330分)
 * 012350 自費（身生）     東郷 安藤仁海 202606 ×2 / 木村陽子 ×2  → 類型 自費身生
 * 010004 研修            山武 3名 / 八千代 1名 (15〜45分)        → 類型 対象外
 * ```
 * ⚠ 015102/104/106/108/112/116/120 は既に「有料1350」に登録済みで、110 と 124 だけ抜けていた。
 * ⚠ 010004「研修」は訪問ではない。研修費は 事業所書式の研修時間 × 1,150円/時 で別に払うので、
 *   ここでは「対象外」にして 0 円のまま・未マッピング扱いから外すだけ。
 * 冪等: 既に登録があれば触らない。
 */
const EXECUTE = process.argv.includes("--execute");

/** サービスコード → 類型名 */
const PLAN = [
  { code: "015110", category: "有料1350", why: "有料1350　150 (015102〜120 と同じ)" },
  { code: "015124", category: "有料1350", why: "有料1350　360 (同上)" },
  { code: "012350", category: "自費身生", why: "自費（身生）" },
  { code: "010004", category: "対象外", why: "研修 (訪問ではない。研修費は事業所書式から別途)" },
];

import { readFileSync } from "node:fs";
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
  const r = await fetch(`${SB_URL}/rest/v1/${q}`, { headers: H });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(JSON.stringify(j));
  return j;
};

const cats = await get("payroll_service_categories?select=id,name");
const catId = new Map(cats.map((c) => [c.name, c.id]));
const existing = await get(`payroll_service_type_mappings?select=service_code,category_id&service_code=in.(${PLAN.map((p) => p.code).join(",")})`);
const have = new Map(existing.map((x) => [x.service_code, x.category_id]));
const catName = new Map(cats.map((c) => [c.id, c.name]));

const ops = [], skipped = [];
for (const p of PLAN) {
  const id = catId.get(p.category);
  if (!id) { skipped.push(`★ ${p.code}: 類型「${p.category}」が無い`); continue; }
  if (have.has(p.code)) { skipped.push(`${p.code}: 既に「${catName.get(have.get(p.code)) ?? "?"}」に登録済み`); continue; }
  // 実際に その コードの明細があるか (無いものは足さない)
  const used = await get(`payroll_service_records?select=service_code&service_code=eq.${p.code}&limit=1`);
  if (used.length === 0) { skipped.push(`${p.code}: 実績に 1 件も無いので足さない`); continue; }
  ops.push({ service_code: p.code, category_id: id, label: `${p.code} → ${p.category}  (${p.why})` });
}

console.log(`=== サービスコードの類型を登録 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${ops.length} 件 ===`);
for (const o of ops) console.log("  " + o.label);
if (skipped.length) { console.log("--- 触らないもの"); for (const s of skipped) console.log("  " + s); }
if (!EXECUTE || ops.length === 0) { console.log("DRY RUN。--execute で書き込みます"); process.exit(0); }
const body = ops.map(({ label, ...r }) => { void label; return r; });
const res = await fetch(`${SB_URL}/rest/v1/payroll_service_type_mappings?on_conflict=service_code`, {
  method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body) });
const b = await res.json();
if (!res.ok || !Array.isArray(b) || b.length !== body.length) { console.error("★ 書き込みに失敗:", b); process.exit(1); }
console.log(`  反映 ${b.length} 件`);
