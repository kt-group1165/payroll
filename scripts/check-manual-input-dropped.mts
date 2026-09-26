/**
 * check:manual-input-dropped  月ごとの手入力 (payroll_monthly_inputs) があるのに 給与計算に載っていない人月 (2026-09-27 給与D)
 *
 *   npx tsx scripts/check-manual-input-dropped.mts
 *   npx tsx scripts/check-manual-input-dropped.mts -- --update          ★ 基準値方式の数だけ更新
 *   SNAPSHOT=<path.json> npx tsx scripts/check-manual-input-dropped.mts   1 回目は保存し 2 回目から使い回す
 *
 * 【数え方】 値が 0 より大きい手入力 1 行ずつ (social_insurance は 0 にも意味があるので除く)
 *   ① STALE を先に除く: 手入力の更新日時 > その事業所月の給与計算の実行日時 → 「計算の後に入った」だけ。バグではない
 *   ② 残りを 「その人月が計算結果 (payload の hourly / monthly) に居るか」で分ける
 *      ★A 居ない  … 手入力があるのに 行ごと計算から落ちている。★ 再計算では直らない型
 *          A1 時給・在職者   計算対象を作る集合が 実績/出勤簿/事業所書式/事務時間の手入力 だけで、
 *                            研修時間・出張km・有給の手入力しか無い人が入らない (page.tsx 時給者のループの入口)
 *          A2 状態で除外     月給の休職者 / 退職者で 退職日が空か その月より前
 *          A3 職員マスタに居ない
 *   ③ 月給者で 有給の付与 (payroll_paid_leave_grants) が無い人は 有給管理簿の手入力日数を使わず
 *      事業所書式・出勤簿の日数で計算する (paidLeaveAllowanceOf を通らない)。
 *      ★B 手入力の日数と 計算に使った日数が食い違う人月
 *   参考 (合否に使わない): 項目ごとに 載っている / STALE / 設計で 0 (提責・事務員の有給) を数える
 *
 * 【基準値方式】0 を目指す検査ではない。★ 増えたら落ちる。
 *   ★ なぜ 0 にできないか: A2 の多くは 退職・休職の人に 事業所が手入力を残しているだけで、払うべきかは人の判断。
 *     A1・B は コードを直せば 0 に近づく (page.tsx の修正待ち。2026-09-27 時点 給与E が編集中)。
 *   ★ --update は 増えた人月を 1 件ずつ見てからにすること。
 *
 * 【負のコントロール】★ DB は壊さない。取得結果の写しを壊して 数え方が反応するかを毎回見る。
 *     ① 計算結果に居る人の手入力を 1 件、計算結果から外した写し → A が 1 増える
 *     ② A の 1 件の更新日時を 計算の後にした写し → STALE に移って A が 1 減る
 *     ③ 付与の無い月給者で 日数が一致している手入力を +1 日した写し → B が 1 増える
 *
 * ★ 2026-09-27 時点の payroll_calc_results は 全件 2026-09-23 の計算。再計算したら基準値を取り直すこと。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { restAll, normEmpNo } from "./_rest.mjs";

const BASELINE = new URL("./check-manual-input-dropped-baseline.json", import.meta.url);
const UPDATE = process.argv.includes("--update");

type Summary = Record<string, number | undefined>;
type Pay = { employee_number: string; employee_name?: string; role_type?: string; summary?: Summary } & Record<string, unknown>;
type Calc = { id: string; office_number: string; processing_month: string; calculated_at: string; hourly: Pay[] | null; monthly: Pay[] | null };
type Input = { id: string; office_number: string; employee_number: string; processing_month: string; item_key: string; numeric_value: number | null; created_at: string; updated_at: string | null };
type Emp = { id: string; employee_number: string; name: string; office_id: string; salary_type: string | null; employment_status: string | null; resignation_date: string | null };
type Snap = { inputs: Input[]; calc: Calc[]; emps: Emp[]; offices: { id: string; office_number: string }[]; grants: { id: string; employee_id: string }[] };

console.log("=== check:manual-input-dropped  手入力があるのに給与計算に載っていない人月 ===\n");
console.log("⚠ この検査が見ていないもの:");
console.log("  - 載った手入力の金額が正しいか (載ったかどうかだけ)");
console.log("  - social_insurance / overnight_allowance (値 0 にも意味がある / 計算結果に対応する欄が無い)");
console.log("  - 居宅介護支援 (別の計算で payroll_calc_results に入らない)");
console.log("  - 計算の実行日時より後の手入力 (STALE として件数だけ出す。再計算で入る)\n");

const SNAPSHOT = process.env.SNAPSHOT ?? "";
let snap: Snap;
if (SNAPSHOT && existsSync(SNAPSHOT)) {
  snap = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snap;
  console.log(`(SNAPSHOT を使いました: ${SNAPSHOT})`);
} else {
  snap = {
    inputs: await restAll<Input>("payroll_monthly_inputs?select=id,office_number,employee_number,processing_month,item_key,numeric_value,created_at,updated_at"),
    calc: await restAll<Calc>("payroll_calc_results?select=id,office_number,processing_month,calculated_at,hourly:payload->hourly,monthly:payload->monthly"),
    emps: await restAll<Emp>("payroll_employees?select=id,employee_number,name,office_id,salary_type,employment_status,resignation_date"),
    offices: await restAll<{ id: string; office_number: string }>("payroll_offices?select=id,office_number"),
    grants: await restAll<{ id: string; employee_id: string }>("payroll_paid_leave_grants?select=id,employee_id"),
  };
  if (SNAPSHOT) { writeFileSync(SNAPSHOT, JSON.stringify(snap)); console.log(`(SNAPSHOT に保存しました: ${SNAPSHOT})`); }
}

const N = (v: unknown) => Number(v ?? 0) || 0;
const DESIGN_ZERO_ROLES = new Set(["提責", "事務員"]); // 月給の有給休暇手当は払わない (総括表 357 件中 356 件が 0 円)
/** 項目ごとに「計算結果に載ったか」を見る欄。参考の表にだけ使う (合否には使わない) */
const REFLECT: Record<string, { h?: (p: Pay, v: number) => boolean; m?: (p: Pay, v: number) => boolean }> = {
  business_km: { h: (p) => N(p.business_trip_fee) > 0 || N(p.summary?.businessKmTotal) > 0, m: (p) => N(p.travel_km_auto) > 0 || N(p.travel_km) > 0 },
  training_minutes: { h: (p) => N(p.training_pay) > 0, m: (p, v) => N(p.care_minutes) >= v },
  office_work_minutes: { h: (p) => N(p.office_work_minutes) > 0 || N(p.summary?.workHoursMin) > 0, m: (p) => N(p.summary?.workHoursMin) > 0 },
  commute_yen: { h: (p) => N(p.commute_fee) > 0, m: (p) => N(p.summary?.commuteYenTotal) > 0 },
  absence_days: { m: (p) => N(p.absence_days) > 0 },
  overtime_minutes: { h: (p) => N(p.overtime_minutes) > 0, m: (p) => N(p.overtime_minutes_override) > 0 || N(p.summary?.overtimeMinutes) > 0 },
  legal_within_overtime_minutes: { m: (p) => N(p.legal_within_minutes) > 0 },
  childcare_allowance: { h: (p) => N(p.childcare_allowance) > 0, m: (p) => N(p.childcare_allowance) > 0 },
  bonus_paid: { m: (p) => p.bonus_paid === true },
  bath_visit_count: { m: (p) => N(p.care_minutes) > 0 },
  bath_minutes: { m: (p) => N(p.care_minutes) > 0 },
  paid_leave_days: {
    h: (p) => N(p.paid_leave_allowance) > 0 || N(p.summary?.paidLeave) + 0.5 * N(p.summary?.halfLeave) > 0,
    m: (p) => N(p.paid_leave_allowance_override) > 0 || N(p.summary?.paidLeave) + 0.5 * N(p.summary?.halfLeave) > 0,
  },
};
const SKIP = new Set(["social_insurance", "overnight_allowance"]);

