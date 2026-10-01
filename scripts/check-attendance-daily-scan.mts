/**
 * check:attendance-daily-scan — スキャンから書き写した **日別出勤簿 TSV** が
 * ② (payroll_soukatsu_rows) の 出勤時間・出勤日数・残業 を再現するかを見る。★ 読み取り専用。
 *
 *   npm run check:attendance-daily-scan
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────────
 * 一部の事務員は 出勤簿が CSV で取り込めず (紙→スキャン PDF のみ)、
 * ★ `payroll_monthly_inputs.office_work_minutes` に **月合計だけ**手入力されていた。
 * そのため **残業が 0 のまま**で ② より過少に出ていた。
 * 日別で入れれば 残業は 当方の計算 (日 8h 超 + 週 40h 超) で出せる
 * → ★ 「その書き写しが本当に ② を再現するか」を 常設で見張る
 *   ([[feedback_write_knowhow_as_you_go]] / 一度の調査を検査に変える)。
 *
 * ── 何を見るか ────────────────────────────────────────────────────────────
 *   TSV の行を **本番の computeSummary() にそのまま渡して** 出勤時間・出勤日数・残業を出し、② と比べる。
 *   ★ 逐語コピーはしない。TSV の読み取りも 取込 script と同じ `_attendance_tsv_parse.mjs` を使う。
 *
 * ── この検査が見ていないもの ──────────────────────────────────────────────
 *   ・残業「代」の金額 (単価は別の話。→ check:verification-verdicts)
 *   ・DB に入っているかどうか (★ TSV を見るだけ。取込前でも回る)
 *   ・TSV に無い人月 (世古 202608・牛来 202605 等。理由は各 TSV の冒頭に書いてある)
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { restAll, normEmpNo } from "./_rest.mjs";
import { parseAttendanceTsv, groupByPersonMonth, groupKeyOf, type ScanAttendanceRow } from "../migrations/_attendance_tsv_parse.mjs";
import { computeSummary, type OfficeAttendanceRecord } from "../src/lib/payroll/payroll-calc.js";

const TSV_DIR = new URL("../migrations/_attendance_tsv/", import.meta.url);
type Souk = { office_number: string; processing_month: string; employee_number: string; row_data: Record<string, unknown> };
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);

let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };

/** TSV の行 → 本番の computeSummary で 出勤時間・出勤日数・残業 を出す */
function summarize(rows: ScanAttendanceRow[], yearMonth: string) {
  return computeSummary([], rows as unknown as OfficeAttendanceRecord[], [], "office_form_first", new Set(), yearMonth);
}

async function main() {
  console.log("=== check:attendance-daily-scan (スキャンの日別出勤簿 vs ②) 2026-10-01 新設・読み取り専用 ===");

  const files = readdirSync(TSV_DIR).filter((f) => f.startsWith("daily_") && f.endsWith(".tsv"))
    .map((f) => fileURLToPath(new URL(f, TSV_DIR)));   // ⚠ URL.pathname は 日本語パスが %XX のまま
  if (!files.length) { console.log("★ daily_*.tsv が 1 本もありません"); process.exit(0); }
  const { rows, totals } = parseAttendanceTsv(files);
  const groups = groupByPersonMonth(rows);
  console.log(`  TSV ${files.length} 本 / 日別 ${rows.length} 行 / 人月 ${groups.size}`);

  const souk = await restAll<Souk>("payroll_soukatsu_rows?select=office_number,processing_month,employee_number,row_data");
  const soukOf = new Map(souk.map((s) => [`${s.office_number}|${normEmpNo(s.employee_number)}|${s.processing_month}`, s.row_data]));

  console.log("\n--- 人月ごと (当方の計算 ←→ ②)");
  let n = 0;
  for (const [k, g] of groups) {
    const [on, emp, y, m] = k.split("|");
    const ym = `${y}${String(m).padStart(2, "0")}`;
    const d = soukOf.get(`${on}|${emp}|${ym}`);
    if (!d) { expect(false, `${k} … ② にこの人月が無い`); continue; }
    const s = summarize(g, ym);
    const w2 = num(d["出勤時間"]), day2 = num(d["出勤日数"]), ot2 = num(d["残業"]);
    const ok = s.workHoursMin === w2 && s.workDays === day2 && s.overtimeMinutes === ot2;
    expect(ok, `${k}  出勤時間 ${s.workHoursMin}/${w2}  出勤日数 ${s.workDays}/${day2}  残業 ${s.overtimeMinutes}/${ot2}`);
    n++;
  }
  // 用紙の合計行 (#TOTAL) との突合は 取込 script と同じ材料なので ここでも押さえる
  for (const t of totals) {
    const g = groups.get(groupKeyOf(t)) ?? [];
    const s = summarize(g, `${t.year}${String(t.month).padStart(2, "0")}`);
    expect(s.workHoursMin === t.totalMinutes && s.workDays === t.workDays,
      `${groupKeyOf(t)} 用紙の合計 ${t.totalMinutes} 分 / ${t.workDays} 日 ←→ 計算 ${s.workHoursMin} / ${s.workDays}`);
  }

  console.log("\n--- 負のコントロール (検査が効いていることの確認)");
  const first = [...groups.values()][0];
  const broken = first.map((r, i) => (i === first.findIndex((x) => String(x.end_time_1 ?? "") !== "")
    ? { ...r, end_time_1: "23:00" } : r));
  const s0 = summarize(first, `${first[0].year}${String(first[0].month).padStart(2, "0")}`);
  const s1 = summarize(broken, `${first[0].year}${String(first[0].month).padStart(2, "0")}`);
  expect(s1.overtimeMinutes > s0.overtimeMinutes, `★ 1 日の退社を 23:00 にすると 残業が増える (${s0.overtimeMinutes} → ${s1.overtimeMinutes})`);
  // ⚠ 休憩を **空**にしても減らない。本番に「休憩が空で 勤務時間の欄が 時刻−60分 なら欄を採る」規則が
  //   あるため (payroll-calc.ts 2026-09-26)。★ なので 休憩を 2:00 に増やして 効くことを見る
  const longBreak = first.map((r) => (String(r.break_time ?? "") === "" ? r : { ...r, break_time: "2:00" }));
  const s2 = summarize(longBreak, `${first[0].year}${String(first[0].month).padStart(2, "0")}`);
  expect(s2.workHoursMin < s0.workHoursMin, `★ 休憩を 2:00 にすると 出勤時間が減る (${s0.workHoursMin} → ${s2.workHoursMin})`);
  const dropOne = first.filter((r) => String(r.end_time_1 ?? "") === "" || r !== first.find((x) => String(x.end_time_1 ?? "") !== ""));
  const s3 = summarize(dropOne, `${first[0].year}${String(first[0].month).padStart(2, "0")}`);
  expect(s3.workDays === s0.workDays - 1, `★ 出勤日を 1 日落とすと 出勤日数が 1 減る (${s0.workDays} → ${s3.workDays})`);

  console.log(`\n--- 対象 ${n} 人月`);
  console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS");
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
