/**
 * スキャンの出勤簿 (日別) を書き写した TSV の読み取り。
 * ★ 取込 (import_attendance_daily_from_scan_20261001.mjs) と
 *   検査 (scripts/check-attendance-daily-scan.mts) の **両方がここを呼ぶ**。
 *   ★ 逐語コピーで 2 本書くと 片方だけ直したときに乖離する
 *   ([[feedback_test_verbatim_copy_and_wrong_expectation]])。
 *
 * TSV の形式 (# で始まる行・空行は読み飛ばす。タブ区切り):
 *   office_number  employee_number  year  month  day  day_of_week  start  end  break  work_hours  commute_km  note
 *   #TOTAL  office_number  employee_number  year  month  合計時間(H:MM)  出勤日数     ← 検算用。人月ごとに 1 行
 */
import { readFileSync } from "node:fs";

export const normEmpNo = (s) => String(s ?? "").trim().replace(/^0+/, "");
export const hmToMinutes = (s) => {
  const m = /^(\d+):(\d+)$/.exec(String(s ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
export const groupKeyOf = (r) => `${r.office_number}|${normEmpNo(r.employee_number)}|${r.year}|${r.month}`;

/** @returns {{ rows: object[], totals: object[] }} rows は payroll_attendance_records の列名で返す */
export function parseAttendanceTsv(files) {
  const rows = [], totals = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const [i, line] of text.split(/\r?\n/).entries()) {
      const s = line.trim();
      if (!s) continue;
      if (s.startsWith("#TOTAL")) {
        const c = s.split("\t").map((x) => x.trim());
        totals.push({ office_number: c[1], employee_number: normEmpNo(c[2]), year: Number(c[3]), month: Number(c[4]),
          totalMinutes: hmToMinutes(c[5]), workDays: Number(c[6]), file: f });
        continue;
      }
      if (s.startsWith("#")) continue;
      const c = line.split("\t").map((x) => String(x ?? "").trim());
      if (c.length < 10) throw new Error(`${f}:${i + 1} 列が足りません (${c.length}): ${s.slice(0, 70)}`);
      const [on, emp, y, m, d, dow, st, en, br, wh, km, note] = c;
      rows.push({ office_number: on, employee_number: emp, year: Number(y), month: Number(m), day: Number(d),
        day_of_week: dow, start_time_1: st, end_time_1: en, break_time: br, work_hours: wh,
        commute_km: km === "" ? null : Number(km), remarks: note ?? "" });
    }
  }
  return { rows, totals };
}

/** 人月ごとにまとめる */
export function groupByPersonMonth(rows) {
  const g = new Map();
  for (const r of rows) {
    const k = groupKeyOf(r);
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  return g;
}
