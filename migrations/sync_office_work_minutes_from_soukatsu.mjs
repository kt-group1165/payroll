/**
 * 事務員の勤務時間 (office_work_minutes) を 総括表の「出勤時間」から同期する (2026-09-24)。
 *
 *   node migrations/sync_office_work_minutes_from_soukatsu.mjs            # DRY RUN
 *   node migrations/sync_office_work_minutes_from_soukatsu.mjs --execute
 *
 * 出勤簿が **スキャン PDF にしかない事務員 8 名**は CSV で取り込めないので、勤務時間を手入力で持っている。
 * ⚠ 旧 set_office_work_hours_from_scan.mjs は **値がソースにハードコード**されていて 202603〜202607 だけ。
 *   202608 の総括表は後から取り込まれたので 8 名全員 未入力のまま残っていた。
 *   → 総括表テーブルから直接読む形にして、月が増えるたびに追従するようにした。
 *
 * ⚠ **対象は「既に手入力がある職員」だけ**に絞る。総括表の出勤時間を全職員に入れると
 *   出勤簿がある人まで上書きしてしまう (当方は 終了−開始−休憩 を正とする方針)。
 * ⚠ 値は 総括表の出勤時間そのもの。既存 5 か月はこの入れ方で 1 分も違わず一致している。
 *
 * 冪等。既に同じ値なら触らない。
 */
const EXECUTE = process.argv.includes("--execute");
import { readFileSync } from "node:fs";
const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" };
const get = async (q) => { const o = []; for (let f = 0; ; f += 1000) {
  const r = await fetch(`${SB}/rest/v1/${q}`, { headers: { ...H, Range: `${f}-${f + 999}` } }); const j = await r.json();
  if (!Array.isArray(j)) throw new Error(JSON.stringify(j).slice(0, 250)); o.push(...j); if (j.length < 1000) break; } return o; };
const num = (v) => { if (v == null || v === "") return 0; const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, "")); return Number.isNaN(n) ? 0 : n; };
const nn = (s) => String(s ?? "").replace(/^0+/, "");

const cur = await get("payroll_monthly_inputs?select=office_number,employee_number,processing_month,numeric_value&item_key=eq.office_work_minutes&order=id");
const have = new Map(cur.map((r) => [`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, num(r.numeric_value)]));
// 既に手入力がある職員だけを対象にする (出勤簿がある人を上書きしない)
const targets = new Set(cur.map((r) => `${r.office_number}|${nn(r.employee_number)}`));
const empNumOf = new Map(cur.map((r) => [`${r.office_number}|${nn(r.employee_number)}`, String(r.employee_number)]));
const pofs = await get("payroll_offices?select=office_number,office_id&order=id");
const offs = await get("offices?select=id,name&order=id");
const onm = new Map(offs.map((o) => [o.id, o.name]));
const disp = new Map(pofs.map((o) => [o.office_number, onm.get(o.office_id) ?? o.office_number]));
const rows = await get("payroll_soukatsu_rows?select=office_number,processing_month,employee_number,row_data&order=id");

const ops = [];
for (const r of rows) {
  const k = `${r.office_number}|${nn(r.employee_number)}`;
  if (!targets.has(k)) continue;
  const v = num(r.row_data["出勤時間"]); if (v <= 0) continue;
  const kk = `${k}|${r.processing_month}`;
  if (have.get(kk) === v) continue;
  ops.push({ office_number: r.office_number, employee_number: empNumOf.get(k), processing_month: r.processing_month,
    item_key: "office_work_minutes", numeric_value: v,
    note: "総括表の出勤時間から (sync_office_work_minutes_from_soukatsu.mjs)。出勤簿がスキャンPDFにしかない事務員 2026-09-24",
    label: `${disp.get(r.office_number)} ${String(r.row_data["氏名"] ?? "").replace(/\n/g, "/")} ${r.processing_month} ${have.has(kk) ? `${have.get(kk)} → ` : ""}${v} 分` });
}
console.log(`=== 事務員の勤務時間 (総括表より) ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${ops.length} 件 ===`);
for (const o of ops) console.log("  " + o.label);
if (!EXECUTE || ops.length === 0) { console.log("DRY RUN。--execute で書き込みます"); process.exit(0); }
const body = ops.map(({ label, ...x }) => { void label; return x; });
const res = await fetch(`${SB}/rest/v1/payroll_monthly_inputs?on_conflict=office_number,employee_number,processing_month,item_key`, {
  method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body) });
const b = await res.json();
if (!res.ok || !Array.isArray(b) || b.length !== body.length) { console.error("★ 書き込みに失敗:", JSON.stringify(b).slice(0, 400)); process.exit(1); }
console.log(`  反映 ${b.length} 件`);
