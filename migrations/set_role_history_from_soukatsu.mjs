/**
 * 給与設定に「この月からの役職」を入れる (2026-09-23)。
 *
 *   node migrations/set_role_history_from_soukatsu.mjs            # DRY RUN
 *   node migrations/set_role_history_from_soukatsu.mjs --execute
 *
 * 職員マスタの役職は「今の値」1 つしかないので、途中で社員 → 提責 になった人の過去月が
 * 提責として計算され、介護超過手当が 0 になっていた。給与設定は effective_from で履歴を持ち、
 * `resolveEmploymentType` が その月の行の role_type を優先するので、そこに入れれば直る。
 *
 * 誰がいつ変わったかは 総括表② の「提責・事務」列から出した (空=社員 / 1・3=提責 / 2=事務員)。
 * 3〜7月 233 名を突き合わせて 途中で変わるのは この 3 名だけだった (他 3 名は 時給↔月給 の
 * 切替で既に salary_type の履歴で処理済み)。3 名とも 変わる月が 本人給の昇給と一致している。
 *
 *   さつき   宮野 宏子   (2057)   〜2026-03 社員 / 2026-04〜 提責  (本人給 94,000 → 100,000)
 *   大網     髙橋 久江   (230801) 〜2026-04 社員 / 2026-05〜 提責  (94,000 → 100,000)
 *   四街道   金 香蘭     (260204) 〜2026-06 社員 / 2026-07〜 提責  (94,000 → 100,000)
 *
 * 社員の期間には 介護超過手当の 閾値 120h / 単価 2,500 円も入れる (入れないと 0 円のまま)。
 * 根拠: ① の介護超過は 訪問時間(0.75換算後) から (h−120)×2,500 で出る。
 *   宮野 2026-03  122.5h → 6,250 円 (① と一致) / 髙橋久江 2026-03 124h → 10,000 円 (① と一致)
 *
 * ⚠ 提責になった後は 介護超過を払わない (① は計算しているが ② は払っていない。
 *   区分 3 の 12 件すべてで ② が 0)。提責の行には 閾値・単価を入れない。
 * 冪等: 既に同じ値なら触らない。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");

/** 従業員番号 → { 事業所番号, 提責になる月 (この月から提責), 社員期間の介護超過 } */
const PLAN = [
  { num: "2057", office: "1270203191", name: "宮野 宏子", teisekiFrom: "2026-04-01" },
  { num: "230801", office: "1275800892", name: "髙橋 久江", teisekiFrom: "2026-05-01" },
  { num: "260204", office: "1270303173", name: "金 香蘭", teisekiFrom: "2026-07-01" },
];
const CARE_THRESHOLD = 120;
const CARE_UNIT = 2500;

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
const nn = (s) => String(s ?? "").replace(/^0+/, "");

const offices = await get("payroll_offices?select=id,office_number");
const onOf = new Map(offices.map((o) => [o.id, o.office_number]));
const ops = [], skipped = [];

for (const p of PLAN) {
  const cands = (await get(`payroll_employees?select=id,employee_number,name,role_type,office_id&employee_number=eq.${p.num}`))
    .filter((e) => onOf.get(e.office_id) === p.office);
  if (cands.length !== 1) { skipped.push(`${p.name} (${p.num}): 職員が ${cands.length} 件 見つかった`); continue; }
  const e = cands[0];
  if (nn(e.employee_number) !== nn(p.num) || !e.name.includes(p.name.split(" ")[0])) {
    skipped.push(`${p.name} (${p.num}): 名前が合わない (${e.name})`); continue;
  }
  const rows = (await get(`payroll_salary_settings?select=id,effective_from,role_type,care_overtime_threshold_hours,care_overtime_unit_price&employee_id=eq.${e.id}&order=effective_from`));
  if (!rows.some((r) => r.effective_from === p.teisekiFrom)) {
    skipped.push(`★ ${p.name}: 提責になる月 ${p.teisekiFrom} の行が無い (自動では作らない。画面で作ってから回す)`);
    continue;
  }
  for (const r of rows) {
    const isShain = r.effective_from < p.teisekiFrom;
    const want = isShain
      ? { role_type: "社員", care_overtime_threshold_hours: CARE_THRESHOLD, care_overtime_unit_price: CARE_UNIT }
      : { role_type: "提責" };
    const diff = Object.entries(want).filter(([k, v]) => r[k] !== v);
    if (diff.length === 0) continue;
    ops.push({ id: r.id, patch: want,
      label: `${p.name} (${p.num}) ${r.effective_from}〜 → ${isShain ? `社員・介護超過 ${CARE_THRESHOLD}h/${CARE_UNIT}円` : "提責"}  [今 ${r.role_type ?? "(空)"}・閾値${r.care_overtime_threshold_hours}/単価${r.care_overtime_unit_price}]` });
  }
}

console.log(`=== 給与設定に役職の履歴を入れる ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${ops.length} 件 ===`);
for (const o of ops) console.log("  " + o.label);
if (skipped.length) { console.log("--- 触らないもの"); for (const s of skipped) console.log("  " + s); }
if (!EXECUTE || ops.length === 0) { console.log("DRY RUN。--execute で書き込みます"); process.exit(0); }
let ok = 0;
for (const o of ops) {
  const res = await fetch(`${SB_URL}/rest/v1/payroll_salary_settings?id=eq.${o.id}`, {
    method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(o.patch) });
  const b = await res.json();
  if (!res.ok || !Array.isArray(b) || b.length !== 1) { console.error("★ 書き込みに失敗:", o.label, b); process.exit(1); }
  ok++;
}
console.log(`  反映 ${ok} 件`);
