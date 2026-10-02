/**
 * check:soukatsu-overtime-formula — ★ ② (総括表) の **残業の列どうしの関係**が成り立つかを見る。読み取り専用 (2026-10-02 新設)
 *
 *   npm run check:soukatsu-overtime-formula
 *   PAYROLL_ENV=staging npm run check:soukatsu-overtime-formula
 *   npm run check:soukatsu-overtime-formula -- --update     ★ 一致が増えたときだけ
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────────
 * ★ 残業総額の差 72 人月 を追うとき、★ 「式が違う」のか「分数が違う」のかを 分けられなかった。
 *   ② の残業は 1 列ではなく **5 列の組** でできている。2026-10-02 に実データで解いた:
 *
 *     残業代     = 残業(分)/60 × 残業単価  +  法定休日残業(分)/60 × 法定休日残業単価
 *     残業総額2  = 残業代 − 固定残業代                     ★ マイナスのまま入っている
 *     残業総額   = max(0, 残業総額2)  +  法内残業(分)/60 × round(残業単価 ÷ 1.25)
 *
 *   実例 (どれも 1 円一致):
 *     髙橋 久江 202608  1884/60×2448 + 30/60×2643 = 78,189  → −50,000 = 28,189
 *     加瀬 真紀江 202608 179/60×1840 + 法内60/60×1472        =  6,961
 *     吉野 陽子 202603  470/60×2596 = 20,335 → −50,000 = −29,665 (= 残業総額2・支給は 0)
 *
 * ★ これが成り立つなら ★ 当方との差は **分数の差だけ**に絞れる
 *   ([[payroll_overtime_rate_vs_hours]] 「残業の差は単価でなく時間」を 式の側から裏づける)。
 *   ★ 当方の `overtimeExcessPay` も 同じ形 (残業代 − fixed_overtime_pay、提責・管理者は 0)。
 *
 * ── この検査が見ていないもの ──────────────────────────────────────────────
 *   ・★ **当方の値**。ここは ② の内部整合だけを見る (→ check:verification-verdicts)
 *   ・分数そのものが正しいか (出勤簿・用紙との突合は別。→ [[payroll_overtime_handwritten_in_margin]])
 *   ・パート行 (残業単価が無く、「残業」列に **円** が入っている。分母から外す)
 *   ・深夜残業・深夜法定休日残業 (実データで 全行 null のため 式に入れていない)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { restAll, normEmpNo, SB_REF } from "./_rest.mjs";

const UPDATE = process.argv.includes("--update");
const BASELINE = "scripts/check-soukatsu-overtime-formula-baseline.json";

type Souk = { office_number: string; processing_month: string; employee_number: string; row_data: Record<string, unknown> };
const num = (d: Record<string, unknown>, k: string) => Number(d[k] ?? 0) || 0;

let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };

/** ② の残業代 = 時間外 + 法定休日残業 */
function zangyoDai(d: Record<string, unknown>): number {
  return Math.round((num(d, "残業") / 60) * num(d, "残業単価"))
    + Math.round((num(d, "法定休日残業") / 60) * num(d, "法定休日残業単価"));
}
/** ② の残業総額2 = 残業代 − 固定残業代 (マイナスのまま) */
function zangyoSoukei2(d: Record<string, unknown>): number {
  return zangyoDai(d) - num(d, "固定残業代");
}
/** 法内残業手当 = 法内残業(分)/60 × round(残業単価 ÷ 1.25) */
function legalWithinPay(d: Record<string, unknown>): number {
  return Math.round((num(d, "法内残業") / 60) * Math.round(num(d, "残業単価") / 1.25));
}
/**
 * ② の残業総額。★ 模型 A と B を比べる:
 *   A  max(0, 残業総額2) + 法内残業手当                      … 役職を見ない
 *   B  ★ 提責・管理者 (超過支給対象を除く) は 0、それ以外は A … 当方の overtimeExcessPay と同じ形
 */
function zangyoSoukei(d: Record<string, unknown>, noExcess = false): number {
  if (noExcess) return legalWithinPay(d);
  return Math.max(0, zangyoSoukei2(d)) + legalWithinPay(d);
}

