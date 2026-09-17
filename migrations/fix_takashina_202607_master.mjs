/**
 * 高品 (1270402116) の給与マスタを 総括表 2026-07 に合わせる。
 *
 *   node migrations/fix_takashina_202607_master.mjs            # DRY RUN
 *   node migrations/fix_takashina_202607_master.mjs --execute
 *
 * 根拠 (すべて Box 01_総括表\10_ケイティ\R8.7\05_高品 の xlsm と、MEISAI 実績 / 稼働表):
 *  1. 役割: 提責_社員シートの「提責・事務」列 3=提責 / 1=提責 (岡林、固定残業代あり・超過なし) / 2=事務員 (福田、処遇改善なし・残業全額) / 空=社員 (介護超過あり)
 *  2. 社員 (髙橋幸子・根本・櫻井) の介護超過 120h×2,500円 と 夜朝 200円 (さつきが丘と同じ)
 *  3. 根本高光・岡林真美 の給与設定が無い → 総括表の固定給で作る
 *  4. パートの 社会保険=1 と 有給単価 を総括表から入れる
 *  5. MEISAI・稼働表・総括表のどれにも居ない在職/休職者は 退職者 (user 方針 2026-09-17)
 *  6. 高品 身体生活の時給 1,950 → 1,900 (総括表 単価確認用: 1,900円 108分)
 *  8. 【2回目 2026-09-17 計算後】 時給者で総括表に勤続手当がある7名は 資格 "不明（要件は満たす）" (勤続手当は資格者のみ)
 *  9. 月給者の勤続手当は 総括表の額を手入力 (自動計算は資格・通算年数が DB に無く 0 円になる)
 * 10. 根本高光 休職者 → 在職者 (7月に稼働・総括表に在籍)
 * 12. 月給者の勤続手当の月ごとの変化を 給与設定の履歴 (effective_from) で持つ (総括表 2026-03〜07)
 *     花島 11,000→6月 11,500 / 長谷川 6,000→7月 6,500 / 吉田 4,000→5月 4,500 / 櫻井 0→4月 1,000
 *     一番古い行の勤続手当を変化前の額にし、変化月の 1 日から始まる行を (他の項目は同じで) 作る
 * 13. 社員の有給単価 (円/日): 根本 82 / 櫻井 1,286 / 髙橋幸子 1,370 (総括表 有給休暇手当 ÷ 日数。月によらず一定)
 * 11. 退職者のうち 総括表 2026-04 に最後に載っている 鈴木麻亜子・鵜澤奈菜 は 退職日 2026-04-30 (4月の計算に含める)
 *  7. 未対応コード: 010288 移動5.5 / 010147〜010153 有料身有 → 身体介護 (総括表テーブル1: 移動身あり・有料身あり。おゆみ野で 2,100円)
 *
 * 前提: 岡林真美は migrations/register_payroll_employees.mjs employee_lists/202607_takashina.json で登録済みであること。
 * 既存の値が既に目標値なら何もしない (冪等)。
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
const write = async (method, path, body) => {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { method, headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: ${await r.text()}`);
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error(`${method} ${path}: 1 行のはずが ${Array.isArray(rows) ? rows.length : "?"} 行`);
  return rows[0];
};

const OFFICE_NUMBER = "1270402116";
const ROLES = { "2025": "提責", "3021": "提責", "4037": "提責", "4096": "提責", "260606": "提責", "4070": "社員", "4097": "社員", "250401": "社員", "221006": "事務員" };
const SHAIN_CARE = { care_overtime_threshold_hours: 120, care_overtime_unit_price: 2500, yocho_unit_price: 200 };
const NEW_SETTINGS = {
  "4097": { base_personal_salary: 94000, skill_salary: 96000, position_allowance: 0, qualification_allowance: 0, tenure_allowance: 0, tenure_allowance_auto: false, treatment_improvement: 78000, specific_treatment_improvement: 10000, treatment_subsidy: 20000, fixed_overtime_pay: 0, ...SHAIN_CARE },
  "260606": { base_personal_salary: 100000, skill_salary: 96000, position_allowance: 0, qualification_allowance: 5000, tenure_allowance: 0, tenure_allowance_auto: false, treatment_improvement: 78000, specific_treatment_improvement: 40000, treatment_subsidy: 20000, fixed_overtime_pay: 50000, care_overtime_threshold_hours: 0, care_overtime_unit_price: 0, yocho_unit_price: 0 },
};
const SOCIAL_INSURANCE = ["2010", "2155", "4004", "4053", "4082", "4095", "251204"];
const PAID_LEAVE_UNIT = { "4097": 82, "250401": 1286, "4070": 1370, "2010": 10991, "4004": 9186, "4012": 6103, "4053": 11105, "4081": 6248, "4082": 8765, "4095": 8759, "240505": 3263, "240705": 4182, "250705": 4628, "251004": 3527 };
const RETIRE = ["2036", "220503", "221103", "230903", "240303", "240802", "250804", "250911", "4119"];
const SHINTAI_SEIKATSU_RATE = 1900;
const MAP_TO_SHINTAI = ["010288", "010147", "010149", "010151", "010153"];
const QUALIFIED_UNKNOWN = ["2010", "4004", "4012", "4081", "4089", "4095", "250705"];
const MONTHLY_TENURE = { "2025": 9000, "4070": 5000 };
const TENURE_HISTORY = {
  "3021": [["1970-01-01", 11000], ["2026-06-01", 11500]],
  "4037": [["1970-01-01", 6000], ["2026-07-01", 6500]],
  "4096": [["1970-01-01", 4000], ["2026-05-01", 4500]],
  "250401": [["1970-01-01", 0], ["2026-04-01", 1000]],
};
const REINSTATE = ["4097"];
const RESIGNATION_DATES = { "240303": "2026-04-30", "220503": "2026-04-30" };

const [office] = await get(`payroll_offices?select=id&office_number=eq.${OFFICE_NUMBER}`);
const emps = await get(`payroll_employees?select=id,employee_number,name,role_type,social_insurance,paid_leave_unit_price,employment_status,resignation_date,has_care_qualification,care_qualification_kind&office_id=eq.${office.id}`);
const byNo = new Map(emps.map((e) => [e.employee_number, e]));
const ops = [];

for (const [no, role] of Object.entries(ROLES)) {
  const e = byNo.get(no);
  if (!e) { console.error(`★ 職員 ${no} が高品に居ません (岡林なら先に登録)`); process.exit(2); }
  if (e.role_type !== role) ops.push({ label: `役割 ${no} ${e.name} ${e.role_type} → ${role}`, run: () => write("PATCH", `payroll_employees?id=eq.${e.id}`, { role_type: role }) });
}
for (const no of SOCIAL_INSURANCE) {
  const e = byNo.get(no);
  if (e && !e.social_insurance) ops.push({ label: `社保 ${no} ${e.name} → あり`, run: () => write("PATCH", `payroll_employees?id=eq.${e.id}`, { social_insurance: true }) });
}
for (const [no, price] of Object.entries(PAID_LEAVE_UNIT)) {
  const e = byNo.get(no);
  if (e && e.paid_leave_unit_price !== price) ops.push({ label: `有給単価 ${no} ${e.name} ${e.paid_leave_unit_price} → ${price}`, run: () => write("PATCH", `payroll_employees?id=eq.${e.id}`, { paid_leave_unit_price: price }) });
}
for (const no of RETIRE) {
  const e = byNo.get(no);
  if (e && e.employment_status !== "退職者") ops.push({ label: `退職者に ${no} ${e.name} (${e.employment_status})`, run: () => write("PATCH", `payroll_employees?id=eq.${e.id}`, { employment_status: "退職者" }) });
}
for (const no of QUALIFIED_UNKNOWN) {
  const e = byNo.get(no);
  if (e && (!e.has_care_qualification || !e.care_qualification_kind)) ops.push({ label: `資格 ${no} ${e.name} → 不明（要件は満たす）`, run: () => write("PATCH", `payroll_employees?id=eq.${e.id}`, { has_care_qualification: true, care_qualification_kind: e.care_qualification_kind ?? "不明（要件は満たす）" }) });
}
for (const [no, date] of Object.entries(RESIGNATION_DATES)) {
  const e = byNo.get(no);
  if (e && e.resignation_date !== date) ops.push({ label: `退職日 ${no} ${e.name} ${e.resignation_date} → ${date}`, run: () => write("PATCH", `payroll_employees?id=eq.${e.id}`, { resignation_date: date }) });
}
for (const no of REINSTATE) {
  const e = byNo.get(no);
  if (e && e.employment_status !== "在職者") ops.push({ label: `在職者に ${no} ${e.name} (${e.employment_status})`, run: () => write("PATCH", `payroll_employees?id=eq.${e.id}`, { employment_status: "在職者" }) });
}
for (const [no, amount] of Object.entries(MONTHLY_TENURE)) {
  const e = byNo.get(no);
  const [s] = await get(`payroll_salary_settings?select=id,effective_from,tenure_allowance,tenure_allowance_auto&employee_id=eq.${e.id}&order=effective_from.desc&limit=1`);
  if (!s) { console.error(`★ ${no} の給与設定がありません`); process.exit(2); }
  if (s.tenure_allowance !== amount || s.tenure_allowance_auto !== false) ops.push({ label: `勤続手当(手入力) ${no} ${e.name} ${s.tenure_allowance}${s.tenure_allowance_auto === false ? "" : "(自動)"} → ${amount}`, run: () => write("PATCH", `payroll_salary_settings?id=eq.${s.id}`, { tenure_allowance: amount, tenure_allowance_auto: false }) });
}
for (const [no, steps] of Object.entries(TENURE_HISTORY)) {
  const e = byNo.get(no);
  const rows = await get(`payroll_salary_settings?select=*&employee_id=eq.${e.id}&order=effective_from.asc`);
  if (rows.length === 0) { console.error(`★ ${no} の給与設定がありません`); process.exit(2); }
  for (const [eff, amount] of steps) {
    const row = rows.find((r) => r.effective_from === eff);
    if (row) {
      if (row.tenure_allowance !== amount || row.tenure_allowance_auto !== false) ops.push({ label: `勤続手当 ${no} ${e.name} ${eff}〜 ${row.tenure_allowance} → ${amount}`, run: () => write("PATCH", `payroll_salary_settings?id=eq.${row.id}`, { tenure_allowance: amount, tenure_allowance_auto: false }) });
    } else {
      const base = [...rows].reverse().find((r) => r.effective_from < eff) ?? rows[0];
      const { id, created_at, updated_at, ...copy } = base;
      void id; void created_at; void updated_at;
      ops.push({ label: `給与設定の履歴を追加 ${no} ${e.name} ${eff}〜 勤続手当 ${amount} (他は ${base.effective_from} の行と同じ)`, run: () => write("POST", "payroll_salary_settings", { ...copy, effective_from: eff, tenure_allowance: amount, tenure_allowance_auto: false }) });
    }
  }
}
for (const no of ["4070", "250401"]) {
  const e = byNo.get(no);
  const [s] = await get(`payroll_salary_settings?select=id,effective_from,care_overtime_threshold_hours,care_overtime_unit_price,yocho_unit_price&employee_id=eq.${e.id}&order=effective_from.desc&limit=1`);
  if (!s) { console.error(`★ ${no} の給与設定がありません`); process.exit(2); }
  if (Object.entries(SHAIN_CARE).some(([k, v]) => s[k] !== v)) ops.push({ label: `社員の介護超過・夜朝 ${no} ${e.name} (${s.effective_from})`, run: () => write("PATCH", `payroll_salary_settings?id=eq.${s.id}`, SHAIN_CARE) });
}
for (const [no, values] of Object.entries(NEW_SETTINGS)) {
  const e = byNo.get(no);
  const rows = await get(`payroll_salary_settings?select=id&employee_id=eq.${e.id}`);
  if (rows.length === 0) ops.push({ label: `給与設定を作る ${no} ${e.name} ${JSON.stringify(values)}`, run: () => write("POST", "payroll_salary_settings", { employee_id: e.id, effective_from: "1970-01-01", ...values }) });
  else console.log(`  (給与設定あり・触らない) ${no} ${e.name}`);
}
const cats = await get("payroll_service_categories?select=id,name");
const catId = (name) => cats.find((c) => c.name === name)?.id;
const [rate] = await get(`payroll_category_hourly_rates?select=id,hourly_rate&office_id=eq.${office.id}&category_id=eq.${catId("身体生活")}`);
if (rate && rate.hourly_rate !== SHINTAI_SEIKATSU_RATE) ops.push({ label: `高品 身体生活 ${rate.hourly_rate} → ${SHINTAI_SEIKATSU_RATE}`, run: () => write("PATCH", `payroll_category_hourly_rates?id=eq.${rate.id}`, { hourly_rate: SHINTAI_SEIKATSU_RATE }) });
const maps = await get(`payroll_service_type_mappings?select=service_code,category_id&service_code=in.(${MAP_TO_SHINTAI.join(",")})`);
for (const code of MAP_TO_SHINTAI) {
  if (maps.some((m) => m.service_code === code)) { console.log(`  (対応あり・触らない) ${code}`); continue; }
  ops.push({ label: `コード対応 ${code} → 身体介護`, run: () => write("POST", "payroll_service_type_mappings", { service_code: code, category_id: catId("身体介護") }) });
}

console.log(`=== 高品 給与マスタ是正 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${ops.length} 件 ===`);
for (const o of ops) console.log(`  ${o.label}`);
if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }
let done = 0;
for (const o of ops) { await o.run(); done++; }
console.log(`\n完了 ${done} / ${ops.length}`);
