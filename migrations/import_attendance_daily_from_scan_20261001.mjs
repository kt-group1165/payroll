/**
 * 出勤簿の **日別** を スキャン PDF の読み取り結果 (TSV) から取り込む (2026-10-01)。
 *
 *   node migrations/import_attendance_daily_from_scan_20261001.mjs --file <path.tsv>
 *   node migrations/import_attendance_daily_from_scan_20261001.mjs --file <path.tsv> --execute
 *   node migrations/import_attendance_daily_from_scan_20261001.mjs --file <path.tsv> --delete --execute
 *
 * ── なぜ 日別で入れるか ───────────────────────────────────────────────────
 * 事務員の一部 (おゆみ野 世古啓子・牛来葉子 ほか) は `payroll_attendance_records` が **0 行**で、
 * ★ 出勤時間は 月合計の手入力 (payroll_monthly_inputs.office_work_minutes) だけ入っていた。
 * ★ そのため **残業が 0 のまま**で ② より過少に出ていた (3 名 12 人月 ¥71,052)。
 *
 * ★ 日別で入れれば 残業は **当方の計算 (日 8h 超 + 週 40h 超)** で出る。導出値を入れなくて済む。
 *   実証 (牛来葉子 202606): 8.5h の日 +0.5 / 10h の日 +2 → 2.5h = 150 分 = ② の残業 150 と一致。
 *
 * ⚠ 出どころは **スキャンの出勤簿そのもの** (1 人 1 枚)。★ 総括表のページからは取らない (循環)。
 * ⚠ 読み取りは目視なので、★ 取込後に **合計時間が用紙の「合計時間」と一致するか**を必ず出す。
 *   合わなければ --execute しても意味がないので、★ 本 script は合計が合わない人月を **止める**。
 *
 * ── TSV の形式 ───────────────────────────────────────────────────────────
 *   # で始まる行・空行は 読み飛ばす。タブ区切り。
 *   office_number  employee_number  year  month  day  day_of_week  start  end  break  work_hours  commute_km  note
 *     start/end/break/work_hours は "H:MM" (休みの日は 空)。work_hours は 用紙の「時間数」
 *   ★ 最後に 1 行だけ 合計行を置く (検算用):
 *   #TOTAL  office_number  employee_number  year  month  合計時間(H:MM)  出勤日数
 */
import { readFileSync } from "node:fs";
import { parseAttendanceTsv, groupByPersonMonth, groupKeyOf, normEmpNo, hmToMinutes } from "./_attendance_tsv_parse.mjs";

const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");

const FILES = process.argv.reduce((a, v, i) => (process.argv[i - 1] === "--file" ? [...a, v] : a), []);
if (!FILES.length) { console.error("使い方: --file <path.tsv> [--file ...] [--delete] [--execute]"); process.exit(1); }

const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) { console.error("★ .env.local が読めません"); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const q = async (path, init) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: H, ...init });
  if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`);
  const body = await r.text();          // ⚠ PostgREST は return=representation が無いと本文を返さない
  return body ? JSON.parse(body) : null;
};
const nn = normEmpNo, hm = hmToMinutes;
const NOTE = "スキャンの出勤簿 (日別) から (import_attendance_daily_from_scan_20261001.mjs)";

let rows = [], totals = [];
try { ({ rows, totals } = parseAttendanceTsv(FILES)); }
catch (e) { console.error(`★ ${e.message}`); process.exit(1); }
console.log(`=== 出勤簿 (日別) をスキャンから取込 ${DELETE ? "【削除】" : EXECUTE ? "【実行】" : "(DRY RUN)"} ===`);
console.log(`  TSV ${FILES.length} 本 / 日別 ${rows.length} 行 / 検算行 ${totals.length}`);

const groups = groupByPersonMonth(rows);

// ── 検算: 読み取った 時間数の合計が 用紙の「合計時間」と一致するか ───────────
let bad = 0;
console.log("\n--- 検算 (読み取った合計 vs 用紙の合計時間)");
for (const t of totals) {
  const k = groupKeyOf(t);
  const g = groups.get(k) ?? [];
  const sum = g.reduce((s, r) => s + (hm(r.work_hours) ?? 0), 0);
  const days = g.filter((r) => (hm(r.work_hours) ?? 0) > 0).length;
  const okT = t.totalMinutes != null && sum === t.totalMinutes, okD = t.workDays === days;
  console.log(`  ${okT && okD ? "o " : "★ "}${k}  読み取り ${sum} 分 / ${days} 日  ←→ 用紙 ${t.totalMinutes} 分 / ${t.workDays} 日`);
  if (!okT || !okD) bad++;
}
for (const k of groups.keys()) if (!totals.some((t) => groupKeyOf(t) === k)) { console.log(`  ★ ${k} に #TOTAL の検算行がありません`); bad++; }
if (bad) { console.error(`\n★ 検算が合わない人月が ${bad} 件あります。読み取りを直してから実行してください`); process.exit(2); }

