/**
 * ケアマネ (居宅) の 職員登録 と 給与設定の履歴 を 総括表 (ケアマネ) から入れる (2026-10-19)。
 *
 *   npx tsx migrations/import_caremane_settings_from_soukatsu.mts <caremane_rows.json>            # DRY RUN
 *   npx tsx migrations/import_caremane_settings_from_soukatsu.mts <caremane_rows.json> --execute
 *
 * <caremane_rows.json> = Box 01_総括表 の <拠点>_ケアマネ_YYYYMM (R7.1〜R8.9) を scratchpad にコピーして読んだもの (Box には触らない)。
 *   ケアマネの総括表は ① (旧システムの CSV) が無く ②支払用 (入力 + 式) だけ。ここで使うのは 人が入れている「入力値」だけ。
 * ① 職員登録: 総括表の最新月にいるのに その居宅の事業所の職員一覧にいない人を 登録 (社員番号・氏名 = 総括表)。
 *    給与形態 = 本人給 > 0 なら 月給 (社員) / 0 なら 時給 (パート)。
 * ② 給与設定 (payroll_kyotaku_salary): 月ごとの 本人給・職能給・固定残業・資格手当・勤続手当(固定)・特定処遇・介護単価・予防単価 を
 *    「値が変わった月」から有効な行 (effective_from = その月の 1 日) として入れる。同じ (職員, 適用開始月) の行があれば上書き。
 *    総括表の空欄は 0 (払っていない) とみなす。単価の空欄は 空 (NULL) のまま。
 *    2026-10-19 SQL (payroll_kyotaku_salary_soukatsu_items.sql) の列も入れる: ケアプラン固定 (空 = 払わない) / 役職手当 /
 *    勤続手当の型 (1 固定 / 2 固定+件数) と 件数単価・介護時間単価 / 保障額 (例 300000) と 最後の月 / 通勤費の上限 (25000)
 *    保障の最後の月 = R8.9 新様式の「保障期間」欄 (Excel の日付) か、それ以前は 氏名欄の「R8.10月分まで」(R8 = 2026)。人ごとに 全部の月の行へ入れる
 *    通勤費の上限 = 総括表で 通勤費が ちょうど 25000 に抑えられている月がある人だけ (その人の全部の月の行へ)
 * 総括表の事業所名 → 事業所番号 は 実績 (payroll_kyotaku_records) に出てくる事業所で決めた対応表 (15 事業所すべて 1 対 1)。
 */
import { readFileSync } from "node:fs";
import { restAll } from "../scripts/_rest.mjs";

const [SRC] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const EXECUTE = process.argv.includes("--execute");
if (!SRC) { console.error("caremane_rows.json を指定してください"); process.exit(1); }

const OFFICE: Record<string, string> = {
  KT姉崎: "1272401876", 花見川: "1270201922", 五井: "1272400506", おゆみ野: "1270501172", 袖ケ浦: "1273400851",
  いすみ: "1278600406", 姉崎ムツミ: "1272400837", 木更津ムツミ: "1271101287", Hana船橋: "1270907411", Hanaちはら台: "1272403492",
  高品居宅: "1270404229", Hana八千代: "1272603844", Hana四街道: "1270303272", リンクス大網: "1279200081", リンクス茂原: "1271500934",
};
type Row = { office: string; file_month: string; 社員No: number | string | null; name: string; 本人給: number | null; 職能給: number | null; 固定残業手当: number | null;
  資格手当: number | null; 勤続_固定: number | null; 勤続_変動?: number | null; 介護件数?: number | null; 予防件数?: number | null; ケアプラン手当?: number | null; 特定処遇改善: number | null; 介護単価: number | null; 予防単価: number | null;
  ケアプラン固定: number | null; 役職手当: number | null; 勤続手当対象: number | null; 勤続手当単価: number | null; 勤続手当介護単価: number | null;
  保障期間?: number | string | null; 通勤費: number | null; 通勤距離: number | null; consts?: Record<string, number> };
