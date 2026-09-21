/**
 * 総括表 xlsm の「総括表データ_パート」シートから 会議1/2/3件数 を事業所書式に取り込む (2026-09-21)。
 *
 *   node migrations/import_soukatsu_meeting_counts.mjs            # DRY RUN
 *   node migrations/import_soukatsu_meeting_counts.mjs --execute
 *   SOUKATSU=<dir> node ...   # 総括表の置き場 (既定は scratchpad の soukatsu<YYYYMM>)
 *
 * なぜ: 会議費 = 会議1件数×1,500 + 会議2件数×1,150 + 会議3件数×1,150 + 会議時間×1,150/60 で、
 *   この **「件数」の入力欄が 事業所入力 (旧システム) にも 事業所書式 (xlsm) にも無い**。
 *   旧システムの出力である「総括表データ_パート」シートにだけ 1 人ずつ入っている。
 *   ⚠ 取るのは件数だけ。金額 (会議費・研修費) は取らない。金額は当方のロジックで計算して突合する。
 *
 * ⚠ 会議の「時間」(開始・終了) は別の入力。件数として数えると二重計上になる。
 * ⚠ 市原ムツミの xlsm にはこのシートが無い。その事業所月は触らない。
 * 冪等: (office_number, processing_month) の 会議N件数 だけ消して入れ直す。
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";

const EXECUTE = process.argv.includes("--execute");
const SOUKATSU = process.env.SOUKATSU || "C:/Users/domen-PC/AppData/Local/Temp/claude/C--Users-domen-PC-Downloads---------/f92df4c4-f5b9-4d0e-8db9-bd810cfdc5d6/scratchpad";
const MONTHS = (process.env.MONTHS || "202603,202604,202605,202606,202607").split(",");

/** 総括表のフォルダ名 → 事業所番号 */
const OFFNUM = {
  "04_おゆみ野": "1270501180", "06_さつき": "1270203191", "02_花見川": "1270201930", "05_高品": "1270402116",
  "11_Hana四街道": "1270303173", "06_Hana中央": "1270105271", "04_Hana船橋": "1270906546",
  "10_Hana八千代": "1272603851", "03_やわた": "1272404508", "03_五井": "1272401967",
  "01_KT姉崎": "1272400142", "05_Hanaちはら台": "1272403534", "01_姉崎ムツミ": "1272400829",
  "リンクス茂原": "1271500942", "08_いすみ": "1278600398", "09_山武": "1279000366",
  "リンクス大網": "1275800892", "03_木更津ムツミ": "1271101295", "02_市原ムツミ": "1272401561",
  "07_袖ケ浦": "1273400844", "14_君津": "1273001626", "13_東郷": "1271502518", "04_いわね": "1271502500",
};

const env = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL + "/rest/v1/";
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };

const nn = (s) => String(s ?? "").trim().replace(/^0+/, "");
const int = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };

const out = new Map();   // "office|month" → rows
const skipped = [];
for (const m of MONTHS) {
  const root = join(SOUKATSU, `soukatsu${m}`);
  if (!existsSync(root)) { console.warn(`⚠ 総括表が無い: ${root}`); continue; }
  for (const corp of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const off of readdirSync(join(root, corp.name), { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const office = OFFNUM[off.name];
      if (!office) { skipped.push(`${m} ${off.name} (事業所番号が引けない)`); continue; }
      const files = readdirSync(join(root, corp.name, off.name)).filter((f) => /_パート_\d{6}\.xlsm$/.test(f));
      for (const f of files) {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(join(root, corp.name, off.name, f));
        const ws = wb.worksheets.find((w) => w.name.includes("総括表データ_パート"));
        if (!ws) { skipped.push(`${m} ${off.name} (総括表データ_パート シートが無い)`); continue; }
        // ヘッダー行 (「従業員コード」がある行) を探して 行オブジェクトに直す
        let hdr = null, cols = {};
        for (let r = 1; r <= Math.min(10, ws.rowCount); r++) {
          const vals = ws.getRow(r).values;
          if (Array.isArray(vals) && vals.some((v) => String(v ?? "").trim() === "従業員コード")) {
            hdr = r;
            vals.forEach((v, i) => { const k = String(v ?? "").trim(); if (k) cols[k] = i; });
            break;
          }
        }
        if (hdr === null) { skipped.push(`${m} ${off.name} (ヘッダー行が見つからない)`); continue; }
        const rows = [];
        for (let r = hdr + 1; r <= ws.rowCount; r++) {
          const vals = ws.getRow(r).values;
          const o = {};
          for (const [k, i] of Object.entries(cols)) { const v = vals[i]; o[k] = (v && typeof v === "object" && "result" in v) ? v.result : v; }
          rows.push(o);
        }
        const key = `${office}|${m}`;
        if (!out.has(key)) out.set(key, { office_number: office, processing_month: m, folder: off.name, rows: [] });
        const b = out.get(key);
        for (const r of rows) {
          const emp = nn(r["従業員コード"]);
          if (!emp) continue;
          for (const k of ["会議1件数", "会議2件数", "会議3件数"]) {
            const v = int(r[k]);
            if (v > 0) b.rows.push({
              office_number: office, employee_number: emp, processing_month: m,
              record_type: "km", item_name: k, numeric_value: v,
              item_date: null, start_time: null, end_time: null, break_time: null,
              year_month: null, child_name: null, amount: null,
            });
          }
        }
      }
    }
  }
}

console.log(`事業所×月 ${out.size}`);
const tally = new Map();
let total = 0;
for (const [, v] of [...out].sort()) {
  total += v.rows.length;
  for (const r of v.rows) tally.set(r.item_name, (tally.get(r.item_name) ?? 0) + r.numeric_value);
}
console.log(`  会議の件数レコード ${total} 行`);
for (const [k, v] of [...tally].sort()) console.log(`    ${k} 合計 ${v} 件`);
const byOff = new Map();
for (const [, v] of out) { const k = v.folder; byOff.set(k, (byOff.get(k) ?? 0) + v.rows.length); }
console.log("  事業所別:", [...byOff].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(" "));
if (skipped.length) console.log("  ⚠ 飛ばした:", [...new Set(skipped)].join(" / "));

if (!EXECUTE) { console.log("\nDRY RUN (--execute で書き込み)"); process.exit(0); }

for (const [, v] of out) {
  const del = await fetch(`${SB}payroll_office_form_records?office_number=eq.${v.office_number}&processing_month=eq.${v.processing_month}&item_name=in.(会議1件数,会議2件数,会議3件数)`, { method: "DELETE", headers: { ...H, Prefer: "return=minimal" } });
  if (!del.ok) { console.error(`✗ 既存の削除に失敗 (${v.office_number} ${v.processing_month}): ${await del.text()}`); process.exit(1); }
  for (let i = 0; i < v.rows.length; i += 300) {
    const res = await fetch(`${SB}payroll_office_form_records`, { method: "POST", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify(v.rows.slice(i, i + 300)) });
    if (!res.ok) { console.error(`✗ 書き込み失敗 (${v.office_number} ${v.processing_month}): ${await res.text()}`); process.exit(1); }
  }
}
console.log(`完了 ${total} 行`);
