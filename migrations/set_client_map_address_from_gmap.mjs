/**
 * 旧システムの移動計算 (202606_移動手当.xlsx「Gmap結果確認用」) の 文字の MAP住所 が 登録住所と別の場所の利用者に、
 * payroll_clients.map_address を入れる (2026-09-19)。前提 SQL: migrations/payroll_clients_map_address.sql
 *
 *   node migrations/set_client_map_address_from_gmap.mjs <gmap_client_addr.json>            # DRY RUN (SQL 前でも一覧は出る)
 *   node migrations/set_client_map_address_from_gmap.mjs <gmap_client_addr.json> --execute
 *
 * 表記ゆれ (千葉県の重複・丁目/番地・建物名の有無) だけの違いは入れない: 市区町村 + 町名 + 最初の番地 まで同じなら同じ場所とみなす。
 * 座標の MAP住所 は set_client_map_coords_from_gmap.mjs が入れる。当方で map_latitude がある利用者は触らない。冪等。
 */
import { readFileSync } from "node:fs";
const EXECUTE = process.argv.includes("--execute");
const FILE = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!FILE) { console.error("json を指定してください"); process.exit(1); }
const env = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL + "/rest/v1/";
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
async function all(p) {
  const out = [];
  for (let f = 0; ; f += 1000) {
    const r = await fetch(`${SB}${p}&order=id&offset=${f}&limit=1000`, { headers: H });
    if (!r.ok) throw new Error(`${p}: ${await r.text()}`);
    const d = await r.json(); out.push(...d); if (d.length < 1000) break;
  }
  return out;
}
// 場所の鍵: 都道府県を落とし、数字を半角にし、最初の番地の数字まで
const place = (s) => {
  let t = String(s ?? "").normalize("NFKC").replace(/[\s]/g, "").replace(/^(千葉県)+/, "");
  t = t.replace(/丁目|番地の?|番|号|の/g, "-");
  const m = /^(.*?\d+)/.exec(t);
  return m ? m[1] : t;
};
const G = JSON.parse(readFileSync(FILE, "utf8"));
const offs = await all("payroll_offices?select=id,office_number,offices(name)");
const hasCol = (await fetch(`${SB}payroll_clients?select=map_address&limit=1`, { headers: H })).ok;
const ops = [];
for (const o of offs) {
  const g = G[o.offices?.name]; if (!g) continue;
  const pc = await all(`payroll_clients?select=id,client_number,address,map_latitude${hasCol ? ",map_address" : ""}&office_id=eq.${o.id}`);
  const pm = new Map(pc.map((c) => [c.client_number, c]));
  for (const [code, maddr] of Object.entries(g)) {
    const c = pm.get(code);
    if (!c || c.map_latitude != null || /^\s*3\d\.\d+\s*,/.test(maddr)) continue;
    if (place(maddr) === place(c.address)) continue;
    if (hasCol && c.map_address === maddr) continue;
    ops.push({ id: c.id, v: maddr, label: `${o.offices.name} ${code}  登録 ${c.address}  →  地図 ${maddr}` });
  }
}
for (const x of ops) console.log(x.label);
console.log(`書き込み ${ops.length} 件${hasCol ? "" : " (map_address 列がまだ無い: SQL 未適用)"}`);
if (!EXECUTE) { console.log("DRY RUN (--execute で書き込み)"); process.exit(0); }
if (!hasCol) { console.error("★ 先に migrations/payroll_clients_map_address.sql を適用してください"); process.exit(2); }
for (const x of ops) {
  const r = await fetch(`${SB}payroll_clients?id=eq.${x.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ map_address: x.v }) });
  if (!r.ok) { console.error(`★ 失敗 ${x.label}: ${await r.text()}`); process.exit(1); }
}
console.log("完了");
