/**
 * 取込済みの出勤簿で「開始・終了があるのに勤務時間が 0:00」の日を埋め直す。
 *
 *   npx tsx migrations/fix_attendance_day1_work_hours.mts            # DRY RUN
 *   npx tsx migrations/fix_attendance_day1_work_hours.mts --execute
 *
 * 出勤簿 xlsm の式の不具合で 1 日目だけ 勤務時間 が空のまま出てくる。
 * パーサ側は fillMissingWorkHours() で直したが、既に取り込んだ行は 0:00 のままなので直す。
 * 計算に使うのは同じ関数 (逐語コピーしない)。
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { fillMissingWorkHours } from "@/lib/csv/attendance-parser";
import type { AttendanceRow } from "@/types/csv";

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

type Row = {
  id: string; office_number: string; employee_number: string; employee_name: string;
  year: number; month: number; day: number; work_hours: string | null; break_time: string | null;
  start_time_1: string | null; end_time_1: string | null; start_time_2: string | null; end_time_2: string | null;
  start_time_3: string | null; end_time_3: string | null; start_time_4: string | null; end_time_4: string | null;
  start_time_5: string | null; end_time_5: string | null;
};

const COLS = "id,office_number,employee_number,employee_name,year,month,day,work_hours,break_time,start_time_1,end_time_1,start_time_2,end_time_2,start_time_3,end_time_3,start_time_4,end_time_4,start_time_5,end_time_5";
const all: Row[] = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from("payroll_attendance_records").select(COLS)
    .or("work_hours.is.null,work_hours.eq.0:00,work_hours.eq.00:00,work_hours.eq.")
    .not("start_time_1", "is", null).neq("start_time_1", "")
    .order("id").range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  all.push(...(data as unknown as Row[]));
  if (!data || data.length < 1000) break;
}

const fixes: { id: string; from: string; to: string; label: string }[] = [];
for (const r of all) {
  const row: AttendanceRow = {
    日付: String(r.day), 曜日: "", 振替日: "", 勤務摘要: "", 勤務摘要2: "", 勤務摘要3: "", 勤務摘要4: "", 勤務摘要5: "",
    開始: r.start_time_1 ?? "", 終了: r.end_time_1 ?? "", 開始2: r.start_time_2 ?? "", 終了2: r.end_time_2 ?? "",
    開始3: r.start_time_3 ?? "", 終了3: r.end_time_3 ?? "", 開始4: r.start_time_4 ?? "", 終了4: r.end_time_4 ?? "",
    開始5: r.start_time_5 ?? "", 終了5: r.end_time_5 ?? "", 休憩: r.break_time ?? "", 勤務時間: r.work_hours ?? "",
    通勤km: "", 出張km: "",
  };
  fillMissingWorkHours(row);
  if (row.勤務時間 && row.勤務時間 !== (r.work_hours ?? "")) {
    fixes.push({ id: r.id, from: r.work_hours ?? "(空)", to: row.勤務時間, label: `${r.year}/${r.month}/${r.day} ${r.office_number} ${r.employee_number} ${r.employee_name}` });
  }
}

console.log(`=== 出勤簿 勤務時間の埋め直し ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log(`  候補 ${all.length} 行 / 直すもの ${fixes.length} 行`);
const byDay = new Map<number, number>();
for (const f of fixes) byDay.set(Number(f.label.split("/")[2].split(" ")[0]), (byDay.get(Number(f.label.split("/")[2].split(" ")[0])) ?? 0) + 1);
console.log(`  日別: ${[...byDay.entries()].sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d}日 ${n}`).join(" / ")}`);
for (const f of fixes.slice(0, 15)) console.log(`   ${f.label} ${f.from} → ${f.to}`);
if (fixes.length > 15) console.log(`   … 他 ${fixes.length - 15} 行`);
if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }

let done = 0;
for (const f of fixes) {
  const { data, error } = await sb.from("payroll_attendance_records").update({ work_hours: f.to }).eq("id", f.id).select("id");
  if (error) { console.error(`✗ ${f.label}: ${error.message}`); process.exit(2); }
  if ((data ?? []).length !== 1) { console.error(`✗ ${f.label}: ${data?.length} 行`); process.exit(2); }
  done++;
}
console.log(`完了 ${done} 行`);
