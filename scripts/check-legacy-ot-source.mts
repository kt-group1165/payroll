/**
 * check:legacy-ot-source — 月給者の残業を **出勤簿** と **旧システムの日別** のどちらから採るべきかを
 * ★ 値が食い違う人月だけを分母にして 実データで確かめる。★ 読み取り専用。
 *
 *   npm run check:legacy-ot-source
 *   DETAIL=1 npm run check:legacy-ot-source     … 当方の採用値が ② と違う人月を出す
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────────
 * page.tsx は 旧システムの残業 (payroll_legacy_daily.overtime_min) があれば それで上書きする。
 * ★ 2026-10-01 に 役職で分けて測ったら **向きが逆だった**:
 *   提責   375 人月 … 出勤簿が一致   5 / ★ 旧が一致 245 / どちらでもない 125
 *   事務員  16 人月 … ★ 出勤簿が一致 12 /   旧が一致   1 / どちらでもない   3
 * → ★ 事務員だけ 出勤簿を優先する ように直した (約 ¥21,000 / 12 人月)。
 * ★ 理由: 旧の日別は **出勤簿の外の訪問・移動まで** 数える。訪問に出る提責には合うが、
 *   出勤簿が勤務のすべてである事務員には合わない。
 *
 * ── この検査が落ちるとき ──────────────────────────────────────────────────
 *   ★ 役職ごとの勝ち負けが ひっくり返ったとき (= 優先順を見直す合図)。
 *   ★ 「どちらでもない」が増えたときは 落ちない (基準値で見張る別の話)。
 *
 * ── この検査が見ていないもの ──────────────────────────────────────────────
 *   ・時給者 (② の「残業」列が 円なので 分で比べられない)
 *   ・出勤時間そのもの (employeeWorkMinutes の段。→ check:verification-verdicts の 出勤時間)
 *   ・旧の日別が 0 行の月 (202608)。★ 「差 0」ではなく 測れない
 */
import { restAll, normEmpNo } from "./_rest.mjs";
import { computeSummary, type OfficeAttendanceRecord } from "../src/lib/payroll/payroll-calc.js";

const DETAIL = process.env.DETAIL === "1";
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };

