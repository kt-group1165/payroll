/**
 * 取込済みの出勤簿で「1 日目の 通勤km が空」の日を埋める。
 *
 *   npx tsx migrations/fix_attendance_day1_commute_km.mts            # DRY RUN
 *   npx tsx migrations/fix_attendance_day1_commute_km.mts --execute
 *
 * 出勤簿 xlsm は 1 日目だけ 勤務時間 も 通勤km も空で出てくる (勤務時間は
 * fix_attendance_day1_work_hours.mts で埋めた)。通勤km は同じ人なら毎日同じ値のことが多いので、
 * その月の 通勤km が 1 種類しかないときだけ その値を入れる。2 種類以上ある月は決められないので触らない。
 * パーサ側は fillMissingRows() で同じことをする (これから取り込むぶん)。
 *
 * 根拠: 総括表 2026-03〜07 の「距離(通)」と突合すると 61 人月中 7 → 45 一致に増える
 * (例 市原ムツミ 中村素子 2026-07: 172.8km → 182.4km = 総括表)。
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const EXECUTE = process.argv.includes("--execute");
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

type Row = { id: string; office_number: string; employee_number: string; employee_name: string; year: number; month: number; day: number; commute_km: number | null; start_time_1: string | null; end_time_1: string | null };
const all: Row[] = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from("payroll_attendance_records")
    .select("id,office_number,employee_number,employee_name,year,month,day,commute_km,start_time_1,end_time_1")
    .order("id").range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  all.push(...(data as Row[]));
  if (!data || data.length < 1000) break;
}

const groups = new Map<string, Row[]>();
for (const r of all) {
  const k = `${r.office_number}|${r.employee_number}|${r.year}|${r.month}`;
  (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
}
const fixes: { id: string; km: number; label: string }[] = [];
for (const [, rows] of groups) {
  const kms = new Set(rows.map((r) => r.commute_km).filter((v): v is number => typeof v === "number" && v > 0));
  if (kms.size !== 1) continue;
  const km = [...kms][0];
  for (const r of rows) {
    if (r.day !== 1) continue;                       // 空になるのは 1 日目だけ (実測 60 件すべて)
    if (typeof r.commute_km === "number" && r.commute_km > 0) continue;
    if (!r.start_time_1?.trim() || !r.end_time_1?.trim()) continue;
    if (r.start_time_1 === r.end_time_1) continue;   // 有給の日 (0:00-0:00)
    fixes.push({ id: r.id, km, label: `${r.year}/${r.month}/1 ${r.office_number} ${r.employee_number} ${r.employee_name} → ${km}km` });
  }
}
console.log(`=== 出勤簿 1日目の通勤kmの埋め直し ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log(`  出勤簿 ${all.length} 行 / 人月 ${groups.size} / 直すもの ${fixes.length} 行`);
for (const f of fixes.slice(0, 15)) console.log(`   ${f.label}`);
if (fixes.length > 15) console.log(`   … 他 ${fixes.length - 15} 行`);
if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }
let done = 0;
for (const f of fixes) {
  const { data, error } = await sb.from("payroll_attendance_records").update({ commute_km: f.km }).eq("id", f.id).select("id");
  if (error) { console.error(`✗ ${f.label}: ${error.message}`); process.exit(2); }
  if ((data ?? []).length !== 1) { console.error(`✗ ${f.label}: ${data?.length} 行`); process.exit(2); }
  done++;
}
console.log(`完了 ${done} 行`);
