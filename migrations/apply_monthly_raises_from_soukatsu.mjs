/**
 * 月給者の 固定給の変更 (昇給など) を 総括表から 給与設定に入れる (適用開始 = その月の 1 日)。user 了承「総括表から入れてOK」2026-09-22
 *
 *   SP=<scratchpad> MONTH=202608 node migrations/apply_monthly_raises_from_soukatsu.mjs            # DRY RUN
 *   SP=<scratchpad> MONTH=202608 node migrations/apply_monthly_raises_from_soukatsu.mjs --execute
 *
 * 総括表 <SP>/soukatsu<MONTH>/extract.json の 提責_社員 の固定給の列 と、その月に有効な給与設定 (effective_from ≦ 月初 の最新行) を比べ、
 * 違う人だけ 月初からの行を作る (その月の行が既にあれば更新)。元の行をコピーして 違う項目だけ差し替える。
 * 触らない項目:
 *   - 勤続手当: 節目で自動で上がる (page.tsx manualTenureWithSteps) ので、勤続手当の違いだけでは行を作らない。
 *     ただし行を作るときは 勤続手当もその月の総括表の値にそろえる (新しい行の額は その月の額として扱われるため)
 *   - 報奨金 (special_bonus): その月だけの支給。給与設定に入れると翌月以降も払い続ける
 * 列名の揺れは scripts/sync-master-from-soukatsu.mts と同じ扱い。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const SP = process.env.SP, MONTH = process.env.MONTH;
if (!SP || !/^\d{6}$/.test(MONTH ?? "")) { console.error("SP=<extract.json のある作業フォルダ> MONTH=YYYYMM を指定"); process.exit(1); }
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
const FIXED = [
  [["本人給"], "base_personal_salary"], [["職能給"], "skill_salary"], [["役職手当"], "position_allowance"], [["資格手当"], "qualification_allowance"],
  [["処遇改善手当"], "treatment_improvement"],
  [["特別処遇改善手当", "特別処遇改善", "特定処遇改善手当", "特定処遇改善"], "specific_treatment_improvement"],
  [["処遇改善補助金手当"], "treatment_subsidy"], [["固定残業代"], "fixed_overtime_pay"],
];
// ★ ① の xlsm には カンマ付きの文字列 "15,631" が 922 セルある (2026-09-27 実測)。
//   Number("15,631") = NaN → 0。★ この script は **昇給を DB に書く** ので、
//   資格手当_3 などが 0 になると 黙って給与を下げる。カンマ・全角を外してから読む
const num = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (v && typeof v === "object" && "result" in v) return num(v.result);
  const n = Number(String(v ?? "").normalize("NFKC").replace(/[,s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const val = (r, keys) => num(r[keys.find((k) => r[k] != null) ?? keys[0]]);
const nn = (s) => String(s ?? "").replace(/^0+/, "");
const monthStart = `${MONTH.slice(0, 4)}-${MONTH.slice(4, 6)}-01`;

const offices = await get("payroll_offices?select=id,office_number");
const offIdByNum = new Map(offices.map((o) => [o.office_number, o.id]));
const ops = [];
for (const f of JSON.parse(readFileSync(`${SP}/soukatsu${MONTH}/extract.json`, "utf8"))) {
  const on = OFF[f.office];
  if (!on || f.kind === "part") continue;
  const emps = await get(`payroll_employees?select=id,employee_number,name&office_id=eq.${offIdByNum.get(on)}`);
  for (const r of f.rows) {
    const code = nn(r._code);
    if (!code || String(r._code).includes("合計")) continue;
    const e = emps.find((x) => nn(x.employee_number) === code);
    if (!e) continue; // 未登録の人は この script では作らない (sync-master の範囲)
    const rows = await get(`payroll_salary_settings?select=*&employee_id=eq.${e.id}&effective_from=lte.${monthStart}`);
    if (rows.length === 0) continue;
    const cur = rows.sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
    const changed = FIXED.filter(([keys, col]) => val(r, keys) !== num(cur[col]));
    if (changed.length === 0) continue;
    // 総括表でその項目が全部 0 の人 (退職・休職で固定給が無い月) は入れない
    if (FIXED.every(([keys]) => val(r, keys) === 0)) continue;
    const patch = Object.fromEntries(changed.map(([keys, col]) => [col, val(r, keys)]));
    // 新しい行は「この月の額」として扱われる (勤続手当の節目の基準の月 = 行の適用開始月)。勤続手当もこの月の総括表の値にそろえる
    if (num(cur.tenure_allowance) !== num(r["勤続手当"])) patch.tenure_allowance = num(r["勤続手当"]);
    const desc = changed.map(([keys, col]) => `${keys[0]} ${num(cur[col])}→${val(r, keys)}`).join(" / ") + ("tenure_allowance" in patch ? ` (勤続手当 ${num(cur.tenure_allowance)}→${patch.tenure_allowance})` : "");
    if (cur.effective_from === monthStart) {
      ops.push({ label: `更新 ${f.office} ${code} ${e.name} (${monthStart}〜の行) ${desc}`, run: () => fetch(`${SB_URL}/rest/v1/payroll_salary_settings?id=eq.${cur.id}`, { method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(patch) }) });
    } else {
      const { id, created_at, updated_at, ...copy } = cur;
      void id; void created_at; void updated_at;
      ops.push({ label: `作成 ${f.office} ${code} ${e.name} ${monthStart}〜 (元 ${cur.effective_from}) ${desc}`, run: () => fetch(`${SB_URL}/rest/v1/payroll_salary_settings`, { method: "POST", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify({ ...copy, ...patch, effective_from: monthStart }) }) });
    }
  }
}
console.log(`=== 総括表 ${MONTH} の固定給の変更 → 給与設定 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${ops.length} 件 ===`);
for (const o of ops) console.log("  " + o.label);
if (!EXECUTE) { console.log("DRY RUN。--execute で書き込みます"); process.exit(0); }
let ok = 0;
for (const o of ops) {
  const res = await o.run();
  const body = await res.json();
  if (!res.ok || !Array.isArray(body) || body.length !== 1) { console.error(`★ 失敗: ${o.label}`, body); process.exit(1); }
  ok++;
}
console.log(`  反映 ${ok} 件`);
