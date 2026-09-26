/**
 * 事業所書式の 会議N件数 を 書式 CSV から戻す (2026-09-27 user 了承「E OK」)。
 *
 *   FORMS_DIR=<書式CSVの置き場> npx tsx migrations/restore_form_meeting_counts.mts            # DRY RUN
 *   FORMS_DIR=<書式CSVの置き場> npx tsx migrations/restore_form_meeting_counts.mts --execute  # 本番
 *   FORMS_DIR=... npx tsx migrations/restore_form_meeting_counts.mts --delete [--execute]      # 撤去 (控えの id で消す)
 *
 * 【何が起きていたか】
 * import_soukatsu_meeting_counts.mjs の DELETE に import_batch_id の条件が無く、書式 CSV から入った
 * 会議N件数 まで消して 総括表① の値で入れ直していた (check:office-form-shrink で判明)。
 * script は同日に直した (DELETE を import_batch_id=is.null に限定 + 書式に件数がある事業所×月には ①を入れない)。
 * ★ 直しが先に入っているので、戻したあと ①を回しても また消えることはない。
 *
 * 【戻すもの】書式バッチ (事業所×月ごとの いちばん新しい office_form バッチ) のうち、
 *   書式 CSV にあって 今は無い 会議N件数 の行だけ。
 *   含めない: ちはら台 202606 (旧システムに丸ごと置き換わった。出張km は別件で user 判断待ち) /
 *            五井 の重複 km (正当な削除) / 会議N件数 以外の項目 / CSV が手元に無い事業所×月
 *
 * 【import_batch_id は 元のバッチの id で戻す】理由:
 *   ① null で入れると 直した import_soukatsu_meeting_counts.mjs の DELETE (import_batch_id=is.null) に
 *      また消される。戻した意味が無くなる
 *   ② 元のバッチに戻すと 書式の取込とまったく同じ形になる (取込の取り消し = バッチ id で消す、も効く)
 *   ③ check:office-form-shrink の「取込時の行数 − 今の行数」が そのぶん自然に減る (新しい復元バッチを作ると
 *      元のバッチは減ったまま・復元バッチは record_count と別に数えることになり 検査の意味がずれる)
 *   代わりに「どの行が戻したものか」はバッチ id では分からないので、★ --execute で入れた行の id を
 *   migrations/_restored_meeting_counts_<日付>.json に控える (= マーカー)。
 *   ⚠ payroll_office_form_records には notes 列が無い。child_name / year_month は保育料の計算が読むので
 *     マーカーに使わない。
 *
 * 【①の行は 職員単位で消す (職員単位の混成)】
 *   戻した職員に ①由来 (import_batch_id が空) の 会議N件数 が残っていると computeMeetingFee が両方を足して
 *   二重計上になるので、★ 書式に件数がある職員の ①は消す。★ 書式に件数が無い職員の ①は残す。
 *   原則「書式を正・無い所だけ ①で補う」を 事業所×月 ではなく 職員 の粒度で当てはめたもの。
 *   なぜ職員単位か (2026-09-27 dry-run で判明):
 *     事業所×月の単位で ①を全部消すと、①にだけ居て書式に件数が無い 3 人の会議費が 1,500 → 0 になった。
 *     東郷 202606 260503 / 五井 202606 631 は 総括表パートで 会議費 1,500 円が実際に払われている = 書式への書き漏れ。
 *     さつき 202606 2052 は 総括表の会議費が空で確かめられないが 同じ型なので同じ扱い。
 *     五井 202606 は ちょうど入れ替わり (書式にだけ 221008 / ①にだけ 631) で、職員単位でないと両方を正しく扱えない。
 *   ⚠ import_soukatsu_meeting_counts.mjs は 書式に件数がある事業所×月を丸ごと飛ばすので、
 *     残した ①の行は 以後 消されも足されもしない (安定)。
 *
 * 【dry-run の合格条件】金額が動く行が 29 行 / 今 − 戻した後 = ¥-41,800 (check:office-form-shrink の測定から
 *   ちはら台の 1 行 ¥-6,350 を除いたもの)。一致しなければ --execute を拒否する。
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { restAll } from "../scripts/_rest.mjs";
import { parseOfficeFormFile } from "../src/lib/csv/office-form-parser";
import { officeFormRecordToRow } from "../src/lib/csv/office-form-record";
import { computeMeetingFee } from "../src/lib/payroll/payroll-calc";

const EXECUTE = process.argv.includes("--execute");
const DELETE_MODE = process.argv.includes("--delete");
const FORMS_DIR = process.env.FORMS_DIR ?? "";
const EXPECT_ROWS = 29, EXPECT_YEN = -41800;
const EXCLUDE = new Set(["1272403534|202606"]);   // ちはら台 202606: 旧システムに置き換わった。別件
const MEET = ["会議1件数", "会議2件数", "会議3件数"];
const isMeet = (s: string) => MEET.includes(s);
const LOG = join(import.meta.dirname, `_restored_meeting_counts_20260927.json`);

const env: Record<string, string> = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL + "/rest/v1/";
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");

// ── 撤去 ──
if (DELETE_MODE) {
  if (!existsSync(LOG)) { console.error(`✗ 控えが無い: ${LOG}`); process.exit(1); }
  const log = JSON.parse(readFileSync(LOG, "utf8")) as { inserted_ids: string[]; deleted_soukatsu_rows: unknown[] };
  console.log(`撤去: 戻した行 ${log.inserted_ids.length} を消す / 消した①の行 ${log.deleted_soukatsu_rows.length} を入れ直す`);
  if (!EXECUTE) { console.log("DRY RUN (--delete --execute で撤去)"); process.exit(0); }
  for (let i = 0; i < log.inserted_ids.length; i += 200) {
    const res = await fetch(`${SB}payroll_office_form_records?id=in.(${log.inserted_ids.slice(i, i + 200).join(",")})`, { method: "DELETE", headers: { ...H, Prefer: "return=representation" } });
    const j = await res.json();
    if (!res.ok || !Array.isArray(j)) { console.error("✗ 撤去に失敗:", JSON.stringify(j).slice(0, 300)); process.exit(1); }
  }
  const back = await fetch(`${SB}payroll_office_form_records`, { method: "POST", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify(log.deleted_soukatsu_rows) });
  if (!back.ok) { console.error("✗ ①の行を戻せない:", await back.text()); process.exit(1); }
  console.log("撤去完了");
  process.exit(0);
}

if (!FORMS_DIR || !existsSync(FORMS_DIR)) { console.error("FORMS_DIR=<書式CSVの置き場> を指定してください"); process.exit(1); }

type Batch = { id: string; file_names: string[] | null; record_count: number; processing_month: string; office_number: string; created_at: string };
type Row = { id: string; import_batch_id: string | null; office_number: string; processing_month: string; employee_number: string; record_type: string; item_name: string; numeric_value: number | null };
const [batches, rows, offices, unitPrices, settings] = await Promise.all([
  restAll<Batch>("payroll_import_batches?select=id,file_names,record_count,processing_month,office_number,created_at&import_type=eq.office_form"),
  restAll<Row>("payroll_office_form_records?select=id,import_batch_id,office_number,processing_month,employee_number,record_type,item_name,numeric_value,item_date,start_time,end_time,break_time,year_month,child_name,amount"),
  restAll<{ id: string; office_number: string; meeting_unit_price: number | null }>("payroll_offices?select=id,office_number,meeting_unit_price"),
  restAll<{ office_id: string; effective_from: string; meeting_unit_price: number | null }>("payroll_office_unit_prices?select=id,office_id,effective_from,meeting_unit_price"),
  restAll<{ key: string; value: unknown }>("payroll_app_settings?select=key,value&key=in.(meeting_unit_prices,meeting_fee_unpaid_offices)", "key"),
]);
const officeByNum = new Map(offices.map((o) => [o.office_number, o]));
const unitOf = (office: string, month: string) => {
  const o = officeByNum.get(office); const end = `${month.slice(0, 4)}-${month.slice(4, 6)}-31`;
  const u = unitPrices.filter((x) => x.office_id === o?.id && x.effective_from <= end && x.meeting_unit_price != null).sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
  return Number(u?.meeting_unit_price ?? o?.meeting_unit_price ?? 0);
};
const prices = ((settings.find((s) => s.key === "meeting_unit_prices")?.value as { prices?: Record<string, Record<string, number>> })?.prices) ?? {};
const unpaid = new Set(((settings.find((s) => s.key === "meeting_fee_unpaid_offices")?.value as { offices?: string[] })?.offices) ?? []);

// 事業所×月ごとの いちばん新しいバッチ
const latest = new Map<string, Batch>();
for (const b of batches) { const k = `${b.office_number}|${b.processing_month}`; const c = latest.get(k); if (!c || b.created_at > c.created_at) latest.set(k, b); }
const nowCount = new Map<string, number>(); for (const r of rows) if (r.import_batch_id) nowCount.set(r.import_batch_id, (nowCount.get(r.import_batch_id) ?? 0) + 1);
const rowsBy = new Map<string, Row[]>(); for (const r of rows) { const k = `${r.office_number}|${r.processing_month}`; (rowsBy.get(k) ?? rowsBy.set(k, []).get(k)!).push(r); }

const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : /\.csv$/i.test(e.name) ? [join(d, e.name)] : []);
const files = walk(FORMS_DIR);
const baseOf = (f: string) => f.split(/[\\/]/).pop()!;

type Plan = { key: string; batch: Batch; insert: ReturnType<typeof officeFormRecordToRow>[]; deleteSoukatsu: Row[]; feeNow: number; feeAfter: number; effRows: number; lines: string[] };
const plans: Plan[] = [];
const noCsv: string[] = [], excluded: string[] = [], keptAll: string[] = [];
let totalShrink = 0;
for (const [k, b] of [...latest].sort()) {
  const shrink = b.record_count - (nowCount.get(b.id) ?? 0);
  if (shrink <= 0) continue;
  totalShrink += shrink;
  if (EXCLUDE.has(k)) { excluded.push(`${k} (${shrink} 行。旧システムに置き換わった。出張km は別件)`); continue; }
  // CSV を探す (バッチのファイル名 → <YYYYMM>.csv。同名が複数あるので 中の事業所番号で照合)
  const cands = [...new Set([...files.filter((x) => b.file_names?.[0] && baseOf(x) === b.file_names[0]), ...files.filter((x) => baseOf(x) === `${b.processing_month}.csv`)])];
  let recs: Awaited<ReturnType<typeof parseOfficeFormFile>>["data"] | null = null;
  for (const f of cands) {
    const p = await parseOfficeFormFile(new File([readFileSync(f)], baseOf(f)));
    if (p.data[0]?.office_number === b.office_number) { recs = p.data; break; }
  }
  if (!recs) { noCsv.push(`${k} ${b.file_names?.[0] ?? ""} (${shrink} 行。CSV が手元に無いので戻せない・中身も不明)`); continue; }

  const csvMeet = recs.filter((r) => isMeet(r.item_name));
  if (csvMeet.length === 0) continue;   // この事業所×月で消えたのは 会議件数以外 (五井 202604 の重複 km 等)
  const cur = rowsBy.get(k) ?? [];
  const batchMeet = cur.filter((r) => r.import_batch_id === b.id && isMeet(r.item_name));
  // 職員×項目ごとに CSV の行数 − 今のバッチの行数 だけ戻す
  const need = new Map<string, number>();
  for (const r of csvMeet) { const kk = `${nn(r.employee_number)}|${r.item_name}`; need.set(kk, (need.get(kk) ?? 0) + 1); }
  for (const r of batchMeet) { const kk = `${nn(r.employee_number)}|${r.item_name}`; need.set(kk, (need.get(kk) ?? 0) - 1); }
  const insert: Plan["insert"] = [];
  const used = new Map<string, number>();
  for (const r of csvMeet) {
    const kk = `${nn(r.employee_number)}|${r.item_name}`;
    const u = used.get(kk) ?? 0;
    if (u < (need.get(kk) ?? 0)) { insert.push(officeFormRecordToRow(r, { batchId: b.id, processingMonth: b.processing_month })); used.set(kk, u + 1); }
  }
  if (insert.length === 0) continue;
  // ★ 職員単位の混成: 書式に件数がある職員の ①だけ消す。書式に件数が無い職員の ①は残す
  const formEmps = new Set([...cur.filter((r) => r.import_batch_id === b.id && isMeet(r.item_name)), ...insert].map((r) => nn(r.employee_number)));
  const deleteSoukatsu = cur.filter((r) => !r.import_batch_id && isMeet(r.item_name) && formEmps.has(nn(r.employee_number)));
  const keptSoukatsu = cur.filter((r) => !r.import_batch_id && isMeet(r.item_name) && !formEmps.has(nn(r.employee_number)));
  for (const r of keptSoukatsu) keptAll.push(`${k} 職員${nn(r.employee_number)} ${r.item_name}=${r.numeric_value}`);

  // 金額: 今 (①と書式の残り) と 戻した後 (書式だけ) の会議費を 職員ごとに
  const [office, month] = k.split("|");
  const unit = unitOf(office, month);
  const fee = (rs: { record_type: string; item_name: string; numeric_value?: number | null }[]) =>
    unpaid.has(office) ? 0 : computeMeetingFee(rs.map((r) => ({ record_type: r.record_type, item_name: r.item_name, numeric_value: r.numeric_value ?? null }) as never), unit, prices[office]);
  const after = [...cur.filter((r) => isMeet(r.item_name) && r.import_batch_id), ...insert, ...keptSoukatsu];
  const emps = new Set([...cur.filter((r) => isMeet(r.item_name)).map((r) => nn(r.employee_number)), ...insert.map((r) => nn(r.employee_number))]);
  let feeNow = 0, feeAfter = 0, effRows = 0; const lines: string[] = [];
  for (const e of emps) {
    const n = fee(cur.filter((r) => isMeet(r.item_name) && nn(r.employee_number) === e));
    const a = fee(after.filter((r) => nn(r.employee_number) === e));
    feeNow += n; feeAfter += a;
    if (n !== a) { effRows += insert.filter((r) => nn(r.employee_number) === e).length; lines.push(`職員${e} 会議費 ¥${n} → ¥${a}`); }
  }
  plans.push({ key: k, batch: b, insert, deleteSoukatsu, feeNow, feeAfter, effRows, lines });
}

const insTotal = plans.reduce((s, p) => s + p.insert.length, 0);
const delTotal = plans.reduce((s, p) => s + p.deleteSoukatsu.length, 0);
const effRows = plans.reduce((s, p) => s + p.effRows, 0);
const yen = plans.reduce((s, p) => s + (p.feeNow - p.feeAfter), 0);   // 今 − 戻した後 (check:office-form-shrink と同じ向き)
console.log(`=== 書式の会議件数を戻す ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log(`取込後に行が減った 事業所×月の 減った行 合計 ${totalShrink}`);
console.log(`戻す: ${plans.length} 事業所×月 / 書式の会議N件数 ${insTotal} 行 (元のバッチ id で)`);
console.log(`消す: 同じ事業所×月で 書式に件数がある職員の ①由来 (import_batch_id が空) の会議N件数 ${delTotal} 行 (残すと二重計上)`);
console.log(`残す: 書式に件数が無い職員の ①由来 ${keptAll.length} 行 (書式への書き漏れ。①が正)`);
for (const s of keptAll) console.log(`  ${s}`);
console.log("  ⚠ 東郷 260503・五井 631 は 総括表パートで会議費 1,500 円が払われているのを確かめた。さつき 2052 は総括表の会議費が空で確かめられていない (同じ型なので同じ扱い)");
for (const p of plans) {
  console.log(`  ${p.key}  戻す ${p.insert.length} / ①を消す ${p.deleteSoukatsu.length}  会議費 ¥${p.feeNow.toLocaleString()} → ¥${p.feeAfter.toLocaleString()}${p.lines.length ? "\n      " + p.lines.join("\n      ") : ""}`);
}
if (excluded.length) console.log(`含めない: ${excluded.join(" / ")}`);
if (noCsv.length) console.log(`★ 戻せない: ${noCsv.join(" / ")}`);
console.log(`\n金額が動く行 ${effRows} / 今 − 戻した後 = ¥${yen.toLocaleString()}  (期待 ${EXPECT_ROWS} 行 / ¥${EXPECT_YEN.toLocaleString()})`);
const ok = effRows === EXPECT_ROWS && yen === EXPECT_YEN;
console.log(ok ? "✓ 期待どおり" : "★ 期待と一致しません。--execute は拒否します。中身を確かめてください");
console.log(`\n戻したあと check:office-form-shrink は ${totalShrink} → ${totalShrink - insTotal} 行 になる見込み (残り = ちはら台の置き換え・五井の重複 km・CSV の無い行)`);
console.log("  手順: npm run check:office-form-shrink (中身を見る: 会議N件数 が消えているか) → 問題なければ -- --update");

/** 実行後の確認 SQL (件数だけ)。DRY RUN でも出す */
function printSql() {
  console.log("\n確認 SQL (--execute のあと Supabase SQL Editor で件数を見る):");
  console.log(`  -- 戻した行 (書式バッチの会議N件数)。${insTotal} 行になるはず
  SELECT count(*) FROM payroll_office_form_records
   WHERE item_name IN ('会議1件数','会議2件数','会議3件数')
     AND import_batch_id IN (${plans.map((p) => `'${p.batch.id}'`).join(",")});
  -- 同じ職員に 書式と ① の会議N件数 が両方残っていないこと (二重計上)。0 行になるはず
  SELECT a.office_number, a.processing_month, a.employee_number, count(*) FROM payroll_office_form_records a
   WHERE a.item_name IN ('会議1件数','会議2件数','会議3件数') AND a.import_batch_id IS NULL
     AND EXISTS (SELECT 1 FROM payroll_office_form_records b
                  WHERE b.office_number = a.office_number AND b.processing_month = a.processing_month
                    AND b.employee_number = a.employee_number AND b.import_batch_id IS NOT NULL
                    AND b.item_name IN ('会議1件数','会議2件数','会議3件数'))
   GROUP BY 1, 2, 3;
  -- 書式に件数が無い職員の ① (残したもの)。${keptAll.length} 行になるはず
  SELECT count(*) FROM payroll_office_form_records a
   WHERE a.item_name IN ('会議1件数','会議2件数','会議3件数') AND a.import_batch_id IS NULL
     AND (a.office_number, a.processing_month) IN (${plans.map((p) => `('${p.batch.office_number}','${p.batch.processing_month}')`).join(",")});`);
}
printSql();