async function main() {
  console.log("=== check:soukatsu-overtime-formula (② の残業の列どうしの関係) 2026-10-02 新設・読み取り専用 ===");
  const souk = await restAll<Souk>("payroll_soukatsu_rows?select=office_number,processing_month,employee_number,row_data");
  const emps = await restAll<{ employee_number: string; name: string; role_type: string; office_id: string }>("payroll_employees?select=employee_number,name,role_type,office_id");
  const po = await restAll<{ id: string; office_number: string }>("payroll_offices?select=id,office_number");
  const bnOf = new Map(po.map((o) => [o.id, o.office_number]));
  const nameOf = new Map(emps.map((e) => [`${bnOf.get(e.office_id)}|${normEmpNo(e.employee_number)}`, e.name]));
  const roleOf = new Map(emps.map((e) => [`${bnOf.get(e.office_id)}|${normEmpNo(e.employee_number)}`, e.role_type]));
  // ★ 提責でも 超過分を払う人 (payroll_app_settings overtime_excess_paid_employees)
  const appSet = await restAll<{ key: string; value: Record<string, string[]> }>("payroll_app_settings?select=key,value&key=eq.overtime_excess_paid_employees&order=key");
  const excessPaid = new Set<string>();
  for (const [bn, nos] of Object.entries(appSet[0]?.value ?? {})) for (const no of nos) excessPaid.add(`${bn}|${normEmpNo(no)}`);
  const NO_EXCESS = new Set(["提責", "管理者"]);

  /** mutate: 負のコントロール用に 1 行だけ値を差し替える */
  function measure(mutate?: (d: Record<string, unknown>, i: number) => Record<string, unknown>) {
    const res = { dai: { ok: 0, ng: [] as string[] }, s2: { ok: 0, ng: [] as string[] }, sA: { ok: 0, ng: [] as string[] }, sB: { ok: 0, ng: [] as string[] } };
    let n = 0, i = 0;
    for (const r of souk) {
      const d0 = r.row_data;
      // ★ パート行は 残業単価が無く「残業」列に円が入る。分母から外す
      if (!num(d0, "残業単価")) continue;
      const d = mutate ? mutate({ ...d0 }, i++) : d0;
      n++;
      const key = `${r.office_number}|${normEmpNo(r.employee_number)}`;
      const who = `${r.processing_month} ${r.office_number} ${r.employee_number} ${nameOf.get(key) ?? ""} [${roleOf.get(key) ?? "?"}]`;
      const noExcess = NO_EXCESS.has(roleOf.get(key) ?? "") && !excessPaid.has(key);
      const pairs: [keyof typeof res, number, number][] = [
        ["dai", zangyoDai(d), num(d, "残業代")],
        ["s2", zangyoSoukei2(d), num(d, "残業総額2")],
        ["sA", zangyoSoukei(d, false), num(d, "残業総額")],
        ["sB", zangyoSoukei(d, noExcess), num(d, "残業総額")],
      ];
      for (const [k, calc, actual] of pairs) {
        if (Math.abs(calc - actual) <= 1) res[k].ok++;
        else if (res[k].ng.length < 12) res[k].ng.push(`${who}  式 ${calc} / ② ${actual} (差 ${actual - calc})`);
        else res[k].ng.push("");
      }
    }
    return { n, res };
  }

  const { n, res } = measure();
  console.log(`  [${SB_REF}] 月給者の ② 行 (残業単価あり): ${n}`);
  const labels = {
    dai: "残業代     = 残業/60×単価 + 法定休日残業/60×法定休日単価",
    s2: "残業総額2  = 残業代 − 固定残業代",
    sA: "残業総額 A = max(0,残業総額2) + 法内残業手当 (役職を見ない)",
    sB: "残業総額 B = ★ 提責・管理者は 0 (超過支給対象を除く) + 法内残業手当",
  } as const;
  const rates: Record<string, number> = {};
  for (const k of ["dai", "s2", "sA", "sB"] as const) {
    const ok = res[k].ok, pct = ((ok / n) * 100).toFixed(1);
    rates[k] = ok;
    console.log(`  ${labels[k].padEnd(52)} 一致 ${String(ok).padStart(5)} / ${n} = ${pct}%`);
  }
  for (const k of ["dai", "sB"] as const) {
    const ng = res[k].ng.filter(Boolean);
    if (!ng.length) continue;
    console.log(`\n--- ${k} の不一致 (先頭 ${ng.length} 件)`);
    for (const x of ng) console.log("   " + x);
  }

  console.log("\n--- 負のコントロール (検査が効いていることの確認)");
  const c1 = measure((d) => ({ ...d, 残業: num(d, "残業") + 60 }));
  expect(c1.res.dai.ok < res.dai.ok, `1 行の 残業を +60 分すると 残業代 の一致が減る (${res.dai.ok} → ${c1.res.dai.ok})`);
  const c2 = measure((d) => ({ ...d, 固定残業代: num(d, "固定残業代") + 1000 }));   // ★ 全行に当てる (1 行目が元々不一致だと空打ちになる)
  expect(c2.res.s2.ok < res.s2.ok, `1 行の 固定残業代を +1,000 すると 残業総額2 の一致が減る (${res.s2.ok} → ${c2.res.s2.ok})`);
  const c3 = measure((d) => ({ ...d, 法内残業: num(d, "法内残業") + 60 }));
  expect(c3.res.sB.ok < res.sB.ok, `1 行の 法内残業を +60 分すると 残業総額B の一致が減る (${res.sB.ok} → ${c3.res.sB.ok})`);
  expect(res.sB.ok > res.sA.ok, `★ 役職を見る B のほうが A より合う (A ${res.sA.ok} / B ${res.sB.ok}) = 「提責・管理者は超過分を払わない」が実データで裏づく`);

  console.log("\n--- 基準値");
  const cur = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) as { _readme: string[]; denominator: number; ok: Record<string, number> } : { _readme: [], denominator: n, ok: rates };
  if (UPDATE) {
    cur.denominator = n; cur.ok = rates;
    writeFileSync(BASELINE, JSON.stringify(cur, null, 2) + "\n", "utf8");
    console.log(`  基準値を更新しました (分母 ${n} / ${JSON.stringify(rates)})`);
  } else {
    if (cur.denominator !== n) console.log(`  ⚠ 分母が違う (${n} ≠ 基準値 ${cur.denominator})。★ データが変わった。一致数の比較は参考値`);
    for (const k of ["dai", "s2", "sA", "sB"] as const)
      expect(rates[k] >= (cur.ok[k] ?? 0), `${k} 一致 ${rates[k]} (基準値 ${cur.ok[k] ?? 0})`);
  }

  console.log("\n★ この検査が見ていないもの: 当方の値 / 分数そのものの正しさ / パート行 / 深夜残業 (実データ全行 null)");
  console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS");
  process.exit(fail ? 1 : 0);
}

await main();
