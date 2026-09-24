/**
 * 総括表 (社員シート) の「入浴時間」「訪問件数(入浴)」を payroll_monthly_inputs に同期する (2026-09-24)。
 *
 *   node migrations/sync_bath_inputs_from_soukatsu.mjs            # DRY RUN
 *   node migrations/sync_bath_inputs_from_soukatsu.mjs --execute
 *
 * 総括表の式: 介護超過 = (訪問時間 + 入浴時間 − 120h) × 単価。入浴件数は 1 件 = 1.12h。
 *
 * ⚠ 旧 set_bath_minutes_from_soukatsu.mjs は **値がソースにハードコード**されていて
 *   202603/04/06/07 の 4 件しか入っていなかった。202608 の総括表は 2026-09-21 に取り込まれたので
 *   backfill が回らず、茂原 HO JINAN KYLE 202608 の 1,080 分が欠けて ¥33,750 不足していた。
 *   → **総括表テーブル (payroll_soukatsu_rows) から直接読む**形にして、月を足すたびに追従するようにした。
 *
 * 冪等。既に同じ値なら触らない。総括表に無い月は消さない (手入力を勝手に消さない)。
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

/**
 * 総括表の列名 → 手入力の item_key。
 *
 * ⚠ **「訪問件数」を入浴件数として拾ってはいけない。**茂原では 入浴時間 と 訪問件数 が
 *   同じ入浴を 別の単位で表しているだけで、両方入れると **二重に介護時間へ足される**
 *   (202603 木村 入浴時間1500分/訪問件数16件 ≈ 94分/件、202608 HO 1080分/12件 = 90分/件。
 *    入浴時間が 0 の月は 訪問件数も 0)。茂原は bath_minutes だけを使う。
 * ⚠ 「入浴件数」列 (×1.12h でおゆみ野が使う式) は 茂原の総括表には **存在しない**。
 *   列がある事業所が出てきたら ここに足す前に 二重にならないか確かめること。
 */
const MAP = [["入浴時間", "bath_minutes"]];

const pofs = await get("payroll_offices?select=id,office_number,office_id&order=id");
const offs = await get("offices?select=id,name&order=id");
const onm = new Map(offs.map((o) => [o.id, o.name]));
const disp = new Map(pofs.map((o) => [o.office_number, onm.get(o.office_id) ?? o.office_number]));
const rows = await get("payroll_soukatsu_rows?select=office_number,processing_month,employee_number,sheet_kind,row_data&order=id");
const cur = await get("payroll_monthly_inputs?select=office_number,employee_number,processing_month,item_key,numeric_value&item_key=in.(bath_minutes,bath_visit_count)&order=id");
const have = new Map(cur.map((r) => [`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}|${r.item_key}`, num(r.numeric_value)]));

const ops = [];
for (const r of rows) {
  if (r.sheet_kind !== "shaseki") continue;                    // 介護超過は社員シートだけ
  const d = r.row_data;
  for (const [col, key] of MAP) {
    if (!(col in d)) continue;
    const v = num(d[col]); if (v <= 0) continue;
    const k = `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}|${key}`;
    if (have.get(k) === v) continue;
    ops.push({ office_number: r.office_number, employee_number: String(r.employee_number), processing_month: r.processing_month,
      item_key: key, numeric_value: v,
      note: `総括表 「${col}」 から (sync_bath_inputs_from_soukatsu.mjs) 2026-09-24`,
      label: `${disp.get(r.office_number)} ${String(d["氏名"] ?? "").replace(/\n/g, "/")} ${r.processing_month} ${key} ${have.has(k) ? `${have.get(k)} → ` : ""}${v}` });
  }
}
console.log(`=== 総括表の入浴 → 月ごとの手入力 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${ops.length} 件 ===`);
for (const o of ops) console.log("  " + o.label);
if (!EXECUTE || ops.length === 0) { console.log("DRY RUN。--execute で書き込みます"); process.exit(0); }
const body = ops.map(({ label, ...x }) => { void label; return x; });
const res = await fetch(`${SB}/rest/v1/payroll_monthly_inputs?on_conflict=office_number,employee_number,processing_month,item_key`, {
  method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body) });
const b = await res.json();
if (!res.ok || !Array.isArray(b) || b.length !== body.length) { console.error("★ 書き込みに失敗:", JSON.stringify(b).slice(0, 400)); process.exit(1); }
console.log(`  反映 ${b.length} 件`);
