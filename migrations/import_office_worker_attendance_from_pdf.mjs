/**
 * 事務員の 出勤時間・残業 を スキャンPDF の読み取り結果 (TSV) から取り込む (2026-09-26)。
 *
 *   node migrations/import_office_worker_attendance_from_pdf.mjs --office 1272400142 --file <path.tsv>
 *   node migrations/import_office_worker_attendance_from_pdf.mjs --office 1272400142 --file <path.tsv> --execute
 *
 * 【なぜ必要か】
 * 事務員 8 名は 出勤簿 (payroll_attendance_records) が 0 行で、事業所書式にも
 * 出勤時間・残業 が 1 件も無い (km / 有給 / 研修 だけ)。元データが スキャンPDF しか無い。
 *
 * ★ 計算では出せない。総括表の 出勤時間・出勤日数 から
 *     残業 = max(0, 出勤時間 - 480 * 出勤日数)
 *   を当てると 42 人月中 34 しか合わない (稲葉香織 4 / 加瀬 2 / 牛来 1 / 本田 1 が外れる)。
 *   全社 shaseki 1,296 人月に当てると 21.5% なので 事務員専用かつ不完全な式。
 *
 * ★ PDF の様式は 事業所 x 雇用形態 で違う。「印字が正」「赤字が正」は一律ではない。
 *   五井 加瀬真紀江 (社員・クロック式出勤簿あり): 5 ヶ月中 4 ヶ月で印字の集計が誤っており
 *     毎月 赤字で訂正している (202606 だけ訂正が無く印字がそのまま最終値)。
 *       202603 印字 173:24 / 5:24 -> 赤字 171:24 / 3:24 = DB 10284 / 204
 *       202607 印字 162:59 / 7:09 -> 赤字 174:41 / 7:26 = DB 10481 / 446
 *   おゆみ野 世古啓子・牛来葉子 (事務系の別様式・残業列なし): 印字がそのまま総括表と一致する。
 *   大網 稲葉香織: クロック式出勤簿が存在せず、ロスター表のセルに直接上書きされた値だけ。
 *
 * 【TSV の形式】1 行 1 人月。タブ区切り。1 行目がヘッダーでもよい (自動で読み飛ばす)
 *   employee_number, processing_month, work_minutes, overtime_minutes, source, 備考
 *     source = 印字 | 赤字 | ロスター | 無し
 *
 * ⚠ **source=ロスター は 総括表そのもの**なので、入れても検証にはならない (循環参照)。
 *   note に出どころを必ず残し、あとから「独立した一次情報で裏が取れた人月」と区別できるようにする。
 *   既定では ロスター は **取り込まない**。--allow-roster を付けたときだけ入れる。
 * ⚠ 職員番号は事業所をまたぐと重複するので、--office と対で必ず検証する。
 * ⚠ 読み取れなかった人月 (source=無し) は **入れない**。埋めると誤った金額になる。
 */
const EXECUTE = process.argv.includes("--execute");
const ALLOW_ROSTER = process.argv.includes("--allow-roster");
const argOf = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const OFFICE = argOf("--office");
const FILES = process.argv.reduce((a, v, i) => (process.argv[i - 1] === "--file" ? [...a, v] : a), []);
import { readFileSync } from "node:fs";
if (!OFFICE || FILES.length === 0) {
  console.error("使い方: --office <事業所番号> --file <path.tsv> [--file ...] [--allow-roster] [--execute]");
  process.exit(1);
}
const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" };
const get = async (q) => { const r = await fetch(`${SB}/rest/v1/${q}`, { headers: H }); const j = await r.json(); if (!Array.isArray(j)) throw new Error(JSON.stringify(j)); return j; };
const normNum = (s) => String(s ?? "").trim().replace(/^0+/, "");
const toInt = (v) => { const s = String(v ?? "").trim(); if (s === "" || s === "-") return null; const n = Number(s.replace(/[, ]/g, "")); return Number.isFinite(n) ? Math.round(n) : null; };

// -- TSV を読む --------------------------------------------------------
const rows = [];
const bad = [];
for (const f of FILES) {
  let text = ""; try { text = readFileSync(f, "utf8"); } catch (e) { console.error(`★ 読めません: ${f} (${e.message})`); process.exit(1); }
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const c = line.split("\t");
    if (c.length < 5) { bad.push(`${f}:${i + 1} 列が足りません (${c.length}列): ${line.slice(0, 80)}`); continue; }
    const [num, month, work, ot, source, ...rest] = c.map((x) => String(x).trim());
    if (!/^\d{6}$/.test(month)) { if (i === 0) continue; bad.push(`${f}:${i + 1} processing_month が YYYYMM でない: ${month}`); continue; }
    rows.push({ file: f, line: i + 1, num: normNum(num), month, work: toInt(work), ot: toInt(ot), source, note: rest.join(" ").trim() });
  }
}
if (bad.length) { console.log(`--- 読めなかった行 ${bad.length} 件`); for (const b of bad) console.log("  " + b); }
if (rows.length === 0) { console.error("★ 取り込める行がありません"); process.exit(1); }

