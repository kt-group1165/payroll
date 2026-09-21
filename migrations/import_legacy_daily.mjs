/**
 * 旧システムの「従業員日別データ」CSV を取り込む (2026-09-21)。前提 SQL: migrations/payroll_legacy_daily.sql
 *
 *   node migrations/import_legacy_daily.mjs            # DRY RUN
 *   node migrations/import_legacy_daily.mjs --execute
 *
 * 出し方: 旧システム → 集計データ出力 → 従業員日別データ出力
 *   事業所 = 会社だけ選ぶ (事業所は空欄でその会社の全事業所が出る) / 指定月 = YYYY/MM
 *   従業員出力情報にチェック: 事業所番号・在職区分・勤続月数・職種・給与形態
 *   出力データにチェック: 訪問時間 実績時間 同行時間 夜朝時間 深夜時間 移動時間 移動手当時間
 *     勤務時間 残業時間 深夜残業時間 法定休日残業時間 法内残業時間 休憩時間 遅刻早退時間
 *     訪問件数 出張km 通勤km 勤務摘要
 *   ★ ファイル名は `従業員日別データ_<DL日>.csv` 固定で 会社も月も入らない。
 *     中身の「会社名」「年月日」で判別できるので リネームは不要。
 *
 * なぜ: 出勤簿・事業所書式が当方に無い月がある。出勤時間・残業・出張km・通勤km の
 *   確定値がここにあり、当方の推定より総括表に近い (出勤簿なしの人: 時給 60.1%→87.3% / 月給 44.9%→69.1%)。
 * 冪等: (work_date, office_number, employee_number) で upsert。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const EXECUTE = process.argv.includes("--execute");
const SRC = process.env.SRC || join(process.env.USERPROFILE || "", "Box", "10F内共有", "ほのぼのから出力");

const env = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL + "/rest/v1/";
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };

if (!existsSync(SRC)) { console.error(`✗ 置き場が無い: ${SRC}`); process.exit(1); }

const dec = new TextDecoder("shift_jis");
const nn = (s) => String(s ?? "").trim().replace(/^0+/, "");
const txt = (s) => { const v = String(s ?? "").trim(); return v === "" ? null : v; };
const int = (s) => { const v = String(s ?? "").replace(/,/g, "").trim(); return v === "" ? null : (Number.isFinite(+v) ? Math.round(+v) : null); };
/**
 * km は **カンマが小数点**。桁区切りも同じカンマなので 最後のカンマだけを小数点にする。
 *   '33,600' = 33.6km / '1,238,000' = 1238km / '700,000' = 700km
 * ⚠ 素直に カンマを消すと 33,600 が 33600km になる (2026-09-21 に踏んだ)
 */
const km = (s) => {
  const v = String(s ?? "").trim();
  if (v === "") return null;
  const parts = v.split(",");
  const n = parts.length === 1 ? +v : +(parts.slice(0, -1).join("") + "." + parts[parts.length - 1]);
  return Number.isFinite(n) ? n : null;
};
/** "HH:MM" → 分。空は null。⚠ 24h を超える値 (48:30 など) もあるので時は上限を設けない */
const hm = (s) => {
  const v = String(s ?? "").trim();
  if (v === "") return null;
  const m = /^(\d+):(\d{1,2})$/.exec(v);
  if (!m) return Number.isFinite(+v) ? Math.round(+v * 60) : null;
  return (+m[1]) * 60 + (+m[2]);
};

/** CSV 列名 → テーブル列 */
const MAP = {
  company_name: ["会社名", txt], office_number: ["事業所番号", txt], office_name: ["事業所名", txt],
  employee_name: ["氏名", txt], employment_status: ["在職区分", txt], tenure_months: ["勤続月数", int],
  job_type: ["職種", txt], pay_type: ["給与形態", txt],
  visit_min: ["訪問時間", hm], actual_min: ["実績時間", hm], accompany_min: ["同行時間", hm],
  evening_min: ["夜朝時間", hm], midnight_min: ["深夜時間", hm], travel_min: ["移動時間", hm],
  travel_paid_min: ["移動手当時間", hm], work_min: ["勤務時間", hm], overtime_min: ["残業時間", hm],
  midnight_ot_min: ["深夜残業時間", hm], holiday_ot_min: ["法定休日残業時間", hm],
  legal_within_ot_min: ["法内残業時間", hm], break_min: ["休憩時間", hm], late_early_min: ["遅刻早退時間", hm],
  visit_count: ["訪問件数", int], business_km: ["出張ｋｍ", km], commute_km: ["通勤ｋｍ", km],
  work_note: ["勤務摘要", txt],
};