const rows = (JSON.parse(readFileSync(SRC, "utf8")) as Row[]).filter((r) => r.name && OFFICE[r.office]);
/** 字違いで同じ人 (職員一覧 ↔ 総括表)。袖ケ浦の職員一覧は 社員番号が仮の番号なので 氏名で結び付けるしかない */
const NAME_ALIAS: Record<string, string> = { 坂本佑香: "坂本祐香" };
const nm = (s: unknown) => { const v = String(s ?? "").split("\n")[0].normalize("NFKC").replace(/[\s　]/g, ""); return NAME_ALIAS[v] ?? v; };
/** 氏名欄の書き込み (「(R8.9末退職)」など) を落とす */
const cleanName = (s: string) => s.split("\n")[0].replace(/[（(].*?[）)]/g, "").trim();
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");

const payOffices = await restAll<{ id: string; office_number: string }>("payroll_offices?select=id,office_number&office_type=eq.居宅介護支援");
const officeId = new Map(payOffices.map((o) => [o.office_number, o.id]));
const emps = await restAll<{ id: string; employee_number: string; name: string; office_id: string }>("payroll_employees?select=id,employee_number,name,office_id");
const salary = await restAll<{ employee_id: string; effective_from: string }>("payroll_kyotaku_salary?select=id,employee_id,effective_from");

// 人 = (事業所番号, 社員番号 or 氏名)
type Person = { officeNumber: string; no: string; name: string; months: Row[] };
const people = new Map<string, Person>();
for (const r of rows) {
  const on = OFFICE[r.office];
  const k = `${on}|${nn(r.社員No) || nm(r.name)}`;
  const p = people.get(k) ?? { officeNumber: on, no: nn(r.社員No), name: cleanName(r.name), months: [] };
  p.months.push(r); p.name = cleanName(r.name);
  people.set(k, p);
}
const latestMonthOfOffice = new Map<string, string>();
for (const r of rows) { const on = OFFICE[r.office]; if ((latestMonthOfOffice.get(on) ?? "") < r.file_month) latestMonthOfOffice.set(on, r.file_month); }
const findEmp = (p: Person) => {
  const oid = officeId.get(p.officeNumber);
  return emps.find((e) => e.office_id === oid && p.no && nn(e.employee_number) === p.no)
    ?? emps.find((e) => e.office_id === oid && nm(e.name) === nm(p.name));
};

// ① 職員登録
const toRegister: Person[] = [], notLatest: string[] = [];
for (const p of people.values()) {
  if (findEmp(p)) continue;
  const last = p.months.map((m) => m.file_month).sort().at(-1)!;
  if (last !== latestMonthOfOffice.get(p.officeNumber)) { notLatest.push(`${p.officeNumber} ${p.no} ${p.name} (最後に載った月 ${last})`); continue; }
  toRegister.push(p);
}
console.log(`① 職員登録 ${toRegister.length} 人 (総括表の最新月にいて 職員一覧にいない人)`);
for (const p of toRegister) { const last = p.months.sort((a, b) => a.file_month.localeCompare(b.file_month)).at(-1)!; console.log(`  ＋ ${p.officeNumber} ${p.no} ${p.name} ${(last.本人給 ?? 0) > 0 ? "月給" : "時給"}`); }
if (notLatest.length) console.log(`  (最新月にいないので登録しない ${notLatest.length} 人: ${notLatest.slice(0, 10).join(" / ")}${notLatest.length > 10 ? " …" : ""})`);

