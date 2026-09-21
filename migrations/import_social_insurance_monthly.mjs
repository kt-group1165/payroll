/**
 * 社会保険の加入を 月ごとに入れる (payroll_monthly_inputs item_key=social_insurance)。2026-09-21
 *
 *   SP=<総括表のある作業ディレクトリ> node migrations/import_social_insurance_monthly.mjs            # DRY RUN
 *   SP=... node migrations/import_social_insurance_monthly.mjs --execute
 *
 * なぜ: 社保の加入は月で変わる (高品 中村美果 03-05 加入 / 06-07 非加入、
 *   袖ケ浦 池田麻美 03-04 加入 / 05-07 非加入)。職員マスタは 1 人 1 値しか持てない。
 *   月ごとの仕組みは既にある (payroll_monthly_inputs social_insurance) ので、そこに入れる。
 *
 * 出どころ: 総括表 xlsm の「総括表データ_パート」シートの **処遇改善補助金手当が出ているか**。
 *   ⚠ 印字シートの「社会保険」列ではない。★ 列と補助金は一致しない
 *     (2026-09-21 実測 1,989/2,072 = 96.0%。食い違い 83 人月 / 30 名)。
 *     例) 高品 菊池亜希 列1だが補助金なし / さつき 滝下恵子 列0だが補助金あり
 *     scripts/sync-master-from-soukatsu.mts が 先に同じ結論に達していた
 *     (「社保 (= 処遇改善補助金の対象) は 補助金が出ているかで決める」)。
 *   ⚠ ここで入れる社保フラグが効くのは 処遇改善補助金手当と通信手当。
 *     ★ 金額に直結するので 列ではなく 金額の実績から取る。
 *
 * 給与計算での使われ方: 処遇改善補助金手当 (訪問介護 × 社保加入 × 当月実績あり → 事業所単価 ¥20,000)
 *   と 通信手当の判定。
 * 冪等: (office_number, employee_number, processing_month, item_key) で upsert。
 */
import ExcelJS from "exceljs";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const EXECUTE = process.argv.includes("--execute");
const S = process.env.SP;
if (!S) { console.error("✗ SP に 総括表 (soukatsu<YYYYMM>/extract.json) のある作業ディレクトリを渡してください"); process.exit(1); }
const MONTHS = (process.env.MONTHS || "202603,202604,202605,202606,202607").split(",");
const OFFNUM = { "04_おゆみ野": "1270501180", "06_さつき": "1270203191", "02_花見川": "1270201930", "05_高品": "1270402116", "11_Hana四街道": "1270303173", "06_Hana中央": "1270105271", "04_Hana船橋": "1270906546", "10_Hana八千代": "1272603851", "03_やわた": "1272404508", "03_五井": "1272401967", "01_KT姉崎": "1272400142", "05_Hanaちはら台": "1272403534", "01_姉崎ムツミ": "1272400829", "リンクス茂原": "1271500942", "08_いすみ": "1278600398", "09_山武": "1279000366", "リンクス大網": "1275800892", "03_木更津ムツミ": "1271101295", "02_市原ムツミ": "1272401561", "07_袖ケ浦": "1273400844", "14_君津": "1273001626", "13_東郷": "1271502518", "04_いわね": "1271502500" };

const env = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL + "/rest/v1/";
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
async function all(q) {
  const out = [];
  for (let o = 0; ; o += 1000) {
    const r = await fetch(`${SB}${q}&order=id&limit=1000&offset=${o}`, { headers: H });
    if (!r.ok) throw new Error(`${q} → ${await r.text()}`);
    const j = await r.json(); out.push(...j);
    if (j.length < 1000) break;
  }
  return out;
}
const nn = (s) => String(s ?? "").trim().replace(/^0+/, "");

