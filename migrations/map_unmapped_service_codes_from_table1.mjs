/**
 * 実績 (payroll_service_records) に出てくるのに給与区分の対応 (payroll_service_type_mappings) が無いサービスコードを、
 * 総括表の区分表 (01_実績データ確認用.xlsm「テーブル1」: コード → 賃金区分) から対応付ける。
 *
 *   node migrations/map_unmapped_service_codes_from_table1.mjs <tanka_table1.json>            # DRY RUN
 *   node migrations/map_unmapped_service_codes_from_table1.mjs <tanka_table1.json> --execute
 *
 * <tanka_table1.json> = { "<コード(先頭0なし)>": { name, cat } } (テーブル1を作業フォルダで JSON にしたもの)
 * 区分の読み替え (総括表の単価確認用で 素の単価が同じもの):
 *   身体介護 ← 身体 / 移動身あり / 有料身あり / 身体（障害） / 通院身あり
 *   生活援助 ← 生活 / 総合事業身なし / 有料身なし / 家事（障害） / 移動身なし / 通院身なし
 *   身体生活 ← 身体生活 / 身体家事（障害）
 * 重度・同行援護・研修などは単価が別なので対応付けない (表示だけ)。
 * 自費 (名前に「自費」) と 養育支援 は時給が個別 (自費 生2,240/H 等) なので対応付けない。
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const TABLE = args.find((a) => !a.startsWith("--"));
if (!TABLE) { console.error("tanka_table1.json を指定してください"); process.exit(1); }
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
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY がありません"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
async function getAll(path) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${path}&order=id&offset=${from}&limit=1000`, { headers: H });
    if (!r.ok) throw new Error(`${path}: ${await r.text()}`);
    const d = await r.json();
    out.push(...d);
    if (d.length < 1000) break;
  }
  return out;
}

const READ = {
  身体: "身体介護", 移動身あり: "身体介護", 有料身あり: "身体介護", "身体（障害）": "身体介護", 通院身あり: "身体介護",
  生活: "生活援助", 総合事業身なし: "生活援助", 有料身なし: "生活援助", "家事（障害）": "生活援助", 移動身なし: "生活援助", 通院身なし: "生活援助",
  身体生活: "身体生活", "身体家事（障害）": "身体生活",
};
const table = JSON.parse(readFileSync(TABLE, "utf8"));
const cats = await getAll("payroll_service_categories?select=id,name");
const catId = Object.fromEntries(cats.map((c) => [c.name, c.id]));
const mapped = new Set((await getAll("payroll_service_type_mappings?select=id,service_code")).map((m) => m.service_code));
const count = new Map();
for (const r of await getAll("payroll_service_records?select=id,service_code&processing_month=gte.202603")) {
  if (!r.service_code || mapped.has(r.service_code)) continue;
  count.set(r.service_code, (count.get(r.service_code) ?? 0) + 1);
}
const add = [], skip = [];
for (const [code, n] of [...count].sort((a, b) => b[1] - a[1])) {
  const t = table[code.replace(/^0+/, "")];
  const target = t && !/自費|養育/.test(String(t.name)) && READ[t.cat];
  if (target) add.push({ code, n, name: t.name, cat: t.cat, target });
  else skip.push(`${code} (${n}件) ${t ? `${t.name} / ${t.cat ?? "区分なし"}` : "テーブル1に無い"}`);
}
console.log(`=== 未対応サービスコードの対応付け ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${add.length} 件 ===`);
for (const a of add) console.log(`  ${a.code} ${a.name} (${a.cat}, ${a.n}件) → ${a.target}`);
if (skip.length) { console.log("--- 対応付けない"); for (const s of skip) console.log(`  ${s}`); }
if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }
if (add.length) {
  const r = await fetch(`${SB_URL}/rest/v1/payroll_service_type_mappings`, { method: "POST", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(add.map((a) => ({ service_code: a.code, category_id: catId[a.target] }))) });
  if (!r.ok) { console.error(await r.text()); process.exit(1); }
  const rows = await r.json();
  if (rows.length !== add.length) { console.error(`★ 追加件数 ${rows.length}/${add.length}`); process.exit(2); }
}
console.log(`完了 ${add.length} 件`);
