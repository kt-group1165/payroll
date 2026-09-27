/**
 * 不変条件: 入社前の月に 月給者の固定給が付いていないこと (2026-09-26)。読み取りのみ・DB書換なし。
 *
 *   npx tsx scripts/check-prehire-monthly-pay.mts                  # 202603〜202608
 *   MONTHS=202608 npx tsx scripts/check-prehire-monthly-pay.mts    # 月を絞る (DB 負荷を下げる)
 *
 * 背景: payroll/page.tsx の monthlyEmps は hiredAfterMonth() で「入社日より後に始まる月」を外すが、
 *   ★ hire_date が空の人には効かない (空を理由に外すと 入社日が未入力なだけの在籍者まで落ちて払い漏れになるため)。
 *   2026-09-26 実測 (payload 9/23 計算): 9 人月 ¥2,586,112。埋め戻し: migrations/backfill_hire_date_from_legacy.mjs
 *
 * 母数: 訪問介護事業所の 月給者 (payroll_employees.salary_type=月給) 全員。
 * 入社日: payroll_employees.hire_date。空なら payroll_legacy_employee.hire_date
 *   (★ (事業所名, 職員番号) の対 + 氏名一致のときだけ。事業所名・氏名は NFKC + 空白除去で揃える)。
 *   どちらも無い人は「入社日不明」として別に出す (判定しない)。
 * 金額: payroll_calc_results.payload.monthly の grand_total。★ payload は計算した時点のもの。
 *   埋め戻しやコード修正の後は 再計算してから回すこと (calculated_at を出力する)。
 * 裏取り: 同じ人月に総括表 (payroll_soukatsu_rows) の行があるか。入社前なら普通は無い。
 *
 * 終了コード: 入社前の月に固定給が付いている人月が 1 件でもあれば 1 (★ 0 が正しい不変条件)。
 *
 * ★ 「0 件」の意味: 入社日が分かっている人について 0。★ 入社日が無い人は判定していない (出力の先頭に人数、下に氏名を出す。
 *   合否とは別。2026-09-27 時点 3 名 = 牛来葉子 / HO JINAN KYLE / 秋元環。減ったら分かる)
 * 負のコントロール: 取得した入社日の写しを 1 名だけ「固定給が付いている月の翌月 1 日」に後ろへずらし、1 件以上 鳴ることを
 *   毎回確かめる (★ DB は壊さない)。鳴らなければ exit 1 (検査が死んでいる)。
 * check:all に編入 (2026-09-27)。入社日を 6 名埋め戻して 138 件を再計算し 8 人月 ¥2,309,160 → 0 になった後。
 */
import { restAll, empKey, normEmpNo } from "./_rest.mjs";

const MONTHS = (process.env.MONTHS ?? "202603,202604,202605,202606,202607,202608").split(",");
const nfkc = (s: unknown) => String(s ?? "").normalize("NFKC").replace(/[\s　]/g, "");
const monthEnd = (m: string) => { const y = Number(m.slice(0, 4)), mo = Number(m.slice(4)); return `${m.slice(0, 4)}-${m.slice(4)}-${String(new Date(y, mo, 0).getDate()).padStart(2, "0")}`; };

type Emp = { id: string; employee_number: string; name: string; office_id: string; hire_date: string | null };
type PO = { id: string; office_number: string; office_id: string; office_type: string };
type Leg = { office_name: string; employee_number: string; employee_name: string; hire_date: string | null };
type Calc = { office_number: string; processing_month: string; calculated_at: string; monthly: { employee_number: string; grand_total?: number }[] | null };
type Sou = { office_number: string; employee_number: string; processing_month: string };

