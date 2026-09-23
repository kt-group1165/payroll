/**
 * 夜朝手当の単価が 未設定 (0) なのに 総括表では夜朝手当が出ている社員に 200 円/時 を入れる (2026-09-23)。
 *
 *   SP=<scratchpad> node migrations/set_yocho_unit_price_from_soukatsu.mjs            # DRY RUN
 *   SP=<scratchpad> node migrations/set_yocho_unit_price_from_soukatsu.mjs --execute
 *
 * ⚠ 単価 0 は「未設定」ではなく「夜朝手当の対象外」。946 件中 721 件が 0 で、
 *   その大半は ① でも夜朝が 0 (= 正しく対象外)。一律 200 を既定にすると 296 件 過払いになる。
 *   なので **① で実際に夜朝手当が出ている人だけ** を対象にする。
 * 単価は 200 円/時 (① の 夜朝(円) ÷ 夜朝訪介 が 3〜7月 全20事業所 350/350 で 200)。
 *
 * 対象 (① と ② の両方で夜朝手当が出ているのに 当方 0):
 *   さつき 宮野宏子 / 八千代 藤冨弥生 / 大網 髙橋久江 / 四街道 金香蘭 / おゆみ野 斉藤里菜
 * 給与設定は effective_from で履歴を持つので、**その人の一番古い行** に入れる (3月から効かせるため)。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const SP = process.env.SP;
if (!SP) { console.error("SP=<layer1_all.json のある作業フォルダ> を指定"); process.exit(1); }
const UNIT = 200;

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
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${q}&order=id`, { headers: { ...H, Range: `${from}-${from + 999}` } });
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(JSON.stringify(j));
    out.push(...j);
    if (j.length < 1000) break;
  }
  return out;
};
const OFF = { "04_おゆみ野": "1270501180", "06_さつき": "1270203191", "02_花見川": "1270201930", "05_高品": "1270402116", "11_Hana四街道": "1270303173", "06_Hana中央": "1270105271", "04_Hana船橋": "1270906546", "10_Hana八千代": "1272603851", "03_やわた": "1272404508", "03_五井": "1272401967", "01_KT姉崎": "1272400142", "05_Hanaちはら台": "1272403534", "01_姉崎ムツミ": "1272400829", "リンクス茂原": "1271500942", "08_いすみ": "1278600398", "09_山武": "1279000366", "リンクス大網": "1275800892", "03_木更津ムツミ": "1271101295", "02_市原ムツミ": "1272401561", "07_袖ケ浦": "1273400844", "14_君津": "1273001626", "13_東郷": "1271502518" };
const nn = (s) => String(s ?? "").replace(/^0+/, "");
const money = (v) => { const f = parseFloat(String(v ?? "").replace(/,/g, "")); return isNaN(f) ? 0 : f; };

// ① で 夜朝手当 (円) が出ている (事業所, 従業員番号)
const L1 = JSON.parse(readFileSync(`${SP}/layer1_all.json`, "utf8"));
const paid = new Map();
for (const [key, a] of Object.entries(L1)) {
  const [m, office, kind, code] = key.split("|");
  if (kind === "part") continue;
  const on = OFF[office];
  if (!on) continue;
  const y = money(a["夜朝"]);
  if (y <= 0) continue;
  const k = on + "|" + code;
  const cur = paid.get(k) ?? { name: a["氏名"], office, months: [] };
  cur.months.push(`${m}:${y.toLocaleString()}円`);
  paid.set(k, cur);
}

const offs = await get("payroll_offices?select=id,office_number");
const onOf = new Map(offs.map((o) => [o.id, o.office_number]));
const emps = await get("payroll_employees?select=id,employee_number,name,office_id");
const empOf = new Map();
for (const e of emps) { const on = onOf.get(e.office_id); if (on) empOf.set(on + "|" + nn(e.employee_number), e); }
const settings = await get("payroll_salary_settings?select=id,employee_id,yocho_unit_price,effective_from");
const byEmp = new Map();
for (const s of settings) { if (!byEmp.has(s.employee_id)) byEmp.set(s.employee_id, []); byEmp.get(s.employee_id).push(s); }

const ops = [], skipped = [];
for (const [k, info] of paid) {
  const e = empOf.get(k);
  if (!e) { skipped.push(`${info.office} ${info.name} (${k.split("|")[1]}): 職員マスタに居ない`); continue; }
  const rows = (byEmp.get(e.id) ?? []).sort((a, b) => String(a.effective_from ?? "").localeCompare(String(b.effective_from ?? "")));
  if (rows.length === 0) { skipped.push(`${info.office} ${e.name}: 給与設定が無い`); continue; }
  if (rows.some((r) => Number(r.yocho_unit_price ?? 0) > 0)) continue;   // 既に入っている
  const target = rows[0];
  ops.push({ id: target.id, yocho_unit_price: UNIT,
    label: `${info.office} ${e.name} (${e.employee_number}) 適用開始 ${target.effective_from ?? "-"} → ${UNIT}円/時  [① ${info.months.join(" / ")}]` });
}

console.log(`=== 夜朝手当の単価を 200 円/時 に ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${ops.length} 件 ===`);
for (const o of ops) console.log("  " + o.label);
if (skipped.length) { console.log("--- 触らないもの"); for (const s of skipped) console.log("  " + s); }
if (!EXECUTE || ops.length === 0) { console.log("DRY RUN。--execute で書き込みます"); process.exit(0); }
let ok = 0;
for (const o of ops) {
  const res = await fetch(`${SB_URL}/rest/v1/payroll_salary_settings?id=eq.${o.id}`, {
    method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify({ yocho_unit_price: UNIT }) });
  const b = await res.json();
  if (!res.ok || !Array.isArray(b) || b.length !== 1) { console.error("★ 書き込みに失敗:", o.label, b); process.exit(1); }
  ok++;
}
console.log(`  反映 ${ok} 件`);
