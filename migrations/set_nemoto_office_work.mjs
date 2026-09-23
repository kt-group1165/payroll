/**
 * 五井 根本カオリ の事務時間と事務時給を入れる (2026-09-23)。
 *
 *   node migrations/set_nemoto_office_work.mjs            # DRY RUN
 *   node migrations/set_nemoto_office_work.mjs --execute
 *
 * 事務員の本人給 = 出勤簿の出勤時間 × 事務時給。根本さんは **出勤簿が CSV で取り込めない**ので 0 円だった
 * (3〜8月で ① ② とも 88,588〜106,950 円/月・計 ¥457,757)。
 *
 * 出勤簿は Box のスキャン PDF にある (テキスト層なし・画像)。
 *   Box/10F内共有/02_共有/10_給与/02_スキャン/Ｋ06　五井/KT五井　R8/五井　R8.<月>/R8.<月>　五井　ﾊﾟｰﾄ.pdf
 *   根本さんのページ: R8.3 p112 / R8.4 p93 / R8.5 p103 / R8.6 p98 / R8.7 p85 (月ごとにページ数が違う)
 *
 * ⚠ **手書きの訂正が入っている**。印字だけ読むと 4月 −7:48 / 7月 −4:00 ずれる。
 *   ① の事務 ÷ 1,150 円/時 と突き合わせて 手書きが正だと確認した:
 * ```
 *   3月  76:02 (印字のまま)                    ① に事務の行なし
 *   4月  69:14 を打ち消して 77:02              88,588 ÷ 1,150 = 77.03h  ★一致
 *   5月  93:00 (印字のまま)                   106,950 ÷ 1,150 = 93.0h   ★一致
 *   6月  64:06 の残業 0:06 を打ち消して 64:00  73,600 ÷ 1,150 = 64.0h   ★一致
 *   7月  76:00 を打ち消して 80:00              92,000 ÷ 1,150 = 80.0h   ★一致
 * ```
 * 冪等: 既に同じ値なら触らない。
 */
const EXECUTE = process.argv.includes("--execute");
const OFFICE_NUMBER = "1272401967";   // ＫＴ五井ヘルパーステーション
const EMP = "231106";                 // 根本 カオリ
const RATE = 1150;                    // 事務時給 (① の事務 ÷ 時間 が全月 1,150)
/** 処理月 → 事務時間 (分)。手書きの訂正を採用した値 */
const MINUTES = {
  "202603": 76 * 60 + 2,
  "202604": 77 * 60 + 2,
  "202605": 93 * 60,
  "202606": 64 * 60,
  "202607": 80 * 60,
};

import { readFileSync } from "node:fs";
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

const offs = await get(`payroll_offices?select=id&office_number=eq.${OFFICE_NUMBER}`);
if (offs.length !== 1) { console.error("★ 事業所が見つからない"); process.exit(1); }
const emps = (await get(`payroll_employees?select=id,name,office_id,is_office_worker&employee_number=eq.${EMP}`)).filter((e) => e.office_id === offs[0].id);
if (emps.length !== 1) { console.error(`★ 職員が ${emps.length} 件`); process.exit(1); }
const emp = emps[0];
if (!emp.name.includes("根本")) { console.error(`★ 名前が違う: ${emp.name}`); process.exit(1); }

// 事務時給 (給与設定の一番古い行に入れる)
const rows = (await get(`payroll_salary_settings?select=id,effective_from,office_work_hourly_rate&employee_id=eq.${emp.id}&order=effective_from`));
const rateOps = [];
for (const r of rows) {
  if (Number(r.office_work_hourly_rate ?? 0) === RATE) continue;
  if (Number(r.office_work_hourly_rate ?? 0) > 0) { console.log(`  ★ ${r.effective_from} に既に ${r.office_work_hourly_rate} 円が入っています (上書きしません)`); continue; }
  rateOps.push({ id: r.id, label: `事務時給 ${r.effective_from}〜 → ${RATE} 円/時` });
}

// 事務時間 (月ごとの手入力)
const exist = await get(`payroll_monthly_inputs?select=processing_month,numeric_value&office_number=eq.${OFFICE_NUMBER}&employee_number=eq.${EMP}&item_key=eq.office_work_minutes`);
const already = new Map(exist.map((r) => [r.processing_month, Number(r.numeric_value ?? 0)]));
const minOps = [];
for (const [M, min] of Object.entries(MINUTES)) {
  if (already.get(M) === min) continue;
  minOps.push({ office_number: OFFICE_NUMBER, employee_number: EMP, processing_month: M, item_key: "office_work_minutes", numeric_value: min,
    note: "出勤簿 (Box のスキャンPDF) より。手書きの訂正を採用。本稼働後は出勤簿から 2026-09-23",
    label: `${M} ${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")} (${min}分) → ${(Math.round(min / 60 * RATE)).toLocaleString()} 円` });
}

console.log(`=== 五井 根本カオリ (${emp.name}) の事務 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log(`  事務員フラグ: ${emp.is_office_worker ? "あり" : "★ 無し (事務の本人給は出ない)"}`);
for (const o of rateOps) console.log("  " + o.label);
for (const o of minOps) console.log("  " + o.label);
if (!EXECUTE || (rateOps.length === 0 && minOps.length === 0)) { console.log("DRY RUN。--execute で書き込みます"); process.exit(0); }
for (const o of rateOps) {
  const res = await fetch(`${SB_URL}/rest/v1/payroll_salary_settings?id=eq.${o.id}`, {
    method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify({ office_work_hourly_rate: RATE }) });
  const b = await res.json();
  if (!res.ok || !Array.isArray(b) || b.length !== 1) { console.error("★ 事務時給の書き込みに失敗:", b); process.exit(1); }
}
if (minOps.length > 0) {
  const body = minOps.map(({ label, ...r }) => { void label; return r; });
  const res = await fetch(`${SB_URL}/rest/v1/payroll_monthly_inputs?on_conflict=office_number,employee_number,processing_month,item_key`, {
    method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body) });
  const b = await res.json();
  if (!res.ok || !Array.isArray(b) || b.length !== body.length) { console.error("★ 事務時間の書き込みに失敗:", b); process.exit(1); }
}
console.log(`  反映 事務時給 ${rateOps.length} 行 / 事務時間 ${minOps.length} 件`);
