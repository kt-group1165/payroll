/**
 * 実績の完全重複を消す (2026-09-30)。
 *
 *   node migrations/delete_duplicate_service_records_20260930.mjs             # DRY RUN
 *   node migrations/delete_duplicate_service_records_20260930.mjs --execute   # 消す
 *   node migrations/delete_duplicate_service_records_20260930.mjs --restore --execute   # 消した行を戻す
 *
 * ── 何を消すか ────────────────────────────────────────────────────────────
 * `payroll_service_records` で
 *   (事業所番号, 社員番号, 日付, 派遣開始時間, 利用者名, サービスコード)
 * が同じ行が 2 つ以上あるとき、★ **id が小さいほうを残して 残りを消す**。
 *
 * ── なぜ消してよいか (★ 3 つの材料が一致している) ──────────────────────────
 * 2026-09-30 に 該当 7 人月すべてで 次を確かめた:
 * ```
 *   ① 総括表データ / ② 支払用シート / 旧システムの従業員日別  ★ 3 つとも 重複を含まない
 *   例 やわた 石本美幸 202606  当方 13,615分 / ★ 3 つとも 13,165分 (差 450分 = 重複 15 行 ×30分)
 * ```
 * ★ 金額では 当方が ② より ¥27,429 多く出ていた
 *   (石本美幸 +19,056 / 麻生麻里奈 +6,250 / 鍬本シナラ +1,073 / 鈴木阿貴子 +1,050)。
 * ⚠ 関章子 (360分) と 吉田美幸 (180分) は ★ 総支給が ② と一致している。★ 消して大丈夫かを実測した:
 *   ★ 2 人とも **月給者**で、★ 介護超過の閾値 (120h = 7,200分) に届いていない
 *   (関 3,330分 = 55.5h / 吉田 6,730分 = 112.2h。消しても 2,970分 / 6,550分 で なお下)。
 *   → ★ 訪問時間は正しくなり、★ 総支給は動かない。
 * ⚠ ★ 40 行すべて やわた 202606 の **同じ利用者 (野村敦子) の 021001 身体介護(自立) 30分**。
 *   ★ MEISAI を 事業者エントリごとに出して 2 本取り込むと 同じ訪問が 2 回入る形。
 *   ★ 取込側 (meisai-importer) を直したので 次からは入らない。
 *
 * ── 取込側も直した ────────────────────────────────────────────────────────
 * `src/components/csv/meisai-importer.tsx` で ★ CSV の中の完全重複を落とすようにした (同日)。
 * ★ これが無いと 取り込み直すたびに 同じ重複が戻る。
 *
 * 冪等。消した行は migrations/_backup_duplicate_service_records_20260930.json に控える。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const RESTORE = process.argv.includes("--restore");
const MONTHS = (process.env.MONTHS || "202603,202604,202605,202606,202607,202608").split(",");
const BACKUP = "migrations/_backup_duplicate_service_records_20260930.json";

const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) { console.error("★ .env.local が読めません"); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const q = async (path, init) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: H, ...init });
  if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`);
  const body = await r.text();               // ⚠ PostgREST は return=representation が無いと本文を返さない
  return body ? JSON.parse(body) : null;
};
async function all(path) {
  const out = []; let from = 0;
  for (;;) { const j = await q(`${path}${path.includes("?") ? "&" : "?"}order=id&offset=${from}&limit=1000`); out.push(...j); if (j.length < 1000) break; from += 1000; }
  return out;
}
const parseDur = (s) => {
  // 本番の parseDurationMinutes と同じ扱い (1440 分以上は 0)。★ 件数の目安を出すだけに使う
  if (!s) return 0;
  const t = String(s).trim();
  let v = 0;
  if (t.includes(":")) { const [h, m] = t.split(":").map(Number); v = (h || 0) * 60 + (m || 0); } else v = parseInt(t, 10) || 0;
  return v >= 1440 ? 0 : v;
};

console.log(`=== 実績の完全重複を消す ${RESTORE ? "【戻す】" : EXECUTE ? "【実行】" : "(DRY RUN)"} 対象月 ${MONTHS.join(",")} ===`);

if (RESTORE) {
  if (!existsSync(BACKUP)) { console.error(`★ ${BACKUP} がありません。--execute をまだ回していないか、ログを消しています。★ 推測で戻しません`); process.exit(2); }
  const log = JSON.parse(readFileSync(BACKUP, "utf8"));
  console.log(`控えた行 ${log.rows.length} (実行 ${log.executed_at})`);
  const nowIds = new Set((await all(`payroll_service_records?select=id&processing_month=in.(${MONTHS.join(",")})`)).map((r) => r.id));
  const missing = log.rows.filter((r) => !nowIds.has(r.id));
  console.log(`いま DB に無い行 (= 戻す対象) ${missing.length}`);
  if (!EXECUTE) { console.log("(DRY RUN。--restore --execute で戻します)"); process.exit(0); }
  for (let i = 0; i < missing.length; i += 100) await q("payroll_service_records", { method: "POST", body: JSON.stringify(missing.slice(i, i + 100)) });
  console.log(`${missing.length} 行を戻しました`);
  process.exit(0);
}

const rows = await all(`payroll_service_records?select=*&processing_month=in.(${MONTHS.join(",")})`);
console.log(`実績 ${rows.length} 行を読みました`);
const seen = new Map(), dup = [];
for (const r of rows) {
  const k = `${r.office_number}|${r.employee_number}|${r.service_date}|${r.dispatch_start_time}|${r.client_name}|${r.service_code}`;
  if (seen.has(k)) dup.push({ r, keep: seen.get(k) }); else seen.set(k, r.id);
}
const byPm = new Map();
for (const { r } of dup) {
  const k = `${r.office_number}|${String(r.employee_number).replace(/^0+/, "")}|${r.processing_month}`;
  const v = byPm.get(k) ?? { name: r.employee_name, n: 0, m: 0 };
  v.n++; v.m += parseDur(r.calc_duration); byPm.set(k, v);
}
console.log(`\n★ 消す ${dup.length} 行 / ${byPm.size} 人月`);
for (const [k, v] of [...byPm].sort((a, b) => b[1].m - a[1].m)) console.log(`  ${k} ${v.name}  ${v.n}行 ${v.m}分`);
console.log(`\n明細 (id / 残す id):`);
for (const { r, keep } of dup.slice(0, 50)) console.log(`  消す id=${r.id} (残す id=${keep}) ${r.office_number} ${r.employee_name} ${r.service_date} ${r.dispatch_start_time} ${r.service_code} ${r.service_type} ${r.client_name} ${r.calc_duration}`);
if (dup.length > 50) console.log(`  … ほか ${dup.length - 50} 行`);

if (!EXECUTE) { console.log("\n(DRY RUN。--execute で消します)"); process.exit(0); }
writeFileSync(BACKUP, JSON.stringify({ executed_at: new Date().toISOString(), note: "delete_duplicate_service_records_20260930.mjs が消した行。--restore --execute で戻す", rows: dup.map((d) => d.r) }, null, 2) + "\n", "utf8");
console.log(`消す前の行を ${BACKUP} に控えました`);
let done = 0;
for (const { r } of dup) { await q(`payroll_service_records?id=eq.${r.id}`, { method: "DELETE" }); done++; }
const after = await all(`payroll_service_records?select=id&processing_month=in.(${MONTHS.join(",")})`);
console.log(`${done} 行を消しました。確認: 実績 ${after.length} 行 (前 ${rows.length} / 差 ${rows.length - after.length})`);
console.log("★ 次に 該当の 事業所×月 を再計算すること (やわた 202606 / 船橋 202608)");
console.log("★ そのあと npm run check:soukatsu-cause で 総支給の一致率が下がっていないか必ず見ること");
console.log("★ 戻すときは --restore --execute");
