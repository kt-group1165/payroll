/**
 * 介護アプリの居宅の請求 (kaigo_care_support_claims) を 給与の居宅の実績 (payroll_kyotaku_records) に写す (2026-10-19)。
 * user 2026-10-19「少なくとも構築中の今は 介護アプリの実績を取り込む方式でいい」(CLAUDE.md §10.5 snapshot pull)。
 *
 *   npx tsx migrations/pull_kyotaku_records_from_kaigo.mts 2026-06            # DRY RUN
 *   npx tsx migrations/pull_kyotaku_records_from_kaigo.mts 2026-06 --execute
 *
 * 写し方 (国保連 CSV の行と同じ形にする。給与の計算 kyotaku-calc.ts はこの形を読む):
 *   1 請求 = 基本の行 (detail_row_no "1"・居宅介護支援費のコード) + 加算の行 (detail_row_no "2"〜・加算の名前)
 *   提供月 = 請求の billing_month (介護アプリでは 提供月) / 請求月 = 取り込んだ伝送ファイル KKyymm の送信月 (notes に残っている)
 *   事業所 = 利用者の居宅の事業所 (client_office_assignments → payroll_offices.office_number)
 *     (2 つ付いているときは 担当ケアマネが 給与の職員として登録されている方。2026-06 で 2 件: 秋元とし子・武井與里子)
 *   担当ケアマネ = その月に有効な認定の care_manager。給与の職員一覧に 同じ事業所で同じ名前 (空白の違いは無視) がいれば その表記に揃える
 *   要介護度 = 有効な認定の care_level
 * 再取込: その事業所 × 提供月 の「介護アプリから写した行」(source_filename が kaigo-app snapshot) だけを消してから入れ直す。
 *   国保連 CSV から入れた行には触らない。同じ事業所 × 提供月に CSV の行があれば 写さずに止める (二重になるため)。
 */
import { readFileSync } from "node:fs";
import { restAll } from "../scripts/_rest.mjs";

const MONTH = process.argv.slice(2).find((a) => /^\d{4}-\d{2}$/.test(a));
const EXECUTE = process.argv.includes("--execute");
if (!MONTH) { console.error("提供月を YYYY-MM で指定してください"); process.exit(1); }
const SOURCE = `kaigo-app snapshot ${MONTH}`;
const nm = (s: string | null | undefined) => String(s ?? "").normalize("NFKC").replace(/[\s　]/g, "");

type Claim = {
  id: string; user_id: string; billing_month: string; care_support_code: string | null; care_support_name: string | null;
  units: number | null; unit_price: number | null; total_amount: number | null; notes: string | null;
  initial_addition: boolean; initial_addition_units: number | null; hospital_coordination: boolean; hospital_coordination_units: number | null;
  discharge_addition: boolean; discharge_addition_units: number | null; discharge_type: string | null; medical_coordination: boolean; medical_coordination_units: number | null;
  terminal_care: boolean; terminal_care_units: number | null; emergency_conference: boolean; emergency_conference_units: number | null;
  tokutei_kassan_type: string | null; tokutei_kassan_units: number | null; insurer_number: string | null; insured_number: string | null;
};
const claims = await restAll<Claim>(`kaigo_care_support_claims?select=*&billing_month=eq.${MONTH}`);
const certs = await restAll<{ client_id: string; care_manager: string | null; care_level: string | null; certification_start_date: string | null; certification_end_date: string | null; insurer_number: string | null; insurer_name: string | null; insured_number: string | null }>(
  "client_insurance_records?select=id,client_id,care_manager,care_level,certification_start_date,certification_end_date,insurer_number,insurer_name,insured_number");
const clients = new Map((await restAll<{ id: string; name: string; user_number?: string | null }>("clients?select=id,name,user_number")).map((c) => [c.id, c]));
const payOffices = await restAll<{ id: string; office_id: string | null; office_number: string; office_type: string }>("payroll_offices?select=id,office_id,office_number,office_type");
const kyoByMaster = new Map(payOffices.filter((o) => o.office_type === "居宅介護支援" && o.office_id).map((o) => [o.office_id!, o]));
const asg = await restAll<{ client_id: string; office_id: string }>("client_office_assignments?select=id,client_id,office_id");
const officesOfClient = new Map<string, Set<string>>();
for (const a of asg) { const o = kyoByMaster.get(a.office_id); if (!o) continue; const s = officesOfClient.get(a.client_id) ?? new Set(); s.add(o.office_number); officesOfClient.set(a.client_id, s); }
const emps = await restAll<{ name: string; office_id: string }>("payroll_employees?select=id,name,office_id");
const payOfficeNumById = new Map(payOffices.map((o) => [o.id, o.office_number]));
const empNameByOfficeNorm = new Map<string, string>();
for (const e of emps) { const on = payOfficeNumById.get(e.office_id); if (on) empNameByOfficeNorm.set(`${on}|${nm(e.name)}`, e.name); }
const units = await restAll<{ item_name: string }>("payroll_kyotaku_service_units?select=id,item_name");
const unitNames = units.map((u) => u.item_name);

