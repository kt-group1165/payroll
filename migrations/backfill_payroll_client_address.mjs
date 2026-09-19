/**
 * 給与の利用者マスタ (payroll_clients) に 住所が無い / 行が無い 利用者を、共通の利用者マスタ (clients) から補う (2026-09-19)。
 *
 *   node migrations/backfill_payroll_client_address.mjs            # DRY RUN
 *   node migrations/backfill_payroll_client_address.mjs --execute
 *
 * なぜ: 移動手当・移動時間は 訪問と訪問の間の区間で決まるが、利用者の住所が無いと その区間が落ちて 0 になる。
 *   2026-03〜07 の実績で 全事業所 の 2〜9% (いすみ 1,308件 / 花見川 623件 …) が 住所なし の利用者だった。
 *   例: 船橋 618000157 小川延子 は payroll_clients に行が無いが clients には 船橋市二和東4-1-16 がある。
 * 引き方: 利用者番号は拠点の中でしか一意でないので、その事業所に割り当てのある (client_office_assignments) clients に限って
 *   user_number で引く。1 人に決まるものだけ使う (2 人以上 / 0 人は入れず一覧に出す)。
 * 対象: 2026-03〜07 の実績 (payroll_service_records) に出てくる利用者だけ。冪等。
 */
import { readFileSync } from "node:fs";
const EXECUTE = process.argv.includes("--execute");
const MONTHS = ["202603", "202604", "202605", "202606", "202607"];
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
const nn = (s) => String(s ?? "").trim().replace(/^0+/, "");
const offices = await all("payroll_offices?select=id,office_number,office_id,office_type");
const inserts = [], updates = [], unresolved = [];
for (const o of offices.filter((x) => x.office_type === "訪問介護" && x.office_id)) {
  const recs = await all(`payroll_service_records?select=client_number,client_name&office_number=eq.${o.office_number}&processing_month=in.(${MONTHS.join(",")})`);
  if (recs.length === 0) continue;
  const nameOf = new Map(recs.map((r) => [r.client_number, r.client_name]));
  const pc = await all(`payroll_clients?select=id,client_number,address,map_latitude&office_id=eq.${o.id}`);
  const pcMap = new Map(pc.map((c) => [c.client_number, c]));
  const missing = [...nameOf.keys()].filter((c) => { const x = pcMap.get(c); return !x || (!String(x.address ?? "").trim() && x.map_latitude == null); });
  if (missing.length === 0) continue;
  const asg = await all(`client_office_assignments?select=client_id&office_id=eq.${o.office_id}`);
  const ids = [...new Set(asg.map((a) => a.client_id))];
  const cls = [];
  for (let i = 0; i < ids.length; i += 150) cls.push(...await all(`clients?select=id,name,address,user_number&id=in.(${ids.slice(i, i + 150).join(",")})`));
  const byNum = new Map();
  for (const c of cls) { const k = nn(c.user_number); if (!k) continue; if (!byNum.has(k)) byNum.set(k, []); byNum.get(k).push(c); }
  for (const num of missing) {
    const hits = (byNum.get(nn(num)) ?? []).filter((c) => String(c.address ?? "").trim());
    if (hits.length !== 1) { unresolved.push(`${o.office_number} ${num} ${nameOf.get(num) ?? ""}: 候補 ${hits.length}`); continue; }
    // 氏名も照合する (番号の使い回し・誤爆よけ)。空白・括弧書き・旧字の差は落として比べる
    const nm = (x) => String(x ?? "").split("\n")[0].replace(/[\s　]/g, "").replace(/[（(].*?[)）]/g, "").replace(/髙/g, "高").replace(/﨑/g, "崎");
    if (nm(hits[0].name) !== nm(nameOf.get(num))) { unresolved.push(`${o.office_number} ${num} ${nameOf.get(num) ?? ""}: 氏名が違う (clients: ${hits[0].name})`); continue; }
    const addr = hits[0].address.trim();
    const ex = pcMap.get(num);
    if (ex) updates.push({ id: ex.id, address: addr, label: `${o.office_number} ${num} ${nameOf.get(num)} → ${addr}` });
    else inserts.push({ row: { client_number: num, name: hits[0].name, address: addr, office_id: o.id }, label: `${o.office_number} ${num} ${nameOf.get(num)} (新規) → ${addr}` });
  }
}
for (const x of [...updates, ...inserts]) console.log(x.label);
console.log(`\n住所を入れる: 更新 ${updates.length} / 新規 ${inserts.length} / 決まらない ${unresolved.length}`);
for (const u of unresolved.slice(0, 40)) console.log("  ✗", u);
if (!EXECUTE) { console.log("DRY RUN (--execute で書き込み)"); process.exit(0); }
for (const u of updates) {
  const r = await fetch(`${SB}payroll_clients?id=eq.${u.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ address: u.address }) });
  if (!r.ok) { console.error(`★ 更新失敗 ${u.label}: ${await r.text()}`); process.exit(1); }
}
for (let i = 0; i < inserts.length; i += 200) {
  const r = await fetch(`${SB}payroll_clients`, { method: "POST", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify(inserts.slice(i, i + 200).map((x) => x.row)) });
  if (!r.ok) { console.error(`★ 追加失敗: ${await r.text()}`); process.exit(1); }
}
console.log(`完了 更新 ${updates.length} / 新規 ${inserts.length}`);