// ② 給与設定の履歴
/** 保障の最後の月 (YYYY-MM-01)。新様式の「保障期間」(Excel の日付 = 1899-12-30 からの時間で読んである) か 氏名欄の「R8.10月分まで」 */
const guaranteeUntilOf = (r: Row): string | null => {
  const h = r.保障期間;
  if (typeof h === "number" && h > 24 * 3000) { const d = new Date(Date.UTC(1899, 11, 30) + h * 3600 * 1000); return `${d.toISOString().slice(0, 7)}-01`; }
  if (typeof h === "string" && /^\d{4}-\d{2}/.test(h)) return `${h.slice(0, 7)}-01`;
  const m = /R(\d+)\.(\d+)月分まで/.exec(String(r.name ?? ""));
  return m ? `${2018 + Number(m[1])}-${String(Number(m[2])).padStart(2, "0")}-01` : null;
};
/** 人ごとに決まる値 (保障・通勤費の上限)。どの月の行にも同じ値を入れる */
const personWide = new Map<Person, { guarantee_amount: number | null; guarantee_until: string | null; commute_cap: number | null }>();
for (const p of people.values()) {
  const until = p.months.map(guaranteeUntilOf).filter((x): x is string => !!x).sort().at(-1) ?? null;
  const amount = until ? (p.months.map((m) => m.consts?.保障額).find((x) => typeof x === "number") ?? 300000) : null;
  const capped = p.months.some((m) => m.通勤費 === 25000 && (m.通勤距離 ?? 0) * (m.consts?.単価 ?? 12) > 25000);
  personWide.set(p, { guarantee_amount: amount, guarantee_until: until, commute_cap: capped ? 25000 : null });
}
/**
 * 単価の欄が無い月 (姉崎ムツミ 2026-01〜08 は ケアプランの金額を直接入れていた) の 介護単価・予防単価。
 * 介護単価 = (プラン手当 + ケアプラン固定 − 予防単価 3,000 × 予防件数) ÷ 介護件数 が 整数になるときだけ (実測で全員 8,000/8,300/9,000。9 月のブックの単価と一致)。
 * プランが 0 円で逆算できない月は 0 のまま (総括表もその月は 0 円。管理者など ケアプランの額が無い人に 単価を補わない)
 */
