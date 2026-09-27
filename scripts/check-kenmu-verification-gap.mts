/**
 * 兼務者 (同一人物が複数 office の payroll_employees に登録されている) が
 * /verification (事業所別の総括表突合) にどれだけ「事業所別だと乖離するが合算すると消える」
 * 差分を生んでいるかを数える。DB書換なし。読み取りのみ。
 *
 *   npx tsx scripts/check-kenmu-verification-gap.mts
 *
 * 兼務者の判定材料:
 *   ① payroll_employees.member_id が同一 (最有力)
 *   ② 両 office とも employment_status = '在職者' (今まさに両方で給与が発生しうる)
 *   ③ 住所が一致 (補強)
 * member_id が無い行は 氏名+住所 一致で拾うが、今回の実データでは「両方在職者」に該当するものは
 * 0 件だった (2026-09-26 実測)。
 *
 * ⚠ 逐語コピー禁止 ([[feedback_test_verbatim_copy_and_wrong_expectation]])。
 *   ourItems / ② の値の読み方 (verificationItems) / diffItems / pickSoukatsu は verification-content.tsx と同じ src/lib 関数を import する。
 */
import { readFileSync } from "node:fs";
import {
  diffItems, pickSoukatsu,
  type DiffContext, type DiffVerdict,
} from "../src/lib/payroll/soukatsu-diff.js";
import { attendanceWorkMinutes, parseWorkHoursMinutes, type OvertimeSetting } from "../src/lib/payroll/payroll-calc.js";
import { verificationItems } from "../src/lib/payroll/verification-items.js";

const env: Record<string, string> = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY };
const norm = (n: unknown) => String(n ?? "").replace(/^0+/, "");
const num = (v: unknown) => (typeof v === "number" ? v : 0);
const MONTHS = ["202603", "202604", "202605", "202606", "202607", "202608"];

