/**
 * 夜朝手当の単価を「その月に効く給与設定の行」に入れ直す (2026-09-23)。
 *
 *   node migrations/fix_yocho_unit_price_rows.mjs            # DRY RUN
 *   node migrations/fix_yocho_unit_price_rows.mjs --execute
 *
 * ⚠ set_yocho_unit_price_from_soukatsu.mjs は **一番古い行にしか入れなかった**ので、
 *   途中に行がある人 (昇給などで effective_from が増えている人) は その月に効かなかった。
 *   給与設定は「対象月 >= effective_from の最新の行」が効くので、行ごとに入れる必要がある。
 *
 * 単価は 200 円/時 (① の 夜朝(円) ÷ 夜朝訪介 が 3〜7月 全20事業所 350/350 で 200)。
 * ⚠ 単価 0 は「未設定」ではなく「夜朝手当の対象外」。① が 0 の月をまたぐ行には入れない。
 *
 * ① の夜朝 (円) と 当システムの夜朝の時間:
 * ```
 * 八千代 藤冨弥生 ① 03:100 04:100 05:400 06:400 07:0   当方 0.5h 0.5h 2h 2h 1.5h
 *     → 行は 1970 の 1 本だけ。03〜06 は 1 円まで一致。07 だけ ① が 0 (当方 +300 円)
 * 大網 髙橋久江   ① 03:667 04:667 05:0 06:0 07:0        当方 3.33h 3.33h 1h 0h 0h
 *     → 1970 行 (03) と 2026-04 行 (04) に 200。2026-05 行 (05〜) は 0 のまま = ① と一致
 * 四街道 金香蘭   ① 03:0 04:0 05:900 06:1500 07:300     当方 0h 0h 3.5h 5.5h 0.5h
 *     → 1970 行 (03〜06) と 2026-07 行 (07) に 200
 * さつき 宮野宏子 ① 03:2000 04:1300 05:0 06:0 07:0      当方 10h 6.5h 2h 3h 0.5h
 *     → 2026-03 行 (03) と 2026-04 行 (04) に 200。★ 2026-04 行は 05〜07 も覆うので
 *       2026-05-01 の行を足して そこから 0 に戻す (05〜07 で ① は 0 = 対象外になっている)
 * ```
 * 冪等: 既に同じ値なら触らない。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const UNIT = 200;

/** 従業員番号 / 事業所番号 / 単価 200 にする行 (effective_from) / 0 のまま据え置く行 */
const PLAN = [
  { num: "250301", office: "1272603851", name: "藤冨 弥生", set200: ["1970-01-01"] },
  { num: "230801", office: "1275800892", name: "髙橋 久江", set200: ["1970-01-01", "2026-04-01"] },
  { num: "260204", office: "1270303173", name: "金 香蘭", set200: ["1970-01-01", "2026-07-01"] },
  { num: "2057", office: "1270203191", name: "宮野 宏子", set200: ["2026-03-01", "2026-04-01"],
    // 2026-04 行が 05〜07 も覆ってしまうので、05 から 0 に戻す行を足す (04 行の値をそのまま複製)
    insertZeroFrom: { effective_from: "2026-05-01", copyFrom: "2026-04-01" } },
];

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

const offices = await get("payroll_offices?select=id,office_number");
const onOf = new Map(offices.map((o) => [o.id, o.office_number]));
const patches = [], inserts = [], skipped = [];

for (const p of PLAN) {
  const cands = (await get(`payroll_employees?select=id,employee_number,name,office_id&employee_number=eq.${p.num}`))
    .filter((e) => onOf.get(e.office_id) === p.office);
  if (cands.length !== 1) { skipped.push(`${p.name} (${p.num}): 職員が ${cands.length} 件`); continue; }
  const e = cands[0];
  const rows = await get(`payroll_salary_settings?select=*&employee_id=${"eq." + e.id}&order=effective_from`);
  for (const from of p.set200) {
    const r = rows.find((x) => x.effective_from === from);
    if (!r) { skipped.push(`★ ${p.name}: ${from} の行が無い`); continue; }
    if (Number(r.yocho_unit_price ?? 0) === UNIT) continue;
    patches.push({ id: r.id, label: `${p.name} (${p.num}) ${from}〜 夜朝単価 ${r.yocho_unit_price} → ${UNIT}` });
  }
  if (p.insertZeroFrom) {
    const { effective_from, copyFrom } = p.insertZeroFrom;
    if (rows.some((x) => x.effective_from === effective_from)) continue;   // 既にある
    const src = rows.find((x) => x.effective_from === copyFrom);
    if (!src) { skipped.push(`★ ${p.name}: 複製元 ${copyFrom} の行が無い`); continue; }
    const { id: _id, created_at: _c, updated_at: _u, ...rest } = src;
    void _id; void _c; void _u;
    inserts.push({ row: { ...rest, effective_from, yocho_unit_price: 0,
        note: `${src.note ? src.note + " / " : ""}夜朝手当は 2026-05 から対象外 (総括表① が 0)。2026-04 の設定を複製 2026-09-23` },
      label: `${p.name} (${p.num}) ${effective_from}〜 の行を追加 (${copyFrom} の複製・夜朝単価 0)` });
  }
}

console.log(`=== 夜朝手当の単価を行ごとに入れ直す ${EXECUTE ? "【本番】" : "(DRY RUN)"} 更新 ${patches.length} 件 / 追加 ${inserts.length} 件 ===`);
for (const o of patches) console.log("  更新 " + o.label);
for (const o of inserts) console.log("  追加 " + o.label);
if (skipped.length) { console.log("--- 触らないもの"); for (const s of skipped) console.log("  " + s); }
if (!EXECUTE || (patches.length === 0 && inserts.length === 0)) { console.log("DRY RUN。--execute で書き込みます"); process.exit(0); }

for (const o of patches) {
  const res = await fetch(`${SB_URL}/rest/v1/payroll_salary_settings?id=eq.${o.id}`, {
    method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify({ yocho_unit_price: UNIT }) });
  const b = await res.json();
  if (!res.ok || !Array.isArray(b) || b.length !== 1) { console.error("★ 更新に失敗:", o.label, b); process.exit(1); }
}
for (const o of inserts) {
  const res = await fetch(`${SB_URL}/rest/v1/payroll_salary_settings?on_conflict=employee_id,effective_from`, {
    method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify([o.row]) });
  const b = await res.json();
  if (!res.ok || !Array.isArray(b) || b.length !== 1) { console.error("★ 追加に失敗:", o.label, b); process.exit(1); }
}
console.log(`  更新 ${patches.length} 件 / 追加 ${inserts.length} 件 を反映`);