const PREVENT_RATE = 3000;
const rateOf = new Map<Row, { k: number | null; s: number | null }>();
for (const p of people.values()) {
  const ms = [...p.months].sort((a, b) => a.file_month.localeCompare(b.file_month));
  for (const m of ms) {
    if (m.介護単価 != null) { rateOf.set(m, { k: m.介護単価, s: m.予防単価 ?? null }); continue; }
    const fixed = m.ケアプラン固定 ?? ((m.本人給 ?? 0) > 0 ? (m.本人給 ?? 0) + (m.職能給 ?? 0) + (m.固定残業手当 ?? 0) : 0);
    const k = m.介護件数 ?? 0, plan = m.ケアプラン手当 ?? 0;
    const est = k > 0 && plan > 0 ? (plan + fixed - PREVENT_RATE * (m.予防件数 ?? 0)) / k : NaN;
    if (Number.isInteger(est) && est >= 5000 && est <= 12000) rateOf.set(m, { k: est, s: PREVENT_RATE });
  }
}
const val = (r: Row, p: Person) => ({
  honnin_kyu: r.本人給 ?? 0, shokuno_kyu: r.職能給 ?? 0, kotei_zangyo: r.固定残業手当 ?? 0, shikaku_teate: r.資格手当 ?? 0,
  // 単価: 総括表の値 → 無ければ 逆算・近い月の値 → それも無ければ 0 (列が NOT NULL。計算は空を 0 と同じに扱う)
  kotei: r.勤続_固定 ?? 0, tokutei_shogu: r.特定処遇改善 ?? 0, kaigo_rate: rateOf.get(r)?.k ?? 0, shien_rate: rateOf.get(r)?.s ?? r.予防単価 ?? 0,
  // ケアプラン固定が空: 月給の社員 (本人給 > 0) は その月のブックに欄が無かっただけ (姉崎ムツミ 2026-01〜08 など。
  //   プラン手当は 粗額 − (本人給+職能給+固定残業) で払われていた) → その合計を固定とする。
  //   時給のケアマネ (本人給 0) は 0 = ケアプランの額を全額払う (総括表の実際の運用。2026-09 の新しいブックも 固定 0 で全額。
  //   user 2026-10-19 に「払わない」→ 実データを見て「固定 0 = 全額」に訂正して OK)
  care_plan_fixed: r.ケアプラン固定 ?? ((r.本人給 ?? 0) > 0 ? (r.本人給 ?? 0) + (r.職能給 ?? 0) + (r.固定残業手当 ?? 0) : 0),
  position_allowance: r.役職手当 ?? 0,
  // 勤続手当対象の欄が無いブック (姉崎ムツミ 2026-01〜08) でも 件数分 (勤続_変動) が払われていれば 型 2 (2026-10-19)
  kinzoku_type: r.勤続手当対象 === 2 || (r.勤続手当対象 == null && (r.勤続_変動 ?? 0) > 0) ? 2 : r.勤続手当対象 === 1 ? 1 : null, kinzoku_unit: r.勤続手当単価 ?? null, kinzoku_care_unit: r.勤続手当介護単価 ?? null,
  ...personWide.get(p)!,
});
type Plan = { p: Person; effective_from: string; v: ReturnType<typeof val>; overwrite: boolean };
const salaryPlans: Plan[] = [];
for (const p of people.values()) {
  const months = [...p.months].sort((a, b) => a.file_month.localeCompare(b.file_month));
  let prev = "";
  for (const m of months) {
    const v = val(m, p); const key = JSON.stringify(v);
    if (key === prev) continue;
    prev = key;
    salaryPlans.push({ p, effective_from: `${m.file_month.slice(0, 4)}-${m.file_month.slice(4)}-01`, v, overwrite: false });
  }
}
const willExist = (p: Person) => !!findEmp(p) || toRegister.includes(p);
const skippedSalary = salaryPlans.filter((s) => !willExist(s.p));
const doSalary = salaryPlans.filter((s) => willExist(s.p));
for (const s of doSalary) { const e = findEmp(s.p); s.overwrite = !!e && salary.some((x) => x.employee_id === e.id && x.effective_from === s.effective_from); }
console.log(`\n② 給与設定の行 ${doSalary.length} 行 (${new Set(doSalary.map((s) => s.p)).size} 人。うち 同じ適用開始月を上書き ${doSalary.filter((s) => s.overwrite).length}) / 職員がいないので入れない ${skippedSalary.length} 行`);
const inferred = [...rateOf].filter(([m]) => m.介護単価 == null);
console.log(`  単価を逆算・補った月 ${inferred.length} (${[...new Set(inferred.map(([m]) => m.office))].join(", ")}): ${[...new Set(inferred.map(([m, v]) => `${cleanName(m.name)} ${v.k}`))].join(" / ")}`);
for (const s of doSalary.slice(0, 8)) console.log(`  ${s.p.officeNumber} ${s.p.no} ${s.p.name} ${s.effective_from}〜 本人給 ${s.v.honnin_kyu} 職能給 ${s.v.shokuno_kyu} 固定残業 ${s.v.kotei_zangyo} 資格 ${s.v.shikaku_teate} 勤続 ${s.v.kotei} 特定 ${s.v.tokutei_shogu} 単価 ${s.v.kaigo_rate ?? "空"}/${s.v.shien_rate ?? "空"} プラン固定 ${s.v.care_plan_fixed ?? "空"}`);
const wide = [...personWide].filter(([p, w]) => willExist(p) && (w.guarantee_until || w.commute_cap));
console.log(`  保障あり ${wide.filter(([, w]) => w.guarantee_until).length} 人: ${wide.filter(([, w]) => w.guarantee_until).map(([p, w]) => `${p.name} ${w.guarantee_until?.slice(0, 7)}まで`).join(" / ")}`);
console.log(`  通勤費の上限 25000 ${wide.filter(([, w]) => w.commute_cap).length} 人: ${wide.filter(([, w]) => w.commute_cap).map(([p]) => p.name).join(" / ")}`);
console.log(`  ケアプラン固定が空 (= ケアプランの額を払わない) の人 (0 人のはず): ${[...new Set(doSalary.filter((x) => x.v.care_plan_fixed == null).map((x) => x.p.name))].join(" / ")}`);
console.log(`  件数で決まる勤続手当 (型 2) の人: ${[...new Set(doSalary.filter((x) => x.v.kinzoku_type === 2).map((x) => `${x.p.name}(${x.v.kinzoku_unit ?? "?"}円)`))].join(" / ")}`);
const names = new Map<string, string>(); for (const p of people.values()) { const e = findEmp(p); if (e && nm(e.name) !== nm(p.name)) names.set(`${p.officeNumber} ${e.name}`, p.name); }
if (names.size) console.log(`\n⚠ 職員一覧と総括表で 氏名の字が違う (社員番号で結び付けた): ${[...names].map(([a, b]) => `${a} / 総括表 ${b}`).join(" ; ")}`);
if (!EXECUTE) { console.log("\nDRY RUN。書き込むときは --execute"); process.exit(0); }

