/**
 * 旧システムの「事業所入力」CSV を 事業所書式 (payroll_office_form_records) に取り込む (2026-09-21)。
 *
 *   node migrations/import_legacy_office_form.mjs            # DRY RUN
 *   node migrations/import_legacy_office_form.mjs --execute
 *
 * 出し方: 旧システム → 事業所入力 → 稼働月 + 会社 + 事業所 + 給与形態 を選ぶ → 設定 → CSV
 *   ⚠ 事業所と給与形態は必須。1 回の出力が 1事業所 × 1給与形態 × 1月 なので
 *     1 事業所月あたり 2 本 (月給 / 時給) 出す。
 *   ⚠ ファイル名に 月と事業所が入る (`事業所入力_2026年03月_<事業所名>.csv`) ので リネーム不要。
 *
 * なぜ: 事業所書式 (xlsm) が当方に無い月がある。出張km・会議・有給・保育料が丸ごと欠ける。
 *   総括表で出張費が出ている 2,972 人月のうち 343 人月が「書式にも出勤簿にも km が無い」状態で、
 *   その 302 が おゆみ野 3〜6月 / 木更津 3月 / 高品 5月 / 五井 3月 に集中していた。
 *
 * ⚠ 取込は (office_number, processing_month) 単位で 既存を消してから入れ直す。
 *   既に xlsm から入っている月には当てないこと (--only で対象を絞る)。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const EXECUTE = process.argv.includes("--execute");
const SRC = process.env.SRC || join(process.env.USERPROFILE || "", "Box", "10F内共有", "ほのぼのから出力");
/** 既に書式が入っている月を壊さないため、既存レコードが N 件以上ある事業所月は既定で飛ばす */
const OVERWRITE_LIMIT = Number(process.env.OVERWRITE_LIMIT ?? 30);

const env = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL + "/rest/v1/";
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };

if (!existsSync(SRC)) { console.error(`✗ 置き場が無い: ${SRC}`); process.exit(1); }

const dec = new TextDecoder("shift_jis");
const normName = (x) => String(x ?? "").normalize("NFKC").replace(/[\s　]/g, "");
const nn = (s) => String(s ?? "").trim().replace(/^0+/, "");
const txt = (s) => { const v = String(s ?? "").trim(); return v === "" ? null : v; };
const num = (s) => { const v = String(s ?? "").replace(/,/g, "").trim(); return v === "" ? null : (Number.isFinite(+v) ? +v : null); };
/** "2026/03/01,2026/03/02" → ["3月1日","3月2日"] (書式の item_date と同じ書き方) */
const dates = (s) => String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean)
  .map((x) => { const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(x); return m ? `${+m[2]}月${+m[3]}日` : null; })
  .filter((x) => x !== null);
/** "03/02" → "3月2日" */
const mdate = (s) => { const m = /^(\d{1,2})\/(\d{1,2})$/.exec(String(s ?? "").trim()); return m ? `${+m[1]}月${+m[2]}日` : null; };

// 事業所名 → 事業所番号
const offRes = await fetch(`${SB}payroll_offices?select=office_number,master:offices!office_id(name)`, { headers: H });
if (!offRes.ok) { console.error("✗ 事業所の取得に失敗:", await offRes.text()); process.exit(1); }
const offByName = new Map();
for (const o of await offRes.json()) if (o.master?.name) offByName.set(normName(o.master.name), o.office_number);

const files = readdirSync(SRC).filter((f) => /^事業所入力_\d{4}年\d{2}月_.+\.csv$/.test(f));
if (files.length === 0) { console.error(`✗ 対象 CSV が 1 本も無い: ${SRC}`); process.exit(1); }

