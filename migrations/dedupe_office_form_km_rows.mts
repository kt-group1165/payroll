/**
 * 取込済みの事業所書式で、同じ職員の 通勤km / 出張km が 2 行以上ある分を「先頭の行」だけにする。
 *
 *   npx tsx migrations/dedupe_office_form_km_rows.mts <書式CSVのフォルダ>            # DRY RUN
 *   npx tsx migrations/dedupe_office_form_km_rows.mts <書式CSVのフォルダ> --execute
 *
 * <フォルダ>/<タグ>/<YYYYMM>.csv (取込に使った CSV) を読み、CSV で先頭に出てくる値の行を残して、
 * それ以外の同じ (事業所, 職員, 月, 項目) の行を消す。DB の行には並び順が無いので CSV を正にする。
 * パーサ側は keepFirstKmRows() で同じことをする (これから取り込むぶん)。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { parseOfficeFormFile } from "@/lib/csv/office-form-parser";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const DIR = args.find((a) => !a.startsWith("--"));
if (!DIR) { console.error("書式CSVのフォルダを指定してください"); process.exit(1); }
const env: Record<string, string> = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

type Del = { id: string; label: string };
const dels: Del[] = [];
for (const tag of readdirSync(DIR)) {
  let files: string[] = []; try { files = readdirSync(path.join(DIR, tag)).filter((f) => /^\d{6}\.csv$/.test(f)); } catch { continue; }
  for (const f of files) {
    const month = f.slice(0, 6);
    // ★ keepFirstKmRows を通す前の生の並びが要るので、パーサの出力ではなく CSV の順で 先頭の値を拾う
    const parsed = await parseOfficeFormFile(new File([readFileSync(path.join(DIR, tag, f))], f));
    if (!parsed.success || parsed.data.length === 0) continue;
    const office = parsed.data[0].office_number;
    const firstVal = new Map(parsed.data.filter((r) => r.record_type === "km" && (r.item_name === "通勤km" || r.item_name === "出張km"))
      .map((r) => [`${r.employee_number}|${r.item_name}`, r.numeric_value ?? null]));
    for (const item of ["通勤km", "出張km"]) {
      const { data, error } = await sb.from("payroll_office_form_records").select("id,employee_number,numeric_value")
        .eq("office_number", office).eq("processing_month", month).eq("item_name", item).limit(2000);
      if (error) { console.error(error.message); process.exit(1); }
      const byEmp = new Map<string, { id: string; employee_number: string; numeric_value: number | null }[]>();
      for (const r of data ?? []) (byEmp.get(r.employee_number) ?? byEmp.set(r.employee_number, []).get(r.employee_number)!).push(r);
      for (const [emp, allRows] of byEmp) {
        const rows = allRows.filter((r) => Number(r.numeric_value) > 0);   // 空の行は合計に効かないので触らない
        if (rows.length < 2) continue;
        const want = firstVal.get(`${emp}|${item}`);
        if (want === undefined) { console.log(`  ? ${month} ${office} ${emp} ${item}: CSV に無い (触らない)`); continue; }
        const keep = rows.find((r) => Number(r.numeric_value) === Number(want)) ?? null;
        if (!keep) { console.log(`  ? ${month} ${office} ${emp} ${item}: CSV の先頭値 ${want} の行が DB に無い (触らない)`); continue; }
        for (const r of rows) if (r.id !== keep.id) dels.push({ id: r.id, label: `${month} ${office} ${emp} ${item} ${r.numeric_value} を消す (残す: ${keep.numeric_value})` });
      }
    }
  }
}
console.log(`=== 事業所書式の 通勤km/出張km の重複 ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${dels.length} 行 ===`);
for (const d of dels) console.log(`  ${d.label}`);
if (!EXECUTE) { console.log("\nDRY RUN。--execute で消します"); process.exit(0); }
for (const d of dels) {
  const { data, error } = await sb.from("payroll_office_form_records").delete().eq("id", d.id).select("id");
  if (error || (data ?? []).length !== 1) { console.error(`✗ ${d.label}: ${error?.message ?? data?.length}`); process.exit(2); }
}
console.log(`完了 ${dels.length} 行`);