async function main() {
  const po = await restAll<PO>("payroll_offices?select=id,office_number,office_id,office_type");
  const ofs = await restAll<{ id: string; name: string }>("offices?select=id,name");
  const poById = new Map(po.map((p) => [p.id, p]));
  const officeName = new Map(ofs.map((o) => [o.id, o.name]));
  const allMonthly = await restAll<Emp>("payroll_employees?select=id,employee_number,name,office_id,hire_date&salary_type=eq.月給");
  const inScope = allMonthly.filter((e) => poById.get(e.office_id)?.office_type === "訪問介護");
  const legacy = await restAll<Leg>("payroll_legacy_employee?select=office_name,employee_number,employee_name,hire_date");
  const legByKey = new Map<string, Leg[]>();
  for (const l of legacy) { const k = `${nfkc(l.office_name)}|${normEmpNo(l.employee_number)}`; legByKey.set(k, [...(legByKey.get(k) ?? []), l]); }

  // 入社日を決める
  const hireOf = new Map<string, { hire: string; src: string }>();
  const unknown: string[] = [];
  for (const e of inScope) {
    const p = poById.get(e.office_id)!;
    if (e.hire_date) { hireOf.set(e.id, { hire: e.hire_date, src: "DB" }); continue; }
    const cand = (legByKey.get(`${nfkc(officeName.get(p.office_id))}|${normEmpNo(e.employee_number)}`) ?? []).filter((l) => nfkc(l.employee_name) === nfkc(e.name));
    if (cand.length === 1 && cand[0].hire_date) hireOf.set(e.id, { hire: cand[0].hire_date, src: "旧システム" });
    else unknown.push(`${p.office_number} #${e.employee_number} ${e.name} (職員番号の年月 20${e.employee_number.slice(0, 2)}-${e.employee_number.slice(2, 4)})`);
  }
  // ★ 先頭に「0 件」の意味と 判定していない人数を出す (合否とは別)
  console.log(`★ この検査の「0 件」は 入社日が分かっている ${hireOf.size} 名について。★ 入社日が無い ${unknown.length} 名は判定していない (合否とは別。氏名は下に出す)\n`);

  // 負のコントロール用: 入社日が分かっていて 期間の最初の月より前に入社した人を 1 名 (その人の事業所の計算結果も読む)
  const firstDay = `${MONTHS[0].slice(0, 4)}-${MONTHS[0].slice(4)}-01`;
  const ncEmp = inScope.find((e) => { const h = hireOf.get(e.id); return !!h && h.hire <= firstDay; });
  /** 入社前の月 (月末 < 入社日) */
  const preMonthsOf = (hires: Map<string, { hire: string; src: string }>) => {
    const out = new Map<string, string[]>();
    for (const e of inScope) { const h = hires.get(e.id); if (!h) continue; const pre = MONTHS.filter((m) => monthEnd(m) < h.hire); if (pre.length) out.set(e.id, pre); }
    return out;
  };
  // 入社前の月がある人 (+ 負のコントロールの 1 名) の事業所だけ 計算結果と総括表を読む (DB 負荷を下げる)
  const preMonthsById = preMonthsOf(hireOf);
  const offices = [...new Set([...inScope.filter((e) => preMonthsById.has(e.id)), ...(ncEmp ? [ncEmp] : [])].map((e) => poById.get(e.office_id)!.office_number))];
  const inList = `office_number=in.(${offices.join(",")})&processing_month=in.(${MONTHS.join(",")})`;
  const calc = offices.length ? await restAll<Calc>(`payroll_calc_results?select=office_number,processing_month,calculated_at,monthly:payload->monthly&${inList}`) : [];
  const sou = offices.length ? await restAll<Sou>(`payroll_soukatsu_rows?select=office_number,employee_number,processing_month&${inList}`) : [];
  const paid = new Map<string, number>();
  for (const c of calc) for (const m of c.monthly ?? []) paid.set(`${empKey(c.office_number, m.employee_number)}|${c.processing_month}`, Number(m.grand_total ?? 0));
  const souHas = new Set(sou.map((s) => `${empKey(s.office_number, s.employee_number)}|${s.processing_month}`));

  const byId = new Map(inScope.map((e) => [e.id, e]));
  const judge = (hires: Map<string, { hire: string; src: string }>) => {
    let bad = 0, yen = 0;
    const lines: string[] = [];
    for (const [id, pre] of preMonthsOf(hires)) {
      const e = byId.get(id)!;
      const p = poById.get(e.office_id)!; const h = hires.get(e.id)!;
      for (const m of pre) {
        const k = `${empKey(p.office_number, e.employee_number)}|${m}`;
        const v = paid.get(k) ?? 0;
        if (v <= 0) continue;
        bad++; yen += v;
        lines.push(`  ✗ ${p.office_number} #${e.employee_number} ${e.name} ${m}: 固定給 ¥${v.toLocaleString()} (入社日 ${h.hire} [${h.src}] / 総括表の行 ${souHas.has(k) ? "あり" : "なし"})`);
      }
    }
    return { bad, yen, lines };
  };
  // ── 負のコントロール: 1 名の入社日 (取得結果の写し) を 固定給が付いている月の翌月 1 日にずらすと 鳴ること ──
  {
    const p = ncEmp ? poById.get(ncEmp.office_id) : undefined;
    const m = ncEmp && p ? MONTHS.find((x) => (paid.get(`${empKey(p.office_number, ncEmp.employee_number)}|${x}`) ?? 0) > 0) : undefined;
    if (!ncEmp || !p || !m) { console.error("★ 負のコントロールが組めません (期間の最初より前に入社し 固定給が付いている月給者が見つからない)"); process.exit(1); }
    const shifted = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(4)), 1)).toISOString().slice(0, 10);
    const broken = new Map(hireOf); broken.set(ncEmp.id, { hire: shifted, src: "負のコントロール" });
    const r = judge(broken);
    const ok = r.bad >= 1;
    console.log(`負のコントロール: ${p.office_number} #${ncEmp.employee_number} の入社日を (写しで) ${shifted} にずらす → ${r.bad} 件 鳴る (期待 1 以上) ${ok ? "o" : "★ FAIL"}`);
    if (!ok) process.exit(1);
  }
  const { bad, yen, lines } = judge(hireOf);
  console.log(`母数: 訪問介護の月給者 ${inScope.length}名 / 期間 ${MONTHS[0]}〜${MONTHS.at(-1)}`);
  console.log(`入社日: DB ${[...hireOf.values()].filter((h) => h.src === "DB").length}名 / 旧システムで補完 ${[...hireOf.values()].filter((h) => h.src !== "DB").length}名 / 不明 ${unknown.length}名`);
  unknown.forEach((u) => console.log(`  ? 入社日不明 (判定しない): ${u}`));
  const ats = [...new Set(calc.map((c) => c.calculated_at.slice(0, 10)))].sort();
  console.log(`入社前の月に固定給が付いている人月: ${bad} / ¥${yen.toLocaleString()}  (payload の計算日 ${ats.join(", ") || "-"})`);
  lines.forEach((l) => console.log(l));
  if (bad > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