/** (office_number, processing_month) → rows */
const out = new Map();
const unknown = new Set();
for (const f of files.sort()) {
  const m = /^事業所入力_(\d{4})年(\d{2})月_(.+?)(?: \(\d+\))?\.csv$/.exec(f);
  const pm = m[1] + m[2];
  const office = offByName.get(normName(m[3]));
  if (!office) { unknown.add(m[3]); continue; }
  const lines = dec.decode(readFileSync(join(SRC, f))).split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(",").map((x) => x.replace(/^"|"$/g, ""));
  const at = (c, n) => c[head.indexOf(n)];
  const key = `${office}|${pm}`;
  if (!out.has(key)) out.set(key, { office_number: office, processing_month: pm, rows: [], emps: new Set(), files: [] });
  const bucket = out.get(key);
  bucket.files.push(f);
  for (const l of lines.slice(1)) {
    const c = l.split('","').map((x) => x.replace(/^"|"$/g, ""));
    const emp = nn(at(c, "従業員コード"));
    if (!emp) continue;
    if (bucket.emps.has(emp)) continue;   // 同じ月を 2 回出したぶんは 1 回だけ入れる
    bucket.emps.add(emp);
    const base = { office_number: office, employee_number: emp, processing_month: pm };
    const push = (o) => bucket.rows.push({ ...base, item_date: null, start_time: null, end_time: null, break_time: null, numeric_value: null, year_month: null, child_name: null, amount: null, ...o });
    for (const [col, name] of [["通勤km", "通勤km"], ["出張km", "出張km"]]) {
      const v = num(at(c, col));
      if (v != null && v !== 0) push({ record_type: "km", item_name: name, numeric_value: v });
    }
    for (const [col, name] of [["有給(全休)取得日", "有給"], ["有給(半休)取得日", "半有給"],
                               ["欠勤(全休)取得日", "欠勤"], ["欠勤(半休)取得日", "半欠勤"],
                               ["特休(全休)取得日", "特休"], ["特休(半休)取得日", "半特休"]]) {
      for (const d of dates(at(c, col))) push({ record_type: "leave", item_name: name, item_date: d });
    }
    for (const [pre, name] of [["保育園料", "保育料"], ["幼稚園料", "幼稚園料"]]) {
      const amt = num(at(c, `${pre}(金額)`));
      if (amt) push({ record_type: "childcare", item_name: name, year_month: txt(at(c, `${pre}(利用月)`)), child_name: txt(at(c, `${pre}(お子さんの名前)`)), amount: amt });
    }
    const td = mdate(at(c, "研修(日付)"));
    if (td) push({ record_type: "training", item_name: txt(at(c, "研修(区分)")) ?? "研修", item_date: td, start_time: txt(at(c, "研修(開始時間)")), end_time: txt(at(c, "研修(終了時間)")), break_time: txt(at(c, "研修(休憩時間)")) });
    const md = mdate(at(c, "会議(日付)"));
    if (md) {
      push({ record_type: "training", item_name: "会議", item_date: md, start_time: txt(at(c, "会議(開始時間)")), end_time: txt(at(c, "会議(終了時間)")), break_time: txt(at(c, "会議(休憩時間)")) });
      // 会議費は「会議1件数」(km/numeric_value) で数えている。件数として 1 を立てる
      push({ record_type: "km", item_name: "会議1件数", numeric_value: 1 });
    }
  }
}
if (unknown.size) console.warn("⚠ 事業所名を解決できなかったファイル:", [...unknown].join(" / "));

console.log(`CSV ${files.length} 本 → 事業所×月 ${out.size}`);
let total = 0;
const targets = [];
for (const [k, v] of [...out].sort()) {
  const r = await fetch(`${SB}payroll_office_form_records?select=id&office_number=eq.${v.office_number}&processing_month=eq.${v.processing_month}&limit=200`, { headers: H });
  const cur = (await r.json()).length;
  const skip = cur >= OVERWRITE_LIMIT;
  console.log(`  ${k}  職員${v.emps.size} 行${v.rows.length}  既存${cur}${skip ? "  ★ 既に書式があるので飛ばす" : ""}`);
  if (!skip) { targets.push(v); total += v.rows.length; }
}
console.log(`取込対象 ${targets.length} 事業所月 / ${total} 行`);
const tally = new Map();
for (const t of targets) for (const r of t.rows) tally.set(r.record_type + "|" + r.item_name, (tally.get(r.record_type + "|" + r.item_name) ?? 0) + 1);
for (const [k, v] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(24)} ${v}`);

if (!EXECUTE) { console.log("\nDRY RUN (--execute で書き込み)"); process.exit(0); }

for (const t of targets) {
  const del = await fetch(`${SB}payroll_office_form_records?office_number=eq.${t.office_number}&processing_month=eq.${t.processing_month}`, { method: "DELETE", headers: { ...H, Prefer: "return=minimal" } });
  if (!del.ok) { console.error(`✗ 既存の削除に失敗 (${t.office_number} ${t.processing_month}): ${await del.text()}`); process.exit(1); }
  for (let i = 0; i < t.rows.length; i += 300) {
    const res = await fetch(`${SB}payroll_office_form_records`, { method: "POST", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify(t.rows.slice(i, i + 300)) });
    if (!res.ok) { console.error(`✗ 書き込み失敗 (${t.office_number} ${t.processing_month}): ${await res.text()}`); process.exit(1); }
  }
  console.log(`  入れた ${t.office_number} ${t.processing_month} ${t.rows.length} 行`);
}
console.log("完了");
