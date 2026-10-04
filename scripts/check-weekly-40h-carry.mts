/**
 * check:weekly-40h-carry — ★ 週40時間超を **月をまたぐ週** でも正しく数えているか。読み取り専用 (2026-10-04 新設)
 *
 *   npm run check:weekly-40h-carry
 *   PAYROLL_ENV=staging npm run check:weekly-40h-carry
 *   npm run check:weekly-40h-carry -- --update      ★ 一致が増えたときだけ
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────────
 * 週40時間超は **暦の週 (日曜起算)** で判定する (2026-09-23 に決めて実装済み。規則の変更ではない)。
 * ★ ところが当方は 当月の出勤簿しか見ていなかったので、★ 月をまたぐ週の前月分を数え落としていた。
 *   実例 2026-08-01 (土): 7/27〜31 で既に 40 時間 → 8/1 の勤務は丸ごと 週40時間超。
 *     相原康子 ② 10:00 (= 平日 2:00 + 8/1 8:00) / 中村美彌子 ② 7:30 / 相川晴代 ② 3:30
 *   → 2026-10-04 に `computeSummary` に 前月の出勤簿 (prevMonthAttDays) を渡せるようにした。
 *
 * ★ 出勤簿 (Excel) は 自分で週40時間超を計算して 週の最後の土曜の行に「週残業」欄として書く (前月末の日も込み)。
 *   ★ その週の当月の行に 週残業欄が既にあれば 足さない (二重計上しない)。8/1 のように 土曜が 1 日目の行だと
 *   取込で列がずれて欄が入らないので、そのときだけ 当方が足す。
 *
 * ── 何を見るか ────────────────────────────────────────────────────────────
 * ★ **事務員**の 残業 (分) を 本番の computeSummary で出し (前月の出勤簿 あり/なし)、② の「残業」列と比べる。
 *   ★ 事務員だけを見るのは、② の残業が 出勤簿から出ている役職だから
 *   (提責・社員の ② は 旧システムの日別から出ている。→ [[payroll_overtime_after_cutover_gap]])。
 *
 * ── この検査が見ていないもの ──────────────────────────────────────────────
 *   ・残業代の金額 (単価は → check:soukatsu-overtime-formula)
 *   ・出勤簿が当方に無い人月 (スキャンの手書き → [[payroll_overtime_handwritten_in_margin]])
 *   ・★ 計算結果 (payload) は見ない。★ 出勤簿から その場で計算する = 再計算しなくても回る
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { restAll, normEmpNo, SB_REF } from "./_rest.mjs";
import { computeSummary, type OfficeAttendanceRecord } from "../src/lib/payroll/payroll-calc.js";

const UPDATE = process.argv.includes("--update");
const BASELINE = "scripts/check-weekly-40h-carry-baseline.json";
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);
const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

type Att = OfficeAttendanceRecord & { office_number: string; year: number; month: number; day: number };
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };

async function main() {
  console.log("=== check:weekly-40h-carry (月をまたぐ週の 週40時間超) 2026-10-04 新設・読み取り専用 ===");
  const att = await restAll<Att>("payroll_attendance_records?select=*");
  const souk = await restAll<{ office_number: string; processing_month: string; employee_number: string; row_data: Record<string, unknown> }>(
    "payroll_soukatsu_rows?select=office_number,processing_month,employee_number,row_data");
  const calc = await restAll<{ office_number: string; processing_month: string; payload: { monthly?: { employee_number: string; role_type?: string }[] } }>(
    "payroll_calc_results?select=office_number,processing_month,payload");
  const roleOf = new Map<string, string>();
  for (const c of calc) for (const e of (c.payload?.monthly ?? [])) roleOf.set(`${c.office_number}|${normEmpNo(e.employee_number)}|${c.processing_month}`, e.role_type ?? "?");
  const byPM = new Map<string, Att[]>();
  for (const a of att) {
    const k = `${a.office_number}|${normEmpNo(a.employee_number)}|${a.year}${String(a.month).padStart(2, "0")}`;
    if (!byPM.has(k)) byPM.set(k, []);
    byPM.get(k)!.push(a);
  }
  const prevKey = (k: string) => {
    const [o, e, ym] = k.split("|"); const y = +ym.slice(0, 4), m = +ym.slice(4);
    const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
    return `${o}|${e}|${py}${String(pm).padStart(2, "0")}`;
  };

  type Row = { k: string; name: string; target: number; without: number; withPrev: number };
  function measure(mutatePrev?: (rows: Att[]) => Att[]) {
    const rows: Row[] = [];
    for (const s of souk) {
      if (!num(s.row_data["残業単価"])) continue;               // パート行 (残業列が円) を外す
      const k = `${s.office_number}|${normEmpNo(s.employee_number)}|${s.processing_month}`;
      if (roleOf.get(k) !== "事務員") continue;
      const cur = byPM.get(k); if (!cur?.length) continue;
      const prev0 = byPM.get(prevKey(k)) ?? [];
      const prev = mutatePrev ? mutatePrev(prev0) : prev0;
      const ym = s.processing_month;
      rows.push({
        k, name: String(s.row_data["氏名"] ?? ""), target: num(s.row_data["残業"]),
        without: computeSummary([], cur, [], "office_form_first", new Set(), ym).overtimeMinutes,
        withPrev: computeSummary([], cur, [], "office_form_first", new Set(), ym, false, prev).overtimeMinutes,
      });
    }
    return rows;
  }

  const rows = measure();
  const okWithout = rows.filter((r) => r.without === r.target).length;
  const okWith = rows.filter((r) => r.withPrev === r.target).length;
  const fixed = rows.filter((r) => r.without !== r.target && r.withPrev === r.target);
  const broken = rows.filter((r) => r.without === r.target && r.withPrev !== r.target);
  console.log(`  [${SB_REF}] 事務員 (当方に出勤簿あり・② に残業単価あり) ${rows.length} 人月`);
  console.log(`  ② の残業(分) と完全一致   前月なし ${okWithout} → ★ 前月あり ${okWith}   (直る ${fixed.length} / 壊れる ${broken.length})`);
  for (const r of fixed) console.log(`     直る   ${r.k.split("|")[2]} ${r.name.padEnd(10)} ② ${hm(r.target)}  ${hm(r.without)} → ${hm(r.withPrev)}`);
  for (const r of broken) console.log(`   ★ 壊れる ${r.k.split("|")[2]} ${r.name.padEnd(10)} ② ${hm(r.target)}  ${hm(r.without)} → ${hm(r.withPrev)}`);

  console.log("\n--- 負のコントロール (検査が効いていることの確認)");
  // ① 前月を空にすると 従来と同じになる
  const empty = measure(() => []);
  expect(empty.every((r) => r.withPrev === r.without), "★ 前月の出勤簿を渡さなければ 従来どおり (全人月で 前月なし と同じ値)");
  // ② 前月末を全部 0 時間にすると 直ったものが戻る
  const zero = measure((rs) => rs.map((r) => ({ ...r, start_time_1: "", end_time_1: "", start_time_2: "", end_time_2: "", work_hours: "" })));
  expect(zero.filter((r) => r.withPrev === r.target).length === okWithout, `★ 前月末を 0 時間にすると 一致数が 前月なし と同じ ${okWithout} に戻る (${zero.filter((r) => r.withPrev === r.target).length})`);
  // ③ 週残業欄が既にある週は 足さない (6 月: 出勤簿が 6/6 に 週残業を書いている → 前月ありでも 値が変わらない)
  const june = rows.filter((r) => r.k.endsWith("|202606"));
  const juneHasOwFirstWeek = june.filter((r) => (byPM.get(r.k) ?? []).some((a) => a.day <= 6 && String(a.overtime_weekly ?? "").trim() && a.overtime_weekly !== "0:00"));
  expect(juneHasOwFirstWeek.length > 0 && juneHasOwFirstWeek.every((r) => r.withPrev === r.without),
    `★ 月初の週に 週残業欄がある人月 (${juneHasOwFirstWeek.length} 件・202606) は 前月を渡しても 値が変わらない (二重計上しない)`);
  // ④ 実例 3 件が ② と完全一致する
  for (const nm of ["相原", "中村", "相川"]) {
    const r = rows.find((x) => x.k.endsWith("|202608") && x.name.includes(nm));
    expect(!!r && r.withPrev === r.target, `★ ${nm} 202608 が ② と一致 (${r ? `${hm(r.withPrev)} / ② ${hm(r.target)}` : "見つからない"})`);
  }

  console.log("\n--- 基準値");
  const cur = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) as { _readme: string[]; denominator: number; ok: number } : { _readme: [], denominator: rows.length, ok: okWith };
  if (UPDATE) {
    cur.denominator = rows.length; cur.ok = okWith;
    writeFileSync(BASELINE, JSON.stringify(cur, null, 2) + "\n", "utf8");
    console.log(`  基準値を ${okWith} / ${rows.length} に更新しました`);
  } else {
    if (cur.denominator !== rows.length) console.log(`  ⚠ 分母が違う (${rows.length} ≠ 基準値 ${cur.denominator})。★ データが変わった`);
    expect(okWith >= cur.ok, `前月ありの一致 ${okWith} (基準値 ${cur.ok})`);
    expect(broken.length === 0, `★ 前月を足して壊れる人月が 0 (${broken.length})`);
  }
  console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS");
  process.exit(fail ? 1 : 0);
}
await main();