const mStart = `${MONTH}-01`;
const mEnd = new Date(Date.UTC(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5, 7)), 0)).toISOString().slice(0, 10);
const nextMonth = (() => { const d = new Date(Date.UTC(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5, 7)), 1)); return d.toISOString().slice(0, 10); })();

/**
 * 退院退所加算の名前 (国保連のサービス名と同じ。単位数の表 payroll_kyotaku_service_units の item_name に合わせる)。
 * 介護アプリの discharge_type で区分を決める (600 単位は Ⅰ２ と Ⅱ１ の 2 つあるので 単位数では決まらない。2026-10-19)
 *   436132 Ⅰ１ 450 / 436143 Ⅰ２ 600 / 436144 Ⅱ１ 600 / 436145 Ⅱ２ 750 / 436146 Ⅲ 900
 */
function dischargeName(type: string | null, units: number | null): string {
  const byType: Record<string, string> = { i_i: "退院退所加算Ⅰ１", i_ro: "退院退所加算Ⅰ２", ii_i: "退院退所加算Ⅱ１", ii_ro: "退院退所加算Ⅱ２", iii: "退院退所加算Ⅲ" };
  if (type && byType[type]) return byType[type];
  const byUnits: Record<number, string> = { 450: "退院退所加算Ⅰ１", 750: "退院退所加算Ⅱ２", 900: "退院退所加算Ⅲ" };
  return byUnits[units ?? 0] ?? `退院退所加算 (${units ?? "?"}単位)`;
}

type Rec = Record<string, unknown>;
const rows: Rec[] = [];
const warn = { noOffice: 0, manyOffice: 0, manyResolved: 0, noCm: 0, noCert: 0, addonUnmatched: new Map<string, number>(), cmNotInPayroll: new Map<string, number>(), late: 0 };
for (const c of claims) {
  const offs = [...(officesOfClient.get(c.user_id) ?? [])];
  if (offs.length === 0) { warn.noOffice++; continue; }
  const cert = certs.filter((x) => x.client_id === c.user_id && (x.certification_start_date ?? "") <= mEnd && (!x.certification_end_date || x.certification_end_date >= mStart))
    .sort((a, b) => (b.certification_start_date ?? "").localeCompare(a.certification_start_date ?? ""))[0];
  if (!cert) { warn.noCert++; continue; }
  const cmRaw = cert.care_manager?.trim() ?? "";
  if (!cmRaw) { warn.noCm++; continue; }
  // 居宅の事業所が 2 つ付いている利用者は 担当ケアマネが 給与の職員として登録されている事業所にする (2026-10-19)。
  // それでも 1 つに決まらなければ 写さない
  const office = offs.length === 1 ? offs[0] : (() => {
    const hit = offs.filter((o) => empNameByOfficeNorm.has(`${o}|${nm(cmRaw)}`));
    return hit.length === 1 ? hit[0] : null;
  })();
  if (!office) { warn.manyOffice++; continue; }
  if (offs.length > 1) warn.manyResolved++;
  const staff = empNameByOfficeNorm.get(`${office}|${nm(cmRaw)}`) ?? cmRaw;
  if (!empNameByOfficeNorm.has(`${office}|${nm(cmRaw)}`)) warn.cmNotInPayroll.set(`${office} ${cmRaw}`, (warn.cmNotInPayroll.get(`${office} ${cmRaw}`) ?? 0) + 1);
  const kk = /KK(\d{2})(\d{2})/.exec(c.notes ?? "");
  const billing = kk ? `20${kk[1]}-${kk[2]}-01` : nextMonth;
  if (billing > nextMonth) warn.late++;
  const careLevel = cert.care_level ?? (String(c.care_support_code ?? "").startsWith("43") ? "要介護" : null);
  const base: Rec = {
    tenant_id: "kt-group", office_number: office, source_filename: SOURCE, service_month: mStart, billing_month: billing,
    staff_name: staff, insured_number: c.insured_number ?? cert.insured_number, insured_name: clients.get(c.user_id)?.name ?? null,
    client_number: clients.get(c.user_id)?.user_number ?? null, care_level: careLevel,
    insurer_number: c.insurer_number ?? cert.insurer_number, insurer_name: cert.insurer_name ?? null,
    cert_start_date: cert.certification_start_date, cert_end_date: cert.certification_end_date,
  };
  rows.push({ ...base, detail_row_no: "1", service_code: c.care_support_code, service_name: c.care_support_name, unit_total: c.units, unit_price: c.unit_price, amount: c.total_amount });
  // 加算 (給与は 単位数の表の名前が service_name に含まれる行を数える)
  const addons: [boolean, string, number | null][] = [
    [c.initial_addition, "初回加算", c.initial_addition_units],
    [c.hospital_coordination, (c.hospital_coordination_units ?? 0) >= 250 ? "入院時情報連携加算Ⅰ" : "入院時情報連携加算Ⅱ", c.hospital_coordination_units],
    [c.discharge_addition, dischargeName(c.discharge_type, c.discharge_addition_units), c.discharge_addition_units],
    [c.medical_coordination, "通院時情報連携加算", c.medical_coordination_units],
    [c.terminal_care, "ターミナルケアマネジメント加算", c.terminal_care_units],
    [c.emergency_conference, "緊急時等居宅カンファレンス加算", c.emergency_conference_units],
    [!!c.tokutei_kassan_type && (c.tokutei_kassan_units ?? 0) > 0, `特定事業所加算${c.tokutei_kassan_type ?? ""}`, c.tokutei_kassan_units],
  ];
  let no = 2;
  for (const [on, name, u] of addons) {
    if (!on) continue;
    if (!unitNames.some((n) => name.includes(n))) warn.addonUnmatched.set(name, (warn.addonUnmatched.get(name) ?? 0) + 1);
    rows.push({ ...base, detail_row_no: String(no++), service_code: null, service_name: name, unit_total: u, unit_price: c.unit_price, amount: null });
  }
}

