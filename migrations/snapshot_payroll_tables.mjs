/**
 * payroll の主要テーブルを **ファイルに写して**、後から 変化の検知 と 復元 ができるようにする (2026-10-01)。
 *
 *   node migrations/snapshot_payroll_tables.mjs --out <dir>              … 写す (既定 _snapshot_<YYYYMMDD>)
 *   node migrations/snapshot_payroll_tables.mjs --diff <dir>             … 今の DB と写しを比べる (読み取り専用)
 *   node migrations/snapshot_payroll_tables.mjs --diff <dir> --detail    … 変わった行の id まで出す
 *   node migrations/snapshot_payroll_tables.mjs --restore <dir> --table <t>            … DRY RUN
 *   node migrations/snapshot_payroll_tables.mjs --restore <dir> --table <t> --execute  … 戻す
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────────
 * 給与計算スタッフが同じ DB で実験する予定 (2026-10-01 user)。★ RLS は authenticated なら全部読み書きできる
 * (`FOR ALL TO authenticated USING (true)`) ので、★ アカウントを分けてもデータは分かれない。
 * ★ 出勤簿の取込は 対象月を消して入れ直す / 月ごとの手入力は上書き なので、★ 戻せなくなる経路がある。
 * → ★ 先に写しを取っておけば ① 何が動いたか分かる ② 戻せる。
 *
 * ⚠ ★ payroll_service_records (356,550 行) と payroll_legacy_daily (53,255 行) は **写さない**。
 *   ★ どちらも CSV から入れ直せる (取込 script がある) ので、★ 写しの価値より 容量と時間の負担が勝つ。
 *   ★ 写すのは **人が入れた / 計算で作った もの**だけ。
 *
 * ⚠ --restore は **消してから入れ直す**。★ 必ず --diff で中身を見てから。
 *   ★ 既定は DRY RUN。★ --execute を付けたときだけ書く。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

const argOf = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const EXECUTE = process.argv.includes("--execute");
const DETAIL = process.argv.includes("--detail");
const OUT = argOf("--out");
const DIFF = argOf("--diff");
const RESTORE = argOf("--restore");
const ONLY_TABLE = argOf("--table");

/** 写すテーブル。★ id で並べて 全件取る */
const TABLES = [
  "payroll_calc_results",        // 給与計算の結果 (★ 検証の対象そのもの)
  "payroll_monthly_status",      // 事業所×月の状態 (確定など)
  "payroll_monthly_inputs",      // 月ごとの手入力 (★ 人が入れた値。消えると戻せない)
  "payroll_office_form_records", // 事業所書式 (★ 同上)
  "payroll_salary_settings",     // 給与設定 (★ 月を持たない = 過去月にも効く)
  "payroll_employees",           // 職員マスタ (★ 同上)
  "payroll_offices",             // 事業所マスタ (★ 同上)
  "payroll_attendance_records",  // 出勤簿 (★ 取込が 対象月を消して入れ直す)
  "payroll_soukatsu_rows",       // ② 総括表 (★ 突合の正)
];