// ── 既存行の確認 (入れ直しは 消してから) ───────────────────────────────
for (const [k, g] of groups) {
  const [on, emp, y, m] = k.split("|");
  const cur = await q(`payroll_attendance_records?select=id,remarks&office_number=eq.${on}&employee_number=eq.${emp}&year=eq.${y}&month=eq.${m}`);
  const mine = cur.filter((r) => r.remarks === NOTE).length;
  console.log(`  ${k}  入れる ${g.length} 行 / 既存 ${cur.length} 行 (うち この script ${mine})`);
  if (DELETE) {
    if (!EXECUTE) continue;
    for (const r of cur.filter((x) => x.remarks === NOTE)) await q(`payroll_attendance_records?id=eq.${r.id}`, { method: "DELETE" });
    continue;
  }
  if (cur.length > 0) { console.error(`★ ${k} に既に ${cur.length} 行あります。--delete --execute で消してから入れ直してください`); process.exit(2); }
}
if (DELETE) { console.log(EXECUTE ? "\n消しました" : "\n(DRY RUN。--delete --execute で消します)"); process.exit(0); }
if (!EXECUTE) { console.log("\n(DRY RUN。--execute で書き込みます)"); process.exit(0); }

const emps = await q("payroll_employees?select=employee_number,name,office_id&limit=2000");
const pofs = await q("payroll_offices?select=id,office_number&limit=200");
const offIdOf = new Map(pofs.map((o) => [o.id, o.office_number]));
const nameOf = new Map(emps.map((e) => [`${offIdOf.get(e.office_id) ?? "?"}|${nn(e.employee_number)}`, e.name]));

// ⚠ remarks は **削除のしるし** に使うので TSV の備考 (休み/有給 …) は work_note_1 に入れる。
//   work_note_1 は 計算には使われていない (型定義と画面表示だけ。2026-10-01 に grep で確認)。
const body = rows.map((r) => ({ ...r, employee_name: nameOf.get(`${r.office_number}|${nn(r.employee_number)}`) ?? "",
  substitute_date: "", work_note_1: r.remarks ?? "", work_note_2: "", work_note_3: "", work_note_4: "", work_note_5: "",
  start_time_2: "", end_time_2: "", start_time_3: "", end_time_3: "", start_time_4: "", end_time_4: "", start_time_5: "", end_time_5: "",
  overtime_weekly: "", overtime_daily: "", holiday_work: "", legal_overtime: "", deduction: "", remarks: NOTE }));
for (let i = 0; i < body.length; i += 200) await q("payroll_attendance_records", { method: "POST", body: JSON.stringify(body.slice(i, i + 200)) });
console.log(`\n${body.length} 行を入れました`);
console.log("★ 次に 対象の 事業所×月 を再計算すること");
console.log("★ 戻すときは --delete --execute");
