/**
 * 事業所書式「Web 入力」→ 給与 の前後を実データで出す (dry-run 付き)
 *
 *   npx tsx migrations/office_input_flow_demo.mts                    DRY RUN (★ DB を 1 行も書かない)
 *   npx tsx migrations/office_input_flow_demo.mts --execute          サンプル投入 + 読み戻し確認
 *   npx tsx migrations/office_input_flow_demo.mts --delete           撤去の DRY RUN
 *   npx tsx migrations/office_input_flow_demo.mts --delete --execute 撤去
 *
 * ── 2 段構成 ──────────────────────────────────────────────────────────────
 *   段A 書込なし・実データ  実在する (事業所 × 月 × 職員) の CSV 取込の行を取り、
 *                          そこに Web 入力を 1 行足したと仮定して **前後の金額** を出す。
 *                          ★ DB を一切触らない。--execute でも触らない。
 *                          ★ これが「Web 入力した値が給与に出る」の実データでの提示。
 *   段B 書込あり (--execute) サンプル月 (SAMPLE_MONTH) に実際に INSERT し、
 *                          画面と同じ query 関数で読み戻して 同じ金額になるかを見る。
 *                          ★ 実運用の月には書かない。★ marker 必須。★ 必ず撤去する。
 *
 * ⚠ marker: notes = "[fake office-input-flow-demo]"。撤去は **marker と月の両方一致**で行う
 *   (接頭辞だけで消すと他セッションのサンプルを巻き込む)。
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  computeMeetingFee, trainingMinutes, trainingPayAmount, TRAINING_RATE_PER_HOUR,
  officeFormPaidLeaveDays, businessTripFeeAmount, adjustedCommuteDistanceM,
  type OfficeFormRecord,
} from "@/lib/payroll/payroll-calc";
import {
  officeInputEntryToFormRecord, mergeOfficeFormSources, normEmp,
} from "@/lib/office-input/to-form-records";
import type { OfficeInputEntry } from "@/lib/office-input/types";

const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");
/** 実運用の月に書かないための サンプル専用月 */
const SAMPLE_MONTH = "2026-12";
const MARKER = "[fake office-input-flow-demo]";

const env: Record<string, string> = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY が無い (../kaigo-app/.env.local)");
  process.exit(1);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const yen = (n: number) => `${Math.round(n).toLocaleString("ja-JP")} 円`;

