/**
 * 給与計算の結果 (payroll_calc_results) が「その後に変わったもの」より古くなっていないかを数える (2026-09-27)。
 * 読み取りのみ・DB書換なし。★ 基準値方式: 件数が基準値より増えたら exit 1。
 *
 *   npx tsx scripts/check-calc-freshness.mts             # 基準値と比べる
 *   npx tsx scripts/check-calc-freshness.mts --update    # ★ 再計算した直後など、減った/理由が分かったときだけ
 *
 * ★ 「どの表のどの日時列を入力とみなすか」と判定は src/lib/payroll/calc-freshness.ts に 1 か所だけある。
 *   ここは それを読んで数えるだけ (画面を作るときも同じ関数を使う)。
 *
 * ── check:calc-staleness との違い (あちらは消さずに残す) ─────────────────────
 *   check:calc-staleness   事業所×月 単位。monthly_inputs / office_form_records / attendance_records /
 *                          office_unit_prices の 4 つを見る。全件読み (重い)
 *   ★ この検査            ①〜③ を足す。★ 計算日時の最小値より後に変わった行だけ読む (軽い)
 *     ① 人月単位で数える (職員単位の入力は その事業所で計算済みの月すべて)
 *     ② あちらが見ていない計算の入力: payroll_employees / salary_settings / paid_leave_grants /
 *        service_records / app_settings (会議単価など) / overtime_settings / category_hourly_rates
 *     ③ ★ 計算プログラム自体の変更 (git の commit)。DB を見ても分からないので git log で数える
 *        ★ 最も古い計算日時より後を数える = 全事業所月を再計算しきるまで減らない (指示役判断 2026-09-27:
 *          1 事業所だけ再計算して「新しくなった」と誤読するのを防ぐため。この数え方は変えない)
 *
 * ⚠ 見えないもの (★ ここは 0 件と出ても安心しないこと):
 *   ・行の削除 (消えた行は日時が残らない)
 *   ・created_at しか無い表 (office_form_records / attendance_records / service_records) の その場の書き換え
 *   ・入力が変わっても 金額が変わらないもの (この検査は「古い」を数えるだけで、金額の差は見ない)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { restAll } from "./_rest.mjs";
import { CALC_INPUT_SOURCES, classifyCalcFreshness, type CalcStamp, type EmployeeRef } from "../src/lib/payroll/calc-freshness.js";

const UPDATE = process.argv.includes("--update");
const BASELINE = "scripts/check-calc-freshness-baseline.json";

async function main() {
  const calc = await restAll<CalcStamp>("payroll_calc_results?select=office_number,processing_month,calculated_at");
  if (calc.length === 0) { console.log("計算結果が 0 件"); return; }
  const minAt = calc.map((c) => c.calculated_at).sort()[0];
  const t = encodeURIComponent(minAt);
  const po = await restAll<{ id: string; office_number: string }>("payroll_offices?select=id,office_number");
  const officeIdToNumber = new Map(po.map((p) => [p.id, p.office_number]));

  // 定義どおりの表を 最も古い計算日時より後に変わった行だけ 直列で読む (DB 負荷を下げる)
  const rowsByTable = new Map<string, Record<string, unknown>[]>();
  for (const src of CALC_INPUT_SOURCES) {
    const orderCol = src.select.split(",")[0];
    rowsByTable.set(src.table, await restAll<Record<string, unknown>>(`${src.table}?select=${src.select}&${src.tsCol}=gt.${t}`, orderCol));
  }
  // employee_id しか持たない表 (給与設定・有給の付与) のために 職員を引く
  const employees = new Map<string, EmployeeRef>();
  const ids = new Set<string>();
  for (const src of CALC_INPUT_SOURCES) if (src.level === "employee" && !src.select.includes("office_id")) for (const r of rowsByTable.get(src.table) ?? []) ids.add(String(r.employee_id));
  const idList = [...ids];
  for (let i = 0; i < idList.length; i += 100) {
    for (const e of await restAll<{ id: string; employee_number: string; office_id: string }>(`payroll_employees?select=id,employee_number,office_id&id=in.(${idList.slice(i, i + 100).join(",")})`)) {
      const o = officeIdToNumber.get(e.office_id); if (o) employees.set(e.id, { office_number: o, employee_number: e.employee_number });
    }
  }
  const { person, officeMonth } = classifyCalcFreshness(calc, rowsByTable, employees, officeIdToNumber);

  // ③ プログラムの変更 (git)
  let codeCommits = 0;
  const codeLines: string[] = [];
  try {
    const out = execSync(`git log --since="${minAt}" --format="%h %cI %s" -- src/lib/payroll src/app/payroll/page.tsx`, { encoding: "utf8" }).trim();
    for (const l of out ? out.split("\n") : []) { codeCommits++; codeLines.push(l); }
  } catch (e) { console.warn("⚠ git log を読めませんでした (プログラム変更の数は 不明とする):", String(e).slice(0, 120)); codeCommits = -1; }

  const count = (m: Map<string, Set<string>>) => { const c = new Map<string, number>(); for (const s of m.values()) for (const w of s) c.set(w, (c.get(w) ?? 0) + 1); return [...c].sort((a, b) => b[1] - a[1]); };
  const ats = calc.map((c) => c.calculated_at).sort();
  console.log(`母数: 計算結果 ${calc.length} 事業所月 (計算日時 ${ats[0].slice(0, 16)} 〜 ${ats.at(-1)!.slice(0, 16)})`);
  console.log(`① 職員単位の入力が 計算後に変わった: ${person.size} 人月 / ${new Set([...person.keys()].map((k) => { const [o, , m] = k.split("|"); return `${o}|${m}`; })).size} 事業所月`);
  for (const [k, v] of count(person)) console.log(`    ${k}: ${v} 人月`);
  console.log(`② 事業所・全社単位の設定が 計算後に変わった: ${officeMonth.size} 事業所月`);
  for (const [k, v] of count(officeMonth)) console.log(`    ${k}: ${v} 事業所月`);
  console.log(`③ 計算プログラムの commit (最も古い計算日時より後): ${codeCommits < 0 ? "不明" : `${codeCommits} 件`}  ★ 1 件でもあれば 全計算結果が古いプログラムで作られている`);
  for (const l of codeLines.slice(0, 5)) console.log(`    ${l}`);
  if (codeLines.length > 5) console.log(`    …他 ${codeLines.length - 5} 件`);

  const now = { person_months: person.size, office_months_settings: officeMonth.size, code_commits: codeCommits };
  if (UPDATE) {
    const prev = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
    writeFileSync(BASELINE, JSON.stringify({ _readme: "計算結果より後に変わった件数の基準値。再計算すると減る。★ 増えたまま --update しないこと (理由を _why に書く)", _why: prev._why ?? "", updated: new Date().toISOString(), ...now }, null, 2) + "\n");
    console.log(`\n基準値を更新しました: ${BASELINE} (★ _why を今回の理由に書き換えること)`); return;
  }
  if (!existsSync(BASELINE)) { console.log(`\n基準値ファイルがありません。--update で作ってください (${BASELINE})`); return; }
  const base = JSON.parse(readFileSync(BASELINE, "utf8"));
  const worse = (["person_months", "office_months_settings", "code_commits"] as const).filter((k) => now[k] > base[k]);
  console.log(`\n基準値 (${String(base.updated).slice(0, 10)}): 人月 ${base.person_months} / 事業所月 ${base.office_months_settings} / commit ${base.code_commits}`);
  if (worse.length) { console.log(`✗ 基準値より増えた: ${worse.join(", ")} → 再計算してから見てください (計算結果が古いまま 金額を議論しない)`); process.exit(1); }
  console.log("✓ 基準値以下");
}
main().catch((e) => { console.error(e); process.exit(1); });