if (!EXECUTE) { console.log("\nDRY RUN (--execute で書き込み)"); process.exit(0); }
if (!ok) process.exit(2);

const insertedIds: string[] = [];
const deletedRows: Record<string, unknown>[] = [];
for (const p of plans) {
  if (p.deleteSoukatsu.length) {
    const res = await fetch(`${SB}payroll_office_form_records?id=in.(${p.deleteSoukatsu.map((r) => r.id).join(",")})&import_batch_id=is.null`, { method: "DELETE", headers: { ...H, Prefer: "return=representation" } });
    const j = await res.json();
    if (!res.ok || !Array.isArray(j) || j.length !== p.deleteSoukatsu.length) { console.error(`✗ ①の削除に失敗 (${p.key}): ${JSON.stringify(j).slice(0, 300)}`); writeFileSync(LOG, JSON.stringify({ inserted_ids: insertedIds, deleted_soukatsu_rows: deletedRows }, null, 2)); process.exit(1); }
    deletedRows.push(...j.map((r: Record<string, unknown>) => { const { id: _id, created_at: _c, ...rest } = r; void _id; void _c; return rest; }));
  }
  const res = await fetch(`${SB}payroll_office_form_records?select=id`, { method: "POST", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(p.insert) });
  const j = await res.json();
  if (!res.ok || !Array.isArray(j) || j.length !== p.insert.length) { console.error(`✗ 書き込みに失敗 (${p.key}): ${JSON.stringify(j).slice(0, 300)}`); writeFileSync(LOG, JSON.stringify({ inserted_ids: insertedIds, deleted_soukatsu_rows: deletedRows }, null, 2)); process.exit(1); }
  insertedIds.push(...j.map((r: { id: string }) => r.id));
}
writeFileSync(LOG, JSON.stringify({ restored_at: new Date().toISOString(), inserted_ids: insertedIds, deleted_soukatsu_rows: deletedRows }, null, 2) + "\n");
console.log(`完了: 戻した ${insertedIds.length} 行 / ①を消した ${deletedRows.length} 行。控え ${LOG}`);
printSql();