const byOffice = new Map<string, { rows: number; base: number; staff: Set<string> }>();
for (const r of rows) { const o = String(r.office_number); const v = byOffice.get(o) ?? { rows: 0, base: 0, staff: new Set<string>() }; v.rows++; if (r.detail_row_no === "1") v.base++; v.staff.add(String(r.staff_name)); byOffice.set(o, v); }
console.log(`提供月 ${MONTH}: 請求 ${claims.length} 件 → 写す行 ${rows.length} (基本 ${rows.filter((r) => r.detail_row_no === "1").length} / 加算 ${rows.filter((r) => r.detail_row_no !== "1").length})`);
console.log(`写さない: 居宅の事業所が無い ${warn.noOffice} / 複数で決まらない ${warn.manyOffice} / 有効な認定が無い ${warn.noCert} / 担当ケアマネが空 ${warn.noCm}`);
if (warn.manyResolved) console.log(`居宅の事業所が複数 → 担当ケアマネの事業所に決めた ${warn.manyResolved} 件`);
console.log(`月遅れで請求された (送信月が翌月より後) ${warn.late} 件`);
for (const [o, v] of [...byOffice].sort()) console.log(`  ${o}: 基本 ${v.base} 行 / 全 ${v.rows} 行 / ケアマネ ${v.staff.size} 人`);
if (warn.addonUnmatched.size) console.log(`⚠ 単位数の表に名前が無い加算 (給与の加算手当に入らない): ${[...warn.addonUnmatched].map(([k, v]) => `${k}=${v}`).join(" / ")}`);
console.log(`⚠ 給与の職員一覧に 同じ事業所・同じ名前が無いケアマネ ${warn.cmNotInPayroll.size} 人 (給与設定が引けないので 計算されない): ${[...warn.cmNotInPayroll.keys()].slice(0, 12).join(" / ")}${warn.cmNotInPayroll.size > 12 ? " …" : ""}`);

// 国保連 CSV の行が既にある 事業所 × 提供月 には写さない
const existing = await restAll<{ office_number: string; source_filename: string | null }>(`payroll_kyotaku_records?select=id,office_number,source_filename&service_month=eq.${mStart}`);
const csvOffices = new Set(existing.filter((r) => !String(r.source_filename ?? "").startsWith("kaigo-app snapshot")).map((r) => r.office_number));
const blocked = [...byOffice.keys()].filter((o) => csvOffices.has(o));
if (blocked.length) console.log(`★ 国保連 CSV の行が既にあるので 写さない事業所: ${blocked.join(", ")}`);
if (!EXECUTE) { console.log("\nDRY RUN。書き込むときは --execute"); process.exit(0); }

const env: Record<string, string> = {};
for (const f of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const base = `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/payroll_kyotaku_records`;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" };
const toWrite = rows.filter((r) => !blocked.includes(String(r.office_number)));
// 前回この script で写した行だけを消す (事業所 × 提供月 × 出どころ で絞る)
for (const o of new Set(toWrite.map((r) => String(r.office_number)))) {
  const r = await fetch(`${base}?office_number=eq.${o}&service_month=eq.${mStart}&source_filename=eq.${encodeURIComponent(SOURCE)}`, { method: "DELETE", headers: H });
  if (!r.ok) { console.error(`消す前で止めました (${o}): ${r.status} ${await r.text()}`); process.exit(1); }
}
let ok = 0; const fails: string[] = [];
for (let i = 0; i < toWrite.length; i += 500) {
  const r = await fetch(base, { method: "POST", headers: H, body: JSON.stringify(toWrite.slice(i, i + 500)) });
  if (!r.ok) fails.push(`${i}: ${r.status} ${(await r.text()).slice(0, 200)}`); else ok += Math.min(500, toWrite.length - i);
}
console.log(`書き込み ${ok} 行 / 失敗 ${fails.length} 回`);
for (const f of fails) console.log("  ✗ " + f);
const after = await restAll<{ id: string }>(`payroll_kyotaku_records?select=id&service_month=eq.${mStart}&source_filename=eq.${encodeURIComponent(SOURCE)}`);
console.log(`確認: ${MONTH} の 介護アプリから写した行 ${after.length} (書いたつもり ${toWrite.length})`);
if (fails.length > 0 || after.length !== toWrite.length) process.exit(1);
