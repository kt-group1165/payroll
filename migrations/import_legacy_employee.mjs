/**
 * 旧システムの「従業員データ」CSV から 勤続月数の基準値と入社日を取り込む (2026-09-21)。
 * 前提 SQL: migrations/payroll_legacy_employee.sql
 *
 *   node migrations/import_legacy_employee.mjs            # DRY RUN
 *   node migrations/import_legacy_employee.mjs --execute
 *
 * 出し方: 旧システム → データダウンロード → 「従業員データダウンロード」→ 会社を選ぶ (事業所は空でよい)
 *   ★ 月の指定は無い。出力日時点の値が出る。今回は 2026-09-21 に出したもので、
 *     中の「事業所/会社/グループ勤続年数」は **月数** で、**2026-08 時点** の値だった。
 *     (総括表 2026-03〜07 のパート 575 人月で検算: グループ 563 一致 97.9% / 会社 97.7% / 事業所 96.9%。
 *      入社年月日から暦月で数えると 86.6% にしかならない = 転籍前が入社日に反映されていないため)
 *
 * ⚠ 社員No は事業所をまたぐと重複する (4089 = 花見川 松元綾子 / 高品 松元綾子 で入社日が別、
 *   523 = 五井 石本美幸 / ムツミ 鎗水眞佐子)。必ず (所属名, 社員No) で扱う。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const EXECUTE = process.argv.includes("--execute");
const SRC = process.env.SRC || join(process.env.USERPROFILE || "", "Box", "10F内共有", "ほのぼのから出力");
/** 勤続月数が「いつ時点の値か」。CSV に月の指定が無いので ここで宣言して持つ */
const TENURE_AS_OF = process.env.TENURE_AS_OF || "202608";

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
const int = (s) => { const v = String(s ?? "").trim(); return v === "" ? null : (Number.isInteger(+v) ? +v : null); };
const date = (s) => { const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(String(s ?? "").trim()); return m ? `${m[1]}-${String(+m[2]).padStart(2, "0")}-${String(+m[3]).padStart(2, "0")}` : null; };

const files = readdirSync(SRC).filter((f) => /^従業員データ_\d{8}.*\.csv$/i.test(f));
if (files.length === 0) { console.error(`✗ 対象 CSV が無い: ${SRC}`); process.exit(1); }

const NEED = ["社員No", "氏名", "在職区分", "支払形態", "入社年月日", "退職年月日", "事業所勤続年数", "会社勤続年数", "グループ勤続年数", "所属名", "職種", "休職事由"];
const byKey = new Map();
const conflicts = [];
for (const f of files.sort()) {
  const lines = dec.decode(readFileSync(join(SRC, f))).split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(",").map((x) => x.replace(/^"|"$/g, ""));
  for (const n of NEED) if (!head.includes(n)) { console.error(`✗ ${f}: 列「${n}」が無い`); process.exit(1); }
  const at = (c, n) => c[head.indexOf(n)];
  for (const l of lines.slice(1)) {
    const c = l.split('","').map((x) => x.replace(/^"|"$/g, ""));
    const office = txt(at(c, "所属名")), emp = nn(at(c, "社員No"));
    if (!office || !emp) continue;
    const row = {
      office_name: office, employee_number: emp, employee_name: txt(at(c, "氏名")),
      employment_status: txt(at(c, "在職区分")), pay_type: txt(at(c, "支払形態")),
      hire_date: date(at(c, "入社年月日")), quit_date: date(at(c, "退職年月日")),
      office_tenure_months: int(at(c, "事業所勤続年数")), company_tenure_months: int(at(c, "会社勤続年数")),
      group_tenure_months: int(at(c, "グループ勤続年数")), job_type: txt(at(c, "職種")),
      leave_reason: txt(at(c, "休職事由")), tenure_as_of: TENURE_AS_OF, source_file: f,
    };
    const k = `${office}|${emp}`;
    const prev = byKey.get(k);
    if (prev) {
      if (JSON.stringify({ ...prev, source_file: 0 }) !== JSON.stringify({ ...row, source_file: 0 })) conflicts.push(`${k}: ${prev.source_file} と ${f} で内容が違う`);
      continue;
    }
    byKey.set(k, row);
  }
}
if (conflicts.length) {
  console.error(`✗ 同じ (所属名, 社員No) で内容の違う行が ${conflicts.length} 件。どちらが正か決められないので止める`);
  for (const c of conflicts.slice(0, 10)) console.error("  ", c);
  process.exit(2);
}

const rows = [...byKey.values()];
console.log(`CSV ${files.length} 本 / ${rows.length} 名 (勤続月数は ${TENURE_AS_OF} 時点)`);
console.log(`  事業所 ${new Set(rows.map((r) => r.office_name)).size} / 在職 ${rows.filter((r) => r.employment_status === "在職者").length} / 退職 ${rows.filter((r) => r.employment_status !== "在職者").length}`);
console.log(`  グループ勤続月数あり ${rows.filter((r) => r.group_tenure_months != null).length} / 入社日あり ${rows.filter((r) => r.hire_date).length}`);
const dup = rows.filter((r) => rows.filter((x) => x.employee_number === r.employee_number).length > 1);
console.log(`  ⚠ 事業所をまたいで 社員No が重複する行 ${dup.length} (必ず 所属名 と対で使う)`);

if (!EXECUTE) { console.log("\nDRY RUN (--execute で書き込み)"); process.exit(0); }

for (let i = 0; i < rows.length; i += 200) {
  const res = await fetch(`${SB}payroll_legacy_employee?on_conflict=office_name,employee_number`, {
    method: "POST",
    headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows.slice(i, i + 200)),
  });
  if (!res.ok) { console.error(`✗ 書き込み失敗 (${i}件目〜): ${await res.text()}`); process.exit(1); }
}
console.log(`完了 ${rows.length} 名`);