async function page<T>(table: string, select: string, apply?: (q: ReturnType<typeof sb.from>) => unknown): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += 1000) {
    let q = sb.from(table).select(select);
    if (apply) q = apply(q as never) as never;
    const { data, error } = await q.order("id").range(f, f + 999);
    if (error) throw new Error(`${table} 取得失敗: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// ─── 撤去 ────────────────────────────────────────────────────────────────
if (DELETE) {
  const { data, error } = await sb.from("payroll_office_input_entries")
    .select("id,item_name,employee_id")
    .eq("billing_month", SAMPLE_MONTH).eq("notes", MARKER);
  if (error) throw new Error(`撤去対象の取得に失敗: ${error.message}`);
  const rows = data ?? [];
  console.log(`撤去対象 (billing_month=${SAMPLE_MONTH} かつ notes="${MARKER}"): ${rows.length} 行`);
  for (const r of rows) console.log(`  ${r.item_name}`);
  if (!EXECUTE) {
    console.log("\nDRY RUN。消すなら --delete --execute");
    console.log("★ 撤去後に もう一度 --delete (DRY RUN) を回して 0 件を確認すること");
    process.exit(0);
  }
  if (rows.length > 0) {
    const { error: delErr } = await sb.from("payroll_office_input_entries")
      .delete().eq("billing_month", SAMPLE_MONTH).eq("notes", MARKER);
    if (delErr) throw new Error(`撤去に失敗: ${delErr.message}`);
  }
  const { count, error: cErr } = await sb.from("payroll_office_input_entries")
    .select("id", { count: "exact", head: true }).eq("billing_month", SAMPLE_MONTH).eq("notes", MARKER);
  if (cErr) throw new Error(`撤去確認に失敗: ${cErr.message}`);
  console.log(`撤去しました。残り ${count ?? 0} 件`);
  process.exit(count === 0 ? 0 : 1);
}

// ═══ 段A 書込なし・実データで前後を出す ═══════════════════════════════════
console.log("=".repeat(72));
console.log("段A  実データ・DB 書込なし — Web 入力を 1 行足すと給与がどう動くか");
console.log("=".repeat(72));

type Rec = OfficeFormRecord & { office_number: string; processing_month: string };
const csvRows = await page<Rec>("payroll_office_form_records",
  "id,office_number,employee_number,processing_month,record_type,item_name,item_date,numeric_value,start_time,end_time,break_time,year_month,child_name,amount");
// ⚠ payroll_offices に name 列は無い (identity は office_id → 共通 offices)。表示名は共通マスタから引く
const offices = await page<{ id: string; office_number: string; short_name: string | null; office_id: string | null; travel_unit_price: number | null; distance_adjustment_rate: number | null; meeting_unit_price: number | null }>(
  "payroll_offices", "id,office_number,short_name,office_id,travel_unit_price,distance_adjustment_rate,meeting_unit_price");
const masterOffices = await page<{ id: string; name: string }>("offices", "id,name");
const masterNameById = new Map(masterOffices.map((o) => [o.id, o.name]));
const emps = await page<{ id: string; employee_number: string; name: string; office_id: string }>(
  "payroll_employees", "id,employee_number,name,office_id");
const officeByNum = new Map(offices.map((o) => [o.office_number, o]));

// 対象を自動で選ぶ: 出張km が入っている (事業所 × 月 × 職員) のうち 最新月の先頭
const candidates = csvRows
  .filter((r) => r.item_name === "出張km" && (r.numeric_value ?? 0) > 0)
  .sort((a, b) => b.processing_month.localeCompare(a.processing_month));
if (candidates.length === 0) { console.log("対象が見つかりません (出張km の行が無い)"); process.exit(1); }
const target = candidates[0];
const office = officeByNum.get(target.office_number);
const empRow = emps.find((e) => e.office_id === office?.id && normEmp(e.employee_number) === normEmp(target.employee_number));
const officeLabel = office?.short_name || masterNameById.get(office?.office_id ?? "") || target.office_number;
console.log(`対象: ${officeLabel} / ${target.processing_month} / 職員番号 ${target.employee_number}${empRow ? ` (${empRow.name})` : " ★ 職員マスタに未登録"}`);

const mine = csvRows.filter((r) => r.office_number === target.office_number
  && r.processing_month === target.processing_month
  && normEmp(r.employee_number) === normEmp(target.employee_number));
console.log(`\nこの職員の CSV 取込の行 ${mine.length} 件:`);
for (const r of mine) {
  console.log(`  ${r.record_type.padEnd(9)} ${r.item_name.padEnd(10)} date=${String(r.item_date ?? "-").padEnd(12)} num=${String(r.numeric_value ?? "-").padEnd(8)} ${r.start_time ?? ""}${r.end_time ? "-" + r.end_time : ""}`);
}

/** 事業所書式の行から 金額に効く数字を出す (画面と同じ payroll-calc の関数だけを使う) */
function moneyOf(recs: OfficeFormRecord[]) {
  const tripKm = recs.filter((r) => r.record_type === "km" && r.item_name === "出張km")
    .reduce((s, r) => s + (r.numeric_value ?? 0), 0);
  const adjusted = adjustedCommuteDistanceM(tripKm * 1000, office?.distance_adjustment_rate ?? 100);
  const tripFee = businessTripFeeAmount(adjusted, office?.travel_unit_price ?? 0);
  const trainMin = trainingMinutes(recs);
  const trainPay = trainingPayAmount(trainMin, TRAINING_RATE_PER_HOUR);
  const meeting = computeMeetingFee(recs, office?.meeting_unit_price ?? 1150);
  const leave = officeFormPaidLeaveDays(recs);
  return { tripKm, tripFee, trainMin, trainPay, meeting, leave };
}

/** 足してみる Web 入力 (= 事業所が /office-input で打った想定) */
const mkEntry = (p: Partial<OfficeInputEntry> & Pick<OfficeInputEntry, "category" | "item_name">): OfficeInputEntry => ({
  id: "demo", tenant_id: "kt-group", employee_id: empRow?.id ?? "demo", billing_month: SAMPLE_MONTH,
  numeric_value: null, time_minutes: null, date_value: null, start_time: null, end_time: null,
  break_minutes: null, child_name: null, reference_month: null, notes: MARKER,
  created_at: "", updated_at: "", ...p,
} as OfficeInputEntry);

const demoEntries: OfficeInputEntry[] = [
  mkEntry({ category: "数値項目", item_name: "出張km", numeric_value: (target.numeric_value ?? 0) + 100 }),
  mkEntry({ category: "数値項目", item_name: "会議1件数", numeric_value: 2 }),
  // ★ 有給は 2 日ぶん入れる。1 日だと CSV 側の有給 1 日と釣り合って「動かない」ように見えてしまう
  mkEntry({ category: "日付項目", item_name: "有給", date_value: `${target.processing_month.slice(0, 4)}-${target.processing_month.slice(4, 6)}-05` }),
  mkEntry({ category: "日付項目", item_name: "有給", date_value: `${target.processing_month.slice(0, 4)}-${target.processing_month.slice(4, 6)}-06` }),
  mkEntry({ category: "日時項目", item_name: "HRD研修", date_value: `${target.processing_month.slice(0, 4)}-${target.processing_month.slice(4, 6)}-09`, start_time: "09:00:00", end_time: "12:00:00", break_minutes: 30 }),
];
const webRecs = demoEntries.map((e) => officeInputEntryToFormRecord(e, target.employee_number));
const merged = mergeOfficeFormSources(mine, webRecs);

const before = moneyOf(mine);
const after = moneyOf(merged.records);
console.log(`\nWeb 入力 (想定) ${webRecs.length} 行を足すと CSV ${merged.csvDropped} 行が差し替わる`);
console.log(`\n  項目             BEFORE (CSV のみ)      AFTER (Web 合流後)`);
const line = (label: string, b: string, a: string) =>
  console.log(`  ${label.padEnd(14)} ${b.padStart(20)}   ${a.padStart(20)}${b === a ? "" : "   ← 動いた"}`);
line("出張km", `${before.tripKm} km`, `${after.tripKm} km`);
line("出張費", yen(before.tripFee), yen(after.tripFee));
line("研修時間", `${before.trainMin} 分`, `${after.trainMin} 分`);
line("研修手当", yen(before.trainPay), yen(after.trainPay));
line("会議費", yen(before.meeting), yen(after.meeting));
line("有給日数", `${before.leave} 日`, `${after.leave} 日`);
const moved = (["tripFee", "trainPay", "meeting"] as const).reduce((s, k) => s + (after[k] - before[k]), 0);
console.log(`\n  → 金額の差: ${yen(moved)} (出張費 + 研修手当 + 会議費)`);
console.log(`  → 有給日数の差: ${after.leave - before.leave} 日`);
if (moved === 0 && after.leave === before.leave) {
  console.log("  ★ 1 円も動いていません。射影か合流が効いていない可能性があります");
  process.exit(1);
}
console.log("  ★ DB は 1 行も触っていません");

// ═══ 段B 実際に INSERT して読み戻す ══════════════════════════════════════
console.log(`\n${"=".repeat(72)}`);
console.log(`段B  サンプル投入 (billing_month=${SAMPLE_MONTH} / notes="${MARKER}")`);
console.log("=".repeat(72));
if (!empRow) {
  console.log("★ 対象職員が payroll_employees に居ないのでサンプル投入はしません (段A のみ)");
  process.exit(0);
}
const payload = demoEntries.map((e) => ({
  employee_id: empRow.id, billing_month: SAMPLE_MONTH, category: e.category, item_name: e.item_name,
  numeric_value: e.numeric_value, time_minutes: e.time_minutes, date_value: e.date_value,
  start_time: e.start_time, end_time: e.end_time, break_minutes: e.break_minutes,
  child_name: e.child_name, reference_month: e.reference_month, notes: MARKER,
}));
console.log(`投入する ${payload.length} 行 (職員 ${empRow.name} / ${empRow.employee_number}):`);
for (const p of payload) console.log(`  ${p.category.padEnd(6)} ${p.item_name.padEnd(10)} num=${p.numeric_value ?? "-"} date=${p.date_value ?? "-"} ${p.start_time ?? ""}`);

if (!EXECUTE) {
  console.log("\nDRY RUN。投入するなら --execute");
  console.log("★ 投入したら必ず --delete --execute で撤去し、--delete の DRY RUN で 0 件を確認すること");
  process.exit(0);
}

// 既存のサンプルがあれば先に消す (二重投入を防ぐ)
{
  const { error } = await sb.from("payroll_office_input_entries")
    .delete().eq("billing_month", SAMPLE_MONTH).eq("notes", MARKER);
  if (error) throw new Error(`既存サンプルの撤去に失敗: ${error.message}`);
}
// ⚠ 行ごとにキー集合が違うと未指定列に NULL が明示送信される。payload は全行同じキーに揃えてある
const { data: inserted, error: insErr } = await sb.from("payroll_office_input_entries").insert(payload).select();
if (insErr) throw new Error(`投入に失敗: ${insErr.message}`);
console.log(`\n投入しました: ${inserted?.length ?? 0} 行`);

// 読み戻し — 画面と同じ query 関数の条件で引き、同じ射影を通す
const { data: readBack, error: rbErr } = await sb.from("payroll_office_input_entries")
  .select("*").eq("employee_id", empRow.id).eq("billing_month", SAMPLE_MONTH).order("id");
if (rbErr) throw new Error(`読み戻しに失敗: ${rbErr.message}`);
const rbRecs = ((readBack ?? []) as OfficeInputEntry[]).map((e) => officeInputEntryToFormRecord(e, empRow.employee_number));
const rbMoney = moneyOf(mergeOfficeFormSources(mine, rbRecs).records);
console.log("\n読み戻して同じ射影を通した結果 (段A の AFTER と一致するはず):");
const same = (a: number, b: number) => (a === b ? "一致" : `★ 不一致 (${a} vs ${b})`);
console.log(`  出張費   ${yen(rbMoney.tripFee)}  ${same(rbMoney.tripFee, after.tripFee)}`);
console.log(`  研修手当 ${yen(rbMoney.trainPay)}  ${same(rbMoney.trainPay, after.trainPay)}`);
console.log(`  会議費   ${yen(rbMoney.meeting)}  ${same(rbMoney.meeting, after.meeting)}`);
console.log(`  有給日数 ${rbMoney.leave} 日  ${same(rbMoney.leave, after.leave)}`);
const ok = rbMoney.tripFee === after.tripFee && rbMoney.trainPay === after.trainPay
  && rbMoney.meeting === after.meeting && rbMoney.leave === after.leave;
console.log(`\n★ 撤去を忘れないこと: npx tsx migrations/office_input_flow_demo.mts --delete --execute`);
console.log(ok ? "[PASS] DB 往復しても同じ金額になった" : "[FAIL] DB 往復で金額が変わった");
process.exit(ok ? 0 : 1);
