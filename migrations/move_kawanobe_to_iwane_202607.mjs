/**
 * 川野邉真弓 (2002) を 2026-07 から いわね (1271103184) の職員にする。
 *
 *   node migrations/move_kawanobe_to_iwane_202607.mjs            # DRY RUN
 *   node migrations/move_kawanobe_to_iwane_202607.mjs --execute
 *
 * user 判断 2026-09-17「川野辺7月からいわねOK」。
 * payroll_employees は所属の月次履歴を持たないので、office_id を書き換えると 3〜6月の高品の計算から消える。
 * → 高品の行は 退職日 2026-06-30 (6月まで高品で計算される)、いわねに 7月からの行を新しく作る。
 *   給与設定 (payroll_salary_settings) は全行を新しい職員にコピーする。
 * 総括表: 高品 提責 3〜6月 (勤続手当 8,500) / いわね 提責 7月。どちらも 提責・事務=3 → 役割は 提責。
 * 冪等: いわねに 2002 が既にあれば作らない。
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
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY がありません"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const get = async (path) => {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`${path}: ${await r.text()}`);
  return r.json();
};
const write = async (method, path, body, expect = 1) => {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { method, headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: ${await r.text()}`);
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length !== expect) throw new Error(`${method} ${path}: ${expect} 行のはずが ${Array.isArray(rows) ? rows.length : "?"} 行`);
  return rows;
};

const [takashina] = await get("payroll_offices?select=id&office_number=eq.1270402116");
const [iwane] = await get("payroll_offices?select=id&office_number=eq.1271103184");
const [src] = await get(`payroll_employees?select=*&employee_number=eq.2002&office_id=eq.${takashina.id}`);
if (!src) { console.error("★ 高品に 2002 がいません"); process.exit(2); }
const existing = await get(`payroll_employees?select=id&employee_number=eq.2002&office_id=eq.${iwane.id}`);
const settings = await get(`payroll_salary_settings?select=*&employee_id=eq.${src.id}&order=effective_from.asc`);

const ops = [];
const patchSrc = {};
if (src.resignation_date !== "2026-06-30") patchSrc.resignation_date = "2026-06-30";
if (src.employment_status !== "退職者") patchSrc.employment_status = "退職者";
if (src.role_type !== "提責") patchSrc.role_type = "提責";
if (Object.keys(patchSrc).length) ops.push({ label: `高品 2002 ${src.name}: ${JSON.stringify(patchSrc)}`, run: () => write("PATCH", `payroll_employees?id=eq.${src.id}`, patchSrc) });
for (const s of settings) {
  if (s.tenure_allowance !== 8500 || s.tenure_allowance_auto !== false) ops.push({ label: `高品 2002 給与設定 ${s.effective_from}: 勤続手当 ${s.tenure_allowance} → 8500 (手入力)`, run: () => write("PATCH", `payroll_salary_settings?id=eq.${s.id}`, { tenure_allowance: 8500, tenure_allowance_auto: false }) });
}
if (existing.length === 0) {
  const { id, created_at, updated_at, auth_user_id, member_id, ...copy } = src;
  void id; void created_at; void updated_at; void auth_user_id; void member_id;
  const newEmp = { ...copy, office_id: iwane.id, employment_status: "在職者", resignation_date: null, role_type: "提責" };
  ops.push({
    label: `いわねに 2002 ${src.name} を作る (提責/月給/在職者) + 給与設定 ${settings.length} 行をコピー`,
    run: async () => {
      const [created] = await write("POST", "payroll_employees", newEmp);
      for (const s of settings) {
        const { id: sid, created_at: sc, updated_at: su, employee_id, ...sc2 } = s;
        void sid; void sc; void su; void employee_id;
        await write("POST", "payroll_salary_settings", { ...sc2, employee_id: created.id, tenure_allowance: 8500, tenure_allowance_auto: false });
      }
    },
  });
} else {
  console.log("  (いわねに 2002 は既にある・作らない)");
}

console.log(`=== 川野邉 → いわね ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${ops.length} 件 ===`);
for (const o of ops) console.log(`  ${o.label}`);
if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }
for (const o of ops) await o.run();
console.log(`完了 ${ops.length} 件`);
