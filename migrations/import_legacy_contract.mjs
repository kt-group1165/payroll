/**
 * 旧システムの「従業員契約情報データ」CSV を取り込む (2026-09-21)。前提 SQL: migrations/payroll_legacy_contract.sql
 *
 *   node migrations/import_legacy_contract.mjs            # DRY RUN
 *   node migrations/import_legacy_contract.mjs --execute
 *   SRC=<dir> node migrations/import_legacy_contract.mjs  # 置き場を変えるとき
 *
 * 出し方: 旧システム → データ出力 → 「従業員契約情報データダウンロード」→ 事業所を選ぶ → ダウンロード
 *   ★ 月の指定は無い (= 今の設定が出る)。事業所ごとに 1 本、訪問介護は 23 事業所。
 *   ファイル名は `従業員契約情報データ_<DL日>.csv` 固定で事業所が入らないが、中の「事業所コード」で判別できる。
 * 置き場: Box\10F内共有\ほのぼのから出力\
 *
 * なぜ: 給与のルール (育児手当の上限・割合、出張費単価、通勤費の有無、通信手当、固定残業 …) が
 *   職員ごとに違うのに、当方は事業所単位の設定しか持っていなかった。
 * 冪等: (office_number, employee_number) で upsert。
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
const num = (s) => { const v = String(s ?? "").replace(/,/g, "").trim(); return v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null); };
const txt = (s) => { const v = String(s ?? "").trim(); return v === "" ? null : v; };

/** CSV 列名 → テーブル列 */
const MAP = {
  employee_name: ["氏名", txt], job_type: ["職種①", txt], position: ["役職①", txt],
  scheduled_work_hours: ["所定労働時間", num], work_hours_method: ["出勤時間の算出方法", txt],
  overtime_mode: ["残業計算区分", txt], weekly40_overtime_mode: ["週40時間超残業計算区分", txt],
  week_start_day: ["週の起算曜日", txt], half_leave_threshold_h: ["半休判断時間", num],
  late_early_mode: ["遅刻早退計算", txt], travel_method: ["移動手段", txt],
  base_hourly_rate: ["基本時給", num], personal_salary: ["本人給", num], skill_salary: ["職能給", num],
  position_allowance: ["役職手当", num], qualification_allowance: ["資格手当", num],
  other_allowance: ["その他手当", num], fixed_overtime_pay: ["固定残業手当", num],
  adjustment_allowance: ["調整手当", num],
  treatment_unit_kind: ["処遇改善加算手当（単価種別）", txt], treatment_unit_price: ["処遇改善加算手当（単価）", num],
  treatment_subsidy: ["処遇改善補助金手当", num],
  commute_method: ["通勤費算方法", txt], commute_unit_price: ["通勤費単価", num],
  business_trip_method: ["出張費算方法", txt], business_trip_unit_price: ["出張費単価", num],
  communication_method: ["通信手当算方法", txt], fixed_communication_fee: ["固定通信費", num],
  childcare_method: ["育児手当計算方法", txt], childcare_rate_pct: ["育児手当指定割合", num],
  childcare_limit: ["育児手当支給限度額", num],
};

const files = readdirSync(SRC).filter((f) => /^従業員契約情報データ_\d{8}.*\.csv$/i.test(f));
if (files.length === 0) { console.error(`✗ 対象 CSV が 1 本も無い: ${SRC}`); process.exit(1); }

const byKey = new Map();
let dup = 0;
const conflicts = [];
for (const f of files.sort()) {
  const lines = dec.decode(readFileSync(join(SRC, f))).split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(",").map((x) => x.replace(/^"|"$/g, ""));
  for (const [, [jp]] of Object.entries(MAP)) {
    if (!head.includes(jp)) { console.error(`✗ ${f}: 列「${jp}」が無い (出力設定が違う可能性)`); process.exit(1); }
  }
  const iOff = head.indexOf("事業所コード"), iEmp = head.indexOf("従業員コード");
  if (iOff < 0 || iEmp < 0) { console.error(`✗ ${f}: 事業所コード / 従業員コード が無い`); process.exit(1); }
  for (const l of lines.slice(1)) {
    const c = l.split('","').map((x) => x.replace(/^"|"$/g, ""));
    const office = c[iOff]?.trim();
    const emp = nn(c[iEmp]);
    if (!office || !emp) continue;
    const raw = {};
    head.forEach((h, i) => { if (h) raw[h] = c[i] ?? ""; });
    const row = { office_number: office, employee_number: emp, raw, source_file: f };
    for (const [col, [jp, conv]] of Object.entries(MAP)) row[col] = conv(c[head.indexOf(jp)]);
    const k = `${office}|${emp}`;
    const prev = byKey.get(k);
    if (prev) {
      dup++;
      if (JSON.stringify(prev.raw) !== JSON.stringify(row.raw)) conflicts.push(`${k}: ${prev.source_file} と ${f} で内容が違う`);
      continue;
    }
    byKey.set(k, row);
  }
}
if (conflicts.length) {
  console.error(`✗ 同じ (事業所, 社員番号) で内容の違う行が ${conflicts.length} 件。どちらが正か決められないので止める`);
  for (const c of conflicts.slice(0, 10)) console.error("  ", c);
  process.exit(2);
}

const rows = [...byKey.values()];
console.log(`CSV ${files.length} 本 / 取込対象 ${rows.length} 名 (重複 ${dup})`);
console.log(`  事業所 ${new Set(rows.map((r) => r.office_number)).size}`);
const tally = (col) => {
  const m = new Map();
  for (const r of rows) m.set(r[col] ?? "(空)", (m.get(r[col] ?? "(空)") ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" / ");
};
for (const col of ["work_hours_method", "childcare_method", "childcare_limit", "commute_method", "communication_method", "treatment_unit_kind"]) {
  console.log(`  ${col}: ${tally(col)}`);
}

if (!EXECUTE) { console.log("\nDRY RUN (--execute で書き込み)"); process.exit(0); }

for (let i = 0; i < rows.length; i += 200) {
  const res = await fetch(`${SB}payroll_legacy_contract?on_conflict=office_number,employee_number`, {
    method: "POST",
    headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows.slice(i, i + 200)),
  });
  if (!res.ok) { console.error(`✗ 書き込み失敗 (${i}名目〜): ${await res.text()}`); process.exit(1); }
}
console.log(`完了 ${rows.length} 名`);
