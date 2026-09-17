/**
 * 給与の移動計算に使う利用者住所 (payroll_clients) の欠けを、ほのぼのの利用者マスタ CSV から埋める。
 *
 *   node migrations/fill_payroll_client_addresses.mjs --office 1270203191 --month 202607 --csv "../kaigo-app/利用者データ/さつきが丘/基本情報_______.CSV"            # DRY RUN
 *   node migrations/fill_payroll_client_addresses.mjs --office 1270203191 --month 202607 --csv "..." --execute
 *
 * 対象: その事業所・月の実績 (payroll_service_records) に出てくる利用者番号のうち、
 *       payroll_clients に行が無い or 住所が空 のもの。
 * - 利用者番号は使い回されることがあるので、**番号と氏名の両方が一致**したときだけ使う
 * - 既に住所が入っている行は書き換えない
 * - --csv は複数指定可 (先に指定したものを優先)。CP932
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const iconv = require("iconv-lite");

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const OFFICE = opt("--office");
const MONTH = opt("--month");
const CSVS = args.flatMap((a, i) => (a === "--csv" ? [args[i + 1]] : []));
if (!OFFICE || !MONTH || CSVS.length === 0) {
  console.error("--office <事業所番号> --month <YYYYMM> --csv <基本情報CSV> を指定してください");
  process.exit(1);
}

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
async function getAll(path) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${path}&order=id&offset=${from}&limit=1000`, { headers: H });
    if (!r.ok) throw new Error(`${path}: ${await r.text()}`);
    const d = await r.json();
    out.push(...d);
    if (d.length < 1000) break;
  }
  return out;
}
const N = (s) => String(s ?? "").normalize("NFKC").replace(/[\s　]/g, "").replace(/髙/g, "高").replace(/﨑/g, "崎");

function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f.replace(/\r$/, "")); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

// 利用者番号 → [{name, address, csv}]
const master = new Map();
for (const path of CSVS) {
  const rows = parseCsv(iconv.decode(readFileSync(path), "cp932"));
  const h = rows[0];
  const iNo = h.indexOf("利用者番号"), iName = h.indexOf("利用者名"), iAddr = h.indexOf("住所");
  if (iNo < 0 || iName < 0 || iAddr < 0) { console.error(`${path}: 利用者番号/利用者名/住所 の列が見つかりません`); process.exit(1); }
  for (const r of rows.slice(1)) {
    const no = (r[iNo] ?? "").trim();
    if (!no) continue;
    if (!master.has(no)) master.set(no, []);
    master.get(no).push({ name: r[iName] ?? "", address: (r[iAddr] ?? "").trim(), csv: path });
  }
}

const [office] = await getAll(`payroll_offices?select=id,office_number&office_number=eq.${OFFICE}`);
if (!office) { console.error(`payroll_offices に ${OFFICE} がありません`); process.exit(1); }
const recs = await getAll(`payroll_service_records?select=id,client_number,client_name&processing_month=eq.${MONTH}&office_number=eq.${OFFICE}`);
const clients = await getAll(`payroll_clients?select=id,client_number,name,address&office_id=eq.${office.id}`);
const byNo = new Map(clients.map((c) => [c.client_number, c]));

const used = new Map(); // client_number → {name, count}
for (const r of recs) {
  if (!r.client_number) continue;
  const u = used.get(r.client_number) ?? { name: r.client_name, count: 0 };
  u.count++;
  used.set(r.client_number, u);
}

const inserts = [], updates = [], unresolved = [];
for (const [no, u] of used) {
  const cur = byNo.get(no);
  if (cur?.address?.trim()) continue;
  const cands = (master.get(no) ?? []).filter((m) => N(m.name) === N(u.name) && m.address);
  if (cands.length === 0) {
    const other = (master.get(no) ?? []).map((m) => m.name).join("/");
    unresolved.push(`${no} ${u.name} (${u.count}件) ${other ? `CSVの同番号は別名: ${other}` : "CSVに無い"}`);
    continue;
  }
  const m = cands[0];
  if (cur) updates.push({ id: cur.id, no, name: u.name, address: m.address, count: u.count });
  else inserts.push({ client_number: no, name: String(u.name).replace(/　/g, " ").trim(), address: m.address, office_id: office.id, _count: u.count });
}

console.log(`=== 利用者住所の補完 ${OFFICE} ${MONTH} ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log(`実績の利用者 ${used.size} 名 / 住所あり ${[...used.keys()].filter((no) => byNo.get(no)?.address?.trim()).length} 名`);
for (const i of inserts) console.log(`  追加 ${i.client_number} ${i.name} (${i._count}件) ${i.address}`);
for (const u of updates) console.log(`  住所を入れる ${u.no} ${u.name} (${u.count}件) ${u.address}`);
for (const u of unresolved) console.log(`  ✗ 補完できない ${u}`);
if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }

if (inserts.length) {
  const payload = inserts.map(({ _count, ...rest }) => { void _count; return rest; });
  const r = await fetch(`${SB_URL}/rest/v1/payroll_clients`, { method: "POST", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(payload) });
  if (!r.ok) { console.error("追加失敗:", await r.text()); process.exit(1); }
  const rows = await r.json();
  if (rows.length !== payload.length) { console.error(`★ 追加件数不一致 ${rows.length}/${payload.length}`); process.exit(2); }
}
for (const u of updates) {
  const r = await fetch(`${SB_URL}/rest/v1/payroll_clients?id=eq.${u.id}`, { method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify({ address: u.address }) });
  if (!r.ok) { console.error(`更新失敗 ${u.no}:`, await r.text()); process.exit(1); }
  if ((await r.json()).length !== 1) { console.error(`★ 更新 0 行 ${u.no}`); process.exit(2); }
}
const after = await getAll(`payroll_clients?select=id,client_number,address&office_id=eq.${office.id}`);
const afterMap = new Map(after.map((c) => [c.client_number, c]));
const stillMissing = [...used.keys()].filter((no) => !afterMap.get(no)?.address?.trim());
console.log(`\n完了: 追加 ${inserts.length} / 住所更新 ${updates.length}。住所が無い利用者 残り ${stillMissing.length} 名`);