async function main() {
  console.log("=== check:legacy-ot-source (月給者の残業は 出勤簿 と 旧 の どちらから採るか) 2026-10-01 新設・読み取り専用 ===");
  const souk = await restAll<{ office_number: string; processing_month: string; employee_number: string; row_data: Record<string, unknown> }>(
    "payroll_soukatsu_rows?select=office_number,processing_month,employee_number,row_data");
  const sOf = new Map(souk.map((s) => [`${s.office_number}|${normEmpNo(s.employee_number)}|${s.processing_month}`, s.row_data]));
  const calc = await restAll<{ office_number: string; processing_month: string; payload: Record<string, unknown> }>(
    "payroll_calc_results?select=id,office_number,processing_month,payload");
  const roleOf = new Map<string, string>(), nameOf = new Map<string, string>();
  for (const c of calc) for (const e of ((c.payload.monthly ?? []) as Record<string, unknown>[])) {
    const k = `${c.office_number}|${normEmpNo(String(e.employee_number ?? ""))}|${c.processing_month}`;
    roleOf.set(k, String(e.role_type ?? "(不明)"));
    nameOf.set(k, String(e.employee_name ?? "").replace(/\s+/g, " "));
  }
  const att = await restAll<Record<string, unknown>>("payroll_attendance_records?select=*");
  const byK = new Map<string, Record<string, unknown>[]>();
  for (const r of att) {
    const k = `${r.office_number}|${normEmpNo(String(r.employee_number))}|${r.year}${String(r.month).padStart(2, "0")}`;
    if (!byK.has(k)) byK.set(k, []);
    byK.get(k)!.push(r);
  }
  const ld = await restAll<{ office_number: string; processing_month: string; employee_number: string; overtime_min: number | null; pay_type: string | null }>(
    "payroll_legacy_daily?select=id,office_number,processing_month,employee_number,overtime_min,pay_type");
  const legOt = new Map<string, number>();
  for (const r of ld) if (r.pay_type === "月給") {
    const k = `${r.office_number}|${normEmpNo(r.employee_number)}|${r.processing_month}`;
    legOt.set(k, (legOt.get(k) ?? 0) + (r.overtime_min ?? 0));
  }

  const by = new Map<string, { n: number; att: number; leg: number; none: number }>();
  const detail: string[] = [];
  for (const [k, rows] of byK) {
    const role = roleOf.get(k); if (!role) continue;
    const d = sOf.get(k); if (!d) continue;
    const leg = legOt.get(k) ?? 0; if (leg <= 0) continue;        // 旧が無ければ そもそも上書きされない
    const ours = computeSummary([], rows as unknown as OfficeAttendanceRecord[], [], "office_form_first", new Set(), k.split("|")[2]).overtimeMinutes;
    if (Math.abs(leg - ours) <= 1) continue;                      // ★ 値が変わらない人月は 分母に入れない
    const s2 = num(d["残業"]);
    const okA = Math.abs(ours - s2) <= 1, okL = Math.abs(leg - s2) <= 1;
    const b = by.get(role) ?? { n: 0, att: 0, leg: 0, none: 0 };
    b.n++; if (okA && !okL) b.att++; else if (okL && !okA) b.leg++; else b.none++;
    by.set(role, b);
    // ★ 当方が今 採る値 (事務員は出勤簿 / それ以外は旧) が ② と違う人月
    const used = role === "事務員" ? ours : leg;
    if (DETAIL && Math.abs(used - s2) > 1)
      detail.push(`  ${k} ${nameOf.get(k)?.slice(0, 10).padEnd(11)} ${role.padEnd(4)} 採用 ${String(used).padStart(5)} (出勤簿 ${String(ours).padStart(5)} / 旧 ${String(leg).padStart(5)}) ←→ ② ${String(s2).padStart(5)}`);
  }

  console.log("\n--- 役職ごと (★ 2 つの値が食い違う人月だけが分母)");
  console.log(`  ${"役職".padEnd(8)}${"分母".padStart(6)}${"出勤簿が一致".padStart(14)}${"旧が一致".padStart(12)}${"どちらでもない".padStart(16)}`);
  for (const [r, b] of [...by].sort((a, c) => c[1].n - a[1].n))
    console.log(`  ${r.padEnd(8)}${String(b.n).padStart(6)}${String(b.att).padStart(14)}${String(b.leg).padStart(12)}${String(b.none).padStart(16)}`);

  console.log("\n--- いまの優先順が 役職ごとに正しいか");
  const jimu = by.get("事務員"), teiseki = by.get("提責");
  expect(!!jimu && jimu.att > jimu.leg, `★ 事務員は 出勤簿のほうが ② に近い (出勤簿 ${jimu?.att} > 旧 ${jimu?.leg})`);
  expect(!!teiseki && teiseki.leg > teiseki.att, `★ 提責は 旧のほうが ② に近い (旧 ${teiseki?.leg} > 出勤簿 ${teiseki?.att})`);

  console.log("\n--- 負のコントロール (分母の取り方が効いていることの確認)");
  const all = [...by.values()].reduce((s, b) => s + b.n, 0);
  expect(all > 0, `★ 分母が 0 なら この検査は何も言っていない (今 ${all} 人月)`);
  expect([...by.values()].every((b) => b.att + b.leg + b.none === b.n), "★ 内訳の合計が 分母と一致する");

  if (DETAIL) { console.log(`\n--- 当方の採用値が ② と違う人月 (${detail.length})`); for (const d of detail.sort()) console.log(d); }
  console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS");
  process.exit(fail ? 1 : 0);
}
await main();
