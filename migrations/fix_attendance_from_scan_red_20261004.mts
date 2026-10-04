/**
 * 事務員の出勤簿を スキャンの **赤字訂正** どおりに直す (2026-10-04)。
 *
 *   npx tsx migrations/fix_attendance_from_scan_red_20261004.mts            # DRY RUN
 *   npx tsx migrations/fix_attendance_from_scan_red_20261004.mts --execute
 *
 * ── なぜ ────────────────────────────────────────────────────────────────
 * 出勤簿 (Excel) の取込値は 給与担当がスキャンに赤で入れた訂正を反映していない。
 * ② (総括表) は 訂正後の値で払っている。★ 赤字 (スキャン) と ② の 2 つが一致する行だけ直す
 * ([[feedback_two_sources_before_filling_input]])。熊谷 202604 (fix_kumagai_202604_break_from_scan.mts) と同じ型。
 *
 * ⚠ 規則にはしない。
 *   「休憩欄が空なら 1 時間引く」は 392 行 / 171 人月を壊すので却下済み。
 *   「振替休があれば 週残業を払わない」は 4 件中 2 件しか当てはまらない
 *   (小原 202608・根本 202603 は 振替休があっても ② が週残業を払っている)。
 *
 * ── 1 行 = 1 日 ──────────────────────────────────────────────────────────
 * 出どころ: Box …\02_スキャン\<拠点>\<拠点>　R8\<拠点>　R8.<n>\R8.<n>　<拠点>　社員.pdf (ページは 1 始まり)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { computeSummary, type OfficeAttendanceRecord } from "@/lib/payroll/payroll-calc";

type Patch = Partial<Record<"break_time" | "work_hours" | "overtime_daily" | "overtime_weekly", string>>;
const PLAN: { off: string; emp: string; ym: string; day: number; expect: Patch; set: Patch; src: string }[] = [
  // 黒田 美和 (リンクスヘルパーステーション山武・事務員)
  //   山武 R8.3 p42: 3/31 の休憩欄に赤で「1:00」、勤務時間 9:00 を消して「8:00」、合計の横に「176:00」。
  //   ② 202603: 出勤 10,560 (=176:00) / 残業 0
  { off: "1279000366", emp: "260302", ym: "202603", day: 31,
    expect: { break_time: "", work_hours: "9:00", overtime_daily: "01:00" },
    set: { break_time: "1:00", work_hours: "8:00", overtime_daily: "" },
    src: "山武 R8.3 p42 3/31 休憩に赤「1:00」・9:00→8:00・合計「176:00」" },
  // 高田 信乃 (Ｈａｎａヘルパーステーション中央・事務員)
  //   中央 R8.8 p6: 8/2(日・公休) 9:00-13:00 から 8/11「8/2の一部振替休」9:00-13:00 へ赤の矢印。
  //   8/8 の 週残業 04:00 と 合計の 04:00 に 赤の ×、欄外に「残 2h」。② 202608: 残業 120
  { off: "1270105271", emp: "1191", ym: "202608", day: 8,
    expect: { overtime_weekly: "04:00" }, set: { overtime_weekly: "" },
    src: "中央 R8.8 p6 8/8 週残業 04:00 に赤の×・欄外「残 2h」" },
  // 相原 康子 (リンクスヘルパーステーションいすみ・事務員)
  //   いすみ R8.3 p7: 3/1(日・公休) 8:00 の振替として 3/3・3/9 が「3/1の一部振替休」9:00-13:00 (赤丸)。
  //   残業として赤で囲んだのは 3/31 の「①」だけ。② 202603: 残業 60
  //   ⚠ 高田と違い 週残業 04:00 に × は無い。★ 振替の赤丸と「①」だけを残業とした印、と読んでいる
  { off: "1278600398", emp: "11003", ym: "202603", day: 7,
    expect: { overtime_weekly: "04:00" }, set: { overtime_weekly: "" },
    src: "いすみ R8.3 p7 3/3・3/9 を 3/1 の振替として赤丸・残業は 3/31 の「①」のみ" },
];

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

type Row = OfficeAttendanceRecord & { id: string; day: number; employee_name: string } & Record<string, unknown>;
const load = async (off: string, emp: string, y: number, m: number): Promise<Row[]> => {
  const { data, error } = await sb.from("payroll_attendance_records").select("*")
    .eq("office_number", off).eq("employee_number", emp).eq("year", y).eq("month", m).order("day");
  if (error) { console.error("読込失敗:", error.message); process.exit(2); }
  return (data ?? []) as Row[];
};
const hm = (x: number) => `${Math.floor(x / 60)}:${String(x % 60).padStart(2, "0")}`;
const str = (v: unknown) => (v == null ? "" : String(v));

let bad = 0;
const todo: { id: string; set: Patch; before: Row }[] = [];
for (const key of [...new Set(PLAN.map((p) => `${p.off}|${p.emp}|${p.ym}`))]) {
  const [off, emp, ym] = key.split("|");
  const y = +ym.slice(0, 4), m = +ym.slice(4);
  const cur = await load(off, emp, y, m);
  const prev = await load(off, emp, m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1);
  const plans = PLAN.filter((p) => `${p.off}|${p.emp}|${p.ym}` === key);
  const fixed = cur.map((r) => {
    const p = plans.find((x) => x.day === r.day);
    return p ? { ...r, ...p.set } : r;
  });
  for (const p of plans) {
    const r = cur.find((x) => x.day === p.day);
    if (!r) { console.error(`★ ${key} ${p.day} 日の行がありません`); bad++; continue; }
    const already = Object.entries(p.set).every(([k, v]) => str(r[k]) === v);
    const asExpected = Object.entries(p.expect).every(([k, v]) => str(r[k]) === v);
    if (already) continue;
    if (!asExpected) { console.error(`★ ${key} ${p.day} 日が想定と違います: ${JSON.stringify(Object.fromEntries(Object.keys(p.expect).map((k) => [k, r[k]])))}`); bad++; continue; }
    todo.push({ id: r.id, set: p.set, before: r });
  }
  const { data: s } = await sb.from("payroll_soukatsu_rows").select("row_data")
    .eq("office_number", off).eq("employee_number", emp).eq("processing_month", ym).maybeSingle();
  const d = (s?.row_data ?? {}) as Record<string, unknown>;
  const w2 = Number(d["出勤時間"] ?? 0), ot2 = Number(d["残業"] ?? 0);
  const a = computeSummary([], cur, [], "office_form_first", new Set(), ym, false, prev);
  const b = computeSummary([], fixed as OfficeAttendanceRecord[], [], "office_form_first", new Set(), ym, false, prev);
  const ok = b.workHoursMin === w2 && b.overtimeMinutes === ot2;
  if (!ok) bad++;
  console.log(`\n${cur[0]?.employee_name} ${ym} (${plans.map((p) => `${p.day}日`).join(",")})`);
  console.log(`  実働  ${hm(a.workHoursMin)} → ${hm(b.workHoursMin)}   ② ${hm(w2)}`);
  console.log(`  残業  ${hm(a.overtimeMinutes)} → ${hm(b.overtimeMinutes)}   ② ${hm(ot2)}${ok ? "   ✔ ② と一致" : "   ★ ② と一致しません"}`);
}
if (bad) { console.error(`\n★ ${bad} 件 問題があります。中止します`); process.exit(2); }
console.log(`\n直すもの ${todo.length} 行`);
if (!todo.length) { console.log("既に直っています。何もしません"); process.exit(0); }
if (!EXECUTE) { console.log("(DRY RUN。--execute で実行します)"); process.exit(0); }

const bk = `migrations/_backup_attendance_scan_red_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.json`;
writeFileSync(bk, JSON.stringify(todo.map((t) => t.before), null, 1));
console.log(`  退避: ${bk}`);
for (const t of todo) {
  const { data, error } = await sb.from("payroll_attendance_records").update(t.set).eq("id", t.id).select("id");
  if (error || (data ?? []).length !== 1) { console.error(`★ 更新失敗 ${t.id}: ${error?.message ?? `件数 ${data?.length}`}`); process.exit(2); }
  console.log(`  更新 ${t.before.employee_name} ${t.before.day}日 ${JSON.stringify(t.set)}`);
}
console.log("\n⚠ /payroll で 再計算してください: 山武 202603 / 中央 202608 / いすみ 202603");