// -- 職員を 事業所と対で検証する ---------------------------------------
const offices = await get(`payroll_offices?select=id,office_number&office_number=eq.${OFFICE}`);
if (offices.length !== 1) { console.error(`★ 事業所 ${OFFICE} を一意に特定できません`); process.exit(1); }
const officeId = offices[0].id;
const emps = await get(`payroll_employees?select=employee_number,name,role_type,is_office_worker&office_id=eq.${officeId}`);
const byNum = new Map(emps.map((e) => [normNum(e.employee_number), e]));

const ops = [], skipped = [];
for (const r of rows) {
  const e = byNum.get(r.num);
  if (!e) { skipped.push(`${r.file}:${r.line} 職員 ${r.num} が事業所 ${OFFICE} に居ません ★職員番号は事業所をまたぐと重複するので必ず確認すること`); continue; }
  if (r.source === "無し" || (r.work == null && r.ot == null)) { skipped.push(`${r.file}:${r.line} ${e.name} ${r.month} 読み取れなかった行 (source=${r.source}) -> 入れない`); continue; }
  if (r.source.includes("ロスター") && !ALLOW_ROSTER) { skipped.push(`${r.file}:${r.line} ${e.name} ${r.month} source=ロスター は総括表そのもの (循環参照) -> 既定では入れない。入れるなら --allow-roster`); continue; }
  // ★ 表記ゆれを吸収する。「印字+赤字裏付」のような書き方で弾いていて、
  //   本田亜美 202604 の残業 180 分 (赤字「残3h」の裏付けあり) を取りこぼしていた (2026-09-26 給与B が発見)。
  //   ★ 「赤字」を含むなら赤字、含まず「印字」を含むなら印字、と読む。
  const src = r.source.includes("赤字") ? "赤字" : r.source.includes("印字") ? "印字" : r.source.includes("ロスター") ? "ロスター" : r.source;
  if (!["印字", "赤字", "ロスター"].includes(src)) { skipped.push(`${r.file}:${r.line} ${e.name} ${r.month} source が不正: ${r.source}`); continue; }
  const note = `スキャンPDF (${r.source})${r.note ? " " + r.note : ""}`;
  if (r.work != null && r.work > 0) ops.push({ num: r.num, name: e.name, month: r.month, key: "office_work_minutes", v: r.work, note, source: src });
  if (r.ot != null && r.ot > 0) ops.push({ num: r.num, name: e.name, month: r.month, key: "overtime_minutes", v: r.ot, note, source: src });
}

// -- 既存の値と比べる --------------------------------------------------
const exist = await get(`payroll_monthly_inputs?select=employee_number,processing_month,item_key,numeric_value,note&office_number=eq.${OFFICE}&item_key=in.(office_work_minutes,overtime_minutes)`);
const already = new Map(exist.map((r) => [`${normNum(r.employee_number)}|${r.processing_month}|${r.item_key}`, { v: Number(r.numeric_value ?? 0), note: r.note ?? "" }]));

const add = [], change = [], same = [];
for (const o of ops) {
  const prev = already.get(`${o.num}|${o.month}|${o.key}`);
  if (!prev) add.push(o);
  else if (prev.v !== o.v) change.push({ ...o, prev: prev.v, prevNote: prev.note });
  else same.push({ ...o, prevNote: prev.note });
}

console.log(`=== 事務員の出勤時間・残業を スキャンPDF から取込 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log(`  事業所 ${OFFICE} / TSV ${FILES.length} 本 / 読めた行 ${rows.length}`);
console.log(`  新規 ${add.length} 件 / 値が変わる ${change.length} 件 / 同じ ${same.length} 件 / 入れない ${skipped.length} 件`);
const bySrc = {}; for (const o of ops) bySrc[o.source] = (bySrc[o.source] ?? 0) + 1;
console.log(`  出どころ: ${JSON.stringify(bySrc)}`);
if (add.length) { console.log("--- 新規"); for (const o of add) console.log(`  ${o.name} ${o.month} ${o.key} = ${o.v}  [${o.note}]`); }
if (change.length) {
  console.log("--- ★ 値が変わる (既存を上書きする。中身を必ず確認すること)");
  for (const o of change) console.log(`  ${o.name} ${o.month} ${o.key}: ${o.prev} -> ${o.v}  [${o.prevNote || "note なし"}] -> [${o.note}]`);
}
if (same.length) {
  const circ = same.filter((o) => !o.prevNote.includes("スキャンPDF"));
  console.log(`--- 同じ値 ${same.length} 件${circ.length ? ` (うち ${circ.length} 件は これまで note が無く、総括表から同期した循環参照だった -> note が付いて出どころが残る)` : ""}`);
}
if (skipped.length) { console.log("--- 入れない行"); for (const s of skipped) console.log("  " + s); }
if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }

const body = [...add, ...change].map((o) => ({
  office_number: OFFICE, employee_number: o.num, processing_month: o.month,
  item_key: o.key, numeric_value: o.v, note: o.note,
}));
if (body.length === 0) { console.log("書き込むものがありません"); process.exit(0); }
const res = await fetch(`${SB}/rest/v1/payroll_monthly_inputs?on_conflict=office_number,employee_number,processing_month,item_key`, {
  method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body) });
const b = await res.json();
if (!res.ok || !Array.isArray(b) || b.length !== body.length) { console.error("★ 書き込みに失敗:", JSON.stringify(b).slice(0, 400)); process.exit(1); }
console.log(`  反映 ${b.length} 件`);