const files = readdirSync(SRC).filter((f) => /^従業員日別データ_\d{8}.*\.csv$/i.test(f));
if (files.length === 0) { console.error(`✗ 対象 CSV が 1 本も無い: ${SRC}`); process.exit(1); }

const byKey = new Map();
const conflicts = [];
let dup = 0;
const months = new Map();
for (const f of files.sort()) {
  const lines = dec.decode(readFileSync(join(SRC, f))).split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(",").map((x) => x.replace(/^"|"$/g, ""));
  for (const [, [jp]] of Object.entries(MAP)) {
    if (!head.includes(jp)) { console.error(`✗ ${f}: 列「${jp}」が無い (出力のチェックが違う可能性)`); process.exit(1); }
  }
  const iD = head.indexOf("年月日"), iE = head.indexOf("従業員コード");
  if (iD < 0 || iE < 0) { console.error(`✗ ${f}: 年月日 / 従業員コード が無い`); process.exit(1); }
  for (const l of lines.slice(1)) {
    const c = l.split('","').map((x) => x.replace(/^"|"$/g, ""));
    const d = /^(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(String(c[iD] ?? "").trim());
    const emp = nn(c[iE]);
    if (!d || !emp) continue;
    const work_date = `${d[1]}-${String(+d[2]).padStart(2, "0")}-${String(+d[3]).padStart(2, "0")}`;
    const processing_month = `${d[1]}${String(+d[2]).padStart(2, "0")}`;
    const row = { work_date, processing_month, employee_number: emp, source_file: f };
    for (const [col, [jp, conv]] of Object.entries(MAP)) row[col] = conv(c[head.indexOf(jp)]);
    if (!row.office_number) continue;
    months.set(`${row.company_name}|${processing_month}`, (months.get(`${row.company_name}|${processing_month}`) ?? 0) + 1);
    const k = `${work_date}|${row.office_number}|${emp}`;
    const prev = byKey.get(k);
    if (prev) {
      dup++;
      const a = { ...prev, source_file: 0 }, b = { ...row, source_file: 0 };
      if (JSON.stringify(a) !== JSON.stringify(b)) conflicts.push(`${k}: ${prev.source_file} と ${f} で内容が違う`);
      continue;
    }
    byKey.set(k, row);
  }
}
if (conflicts.length) {
  console.error(`✗ 同じ (日付, 事業所, 社員No) で内容の違う行が ${conflicts.length} 件。どちらが正か決められないので止める`);
  for (const c of conflicts.slice(0, 10)) console.error("  ", c);
  process.exit(2);
}

const rows = [...byKey.values()];
console.log(`CSV ${files.length} 本 / 取込対象 ${rows.length} 行 (重複 ${dup} は内容一致で捨てた)`);
console.log(`  事業所 ${new Set(rows.map((r) => r.office_number)).size} / 職員 ${new Set(rows.map((r) => r.office_number + "|" + r.employee_number)).size}`);
const mm = [...new Set(rows.map((r) => r.processing_month))].sort();
console.log(`  処理月 ${mm.join(" ")}`);
console.log(`  勤務時間あり ${rows.filter((r) => r.work_min).length} / 出張km あり ${rows.filter((r) => r.business_km).length} / 通勤km あり ${rows.filter((r) => r.commute_km).length}`);

if (!EXECUTE) { console.log("\nDRY RUN (--execute で書き込み)"); process.exit(0); }

for (let i = 0; i < rows.length; i += 500) {
  const res = await fetch(`${SB}payroll_legacy_daily?on_conflict=work_date,office_number,employee_number`, {
    method: "POST",
    headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows.slice(i, i + 500)),
  });
  if (!res.ok) { console.error(`✗ 書き込み失敗 (${i}行目〜): ${await res.text()}`); process.exit(1); }
  if (i % 10000 === 0) console.log(`  ${i} / ${rows.length}`);
}
console.log(`完了 ${rows.length} 行`);