const env: Record<string, string> = {};
for (const f of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" };
const base = env.NEXT_PUBLIC_SUPABASE_URL + "/rest/v1";
if (toRegister.length) {
  const payload = toRegister.map((p) => {
    const last = [...p.months].sort((a, b) => a.file_month.localeCompare(b.file_month)).at(-1)!;
    const monthly = (last.本人給 ?? 0) > 0;
    return { employee_number: p.no || nm(p.name), name: p.name, address: "", office_id: officeId.get(p.officeNumber), employment_status: "在職者", effective_service_months: 0,
      job_type: "居宅介護支援", role_type: monthly ? "社員" : "パート", salary_type: monthly ? "月給" : "時給", transport_type: "車",
      has_care_qualification: false, social_insurance: false, paid_leave_unit_price: 0, communication_fee_type: "none" };
  });
  const r = await fetch(`${base}/payroll_employees`, { method: "POST", headers: H, body: JSON.stringify(payload) });
  if (!r.ok) { console.error(`職員登録に失敗: ${r.status} ${await r.text()}`); process.exit(1); }
  emps.push(...(await r.json() as typeof emps));
  console.log(`職員登録 ${payload.length} 人`);
}
const salPayload = doSalary.map((s) => ({ tenant_id: "kt-group", employee_id: findEmp(s.p)!.id, effective_from: s.effective_from, ...s.v }));
let ok = 0; const fails: string[] = [];
for (let i = 0; i < salPayload.length; i += 300) {
  const r = await fetch(`${base}/payroll_kyotaku_salary?on_conflict=employee_id,effective_from`, {
    method: "POST", headers: { ...H, Prefer: "return=minimal,resolution=merge-duplicates" }, body: JSON.stringify(salPayload.slice(i, i + 300)),
  });
  if (!r.ok) fails.push(`${i}: ${r.status} ${(await r.text()).slice(0, 200)}`); else ok += Math.min(300, salPayload.length - i);
}
console.log(`給与設定 ${ok} 行 / 失敗 ${fails.length}`);
for (const f of fails) console.log("  ✗ " + f);
const after = await restAll<{ employee_id: string; effective_from: string }>("payroll_kyotaku_salary?select=id,employee_id,effective_from");
const have = new Set(after.map((x) => `${x.employee_id}|${x.effective_from}`));
console.log(`確認: 入れた行のうち DB にある ${salPayload.filter((x) => have.has(`${x.employee_id}|${x.effective_from}`)).length}/${salPayload.length}`);
if (fails.length) process.exit(1);
