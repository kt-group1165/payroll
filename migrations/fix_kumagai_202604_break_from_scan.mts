/**
 * 熊谷 明日香 (ＫＴやわた 1272404508 / 260402・事務員) 2026-04 の出勤簿を スキャンの赤字訂正どおりに直す (2026-10-04)。
 *
 *   npx tsx migrations/fix_kumagai_202604_break_from_scan.mts            # DRY RUN
 *   npx tsx migrations/fix_kumagai_202604_break_from_scan.mts --execute
 *
 * ── なぜ ────────────────────────────────────────────────────────────────
 * 入社月 (4/10 入社) の出勤簿 (Excel) は 15 日すべて 9:00〜18:00 で ★ 休憩欄が空。
 * Excel がそのまま 勤務 9:00 / 日残業 01:00 を出していて、当方は 実働 135:00 / 残業 15:00 (¥18,570) を払っていた。
 *
 * ★ スキャン (Box …\02_スキャン\至03　やわた\やわた　R8\やわた　R8.4\R8.4　やわた　社員.pdf の p33) に
 *   給与担当の赤字訂正がある:
 *     休憩欄に「1:00」(4/10・4/13・4/20・4/27 に書き、週ごとに矢印で金曜まで) / 合計 135:00 の横に「120h」
 *     欄外「15d × 8h」「120h」「100,000 × 120/159 = 75,480」「90,000 × 120/159 = 67,920」
 * ★ ② (総括表) 202604: 出勤日数 15 / 出勤時間 7,200 (=120:00) / 残業 なし / 本人給 75,480 / 職能給 67,920。
 * → 出どころが 2 つ独立していて一致する ([[feedback_two_sources_before_filling_input]])。
 *
 * ⚠ 「休憩欄が空なら一律 1 時間引く」にはしない (欄と時刻が一致している 392 行 / 171 人月まで減る)。
 *   ★ この 1 人月だけ、赤字の訂正があるから直す。
 * ⚠ 5 月は 勤務時間欄が 8:00 で入っていて、計算側 (attendanceWorkMinutes) が既に欄を採っている。触らない。
 *
 * 直すもの (15 行): break_time 空 → "1:00" / work_hours "9:00" → "8:00" / overtime_daily "01:00" → null
 * 退避: migrations/_backup_kumagai_202604_attendance_<日付>.json (後で消す)
 * ⚠ 投入後に /payroll で ＫＴやわた 202604 を再計算すること。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { computeSummary, type OfficeAttendanceRecord } from "@/lib/payroll/payroll-calc";

const EXECUTE = process.argv.includes("--execute");
const STAGING = process.env.PAYROLL_ENV === "staging";
const env: Record<string, string> = {};
for (const p of STAGING ? [".env.staging"] : ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY がありません"); process.exit(2); }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
console.log(`[DB] ${STAGING ? "staging" : "本番"} ${/https:\/\/([a-z0-9]+)\./.exec(env.NEXT_PUBLIC_SUPABASE_URL)?.[1]}`);

const OFFICE = "1272404508", EMP = "260402", YM = "202604";
const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

const { data: rows, error } = await sb.from("payroll_attendance_records").select("*")
  .eq("office_number", OFFICE).eq("employee_number", EMP).eq("year", 2026).eq("month", 4).order("day");
if (error || !rows) { console.error("読込失敗:", error?.message); process.exit(2); }
const att = rows as (OfficeAttendanceRecord & { id: string; day: number; employee_name: string })[];
const targets = att.filter((r) => r.start_time_1 === "9:00" && r.end_time_1 === "18:00");
const pending = targets.filter((r) => r.break_time !== "1:00" || r.work_hours !== "8:00" || r.overtime_daily);

// ★ 想定どおりの形か (違えば止める)
const unexpected = att.filter((r) => r.start_time_1 && !targets.includes(r));
if (targets.length !== 15 || unexpected.length) {
  console.error(`★ 想定外: 9:00〜18:00 の行 ${targets.length} (期待 15) / それ以外の勤務行 ${unexpected.length}。中止します`);
  process.exit(2);
}
const fixed = att.map((r) => targets.includes(r) ? { ...r, break_time: "1:00", work_hours: "8:00", overtime_daily: null } : r);

// ★ 計算は本番の関数で (逐語コピーしない)
const before = computeSummary([], att, [], "office_form_first", new Set(), YM);
const after = computeSummary([], fixed as OfficeAttendanceRecord[], [], "office_form_first", new Set(), YM);
const { data: s } = await sb.from("payroll_soukatsu_rows").select("row_data")
  .eq("office_number", OFFICE).eq("employee_number", EMP).eq("processing_month", YM).maybeSingle();
const d = (s?.row_data ?? {}) as Record<string, unknown>;
const w2 = Number(d["出勤時間"] ?? 0), ot2 = Number(d["残業"] ?? 0);
console.log(`\n${att[0]?.employee_name} ${YM}  対象 ${targets.length} 行 / 直すもの ${pending.length} 行`);
console.log(`  実働  ${hm(before.workHoursMin)} → ${hm(after.workHoursMin)}   ② ${hm(w2)}`);
console.log(`  残業  ${hm(before.overtimeMinutes)} → ${hm(after.overtimeMinutes)}   ② ${hm(ot2)}`);
if (after.workHoursMin !== w2 || after.overtimeMinutes !== ot2) {
  console.error("★ 直した後の値が ② と一致しません。中止します"); process.exit(2);
}
if (!pending.length) { console.log("既に直っています。何もしません"); process.exit(0); }
if (!EXECUTE) { console.log("\n(DRY RUN。--execute で実行します)"); process.exit(0); }

const bk = `migrations/_backup_kumagai_202604_attendance_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.json`;
writeFileSync(bk, JSON.stringify(pending, null, 1));
console.log(`  退避: ${bk}`);
const { data: upd, error: ue } = await sb.from("payroll_attendance_records")
  .update({ break_time: "1:00", work_hours: "8:00", overtime_daily: null })
  .in("id", pending.map((r) => r.id)).select("id");
if (ue) { console.error("更新失敗:", ue.message); process.exit(2); }
if ((upd ?? []).length !== pending.length) { console.error(`★ 更新件数 ${upd?.length} ≠ ${pending.length}`); process.exit(2); }
console.log(`  更新 ${upd!.length} 行`);
console.log("\n⚠ /payroll で ＫＴやわた 202604 を再計算してください");
