/**
 * 総括表 (実際に払った額) を検証用のテーブルに取り込む (2026-09-23)。
 *
 *   SP=<scratchpad> node migrations/import_soukatsu_rows.mjs            # DRY RUN
 *   SP=<scratchpad> node migrations/import_soukatsu_rows.mjs --execute
 *
 * 元は scratchpad の `soukatsu<YYYYMM>/extract.json` (総括表の xlsm から抜いたもの)。
 * 1 ファイル = 1 事業所 1 シート、`kind` は part (パート) / shaseki (提責・社員)。
 *
 * ⚠ **Box の総括表そのものは読むだけ。編集・上書きはしない** (user 指示)。
 * ⚠ 移行期だけのテーブル。本稼働後は総括表が無くなるので 落とす。
 * ⚠ 「合計」「小計」の集計行は入れない (茂原は 集計行にも従業員コードが入っている)。
 * 冪等: (処理月, 事業所, 職員, シート) で upsert。
 */
import { readFileSync, existsSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const SP = process.env.SP;
if (!SP) { console.error("SP=<soukatsu*/extract.json のある作業フォルダ> を指定"); process.exit(1); }
const MONTHS = (process.env.MONTHS ?? "202603,202604,202605,202606,202607,202608").split(",");

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
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" };

const OFF = { "04_おゆみ野": "1270501180", "06_さつき": "1270203191", "02_花見川": "1270201930", "05_高品": "1270402116", "11_Hana四街道": "1270303173", "06_Hana中央": "1270105271", "04_Hana船橋": "1270906546", "10_Hana八千代": "1272603851", "03_やわた": "1272404508", "03_五井": "1272401967", "01_KT姉崎": "1272400142", "05_Hanaちはら台": "1272403534", "01_姉崎ムツミ": "1272400829", "リンクス茂原": "1271500942", "08_いすみ": "1278600398", "09_山武": "1279000366", "リンクス大網": "1275800892", "03_木更津ムツミ": "1271101295", "02_市原ムツミ": "1272401561", "07_袖ケ浦": "1273400844", "14_君津": "1273001626", "13_東郷": "1271502518" };
const nn = (s) => String(s ?? "").replace(/^0+/, "");

const rows = [];
const skipped = [];
for (const M of MONTHS) {
  const path = `${SP}/soukatsu${M}/extract.json`;
  if (!existsSync(path)) { skipped.push(`${M}: extract.json が無い`); continue; }
  const sheets = JSON.parse(readFileSync(path, "utf8"));
  for (const f of sheets) {
    const on = OFF[f.office];
    if (!on) { skipped.push(`${M} ${f.office}: 事業所番号が分からない`); continue; }
    for (const r of f.rows) {
      const code = nn(r._code);
      const name = String(r["氏名"] ?? "").trim();
      if (!code || !name) continue;
      if (/合計|小計/.test(name) || String(r._code).includes("合計")) continue;   // 集計行
      rows.push({
        processing_month: M,
        office_number: on,
        employee_number: code,
        employee_name: name,
        sheet_kind: f.kind === "part" ? "part" : "shaseki",
        row_data: r,
        source_file: f.file ?? null,
      });
    }
  }
}

// 同じキーが 2 度出たら 後勝ち (シートが分かれている事業所がある)
const byKey = new Map();
for (const r of rows) byKey.set(`${r.processing_month}|${r.office_number}|${r.employee_number}|${r.sheet_kind}`, r);
const body = [...byKey.values()];

const byMonth = {};
for (const r of body) byMonth[r.processing_month] = (byMonth[r.processing_month] ?? 0) + 1;
console.log(`=== 総括表の取込 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${body.length} 行 ===`);
console.log("  月別:", JSON.stringify(byMonth));
console.log("  シート別:", JSON.stringify(body.reduce((a, r) => { a[r.sheet_kind] = (a[r.sheet_kind] ?? 0) + 1; return a; }, {})));
if (skipped.length) { console.log("--- 取り込めなかったもの"); for (const s of skipped) console.log("  " + s); }
if (!EXECUTE || body.length === 0) { console.log("DRY RUN。--execute で書き込みます"); process.exit(0); }

let done = 0;
for (let i = 0; i < body.length; i += 500) {
  const chunk = body.slice(i, i + 500);
  const res = await fetch(`${SB_URL}/rest/v1/payroll_soukatsu_rows?on_conflict=processing_month,office_number,employee_number,sheet_kind`, {
    method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(chunk) });
  const b = await res.json();
  if (!res.ok || !Array.isArray(b) || b.length !== chunk.length) { console.error("★ 書き込みに失敗:", JSON.stringify(b).slice(0, 400)); process.exit(1); }
  done += b.length;
  console.log(`  ${done}/${body.length}`);
}
console.log(`  反映 ${done} 行`);