const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) { console.error("★ .env.local が読めません"); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function readAll(table) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB}/rest/v1/${table}?select=*&order=id&offset=${from}&limit=1000`, { headers: H });
    if (!r.ok) throw new Error(`${table} ${r.status} ${await r.text()}`);
    const j = await r.json();
    out.push(...j);
    if (j.length < 1000) break;
  }
  return out;
}
const hashOf = (rows) => createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
/** 行を id で引ける形に。★ 比較から外す列 (毎回変わるもの) はここで落とす */
const SKIP_COLS = new Set(["updated_at"]);
const normRow = (r) => { const o = {}; for (const k of Object.keys(r).sort()) if (!SKIP_COLS.has(k)) o[k] = r[k]; return o; };
const rowKey = (r) => JSON.stringify(normRow(r));

async function doSnapshot(dir) {
  mkdirSync(dir, { recursive: true });
  const manifest = { takenAt: new Date().toISOString(), tables: {} };
  for (const t of TABLES) {
    const rows = await readAll(t);
    writeFileSync(`${dir}/${t}.json`, JSON.stringify(rows), "utf8");
    manifest.tables[t] = { rows: rows.length, hash: hashOf(rows) };
    console.log(`  ${String(rows.length).padStart(7)} 行  ${t}  (${manifest.tables[t].hash})`);
  }
  writeFileSync(`${dir}/_manifest.json`, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`\n写しました: ${dir}`);
  console.log("★ 後で比べる: node migrations/snapshot_payroll_tables.mjs --diff " + dir);
}

async function doDiff(dir) {
  if (!existsSync(`${dir}/_manifest.json`)) { console.error(`★ ${dir}/_manifest.json がありません`); process.exit(2); }
  const man = JSON.parse(readFileSync(`${dir}/_manifest.json`, "utf8"));
  console.log(`写しの時刻: ${man.takenAt}\n`);
  let changed = 0;
  for (const t of TABLES) {
    const before = JSON.parse(readFileSync(`${dir}/${t}.json`, "utf8"));
    const after = await readAll(t);
    const b = new Map(before.map((r) => [String(r.id), r])), a = new Map(after.map((r) => [String(r.id), r]));
    const added = [...a.keys()].filter((k) => !b.has(k));
    const removed = [...b.keys()].filter((k) => !a.has(k));
    const modified = [...a.keys()].filter((k) => b.has(k) && rowKey(a.get(k)) !== rowKey(b.get(k)));
    if (!added.length && !removed.length && !modified.length) { console.log(`  o ${t.padEnd(30)} 変化なし (${after.length} 行)`); continue; }
    changed++;
    console.log(`  ★ ${t.padEnd(30)} 増 ${added.length} / 減 ${removed.length} / 変更 ${modified.length}  (${before.length} → ${after.length} 行)`);
    if (DETAIL) {
      for (const k of added.slice(0, 10)) console.log(`       + ${k} ${JSON.stringify(a.get(k)).slice(0, 120)}`);
      for (const k of removed.slice(0, 10)) console.log(`       − ${k} ${JSON.stringify(b.get(k)).slice(0, 120)}`);
      for (const k of modified.slice(0, 10)) console.log(`       ~ ${k} ${JSON.stringify(a.get(k)).slice(0, 120)}`);
    }
  }
  console.log(changed ? `\n★ ${changed} 表が変わっています。--detail で中身を出せます` : "\n全部 写しのままです");
}

async function doRestore(dir) {
  if (!ONLY_TABLE) { console.error("★ --table <テーブル名> が要ります (1 表ずつ戻す)"); process.exit(2); }
  if (!TABLES.includes(ONLY_TABLE)) { console.error(`★ ${ONLY_TABLE} は写しの対象ではありません`); process.exit(2); }
  const before = JSON.parse(readFileSync(`${dir}/${ONLY_TABLE}.json`, "utf8"));
  const after = await readAll(ONLY_TABLE);
  console.log(`${ONLY_TABLE}: 今 ${after.length} 行 → 写しの ${before.length} 行 に戻す`);
  console.log("⚠ ★ 今の行を **全部消してから** 入れ直します");
  if (!EXECUTE) { console.log("\n(DRY RUN。--execute で実行します)"); return; }
  const ids = after.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100).map((x) => `"${x}"`).join(",");
    const r = await fetch(`${SB}/rest/v1/${ONLY_TABLE}?id=in.(${chunk})`, { method: "DELETE", headers: H });
    if (!r.ok) throw new Error(`DELETE ${r.status} ${await r.text()}`);
  }
  for (let i = 0; i < before.length; i += 100) {
    const r = await fetch(`${SB}/rest/v1/${ONLY_TABLE}`, { method: "POST", headers: H, body: JSON.stringify(before.slice(i, i + 100)) });
    if (!r.ok) throw new Error(`POST ${r.status} ${await r.text()}`);
  }
  console.log(`戻しました (${before.length} 行)`);
}

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
if (DIFF) { console.log(`=== 写しと比べる: ${DIFF} ===`); await doDiff(DIFF); }
else if (RESTORE) { console.log(`=== 写しから戻す: ${RESTORE} ===`); await doRestore(RESTORE); }
else {
  const dir = OUT ?? `../../_snapshot_payroll_${stamp}`;
  console.log(`=== payroll の主要テーブルを写す → ${dir} ===`);
  console.log("★ service_records (356,550行) と legacy_daily (53,255行) は CSV から入れ直せるので写しません");
  if (existsSync(dir) && readdirSync(dir).length) { console.error(`★ ${dir} に既にファイルがあります。別の --out を指定してください`); process.exit(2); }
  await doSnapshot(dir);
}