type Row = { key: string; office: string; month: string; num: string; value: number; name: string; detail: string };
function analyze(s: Snap) {
  const offNum = new Map(s.offices.map((o) => [o.id, o.office_number]));
  const empBy = new Map(s.emps.map((e) => [`${offNum.get(e.office_id)}|${normEmpNo(e.employee_number)}`, e]));
  const hasGrant = new Set(s.grants.map((g) => g.employee_id));
  const calcBy = new Map(s.calc.map((c) => [`${c.office_number}|${c.processing_month}`, c]));
  const A1: Row[] = [], A2: Row[] = [], A3: Row[] = [], B: Row[] = [];
  const info: Record<string, Record<string, number>> = {};
  const tally = (k: string, c: string) => { info[k] ??= {}; info[k][c] = (info[k][c] ?? 0) + 1; };
  let stale = 0, total = 0;
  for (const r of s.inputs) {
    if (SKIP.has(r.item_key) || !(N(r.numeric_value) > 0)) continue;
    const c = calcBy.get(`${r.office_number}|${r.processing_month}`);
    if (!c) continue; // 計算していない事業所月 (範囲外)
    total++;
    const num = normEmpNo(r.employee_number);
    const v = N(r.numeric_value);
    if (String(r.updated_at ?? r.created_at) > String(c.calculated_at)) { stale++; tally(r.item_key, "STALE"); continue; }
    const m = (c.monthly ?? []).find((p) => normEmpNo(p.employee_number) === num);
    const h = (c.hourly ?? []).find((p) => normEmpNo(p.employee_number) === num);
    const e = empBy.get(`${r.office_number}|${num}`);
    const base = { key: r.item_key, office: r.office_number, month: r.processing_month, num, value: v, name: e?.name ?? "" };
    if (!m && !h) {
      tally(r.item_key, "★計算に居ない");
      if (!e) { A3.push({ ...base, detail: "職員マスタに居ない" }); continue; }
      const monthStart = `${r.processing_month.slice(0, 4)}-${r.processing_month.slice(4)}-01`;
      const excluded = (e.salary_type === "月給" && e.employment_status === "休職者")
        || (e.employment_status === "退職者" && (!e.resignation_date || e.resignation_date < monthStart));
      if (excluded) A2.push({ ...base, detail: `${e.salary_type}/${e.employment_status} 退職日${e.resignation_date ?? "空"}` });
      else A1.push({ ...base, detail: `${e.salary_type}/${e.employment_status}` });
      continue;
    }
    const p = (m ?? h)!;
    if (r.item_key === "paid_leave_days" && m && DESIGN_ZERO_ROLES.has(String(p.role_type))) { tally(r.item_key, "設計で0 (提責・事務員)"); continue; }
    const test = m ? REFLECT[r.item_key]?.m : REFLECT[r.item_key]?.h;
    tally(r.item_key, !test ? "この給与形態では使わない" : test(p, v) ? "載っている" : "載っていない (参考)");
    // ★B 付与の無い月給者は 手入力の有給日数を使わない
    if (r.item_key === "paid_leave_days" && m && e && !hasGrant.has(e.id)) {
      const used = N(p.summary?.paidLeave) + 0.5 * N(p.summary?.halfLeave);
      if (Math.abs(used - v) > 1e-9) B.push({ ...base, detail: `手入力 ${v} 日 / 計算に使った日数 ${used} 日 (有給単価 ${N(p.paid_leave_unit_price)})` });
    }
  }
  return { A1, A2, A3, B, stale, total, info };
}

