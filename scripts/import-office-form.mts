/**
 * 事業所書式 CSV を 処理月を指定して取り込む。
 *
 *   npx tsx scripts/import-office-form.mts "<CSV>" --month 202607            # DRY RUN
 *   npx tsx scripts/import-office-form.mts "<CSV>" --month 202607 --execute
 *
 * ⚠ ファイル名の日付 (例 _20260805) は「出力した日」で、稼働月ではない。中の日付で稼働月を確かめて --month を指定する。
 * 画面 (/csv-import の「事業所書式」) と同じパーサ・同じ行変換。同じ 事業所×処理月 に既存データがあれば取り込まない。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { parseOfficeFormFile } from "@/lib/csv/office-form-parser";
import { officeFormRecordToRow } from "@/lib/csv/office-form-record";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const FILE = args.find((a) => !a.startsWith("--") && a !== args[args.indexOf("--month") + 1]);
const MONTH = args[args.indexOf("--month") + 1];
if (!FILE || !/^\d{6}$/.test(MONTH ?? "")) { console.error("CSV と --month YYYYMM を指定してください"); process.exit(1); }

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

const parsed = await parseOfficeFormFile(new File([readFileSync(FILE)], path.basename(FILE)));
if (!parsed.success) { console.error("パース失敗:", parsed.errors.join(" / ")); process.exit(1); }
const offices = [...new Set(parsed.data.map((r) => r.office_number))];
if (offices.length !== 1) { console.error(`事業所番号が 1 つに決まらない: ${offices.join(",")}`); process.exit(1); }
const officeNumber = offices[0];

// 稼働月の確かめ: 日付項目 (M/D または M月D日。高品は後者) の月が --month と合うか。月の読めない値 ("7" だけ等) は数えない
const monthsInFile = new Set(parsed.data.map((r) => /^(\d{1,2})[/月]/.exec(String(r.item_date ?? "").trim())?.[1]).filter((m): m is string => !!m));
const mm = String(parseInt(MONTH.slice(4, 6), 10));
if (monthsInFile.size > 0 && (monthsInFile.size !== 1 || !monthsInFile.has(mm))) {
  console.error(`★ ファイル内の日付の月 (${[...monthsInFile].join(",")}) が --month ${MONTH} と合いません`);
  process.exit(2);
}

const { count, error: cErr } = await sb.from("payroll_office_form_records").select("id", { count: "exact", head: true })
  .eq("processing_month", MONTH).eq("office_number", officeNumber);
if (cErr) { console.error("既存確認失敗:", cErr.message); process.exit(1); }

const byItem: Record<string, number> = {};
for (const r of parsed.data) byItem[r.item_name] = (byItem[r.item_name] ?? 0) + 1;
const emps = new Set(parsed.data.map((r) => r.employee_number));
console.log(`=== 事業所書式取込 ${officeNumber} ${MONTH} ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log(`  ${path.basename(FILE)}: ${parsed.data.length} 項目 / 職員 ${emps.size} 名 / ファイル内の月 ${[...monthsInFile].join(",") || "(日付なし)"}`);
console.log(`  項目別: ${JSON.stringify(byItem)}`);
if ((count ?? 0) > 0) { console.log(`  既に ${count} 件あるので取り込まない`); process.exit(0); }
if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }

const { data: batch, error: bErr } = await sb.from("payroll_import_batches").insert({
  import_type: "office_form", file_names: [path.basename(FILE)], record_count: parsed.data.length,
  processing_month: MONTH, office_number: officeNumber, status: "pending",
}).select("id").single();
if (bErr || !batch) { console.error("batch 作成失敗:", bErr?.message); process.exit(1); }
for (let i = 0; i < parsed.data.length; i += 500) {
  const { error } = await sb.from("payroll_office_form_records")
    .insert(parsed.data.slice(i, i + 500).map((r) => officeFormRecordToRow(r, { batchId: batch.id, processingMonth: MONTH })));
  if (error) {
    await sb.from("payroll_office_form_records").delete().eq("import_batch_id", batch.id);
    await sb.from("payroll_import_batches").update({ status: "error", error_message: error.message }).eq("id", batch.id);
    console.error("INSERT 失敗 (取り消し済み):", error.message); process.exit(1);
  }
}
await sb.from("payroll_import_batches").update({ status: "completed" }).eq("id", batch.id);
const { count: after } = await sb.from("payroll_office_form_records").select("id", { count: "exact", head: true }).eq("import_batch_id", batch.id);
console.log(after === parsed.data.length ? `  OK ${after} 件` : `  ★ 件数不一致 ${after}/${parsed.data.length}`);
process.exit(after === parsed.data.length ? 0 : 2);
