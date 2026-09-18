/**
 * 未マッピングだった「自費」「有料」「会議・他・有給」のサービスコードを区分に結び付ける。
 *
 *   node migrations/map_jihi_and_yuryo_service_codes.mjs            # DRY RUN
 *   node migrations/map_jihi_and_yuryo_service_codes.mjs --execute
 *
 * 根拠 (2026-07 の総括表と当方の「集計項目小計」の差 ÷ 未マッピングの時間で単価を出した。
 * 未マッピングのコードを 1 種類だけ持つ人に限って測った):
 *   自費（生活）系  茂原 011004 6名 1,550 / いすみ 011004 4名 1,550 / 袖ケ浦 010997 6名 1,550 /
 *                  東郷 012000 2名 1,550 / 木更津 012026 2名 1,550 / 山武 011004 1,548 /
 *                  ちはら台 013001 1,551 / 君津 012007 1,558
 *                  → いずれも その事業所の「生活援助」と同じ単価
 *   有料身なし 010421  中央 1,800 / 八千代 1,450 → これも その事業所の「生活援助」と同じ
 *   有料1350          四街道 015106 1,350 / 花見川 015104 1,800 (事業所で違う)
 *   会議 010002 / 他 010005  おゆみ野 どちらも 0 円
 *
 * 触らないもの (単価が測れていない): 自費（身体）・自費（身生）・有料身あり・重度7.5%/8.5%・養育支援・健康診断
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY がありません"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const get = async (p) => { const r = await fetch(`${SB}/rest/v1/${p}`, { headers: H }); if (!r.ok) throw new Error(`${p}: ${await r.text()}`); return r.json(); };
const write = async (method, p, body) => { const r = await fetch(`${SB}/rest/v1/${p}`, { method, headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`${method} ${p}: ${await r.text()}`); return r.json(); };

// コード → 区分名
const JIHI_SEIKATSU = ["011004", "010997", "012000", "012026", "013001", "013002", "013003", "013060", "012500", "012007", "010421"];
const YURYO_1350 = ["015102", "015104", "015106", "015108", "015112", "015116", "015120"];
const TAISHOGAI = ["010002", "010005", "019991", "019992"];
const JUHO15 = ["010136", "010145"];
// 有料1350 の事業所別単価 (実測)
const YURYO_RATES = { "1270303173": 1350, "1270201930": 1800 };

const cats = await get("payroll_service_categories?select=*");
const offices = await get("payroll_offices?select=id,office_number");
const rates = await get("payroll_category_hourly_rates?select=id,office_id,category_id,hourly_rate&limit=5000");
const maps = await get("payroll_service_type_mappings?select=id,service_code,category_id&limit=5000");
const mapped = new Map(maps.map((m) => [String(m.service_code), m]));
const catByName = new Map(cats.map((c) => [c.name, c]));
const offById = new Map(offices.map((o) => [o.id, o.office_number]));
const seikatsu = catByName.get("生活援助");
if (!seikatsu) { console.error("区分「生活援助」がありません"); process.exit(2); }
const seikatsuRate = new Map(rates.filter((r) => r.category_id === seikatsu.id).map((r) => [offById.get(r.office_id), r.hourly_rate]));

// 実績にあるコードだけを対象にする
const recs = [];
for (let f = 0; ; f += 1000) {
  const d = await get(`payroll_service_records?select=service_code,service_type,office_number&order=id&offset=${f}&limit=1000`);
  recs.push(...d); if (d.length < 1000) break;
}
const used = new Map();
for (const r of recs) { const k = String(r.service_code); const v = used.get(k) ?? used.set(k, { n: 0, name: r.service_type ?? "", offices: new Set() }).get(k); v.n++; v.offices.add(r.office_number); }

const plan = [];
const ensureCat = (name) => catByName.get(name) ?? null;
const targets = [
  ...JIHI_SEIKATSU.map((c) => [c, "自費生活"]),
  ...YURYO_1350.map((c) => [c, "有料1350"]),
  ...TAISHOGAI.map((c) => [c, "対象外"]),
  ...JUHO15.map((c) => [c, "重度15%"]),
];
const needCats = [...new Set(targets.map(([, n]) => n))].filter((n) => !ensureCat(n));
for (const n of needCats) plan.push({ label: `区分「${n}」を作る`, run: async () => { const base = Object.fromEntries(Object.entries(seikatsu).filter(([k]) => !["id", "created_at", "updated_at", "name"].includes(k))); const [c] = await write("POST", "payroll_service_categories", { ...base, name: n }); catByName.set(n, c); } });

for (const [code, catName] of targets) {
  const u = used.get(code);
  if (!u) continue;                                  // 実績に無いコードは触らない
  const cur = mapped.get(code);
  if (cur && catByName.get(catName) && cur.category_id === catByName.get(catName).id) continue;
  plan.push({
    label: `${code} ${u.name} (${u.n}件) → ${catName}${cur ? " (今は別区分)" : ""}`,
    run: async () => {
      const cat = catByName.get(catName);
      if (cur) await write("PATCH", `payroll_service_type_mappings?id=eq.${cur.id}`, { category_id: cat.id });
      else await write("POST", "payroll_service_type_mappings", { service_code: code, category_id: cat.id });
    },
  });
}
// 単価
const rateOps = [];
for (const [code, catName] of targets) {
  const u = used.get(code); if (!u) continue;
  for (const on of u.offices) {
    const want = catName === "自費生活" ? (seikatsuRate.get(on) ?? null)
      : catName === "有料1350" ? (YURYO_RATES[on] ?? null)
      : catName === "対象外" ? 0
      : null;                                        // 重度15% は既存の単価をそのまま使う
    if (want === null) continue;
    rateOps.push({ on, catName, want });
  }
}
const seen = new Set();
for (const { on, catName, want } of rateOps) {
  const k = `${on}|${catName}`; if (seen.has(k)) continue; seen.add(k);
  const office = offices.find((o) => o.office_number === on); if (!office) continue;
  const cat = catByName.get(catName);
  const cur = cat ? rates.find((r) => r.office_id === office.id && r.category_id === cat.id) : null;
  if (cur && cur.hourly_rate === want) continue;
  plan.push({
    label: `単価 ${on} ${catName} ${cur ? cur.hourly_rate : "(無)"} → ${want}`,
    run: async () => {
      const c = catByName.get(catName);
      const now = await get(`payroll_category_hourly_rates?select=id,hourly_rate&office_id=eq.${office.id}&category_id=eq.${c.id}`);
      if (now.length) await write("PATCH", `payroll_category_hourly_rates?id=eq.${now[0].id}`, { hourly_rate: want });
      else await write("POST", "payroll_category_hourly_rates", { office_id: office.id, category_id: c.id, hourly_rate: want });
    },
  });
}

console.log(`=== 自費・有料のコードを区分に結び付ける ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${plan.length} 件 ===`);
for (const p of plan) console.log(`  ${p.label}`);
if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }
let done = 0;
for (const p of plan) { await p.run(); done++; }
console.log(`完了 ${done} / ${plan.length}`);
