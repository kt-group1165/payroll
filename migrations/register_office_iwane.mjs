/**
 * Ｈａｎａヘルパーステーションいわね (1271103184) を 共通 offices → payroll_offices の順に登録する。
 *
 *   node migrations/register_office_iwane.mjs            # DRY RUN
 *   node migrations/register_office_iwane.mjs --execute
 *
 * - 法人: 株式会社 至誠堂 (総括表の 10_至誠堂 配下)
 * - 地域区分: 事業所番号の先頭 12711 が木更津ムツミ (1271101295) と同じなので 6級地 / 10.42
 * - payroll 側の単価系は 同法人の ＫＴやわたヘルパーステーション (1272404508) を写す。
 *   ただし 移動単価 (travel_unit_price) だけは 木更津ムツミ (1271101295) に合わせる (2026-09-17 user 判断)
 * - offices を INSERT すると DB trigger (payroll_office_auto_create_trigger) が payroll_offices を
 *   単価 0 で自動作成する。なので payroll 側は「無ければ INSERT / あれば単価を PATCH」にする
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
async function rest(method, path, body) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method, headers: { ...H, Prefer: "return=representation" }, body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${t}`);
  return t ? JSON.parse(t) : null;
}

const BN = "1271103184";
const NAME = "Ｈａｎａヘルパーステーションいわね";
const SHISEIDO = "fc98cb5f-feb7-4e66-919c-0390228cb130";
const YAWATA_BN = "1272404508";
const KISARAZU_BN = "1271101295";

const [existingMaster] = await rest("GET", `offices?select=id,name&business_number=eq.${BN}`);
const [existingPayroll] = await rest("GET", `payroll_offices?select=id&office_number=eq.${BN}`);
const [yawata] = await rest("GET", `payroll_offices?select=*&office_number=eq.${YAWATA_BN}`);
const [maxSort] = await rest("GET", "offices?select=sort_order&order=sort_order.desc&limit=1");
const [kisarazu] = await rest("GET", `payroll_offices?select=travel_unit_price&office_number=eq.${KISARAZU_BN}`);
if (!kisarazu) { console.error("木更津ムツミの payroll_offices が見つからない"); process.exit(1); }
if (!yawata) { console.error("やわたの payroll_offices が見つからない"); process.exit(1); }

const masterPayload = {
  tenant_id: "kt-group",
  name: NAME,
  business_number: BN,
  service_type: "訪問介護",
  company_id: SHISEIDO,
  designation_type: "介護保険",
  app_type: "kaigo-app",
  area_category: "6級地",
  unit_price: 10.42,
  is_active: true,
  sort_order: (maxSort?.sort_order ?? 0) + 1,
};
const payrollPayload = (officeId) => ({
  office_id: officeId,
  office_number: BN,
  office_type: "訪問介護",
  short_name: "",
  company_id: yawata.company_id,
  work_week_start: yawata.work_week_start,
  travel_unit_price: kisarazu.travel_unit_price,
  commute_unit_price: yawata.commute_unit_price,
  treatment_subsidy_amount: yawata.treatment_subsidy_amount,
  cancel_unit_price: yawata.cancel_unit_price,
  travel_allowance_rate: yawata.travel_allowance_rate,
  communication_fee_amount: yawata.communication_fee_amount,
  meeting_unit_price: yawata.meeting_unit_price,
  distance_adjustment_rate: yawata.distance_adjustment_rate,
});

console.log(`=== いわね 事業所登録 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log("共通 offices :", existingMaster ? `既存 ${existingMaster.id} (${existingMaster.name}) → 追加しない` : masterPayload);
console.log("payroll_offices:", existingPayroll ? `既存 ${existingPayroll.id} → 単価を更新` : "", payrollPayload(existingMaster?.id ?? "<新規 offices.id>"));
if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }

let officeId = existingMaster?.id;
if (!officeId) {
  const [row] = await rest("POST", "offices", masterPayload);
  officeId = row.id;
  console.log("offices 追加:", officeId);
}
const [payrollNow] = await rest("GET", `payroll_offices?select=id&office_number=eq.${BN}`);
if (!payrollNow) {
  const [row] = await rest("POST", "payroll_offices", payrollPayload(officeId));
  console.log("payroll_offices 追加:", row.id);
} else {
  const { office_number: _n, ...patch } = payrollPayload(officeId);
  const rows = await rest("PATCH", `payroll_offices?id=eq.${payrollNow.id}`, patch);
  if (!rows?.length) { console.error("★ payroll_offices の更新が 0 行"); process.exit(2); }
  console.log("payroll_offices 更新:", payrollNow.id);
}
const [check] = await rest("GET", `payroll_offices?select=id,office_number,office_type,travel_unit_price,commute_unit_price,treatment_subsidy_amount,cancel_unit_price,travel_allowance_rate,meeting_unit_price,distance_adjustment_rate,offices(name,business_number)&office_number=eq.${BN}`);
console.log("確認:", JSON.stringify(check));
if (!check?.offices?.name) { console.error("★ 登録後の確認に失敗"); process.exit(2); }
