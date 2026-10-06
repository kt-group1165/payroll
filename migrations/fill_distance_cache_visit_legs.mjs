/**
 * 訪問と訪問の間の区間 (サービス記録一覧の「移動時間」) のうち 距離キャッシュに無いものを Google から取って埋める (2026-10-06)。
 *
 *   node migrations/fill_distance_cache_visit_legs.mjs                       # DRY RUN (件数と費用の目安だけ)
 *   node migrations/fill_distance_cache_visit_legs.mjs --execute --max 25    # 試しに 25 区間だけ
 *   node migrations/fill_distance_cache_visit_legs.mjs --execute             # 全部
 *   MONTHS=202603,202604 node migrations/fill_distance_cache_visit_legs.mjs  # 月を絞る
 *
 * ── なぜ ────────────────────────────────────────────────────────────────
 * 画面は Google を呼ばず キャッシュにある区間だけ出す (月の API 上限を使い切った事故があるため)。
 * 2026-10-06 実測: 202603〜08 で 必要な区間 40,943 のうち 16,811 がキャッシュに無い。
 * user 承認 (2026-10-06):「1 か月でまとめて (約 $34)」。
 *
 * ── 守っていること (src/app/api/distance/route.ts と同じ) ─────────────────────
 *   ・区間の作り方は 画面 (src/app/service-records/page.tsx) と同じ:
 *     職員 × 日 の訪問を 開始時刻順に並べ、前の利用者の住所 → 次の利用者の住所。同じ住所どうしは除く。
 *     住所 = 利用者の 緯度経度 > 地図用住所 > 住所 (payroll_clients)
 *   ・Distance Matrix (mode=driving, language=ja)。1 リクエスト = 同じ出発地 × 最大 25 の行き先
 *   ・呼んだ件数 (課金単位の element) を payroll_distance_api_usage に記録する。★ 記録できなければ止める
 *   ・月の上限 (payroll_app_settings distance_api_monthly_limit) を超えない。超えるぶんは送らない
 *   ・取れた区間は payroll_distance_cache に upsert (origin_address, destination_address)
 * ⚠ API キーはローカルの GOOGLE_MAPS_API_KEY / DISTANCE_API_KEY を使う。値は表示しない。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const maxArg = process.argv.indexOf("--max");
const MAX = maxArg >= 0 ? Number(process.argv[maxArg + 1]) : Infinity;
const MONTHS = (process.env.MONTHS ?? "202603,202604,202605,202606,202607,202608,202609").split(",");
const CONCURRENCY = 4;

const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const GKEY = env.DISTANCE_API_KEY || env.GOOGLE_MAPS_API_KEY || "";
if (!SB || !KEY) { console.error("★ Supabase の接続情報が読めません"); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
console.log(`[DB] 本番 ${/https:\/\/([a-z0-9]+)\./.exec(SB)?.[1]} / API キー ${GKEY ? "あり" : "★ なし"}`);

const nn = (s) => String(s ?? "").trim().replace(/^0+/, "");
async function all(q, order = "id") {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB}/rest/v1/${q}${q.includes("?") ? "&" : "?"}order=${order}&offset=${from}&limit=1000`, { headers: H });
    if (!r.ok) throw new Error(`${r.status} ${q.slice(0, 60)}: ${await r.text()}`);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(`配列でない: ${JSON.stringify(j).slice(0, 200)}`);
    out.push(...j);
    if (j.length < 1000) break;
  }
  return out;
}
const usageMonth = (() => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  return `${p.find((x) => x.type === "year").value}-${p.find((x) => x.type === "month").value}`;
})();

// ── 区間を作る (画面と同じ)
const offs = await all("payroll_offices?select=id,office_number");
const offIdOf = new Map(offs.map((o) => [o.office_number, o.id]));
const cl = await all("payroll_clients?select=id,office_id,client_number,address,map_address,map_latitude,map_longitude");
const addr = new Map(cl.map((c) => [`${c.office_id}|${c.client_number}`,
  (c.map_latitude != null && c.map_longitude != null) ? `${c.map_latitude},${c.map_longitude}` : (c.map_address?.trim() || c.address)]));
const cache = await all("payroll_distance_cache?select=id,origin_address,destination_address");
const cached = new Set(cache.map((c) => `${c.origin_address}|||${c.destination_address}`));
const miss = new Map();   // key → {origin, destination}
for (const m of MONTHS) {
  const recs = await all(`payroll_service_records?select=id,office_number,employee_number,service_date,client_number,dispatch_start_time&processing_month=eq.${m}`);
  const day = new Map();
  for (const r of recs) {
    const k = `${r.office_number}|${nn(r.employee_number)}|${r.service_date}`;
    if (!day.has(k)) day.set(k, []);
    day.get(k).push(r);
  }
  let n = 0;
  for (const rs of day.values()) {
    const s = rs.map((r) => ({ ...r, a: addr.get(`${offIdOf.get(r.office_number)}|${r.client_number}`) }))
      .filter((r) => r.a?.trim())
      .sort((x, y) => String(x.dispatch_start_time).localeCompare(String(y.dispatch_start_time)));
    for (let i = 0; i + 1 < s.length; i++) {
      if (s[i].a === s[i + 1].a) continue;
      const k = `${s[i].a}|||${s[i + 1].a}`;
      if (cached.has(k) || miss.has(k)) continue;
      miss.set(k, { origin: s[i].a, destination: s[i + 1].a });
      n++;
    }
  }
  console.log(`  ${m}  実績 ${recs.length} 行 / 新しくキャッシュに無い区間 ${n}`);
}

// ── 出発地ごとに 25 件ずつ
const byOrigin = new Map();
for (const p of miss.values()) {
  if (!byOrigin.has(p.origin)) byOrigin.set(p.origin, []);
  byOrigin.get(p.origin).push(p.destination);
}
let chunks = [];
for (const [origin, ds] of byOrigin) for (let i = 0; i < ds.length; i += 25) chunks.push({ origin, destinations: ds.slice(i, i + 25) });

const limitRow = (await all("payroll_app_settings?select=key,value&key=eq.distance_api_monthly_limit", "key"))[0];
const limit = Number(limitRow?.value?.limit ?? 10000);
const usedRows = await all(`payroll_distance_api_usage?select=id,elements&usage_month=eq.${usageMonth}`);
const used = usedRows.reduce((s, r) => s + Number(r.elements ?? 0), 0);
const total = chunks.reduce((s, c) => s + c.destinations.length, 0);
console.log(`\nキャッシュに無い区間 ${miss.size} / リクエスト ${chunks.length} / 今月 (${usageMonth}) の使用 ${used} / 上限 ${limit}`);
console.log(`費用の目安: 月 10,000 件まで無料・超過 $5/1,000 件 として 今月ぶんの超過 ≈ $${(Math.max(0, used + total - 10000) * 5 / 1000).toFixed(1)}`);

// 上限と --max で 送るチャンクを先頭から切る (チャンクは割らない)
let room = Math.min(limit - used, MAX);
const send = [];
for (const c of chunks) { if (c.destinations.length > room) break; send.push(c); room -= c.destinations.length; }
const sendN = send.reduce((s, c) => s + c.destinations.length, 0);
console.log(`送る: ${send.length} リクエスト / ${sendN} 区間${sendN < total ? `  (★ ${total - sendN} 区間は 上限か --max のため送らない)` : ""}`);
if (!EXECUTE) { console.log("\n(DRY RUN。--execute で取りに行きます)"); process.exit(0); }
if (!GKEY) { console.error("★ API キーがありません"); process.exit(2); }

let okEl = 0, billedEl = 0, saved = 0, done = 0, stop = "";
const errors = new Map();
async function one(c) {
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(c.origin)}`
    + `&destinations=${c.destinations.map(encodeURIComponent).join("|")}&mode=driving&language=ja&key=${GKEY}`;
  const res = await fetch(url);
  const data = await res.json();
  const billed = data.status === "OK" ? c.destinations.length : 0;
  const ur = await fetch(`${SB}/rest/v1/payroll_distance_api_usage`, { method: "POST", headers: H,
    body: JSON.stringify({ usage_month: usageMonth, elements: billed, google_status: String(data.status ?? "UNKNOWN"), office_number: null, source: "fill_distance_cache_visit_legs" }) });
  if (!ur.ok) { stop = `利用件数の記録に失敗 (${ur.status} ${await ur.text()})`; return; }
  billedEl += billed;
  if (data.status !== "OK") {
    const k = `${data.status}${data.error_message ? `: ${data.error_message}` : ""}`;
    errors.set(k, (errors.get(k) ?? 0) + 1);
    if (data.status === "REQUEST_DENIED" || data.status === "OVER_QUERY_LIMIT" || data.status === "OVER_DAILY_LIMIT") stop = k;
    return;
  }
  const rows = [];
  const els = data.rows?.[0]?.elements ?? [];
  for (let j = 0; j < c.destinations.length; j++) {
    const e = els[j];
    if (e?.status !== "OK") { const k = `element ${e?.status ?? "?"}`; errors.set(k, (errors.get(k) ?? 0) + 1); continue; }
    okEl++;
    rows.push({ origin_address: c.origin, destination_address: c.destinations[j], distance_meters: e.distance.value, duration_seconds: e.duration.value });
  }
  if (rows.length) {
    const cr = await fetch(`${SB}/rest/v1/payroll_distance_cache?on_conflict=origin_address,destination_address`, {
      method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(rows) });
    if (!cr.ok) { stop = `キャッシュ保存に失敗 (${cr.status} ${await cr.text()})`; return; }
    saved += rows.length;
  }
}
let idx = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (!stop && idx < send.length) {
    const c = send[idx++];
    try { await one(c); } catch (e) { stop = `例外: ${String(e)}`; }
    done++;
    if (done % 200 === 0) console.log(`  … ${done}/${send.length} リクエスト / 課金 ${billedEl} / 保存 ${saved} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
}));
console.log(`\n完了: ${done}/${send.length} リクエスト / 課金 element ${billedEl} / 取れた区間 ${okEl} / キャッシュ保存 ${saved}`);
if (errors.size) console.log("取れなかったもの:", JSON.stringify([...errors]));
if (stop) { console.error(`★ 途中で止めました: ${stop}`); process.exit(2); }
