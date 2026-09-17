/**
 * ほのぼの MEISAI (賃金集計【明細】) を Box のフォルダから一括取込する。
 *
 *   npx tsx scripts/import-meisai-folder.mts "<月フォルダ>"             # DRY RUN
 *   npx tsx scripts/import-meisai-folder.mts "<月フォルダ>" --execute   # 本番
 *
 *   例) <月フォルダ> = C:/Users/domen-PC/Box/10F内共有/02_共有/10_給与/05_移動集計/01_ほのぼの/202607
 *
 * ★ 元フォルダは読むだけ (readFileSync 以外は一切しない)。
 *
 * 画面 (/csv-import の「介護ソフトCSV」) で 1 拠点ずつ取り込むのと同じ結果を作る:
 *   - 月フォルダ直下の 1 サブフォルダ = 1 事業所 (配下の MEISAI_*.csv を再帰で全部)
 *   - 1 事業所 = 1 payroll_import_batches、全ファイルを同じ office_number で入れる
 *     (障害・総合事業のエントリも同じ事業所の職員の稼働なので一緒に入れる)
 *   - パースと行→レコード変換は画面と同じ関数 (meisai-parser / meisai-record)
 *
 * 事業所の決定: CSV 末尾の事業所番号のうち payroll_offices の 訪問介護 に一致するもの。
 *   一意に決まらない / 未登録 はスキップして報告する (推測で入れない)。
 * 既に同じ 月×事業所 のデータがある場合はスキップ (重複取込を防ぐ。消すのは画面から)。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { parseMeisaiFile } from "@/lib/csv/meisai-parser";
import { meisaiRowToRecord } from "@/lib/csv/meisai-record";
import type { MeisaiRow } from "@/types/csv";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const ROOT = args.find((a) => !a.startsWith("--"));
if (!ROOT) {
  console.error("月フォルダのパスを指定してください");
  process.exit(1);
}
const MONTH = path.basename(ROOT);
if (!/^\d{6}$/.test(MONTH)) {
  console.error(`フォルダ名が YYYYMM ではありません: ${MONTH}`);
  process.exit(1);
}

const env: Record<string, string> = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY がありません");
  process.exit(1);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function walkCsv(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkCsv(p, out);
    else if (/^MEISAI_.*\.csv$/i.test(e.name)) out.push(p);
  }
  return out;
}

const { data: offices, error: offErr } = await sb
  .from("payroll_offices")
  .select("office_number, office_type, offices(name)")
  .eq("office_type", "訪問介護");
if (offErr) { console.error("payroll_offices 取得失敗:", offErr.message); process.exit(1); }
const officeName = new Map<string, string>(
  (offices ?? []).map((o) => [o.office_number, (o.offices as unknown as { name?: string } | null)?.name ?? ""]),
);

type Plan = { folder: string; officeNumber: string; files: string[]; rows: MeisaiRow[] };
const plans: Plan[] = [];
const skipped: string[] = [];

for (const e of readdirSync(ROOT, { withFileTypes: true })) {
  if (!e.isDirectory() || e.name.startsWith("00_") || e.name.startsWith("看護")) continue;
  const files = walkCsv(path.join(ROOT, e.name));
  if (files.length === 0) { skipped.push(`${e.name}: MEISAI_*.csv が無い (訪問看護などの別形式)`); continue; }

  const rows: MeisaiRow[] = [];
  const bad: string[] = [];
  for (const f of files) {
    const buf = readFileSync(f);
    const parsed = await parseMeisaiFile(new File([buf], path.basename(f)));
    if (parsed.errors.length > 0) bad.push(`${path.basename(f)}: ${parsed.errors.slice(0, 2).join(" / ")}`);
    // ヘッダーだけの CSV はパーサが「データ行がありません」を返す = 正常
    rows.push(...parsed.data);
  }
  const realBad = bad.filter((b) => !b.includes("データ行がありません"));
  if (realBad.length > 0) { skipped.push(`${e.name}: パースエラー ${realBad.join(" | ")}`); continue; }

  const months = [...new Set(rows.map((r) => r.処理月))];
  if (months.length !== 1 || months[0] !== MONTH) {
    skipped.push(`${e.name}: 処理月が ${MONTH} と一致しない (${months.join(",")})`);
    continue;
  }
  const candidates = [...new Set(rows.map((r) => r.事業所番号))].filter((n) => officeName.has(n));
  if (candidates.length !== 1) {
    const all = [...new Set(rows.map((r) => r.事業所番号))].join(",");
    skipped.push(`${e.name}: 訪問介護の事業所が一意に決まらない (CSV の番号 ${all} / payroll_offices 一致 ${candidates.join(",") || "なし"})`);
    continue;
  }
  plans.push({ folder: e.name, officeNumber: candidates[0], files, rows });
}

// 同じファイル名が複数フォルダにある = 置き間違いの疑い
const seen = new Map<string, string>();
for (const p of plans) for (const f of p.files) {
  const b = path.basename(f);
  if (seen.has(b)) { console.error(`★ 同じファイル名が2か所: ${b} (${seen.get(b)} / ${p.folder})`); process.exit(2); }
  seen.set(b, p.folder);
}
if (new Set(plans.map((p) => p.officeNumber)).size !== plans.length) {
  console.error("★ 同じ事業所に割り当たるフォルダが複数ある"); process.exit(2);
}

console.log(`=== MEISAI 一括取込 ${MONTH} ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
let total = 0;
const ready: Plan[] = [];
for (const p of plans) {
  const { count, error } = await sb
    .from("payroll_service_records")
    .select("id", { count: "exact", head: true })
    .eq("processing_month", MONTH)
    .eq("office_number", p.officeNumber);
  if (error) { console.error(`${p.folder}: 既存件数の確認失敗 ${error.message}`); process.exit(1); }
  const staff = new Set(p.rows.map((r) => r.職員番号)).size;
  const tag = (count ?? 0) > 0 ? `スキップ (既に ${count} 件あり)` : "取込対象";
  console.log(`  ${p.folder.padEnd(14)} ${p.officeNumber} ${officeName.get(p.officeNumber)?.padEnd(28)} ${String(p.files.length).padStart(2)}ファイル ${String(p.rows.length).padStart(5)}行 職員${String(staff).padStart(3)}名  ${tag}`);
  if ((count ?? 0) === 0) { ready.push(p); total += p.rows.length; }
}
console.log(`  取込対象 ${ready.length} 事業所 / ${total} 行`);
if (skipped.length) { console.log("--- 対象外"); for (const s of skipped) console.log("  " + s); }

if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }

let failed = 0;
for (const p of ready) {
  const { data: batch, error: bErr } = await sb
    .from("payroll_import_batches")
    .insert({
      import_type: "meisai",
      file_names: p.files.map((f) => path.basename(f)),
      record_count: p.rows.length,
      processing_month: MONTH,
      office_number: p.officeNumber,
      status: "pending",
    })
    .select("id")
    .single();
  if (bErr || !batch) { console.error(`${p.folder}: batch 作成失敗 ${bErr?.message}`); failed++; continue; }

  let ok = true;
  for (let i = 0; i < p.rows.length; i += 500) {
    const records = p.rows.slice(i, i + 500).map((row) =>
      meisaiRowToRecord(row, { batchId: batch.id, officeNumber: p.officeNumber, processingMonth: MONTH }),
    );
    const { error } = await sb.from("payroll_service_records").insert(records);
    if (error) {
      console.error(`${p.folder}: INSERT 失敗 (${i} 行目から) ${error.message}`);
      await sb.from("payroll_service_records").delete().eq("import_batch_id", batch.id);
      await sb.from("payroll_import_batches").update({ status: "error", error_message: error.message }).eq("id", batch.id);
      ok = false; failed++; break;
    }
  }
  if (!ok) continue;
  const { error: uErr } = await sb.from("payroll_import_batches").update({ status: "completed" }).eq("id", batch.id);
  if (uErr) console.error(`${p.folder}: batch 完了更新失敗 ${uErr.message}`);

  const { count, error: cErr } = await sb
    .from("payroll_service_records")
    .select("id", { count: "exact", head: true })
    .eq("import_batch_id", batch.id);
  const match = !cErr && count === p.rows.length;
  if (!match) failed++;
  console.log(`  ${match ? "OK" : "NG"} ${p.folder} ${count}/${p.rows.length} 行`);
}
process.exit(failed > 0 ? 2 : 0);