let failed = 0;
const expect = (cond: boolean, msg: string) => { console.log(`  ${cond ? "o" : "x"} ${msg}`); if (!cond) failed++; };
const clone = (s: Snap): Snap => JSON.parse(JSON.stringify(s)) as Snap;
const r0 = analyze(snap);
const aCount = (r: ReturnType<typeof analyze>) => r.A1.length + r.A2.length + r.A3.length;

// ── 負のコントロール (写しを壊す) ──
{
  // ① 計算結果に居る時給者の手入力を 1 件選び、その人を写しの計算結果から外す
  const calcBy = new Map(snap.calc.map((c) => [`${c.office_number}|${c.processing_month}`, c]));
  const pick = snap.inputs.find((r) => !SKIP.has(r.item_key) && N(r.numeric_value) > 0 && r.item_key !== "paid_leave_days"
    && (() => { const c = calcBy.get(`${r.office_number}|${r.processing_month}`); return !!c && String(r.updated_at ?? r.created_at) <= String(c.calculated_at)
      && (c.hourly ?? []).some((p) => normEmpNo(p.employee_number) === normEmpNo(r.employee_number)); })());
  if (!pick) { console.log("  x 負のコントロール①用の手入力が見つからない"); process.exit(1); }
  const s1 = clone(snap);
  const c1 = s1.calc.find((c) => c.office_number === pick.office_number && c.processing_month === pick.processing_month)!;
  const others = s1.inputs.filter((r) => r.office_number === pick.office_number && r.processing_month === pick.processing_month
    && normEmpNo(r.employee_number) === normEmpNo(pick.employee_number) && !SKIP.has(r.item_key) && N(r.numeric_value) > 0
    && String(r.updated_at ?? r.created_at) <= String(c1.calculated_at)).length;
  c1.hourly = (c1.hourly ?? []).filter((p) => normEmpNo(p.employee_number) !== normEmpNo(pick.employee_number));
  expect(aCount(analyze(s1)) === aCount(r0) + others, `負のコントロール①: 手入力のある人を計算結果から外すと A が ${aCount(r0)} → ${aCount(r0) + others} (実際 ${aCount(analyze(s1))})`);
  // ② A の 1 件を 計算の後に更新したことにする → STALE に移る
  const a = [...r0.A1, ...r0.A2, ...r0.A3][0];
  if (a) {
    const s2 = clone(snap);
    const row = s2.inputs.find((r) => r.office_number === a.office && r.processing_month === a.month && normEmpNo(r.employee_number) === a.num && r.item_key === a.key)!;
    row.updated_at = "2099-01-01T00:00:00Z";
    expect(aCount(analyze(s2)) === aCount(r0) - 1, `負のコントロール②: A の 1 件を計算後の入力にすると STALE に移り ${aCount(r0)} → ${aCount(r0) - 1} (実際 ${aCount(analyze(s2))})`);
  }
  // ③ 付与の無い月給者で 日数が一致している有給の手入力を +1 日
  const hasGrant = new Set(snap.grants.map((g) => g.employee_id));
  const empBy = new Map(snap.emps.map((e) => [`${new Map(snap.offices.map((o) => [o.id, o.office_number])).get(e.office_id)}|${normEmpNo(e.employee_number)}`, e]));
  const same = snap.inputs.find((r) => {
    if (r.item_key !== "paid_leave_days" || !(N(r.numeric_value) > 0)) return false;
    const c = calcBy.get(`${r.office_number}|${r.processing_month}`); if (!c || String(r.updated_at ?? r.created_at) > String(c.calculated_at)) return false;
    const m = (c.monthly ?? []).find((p) => normEmpNo(p.employee_number) === normEmpNo(r.employee_number)); const e = empBy.get(`${r.office_number}|${normEmpNo(r.employee_number)}`);
    if (!m || !e || hasGrant.has(e.id) || DESIGN_ZERO_ROLES.has(String(m.role_type))) return false;
    return Math.abs(N(m.summary?.paidLeave) + 0.5 * N(m.summary?.halfLeave) - N(r.numeric_value)) < 1e-9;
  });
  if (same) {
    const s3 = clone(snap);
    s3.inputs.find((r) => r.id === same.id)!.numeric_value = N(same.numeric_value) + 1;
    expect(analyze(s3).B.length === r0.B.length + 1, `負のコントロール③: 付与の無い月給者の有給手入力を +1 日すると B が ${r0.B.length} → ${r0.B.length + 1} (実際 ${analyze(s3).B.length})`);
  } else console.log("  (負のコントロール③: 使える手入力が無いので省略)");
  if (failed) { console.log("\n★ 負のコントロールが鳴らない = 検査が壊れている。基準値の判定はしません"); process.exit(1); }
}