const po = await all("payroll_offices?select=id,office_number");
const byId = new Map(po.map((o) => [o.id, o.office_number]));
const emp = new Map();
for (const e of await all("payroll_employees?select=id,employee_number,name,office_id,social_insurance")) {
  const on = byId.get(e.office_id);
  if (on) emp.set(`${on}|${nn(e.employee_number)}`, e);
}
const have = new Map();
for (const r of await all("payroll_monthly_inputs?item_key=eq.social_insurance&select=id,office_number,employee_number,processing_month,numeric_value"))
  have.set(`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, Number(r.numeric_value ?? 0) > 0);

const cell = (v) => { const x = (v && typeof v === "object" && "result" in v) ? v.result : v; const n = Number(x); return Number.isFinite(n) ? n : 0; };
const rows = [];
let seen = 0, same = 0, noEmp = 0, noSheet = 0;
for (const m of MONTHS) {
  const root = join(S, `soukatsu${m}`);
  if (!existsSync(root)) { console.warn(`⚠ 総括表が無い: ${root}`); continue; }
  for (const corp of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()))
  for (const off of readdirSync(join(root, corp.name), { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const onum = OFFNUM[off.name];
    if (!onum) continue;
    for (const file of readdirSync(join(root, corp.name, off.name)).filter((x) => /_パート_\d{6}\.xlsm$/.test(x))) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(join(root, corp.name, off.name, file));
      const ws = wb.worksheets.find((w) => /^総括表データ_パート/.test(w.name));
      if (!ws) { noSheet++; continue; }
      const head = ws.getRow(1).values;
      const cols = {};
      head.forEach((x, i) => { const k = String(x ?? "").trim(); if (k && !(k in cols)) cols[k] = i; });
      if (!cols["従業員コード"] || !cols["処遇改善補助金手当"]) { noSheet++; continue; }
      for (let r = 2; r <= ws.rowCount; r++) {
        const v = ws.getRow(r).values;
        const num = nn(v[cols["従業員コード"]]);
        if (!num) continue;
        if (!emp.has(`${onum}|${num}`)) { noEmp++; continue; }
        seen++;
        const si = cell(v[cols["処遇改善補助金手当"]]) > 0;   // ★ 補助金が出ている = 社保の対象
        const cur = have.get(`${onum}|${num}|${m}`);
        const eff = cur ?? (emp.get(`${onum}|${num}`).social_insurance === true);
        if (eff === si) { same++; continue; }
        rows.push({ office_number: onum, employee_number: num, processing_month: m,
          item_key: "social_insurance", numeric_value: si ? 1 : 0,
          _name: String(v[cols["氏名"]] ?? ""), _office: off.name, _from: eff });
      }
    }
  }
}
console.log(`総括表の 処遇改善補助金手当: ${seen} 人月 / 既に一致 ${same} / ★ 直す ${rows.length}`);
if (noEmp) console.log(`  当方に職員が居ない: ${noEmp} 人月 (対象外)`);
if (noSheet) console.log(`  「総括表データ_パート」が読めないシート: ${noSheet} 本`);
const per = new Map();
for (const r of rows) {
  const k = `${r._office} ${r.employee_number} ${r._name}`;
  const x = per.get(k) ?? [];
  x.push(`${r.processing_month.slice(4)}月 ${r._from ? 1 : 0}→${r.numeric_value}`);
  per.set(k, x);
}
for (const [k, v] of [...per].sort()) console.log(`   ${k.padEnd(34)} ${v.join(" / ")}`);

if (!EXECUTE) { console.log("\nDRY RUN (--execute で書き込み)"); process.exit(0); }
for (let i = 0; i < rows.length; i += 200) {
  const body = rows.slice(i, i + 200).map((r) => ({
    office_number: r.office_number, employee_number: r.employee_number,
    processing_month: r.processing_month, item_key: r.item_key, numeric_value: r.numeric_value,
  }));
  const res = await fetch(`${SB}payroll_monthly_inputs?on_conflict=office_number,employee_number,processing_month,item_key`, {
    method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(body),
  });
  if (!res.ok) { console.error(`✗ 書き込み失敗 (${i}件目〜): ${await res.text()}`); process.exit(1); }
}
console.log(`完了 ${rows.length} 件`);
