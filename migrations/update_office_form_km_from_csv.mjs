/**
 * 事業所書式の 出張km / 通勤km だけを、後から出し直された CSV の値で上書きする (2026-09-18)。
 *
 *   node migrations/update_office_form_km_from_csv.mjs <CSV> --office 1273001626 --month 202606            # DRY RUN
 *   node migrations/update_office_form_km_from_csv.mjs <CSV> --office 1273001626 --month 202606 --execute
 *
 * 例: 君津 2026-06 は R8.6稼動 (20260701) を取り込んだが、本社の印刷済み (20260703) で出張km が直っている
 *   (近藤 359.7 → 422.9 / 佐藤 204.9 → 233.9 / 寺尾 188.2 → 218.7 = 旧システムの集計と一致)。
 *   0703 には日付の入った項目 (有給など) が無いので 全部を入れ替えず km の行だけ直す。
 * CSV は Box から scratchpad にコピーしたもの (Box の元ファイルには触らない)。冪等。
 */
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const FILE = args.find((a, i) => !a.startsWith("--") && !["--office", "--month"].includes(args[i - 1]));
const OFFICE = opt("--office"), MONTH = opt("--month");
if (!FILE || !OFFICE || !/^\d{6}$/.test(MONTH ?? "")) { console.error("<CSV> --office <番号> --month YYYYMM"); process.exit(1); }
const env = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "return=representation" };

// CSV: 事業所番号, 事業所名, 社員番号, 名前, (コード, 項目名, 値) × n。cp932
const text = new TextDecoder("shift_jis").decode(readFileSync(FILE));
const want = new Map(); // `${emp}|${item}` -> value
for (const line of text.split(/\r?\n/).slice(1)) {
  const c = line.split(",");
  if (c[0] !== OFFICE) continue;
  const emp = String(c[2] ?? "").trim().replace(/^0+/, "");
  for (let i = 4; i + 2 < c.length + 1; i += 3) {
    const item = c[i + 1], v = c[i + 2];
    if ((item === "出張km" || item === "通勤km") && v !== undefined && v !== "" && !isNaN(Number(v))) {
      const k = `${emp}|${item}`;
      if (!want.has(k)) want.set(k, Number(v));
    }
  }
}
const r = await fetch(`${SB}/rest/v1/payroll_office_form_records?select=id,employee_number,item_name,numeric_value&office_number=eq.${OFFICE}&processing_month=eq.${MONTH}&item_name=in.(出張km,通勤km)`, { headers: H });
if (!r.ok) { console.error(await r.text()); process.exit(1); }
const rows = await r.json();
const ops = [];
const seen = new Set();
for (const row of rows) {
  const k = `${String(row.employee_number).replace(/^0+/, "")}|${row.item_name}`;
  if (!want.has(k) || seen.has(k)) continue;
  if (!(Number(row.numeric_value) > 0) && rows.some((x) => x !== row && `${String(x.employee_number).replace(/^0+/, "")}|${x.item_name}` === k && Number(x.numeric_value) > 0)) continue;
  seen.add(k);
  const v = want.get(k);
  if (Number(row.numeric_value) === v) continue;
  ops.push([`${k}: ${row.numeric_value} → ${v}`, row.id, v]);
}
const missing = [...want.keys()].filter((k) => !seen.has(k) && !rows.some((x) => `${String(x.employee_number).replace(/^0+/, "")}|${x.item_name}` === k));
for (const [l] of ops) console.log(l);
if (missing.length) console.log(`  DB に行が無い (入れない): ${missing.join(", ")}`);
console.log(`書き込み ${ops.length} 件`);
if (!EXECUTE) { console.log("DRY RUN (--execute で書き込み)"); process.exit(0); }
for (const [, id, v] of ops) {
  const w = await fetch(`${SB}/rest/v1/payroll_office_form_records?id=eq.${id}`, { method: "PATCH", headers: H, body: JSON.stringify({ numeric_value: v }) });
  if (!w.ok) { console.error(await w.text()); process.exit(1); }
}
console.log("完了");