async function getAll<T>(q: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${q}${q.includes("?") ? "&" : "?"}order=id`, { headers: { ...H, Range: `${from}-${from + 999}` } });
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(JSON.stringify(j));
    out.push(...j);
    if (j.length < 1000) break;
  }
  return out;
}

// ourItems は src/lib/payroll/verification-items.ts (検証ページと共有。以前はここに写しがあり 初任者研修調整費・遅刻早退金額 が抜けて乖離していた)

type Emp = { id: string; employee_number: string; name: string; office_id: string; employment_status: string; member_id: string | null; address: string | null };
type Office = { id: string; office_number: string; name?: string };

async function main() {
  const employees = await getAll<Emp>("payroll_employees?select=id,employee_number,name,office_id,employment_status,member_id,address");
  const offices = await getAll<Office>("payroll_offices?select=id,office_number");
  const officeNumOf = new Map(offices.map((o) => [o.id, o.office_number]));

  // 兼務者判定 (member_id 一致・両方在職者)
  const byMember = new Map<string, Emp[]>();
  for (const e of employees) { if (!e.member_id) continue; if (!byMember.has(e.member_id)) byMember.set(e.member_id, []); byMember.get(e.member_id)!.push(e); }
  const trueKenmu: Emp[][] = [];
  for (const rows of byMember.values()) {
    const offs = new Set(rows.map((r) => r.office_id));
    if (offs.size > 1 && rows.every((r) => r.employment_status === "在職者")) trueKenmu.push(rows);
  }
  console.log(`=== 兼務者判定 (母数: payroll_employees ${employees.length}行 / member_id あり ${employees.filter((e) => e.member_id).length}行) ===`);
  console.log(`member_id一致・複数office: ${[...byMember.values()].filter((r) => new Set(r.map((x) => x.office_id)).size > 1).length}名`);
  console.log(`  うち 両方在職者(真の兼務候補): ${trueKenmu.length}名`);
  for (const g of trueKenmu) console.log(`  - ${g[0].name} (${g.map((r) => officeNumOf.get(r.office_id)).join(" / ")})`);

  let totalDiffCases = 0, totalDiffYen = 0;
  const perPerson: { name: string; office: string; month: string; empN: string; diffYen: number; diffCases: number; items: string[] }[] = [];

  for (const group of trueKenmu) {
    for (const month of MONTHS) {
      // このグループの各 office について、その office・月の計算結果と総括表を取得
      const officeResults: { office: string; empN: string; kind: "part" | "shaseki"; total: number; soukatsuTotal: number; diffs: { item: string; ours: number; soukatsu: number; diff: number; verdict: DiffVerdict }[] }[] = [];
      for (const e of group) {
        const officeNumber = officeNumOf.get(e.office_id);
        if (!officeNumber) continue;
        const [sRes, cRes, aRes] = await Promise.all([
          fetch(`${SB_URL}/rest/v1/payroll_soukatsu_rows?select=employee_number,employee_name,sheet_kind,row_data&processing_month=eq.${month}&office_number=eq.${officeNumber}`, { headers: H }).then((r) => r.json()),
          fetch(`${SB_URL}/rest/v1/payroll_calc_results?select=payload&processing_month=eq.${month}&office_number=eq.${officeNumber}`, { headers: H }).then((r) => r.json()),
          fetch(`${SB_URL}/rest/v1/payroll_attendance_records?select=employee_number,start_time_1,end_time_1,start_time_2,end_time_2,start_time_3,end_time_3,start_time_4,end_time_4,start_time_5,end_time_5,break_time,work_hours&office_number=eq.${officeNumber}&year=eq.${month.slice(0, 4)}&month=eq.${Number(month.slice(4))}`, { headers: H }).then((r) => r.json()),
        ]);
        if (process.env.DEBUG) console.log(`    debug ${officeNumber} ${month} emp=${e.employee_number}: sRes=${Array.isArray(sRes) ? sRes.length : sRes} cRes=${Array.isArray(cRes) ? cRes.length : cRes}`);
        if (!Array.isArray(sRes) || sRes.length === 0) continue;
        if (!Array.isArray(cRes) || cRes.length === 0 || !cRes[0]?.payload) continue;
        const payload = cRes[0].payload as { hourly?: Record<string, unknown>[]; monthly?: Record<string, unknown>[]; overtime_settings?: OvertimeSetting[] };
        const otMap = new Map((payload.overtime_settings ?? []).map((r) => [r.job_type, r]));
        const gapByEmp = new Map<string, number>();
        if (Array.isArray(aRes)) {
          for (const r of aRes as Record<string, unknown>[]) {
            const n = norm(r.employee_number);
            const fromTimes = attendanceWorkMinutes(r as never);
            const fromColumn = parseWorkHoursMinutes(String(r.work_hours ?? ""));
            if (fromTimes > 0 && fromTimes !== fromColumn) gapByEmp.set(n, (gapByEmp.get(n) ?? 0) + (fromTimes - fromColumn));
          }
        }
        const sMap = new Map((sRes as { employee_number: string; sheet_kind: string; row_data: Record<string, unknown> }[])
          .map((r) => [`${norm(r.employee_number)}|${r.sheet_kind}`, r]));
        const targetN = norm(e.employee_number);
        for (const [kind, list] of [["part", payload.hourly ?? []], ["shaseki", payload.monthly ?? []]] as const) {
          for (const item of list) {
            const n = norm(item.employee_number);
            if (n !== targetN) continue;
            const s = sMap.get(`${n}|${kind}`);
            if (!s) continue;
            const ctx: DiffContext = {
              roleType: String(item.role_type ?? ""), attendanceGapMinutes: gapByEmp.get(n) ?? 0,
              noAttendance: !gapByEmp.has(n) && !(aRes as unknown[]).length, hasRateGap: num(item.unmappedCount) > 0,
              isOfficeWorker: false, officeNumber, officeFormEmpty: false,
              adjustmentFolded: pickSoukatsu(s.row_data, "調整手当") !== 0,
            };
            const { items } = verificationItems(item, kind, otMap, s.row_data);
            const diffs = diffItems(items, ctx);
            officeResults.push({
              office: officeNumber, empN: n, kind,
              total: num(item.grand_total), soukatsuTotal: pickSoukatsu(s.row_data, "総支給額"),
              diffs: diffs.map((d) => ({ item: d.item, ours: d.ours, soukatsu: d.soukatsu, diff: d.diff, verdict: d.verdict })),
            });
          }
        }
      }
      if (officeResults.length === 0) continue;
      if (process.env.DEBUG) {
        for (const r of officeResults) {
          console.log(`      [all-verdicts] ${group[0].name} ${r.office} ${month} 当方総支給=${r.total.toLocaleString()} 総括表総支給=${r.soukatsuTotal.toLocaleString()} diffs=${r.diffs.map((d) => `${d.item}:${d.verdict}(${Math.round(d.diff)})`).join(",") || "なし"}`);
        }
      }
      for (const r of officeResults) {
        const you = r.diffs.filter((d) => d.verdict === "要対応");
        if (you.length === 0) continue;
        const yen = you.reduce((a, d) => a + Math.abs(d.diff), 0);
        totalDiffCases += you.length; totalDiffYen += yen;
        perPerson.push({ name: group[0].name, office: r.office, month, empN: r.empN, diffYen: yen, diffCases: you.length, items: you.map((d) => d.item) });
      }
      // 総支給額を合算して比較 (合算すれば消えるかどうかの参考値)。件数に関わらず常に出す
      if (officeResults.length > 1) {
        const oursSum = officeResults.reduce((a, r) => a + r.total, 0);
        const souSum = officeResults.reduce((a, r) => a + r.soukatsuTotal, 0);
        const gap = souSum - oursSum;
        console.log(`  [参考] ${group[0].name} ${month}: 合算 当方=${oursSum.toLocaleString()} 総括表=${souSum.toLocaleString()} 差=${gap.toLocaleString()}${Math.abs(gap) <= 1 ? " ★合算一致" : ""}`);
      }
    }
  }

  console.log(`\n=== 兼務者ぶんの /verification 要対応 (事業所別で見たときの偽の乖離) ===`);
  console.log(`件数: ${totalDiffCases}件 / 金額: ¥${totalDiffYen.toLocaleString()}`);
  for (const p of perPerson) {
    console.log(`  ${p.name} ${p.office} ${p.month}: ${p.diffCases}件 ¥${p.diffYen.toLocaleString()} (${p.items.join(",")})`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
