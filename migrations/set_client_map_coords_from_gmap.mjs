/**
 * 旧システムの移動計算 (総括表フォルダ 202606_移動手当.xlsx の「Gmap結果確認用」) で
 * 利用者の MAP住所 が座標 ("35.xx, 140.xx") になっている利用者を、payroll_clients の map_latitude / map_longitude に入れる (2026-09-19)。
 *
 *   node migrations/set_client_map_coords_from_gmap.mjs <gmap_client_addr.json>            # DRY RUN
 *   node migrations/set_client_map_coords_from_gmap.mjs <gmap_client_addr.json> --execute
 *
 * json は scratchpad で xlsx から抜いた { 事業所名: { 利用者コード: MAP住所 } } (Box の元ファイルには触っていない)。
 * なぜ: 移動の区間は旧システムの地図用の場所で数えている。登録住所と違う利用者は区間の分数がずれる。
 * 当方の map_latitude が既に入っている利用者は上書きしない。冪等。
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
const G = JSON.parse(readFileSync(FILE, "utf8"));
const offs = await all("payroll_offices?select=id,office_number,offices(name)");
const ops = [];
for (const o of offs) {
  const g = G[o.offices?.name]; if (!g) continue;
  const pc = await all(`payroll_clients?select=id,client_number,address,map_latitude&office_id=eq.${o.id}`);
  const pm = new Map(pc.map((c) => [c.client_number, c]));
  for (const [code, maddr] of Object.entries(g)) {
    const m = /^\s*(3\d\.\d+)\s*,\s*(1\d\d\.\d+)\s*$/.exec(maddr);
    const c = pm.get(code);
    if (!m || !c || c.map_latitude != null) continue;
    ops.push({ id: c.id, lat: Number(m[1]), lng: Number(m[2]), label: `${o.offices.name} ${code} ${c.address} → ${m[1]},${m[2]}` });
  }
}
for (const x of ops) console.log(x.label);
console.log(`書き込み ${ops.length} 件`);
if (!EXECUTE) { console.log("DRY RUN (--execute で書き込み)"); process.exit(0); }
for (const x of ops) {
  const r = await fetch(`${SB}payroll_clients?id=eq.${x.id}`, { method: "PATCH", headers: H,
    body: JSON.stringify({ map_latitude: x.lat, map_longitude: x.lng, map_note: "旧システム Gmap結果 202606 の MAP住所 (座標)" }) });
  if (!r.ok) { console.error(`★ 失敗 ${x.label}: ${await r.text()}`); process.exit(1); }
}
console.log("完了");
