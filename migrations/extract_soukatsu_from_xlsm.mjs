/**
 * 総括表 xlsm (Box) を直接読んで JSON に抽出する (2026-09-26)。
 *
 *   node migrations/extract_soukatsu_from_xlsm.mjs                 # DRY RUN (件数のみ)
 *   node migrations/extract_soukatsu_from_xlsm.mjs --execute        # scratchpad に extract 済み JSON を書く (Boxには書かない)
 *   OUT=<dir> node migrations/extract_soukatsu_from_xlsm.mjs --execute
 *
 * なぜ: payroll_soukatsu_rows (検証用テーブル) を作った旧セッションの xlsm→JSON 抽出スクリプトが
 *   リポジトリに残っておらず、しかも実データ突合で「実在しない値」「他職員の値との入れ替わり」
 *   「孤立値」が見つかった (2026-09-26 給与D)。抽出処理を作り直して壊れ方の規模を測るためのもの。
 *
 * ⚠ Box は読むだけ。一切書き込まない。
 * ⚠ 列は **ヘッダー名で引く** (位置の決め打ちはしない。利用者マスタCSVの列ズレ事故の教訓)。
 * ⚠ 職員の対応は **従業員コード (先頭0を落とした文字列)** で取る。氏名は表記ゆれがあるため主キーにしない。
 * ⚠ 「合計」「小計」を含む名前の行、従業員コードが空の行は skip。
 *
 * 出力: <OUT>/soukatsu_extract_<processing_month>.json
 *   [{ office_number, employee_number, employee_name, processing_month, sheet_kind, row_data, source_file }]
 */
import { readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ExcelJS = require("exceljs");

const EXECUTE = process.argv.includes("--execute");
const OUT = process.env.OUT || "C:/Users/domen-PC/AppData/Local/Temp/claude/C--Users-domen-PC-Downloads---------/2891151f-c7b0-42ed-ad03-f7911938da20/scratchpad/soukatsu_extract";
const MONTHS = (process.env.MONTHS || "202603,202604,202605,202606,202607,202608").split(",");

const BOX_ROOT = "C:/Users/domen-PC/Box/10F内共有/02_共有/10_給与/01_総括表";
const MONTH_TO_RDIR = { "202603": "R8.3", "202604": "R8.4", "202605": "R8.5", "202606": "R8.6", "202607": "R8.7", "202608": "R8.8" };

// フォルダ名 (会社/事業所) → office_number。事業所名の表記ゆれを吸収するため部分一致で解決する。
const OFFICE_NAME_TO_NUMBER = {
  "KT姉崎": "1272400142", "花見川": "1270201930", "五井": "1272401967", "おゆみ野": "1270501180",
  "高品": "1270402116", "さつき": "1270203191", "袖ケ浦": "1273400844", "いすみ": "1278600398",
  "山武": "1279000366", "東郷": "1271502518", "君津": "1273001626", "やわた": "1272404508",
  "いわね": "1271103184", "姉崎ムツミ": "1272400829", "市原ムツミ": "1272401561", "木更津ムツミ": "1271101295",
  "Hana船橋": "1270906546", "Hanaちはら台": "1272403534", "Hana中央": "1270105271", "Hana八千代": "1272603851",
  "Hana四街道": "1270303173", "リンクス大網": "1275800892", "リンクス茂原": "1271500942",
};
function resolveOffice(dirName) {
  const clean = dirName.replace(/^\d+_/, "");
  for (const [name, num] of Object.entries(OFFICE_NAME_TO_NUMBER)) {
    if (clean.includes(name) || name.includes(clean)) return num;
  }
  return null;
}

// 会社フォルダごとの月ディレクトリの決め方 (至誠堂だけ命名規則が違う)
const COMPANY_DIRS = [
  { company: "10_ケイティ", monthDir: (m) => MONTH_TO_RDIR[m] },
  { company: "15_サービスワン", monthDir: (m) => MONTH_TO_RDIR[m] },
  { company: "15_リンクス茂原.大網", monthDir: (m) => MONTH_TO_RDIR[m] },
];
const SHISEIDO_OFFICES = ["03_やわた", "04_いわね"];

function listTargetFiles() {
  const found = [];
  for (const { company, monthDir } of COMPANY_DIRS) {
    for (const m of MONTHS) {
      const rdir = monthDir(m);
      const base = join(BOX_ROOT, company, rdir);
      let officeDirs;
      try { officeDirs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
      for (const od of officeDirs) {
        const odir = join(base, od.name);
        let files;
        try { files = readdirSync(odir); } catch { continue; }
        for (const f of files) {
          if (f.startsWith("~$")) continue;
          if (/_(パート|提責[_・]社員)_\d{6}\.xlsm$/.test(f) && f.includes(m)) {
            found.push({ company, month: m, officeDir: od.name, file: f, path: join(odir, f), kind: f.includes("パート") ? "part" : "shaseki" });
          }
        }
      }
    }
  }
  for (const od of SHISEIDO_OFFICES) {
    for (const m of MONTHS) {
      const rnum = MONTH_TO_RDIR[m].replace("R8.", "");
      const base = join(BOX_ROOT, "10_至誠堂", od, `R8.${rnum}月稼働`);
      let files;
      try { files = readdirSync(base); } catch { continue; }
      for (const f of files) {
        if (f.startsWith("~$")) continue;
        if (/_(パート|提責[_・]社員)_\d{6}\.xlsm$/.test(f) && f.includes(m)) {
          found.push({ company: "10_至誠堂", month: m, officeDir: od, file: f, path: join(base, f), kind: f.includes("パート") ? "part" : "shaseki" });
        }
      }
    }
  }
  return found;
}

async function extractFile(entry) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(entry.path);
  const sheetNameWant = entry.kind === "part" ? "総括表データ_パート" : "総括表データ_提責_社員";
  const ws = wb.worksheets.find((w) => w.name.includes(sheetNameWant));
  if (!ws) return { rows: [], warn: `シート無し (${sheetNameWant})` };
  // ヘッダー行 (「従業員コード」を含む行) を探す
  let hdr = null, cols = {};
  for (let r = 1; r <= Math.min(10, ws.rowCount); r++) {
    const vals = ws.getRow(r).values;
    if (Array.isArray(vals) && vals.some((v) => String(v ?? "").trim() === "従業員コード")) {
      hdr = r;
      vals.forEach((v, i) => { const k = String(v ?? "").trim(); if (k && !(k in cols)) cols[k] = i; });
      break;
    }
  }
  if (hdr === null) return { rows: [], warn: "ヘッダー行 (従業員コード) が見つからない" };
  const rows = [];
  for (let r = hdr + 1; r <= ws.rowCount; r++) {
    const vals = ws.getRow(r).values;
    const rawEmp = vals[cols["従業員コード"]];
    const emp = String((rawEmp && typeof rawEmp === "object" && "result" in rawEmp) ? rawEmp.result : rawEmp ?? "").trim().replace(/^0+/, "");
    const rawName = vals[cols["氏名"]];
    const name = String((rawName && typeof rawName === "object" && "result" in rawName) ? rawName.result : rawName ?? "").trim();
    if (!emp || !name) continue;
    if (/合計|小計/.test(name)) continue;
    const row_data = {};
    for (const [k, i] of Object.entries(cols)) {
      const v = vals[i];
      row_data[k] = (v && typeof v === "object" && "result" in v) ? v.result : (v ?? null);
    }
    rows.push({ employee_number: emp, employee_name: name, row_data });
  }
  return { rows, warn: null };
}

const files = listTargetFiles();
console.log(`=== 総括表 xlsm 抽出 ${EXECUTE ? "【実行】(scratchpadへ書く。Boxには書かない)" : "(DRY RUN)"} ===`);
console.log(`対象ファイル: ${files.length} 件`);

const unresolved = new Set();
const byMonth = new Map();
for (const f of files) {
  const office_number = resolveOffice(f.officeDir);
  if (!office_number) { unresolved.add(f.officeDir); continue; }
  if (!byMonth.has(f.month)) byMonth.set(f.month, []);
  byMonth.get(f.month).push({ ...f, office_number });
}
if (unresolved.size) {
  console.log("★ 事業所番号を解決できなかったフォルダ (対象外):", [...unresolved].join(", "));
}

if (!EXECUTE) {
  console.log("月別ファイル数:", JSON.stringify(Object.fromEntries([...byMonth].map(([m, a]) => [m, a.length]))));
  console.log("DRY RUN。--execute で scratchpad に書き込みます (Boxへの書込みはありません)");
  process.exit(0);
}

// 同じ (事業所, 職員, 月, シート) が 2 ファイルに出たときの勝者の決め方。
// ★ import_soukatsu_rows.mjs (813ca46) と同じ規則にする。ここがズレると 検証テーブルと原本の突合で
//   「別の版どうしを比べている」偽の不一致が出る (2026-09-26: おゆみ野 202604 で 過誤版が
//   ファイル名の並び順で後勝ちしていた)。
//   ① ファイル名が 過誤/訂正/再/コピー で始まる版を負けにする (通常版を優先)
//   ② 同格なら後勝ち
//   ③ 勝者の値がエラー文字列 (#VALUE! 等) の項目だけ 敗者の値で埋める
const LOSER_FILE = /(^|[\\\/])\s*(過誤|訂正|再|コピー)/;
const isErrorValue = (v) => typeof v === "string" && /^#/.test(v.trim());

mkdirSync(OUT, { recursive: true });
let totalRows = 0, totalWarn = 0;
const overwritten = [];
for (const [month, entries] of byMonth) {
  const byKey = new Map();
  for (const e of entries) {
    const { rows, warn } = await extractFile(e);
    if (warn) { console.warn(`  ⚠ ${e.path}: ${warn}`); totalWarn++; continue; }
    for (const r of rows) {
      const row = {
        office_number: e.office_number,
        employee_number: r.employee_number,
        employee_name: r.employee_name,
        processing_month: month,
        sheet_kind: e.kind,
        row_data: r.row_data,
        source_file: e.file,
      };
      const k = `${row.office_number}|${row.employee_number}|${row.sheet_kind}`;
      const prev = byKey.get(k);
      if (!prev) { byKey.set(k, row); continue; }
      const prevLoses = LOSER_FILE.test(prev.source_file), curLoses = LOSER_FILE.test(row.source_file);
      const winner = prevLoses && !curLoses ? row : !prevLoses && curLoses ? prev : row;
      const loser = winner === row ? prev : row;
      let filled = 0;
      for (const [key, v] of Object.entries(winner.row_data)) {
        const alt = loser.row_data[key];
        if (isErrorValue(v) && alt != null && !isErrorValue(alt)) { winner.row_data[key] = alt; filled++; }
      }
      byKey.set(k, winner);
      overwritten.push(`${month} ${k}  採用=${winner.source_file}  不採用=${loser.source_file}${filled ? `  (エラー ${filled} 項目を補完)` : ""}`);
    }
    totalRows += rows.length;
  }
  const out = [...byKey.values()];
  const outPath = join(OUT, `soukatsu_extract_${month}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(`  ${month}: ${out.length} 行 → ${outPath}`);
}
if (overwritten.length) {
  const files = new Set(overwritten.map((s) => s.replace(/^.*?\s採用=/, "採用=").replace(/\s+\(エラー.*$/, "")));
  console.log(`同じ職員が2ファイルに出た人月: ${overwritten.length} 件 (ファイルの組 ${files.size}):`);
  for (const f of files) console.log(`  ${f}`);
}
console.log(`合計 ${totalRows} 行 読込 (警告 ${totalWarn} 件)`);
