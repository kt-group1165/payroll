/**
 * 年末年始の会社休日 (特日) の登録漏れを足す (2026-09-30)。
 *
 *   node migrations/add_nenmatsu_company_holidays_20260930.mjs             # DRY RUN
 *   node migrations/add_nenmatsu_company_holidays_20260930.mjs --execute
 *   node migrations/add_nenmatsu_company_holidays_20260930.mjs --delete --execute   # 足した行だけ消す
 *
 * ── 何が抜けていたか ──────────────────────────────────────────────────────
 * `payroll_company_holidays` に **元日 (1/1) が 1 年も入っていない**。★ 2025-12-31 も無い。
 * ```
 *   いま  2026-01-02 2026-01-03 / 2026-08-13〜15 / 2026-12-30 2026-12-31 /
 *         2027-01-02 2027-01-03 / 2027-08-13〜15 / 2027-12-30 2027-12-31 / 2028-01-02 2028-01-03
 *   ★ 無い  2025-12-31 ・ 2026-01-01 ・ 2027-01-01 ・ 2028-01-01
 * ```
 *
 * ── 裏付け (★ 総括表 ① から 日 × 単価 を掃引して 1 円一致で確定) ─────────────
 * ```
 *   202512  特日 = ★ 2025/12/31 のみ           単価 300円/時 → 12/12 名が 1 円一致 (200円だと 0/12)
 *   202601  特日 = ★ 2026/01/01・01/02・01/03  単価 300円/時 → 19/19 名が 1 円一致 (200円だと 0/19)
 * ```
 * ★ 2025/12/30 は **特日ではない** (実績は 96 行あるのに 入れると一致が崩れる)。
 * ⚠ 実績があるのが リンクス茂原 1 事業所だけの月なので 分母は 12 名 / 19 名と小さい。
 *   ★ ただし 1 円まで全員一致し 200円では 0 なので 取り違えようがない。
 *
 * ── ★ 足すのは 実データで裏が取れた 2 日だけ ────────────────────────────────
 * ★ 2027-01-01 / 2028-01-01 も 同じ理屈で抜けているが、★ 実績が無く確かめられないので **足さない**。
 *   ★ 2026-12-30 が登録されているのも 2025-12-30 が特日でなかったことと食い違う。
 *   → ★ その年の年末年始休暇は 曜日で変わるので、★ user に確認してから入れること。
 *
 * 冪等。既にある日付は 触らない。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");

/** 日付 / 名前 / 根拠 */
const TARGETS = [
  ["2025-12-31", "年末年始", "① 202512 で 12/12 名が 1 円一致 (300円/時)。12/30 を入れると崩れる"],
  ["2026-01-01", "年末年始", "① 202601 で 1/1・1/2・1/3 の 3 日・300円/時 で 19/19 名が 1 円一致"],
];

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
  const body = await r.text();          // ⚠ PostgREST は return=representation が無いと本文を返さない
  return body ? JSON.parse(body) : null;
};

console.log(`=== 年末年始の会社休日を足す ${DELETE ? "【削除】" : EXECUTE ? "【実行】" : "(DRY RUN)"} ===`);
const cur = await q("payroll_company_holidays?select=id,holiday_date,name&order=holiday_date");
console.log(`いまの会社休日 ${cur.length} 日: ${cur.map((r) => r.holiday_date).join(" ")}`);
const have = new Map(cur.map((r) => [r.holiday_date, r]));

if (DELETE) {
  const ids = TARGETS.map(([d]) => have.get(d)).filter(Boolean).map((r) => r.id);
  console.log(`消す ${ids.length} 日: ${TARGETS.map(([d]) => d).filter((d) => have.has(d)).join(" ")}`);
  if (!EXECUTE) { console.log("(DRY RUN。--delete --execute で消します)"); process.exit(0); }
  for (const id of ids) await q(`payroll_company_holidays?id=eq.${id}`, { method: "DELETE" });
  console.log(`${ids.length} 日を消しました`);
  process.exit(0);
}

const toAdd = [];
for (const [date, name, why] of TARGETS) {
  if (have.has(date)) { console.log(`  済 ${date} (${have.get(date).name}) 既にある`); continue; }
  console.log(`  入れる ${date} ${name}`);
  console.log(`         ${why}`);
  toAdd.push({ tenant_id: "kt-group", holiday_date: date, name });
}
console.log(`\n入れる ${toAdd.length} 日`);
console.log("⚠ 足すと その日は 土日祝手当の対象から外れて 特日手当になります (2026-01-01 は 祝日なので 振り替わる)");
if (!EXECUTE) { console.log("(DRY RUN。--execute で書き込みます)"); process.exit(0); }
if (toAdd.length > 0) await q("payroll_company_holidays", { method: "POST", body: JSON.stringify(toAdd) });
const after = await q("payroll_company_holidays?select=holiday_date&order=holiday_date");
console.log(`${toAdd.length} 日を入れました。確認: 会社休日 ${after.length} 日 (前 ${cur.length})`);
console.log("★ 次に 202512 / 202601 を給与計算すること");
console.log("★ 戻すときは --delete --execute");
