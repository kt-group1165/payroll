/**
 * 出勤簿 CSV (月シートを CSV にしたもの) をフォルダ単位で取り込む。
 *
 *   npx tsx scripts/import-attendance-csv-folder.mts "<CSVフォルダ>"             # DRY RUN
 *   npx tsx scripts/import-attendance-csv-folder.mts "<CSVフォルダ>" --execute   # 本番
 *
 * 画面 (/csv-import の「出勤簿」) と同じパーサ (attendance-parser) と同じ行変換 (attendance-record) を使う。
 * CSV は事業所の出勤簿 xlsm の月シートを書き出したもの (Box の元ファイルは読むだけで、書き出しは作業フォルダに置く)。
 *
 * - 社員番号がシートに無い場合は、同じ事業所の職員マスタから氏名で引く (1 人に決まるときだけ)
 * - 勤務時間の入っている日が 0 日のファイルは取り込まない (退職者などの空シート)
 * - 同じ (社員番号, 年, 月, 事業所) が既にあればスキップ (画面と同じく重複取込しない)
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { parseAttendanceFile } from "@/lib/csv/attendance-parser";
import { attendanceRowToRecord } from "@/lib/csv/attendance-record";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const DIR = args.find((a) => !a.startsWith("--"));
if (!DIR) { console.error("CSV フォルダを指定してください"); process.exit(1); }

const env: Record<string, string> = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY がありません"); process.exit(1); }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const N = (s: string) => s.normalize("NFKC").replace(/\s/g, "");

console.log(`=== 出勤簿取込 ${DIR} ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
let failed = 0;
for (const f of readdirSync(DIR).filter((x) => x.toLowerCase().endsWith(".csv")).sort()) {
  const parsed = await parseAttendanceFile(new File([readFileSync(path.join(DIR, f))], f));
  if (!parsed.success || parsed.data.length === 0) { console.log(`  ✗ ${f}: ${parsed.errors.join(" / ")}`); failed++; continue; }
  const { meta, rows } = parsed.data[0];
  const worked = rows.filter((r) => r.開始 && r.開始.trim() !== "").length;
  if (worked === 0) { console.log(`  - ${f}: ${meta.year}年${meta.month}月 勤務日 0 日のため取り込まない`); continue; }

  const { data: office, error: oErr } = await sb.from("payroll_offices").select("id").eq("office_number", meta.officeNumber).maybeSingle();
  if (oErr || !office) { console.log(`  ✗ ${f}: 事業所番号 ${meta.officeNumber} が payroll_offices に無い ${oErr?.message ?? ""}`); failed++; continue; }

  if (!meta.employeeNumber) {
    const { data: emps, error } = await sb.from("payroll_employees").select("employee_number,name").eq("office_id", office.id);
    if (error) { console.log(`  ✗ ${f}: 職員検索失敗 ${error.message}`); failed++; continue; }
    const hit = (emps ?? []).filter((e) => N(e.name) === N(meta.employeeName));
    if (hit.length !== 1) { console.log(`  ✗ ${f}: 社員番号が空で、氏名「${meta.employeeName}」の職員が ${hit.length} 名`); failed++; continue; }
    meta.employeeNumber = hit[0].employee_number;
    console.log(`    (${meta.employeeName} の社員番号をマスタから補完: ${meta.employeeNumber})`);
  }

  const { count, error: cErr } = await sb.from("payroll_attendance_records")
    .select("id", { count: "exact", head: true })
    .eq("employee_number", meta.employeeNumber).eq("year", meta.year).eq("month", meta.month).eq("office_number", meta.officeNumber);
  if (cErr) { console.log(`  ✗ ${f}: 既存確認失敗 ${cErr.message}`); failed++; continue; }
  const label = `${meta.year}年${meta.month}月 ${meta.employeeNumber} ${meta.employeeName} ${rows.length}日分 (勤務 ${worked}日 / 計 ${parsed.data[0].totals.workHours})`;
  if ((count ?? 0) > 0) { console.log(`  - ${label}: 既に ${count} 行あるのでスキップ`); continue; }
  console.log(`  ${EXECUTE ? "→" : "○"} ${label}`);
  if (!EXECUTE) continue;

  const { data: batch, error: bErr } = await sb.from("payroll_import_batches").insert({
    import_type: "attendance",
    file_names: [`${meta.year}年${meta.month}月_${meta.employeeNumber}_${meta.employeeName}`],
    record_count: rows.length,
    processing_month: `${meta.year}${String(meta.month).padStart(2, "0")}`,
    office_number: meta.officeNumber,
    status: "pending",
  }).select("id").single();
  if (bErr || !batch) { console.log(`  ✗ batch 作成失敗 ${bErr?.message}`); failed++; continue; }
  const { error: iErr } = await sb.from("payroll_attendance_records").insert(rows.map((r) => attendanceRowToRecord(r, meta, batch.id)));
  if (iErr) {
    console.log(`  ✗ INSERT 失敗 ${iErr.message}`);
    await sb.from("payroll_import_batches").update({ status: "error", error_message: iErr.message }).eq("id", batch.id);
    failed++; continue;
  }
  await sb.from("payroll_import_batches").update({ status: "completed" }).eq("id", batch.id);
  const { count: after } = await sb.from("payroll_attendance_records").select("id", { count: "exact", head: true }).eq("import_batch_id", batch.id);
  if (after !== rows.length) { console.log(`  ✗ 件数不一致 ${after}/${rows.length}`); failed++; }
  else console.log(`    OK ${after} 行`);
}
process.exit(failed > 0 ? 2 : 0);