// ── 結果 ──
const calcTimes = snap.calc.map((c) => c.calculated_at).sort();
console.log(`\n給与計算の実行日時: ${calcTimes[0]} 〜 ${calcTimes[calcTimes.length - 1]} (${snap.calc.length} 事業所月)`);
console.log(`分母: 値>0 の手入力 ${r0.total} 行 (計算のある事業所月・social_insurance / overnight_allowance を除く)`);
console.log(`  STALE (計算の後に入った。再計算で入る): ${r0.stale} 行`);
console.log(`★A 手入力があるのに計算に居ない: ${aCount(r0)} 行`);
console.log(`   A1 時給・在職者 (計算対象を作る入口の漏れ): ${r0.A1.length}`);
for (const x of r0.A1) console.log(`     ${x.month} ${x.office} ${x.num} ${x.name} ${x.key}=${x.value} (${x.detail})`);
console.log(`   A2 状態で除外 (休職・退職): ${r0.A2.length}`);
for (const x of r0.A2) console.log(`     ${x.month} ${x.office} ${x.num} ${x.name} ${x.key}=${x.value} (${x.detail})`);
console.log(`   A3 職員マスタに居ない: ${r0.A3.length}`);
for (const x of r0.A3) console.log(`     ${x.month} ${x.office} ${x.num} ${x.key}=${x.value}`);
console.log(`★B 付与の無い月給者で 手入力の有給日数を使っていない (食い違う): ${r0.B.length}`);
for (const x of r0.B) console.log(`     ${x.month} ${x.office} ${x.num} ${x.name} ${x.detail}`);
console.log("\n参考 (合否に使わない): 項目ごとの内訳");
for (const [k, v] of Object.entries(r0.info).sort()) console.log(`  ${k.padEnd(30)} ${Object.entries(v).map(([c, n]) => `${c}=${n}`).join(" / ")}`);

type Baseline = { _readme: string[]; A: number; A1: number; B: number };
const baseline: Baseline = existsSync(BASELINE)
  ? JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline
  : { _readme: [], A: Number.POSITIVE_INFINITY, A1: Number.POSITIVE_INFINITY, B: Number.POSITIVE_INFINITY };
if (UPDATE) {
  Object.assign(baseline, { A: aCount(r0), A1: r0.A1.length, B: r0.B.length });
  writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  console.log(`\n基準値を更新しました: A ${aCount(r0)} (A1 ${r0.A1.length}) / B ${r0.B.length}`);
} else {
  console.log(`\n基準値: A ${baseline.A} (A1 ${baseline.A1}) / B ${baseline.B}`);
  expect(aCount(r0) <= baseline.A, `A (計算に居ない) が基準値から増えていない (${aCount(r0)} <= ${baseline.A})`);
  expect(r0.A1.length <= baseline.A1, `A1 (時給・在職者の入口漏れ) が基準値から増えていない (${r0.A1.length} <= ${baseline.A1})`);
  expect(r0.B.length <= baseline.B, `B (付与なし月給者の有給日数) が基準値から増えていない (${r0.B.length} <= ${baseline.B})`);
}
process.exit(failed ? 1 : 0);
