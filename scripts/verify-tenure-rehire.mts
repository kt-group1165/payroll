/**
 * 再入社による勤続リセット (resolveGroupTenureMonths) の検査。
 *
 *   npm run check:tenure-rehire
 *
 * 旧システムの group_tenure_months は 退職を挟んでも通算のままなので、そのまま使うと
 * 再入社した人の勤続手当が過大になる (白石 則子 6 か月 ¥34,250)。
 * 「同じ人の別の行の退職日が この行の入社日より前」= 空白期間あり = 再入社 と判定し、
 * その事業所での勤続 (office_tenure_months) に戻す。
 *
 * ⚠ 実データ (payroll_legacy_employee 1,656 行) で 再入社と判定されるのは 1 名だけ。
 *   残り 6 名は 兼務先を 1 つ辞めただけなので リセットしてはいけない。両方を検査する。
 */
import { resolveGroupTenureMonths, type LegacyTenureRow } from "../src/lib/payroll/payroll-calc.js";

let ng = 0;
const expect = (ok: boolean, label: string) => {
  console.log(`  ${ok ? "OK  " : "NG  "}${label}`);
  if (!ok) ng++;
};
const row = (o: Partial<LegacyTenureRow>): LegacyTenureRow => ({
  office_tenure_months: null, group_tenure_months: null, hire_date: null, quit_date: null, ...o,
});

console.log("=== 再入社の勤続リセット ===");
{
  // 白石 則子 (実データ)
  const oyumino = row({ office_tenure_months: 22, group_tenure_months: 178, hire_date: "2024-09-16" });
  const goi = row({ office_tenure_months: 178, group_tenure_months: 178, hire_date: "2009-07-10", quit_date: "2024-05-31" });
  expect(resolveGroupTenureMonths(oyumino, [oyumino, goi]) === 22, "白石則子 おゆみ野: 178 → 22 か月 (退職 2024-05-31 < 入社 2024-09-16)");
  expect(resolveGroupTenureMonths(goi, [oyumino, goi]) === 178, "白石則子 五井 (退職済の行) は触らない");
}
{
  // 兼務先を 1 つ辞めただけ (退職日 > 在職行の入社日) → リセットしない。実データ 6 名ぶんの形
  for (const [name, hire, quit, group] of [
    ["藤原有紀子", "2015-06-01", "2022-05-26", 106],
    ["齊藤延江", "2022-10-01", "2024-08-31", 17],
    ["花島典子", "2009-12-01", "2025-07-31", 254],
    ["小林里奈", "2020-08-03", "2026-08-31", 43],
    ["櫻澤美紀", "2022-03-14", "2024-11-30", 32],
    ["堀内則子", "2022-05-09", "2025-02-28", 32],
  ] as [string, string, string, number][]) {
    const active = row({ office_tenure_months: 1, group_tenure_months: group, hire_date: hire });
    const ended = row({ office_tenure_months: 1, group_tenure_months: group, hire_date: hire, quit_date: quit });
    expect(resolveGroupTenureMonths(active, [active, ended]) === group, `${name}: 兼務先の終了なのでリセットしない (${group} か月のまま)`);
  }
}
{
  // 兼務 (退職行なし) → 通算のまま。松元 綾子
  const hanami = row({ office_tenure_months: 24, group_tenure_months: 107, hire_date: "2024-08-01" });
  const takashina = row({ office_tenure_months: 107, group_tenure_months: 107, hire_date: "2017-08-30" });
  expect(resolveGroupTenureMonths(hanami, [hanami, takashina]) === 107, "松元綾子 花見川: 退職行が無いので 107 か月のまま");
}

console.log("=== 境界 ===");
{
  const r = row({ office_tenure_months: 5, group_tenure_months: 100, hire_date: "2024-09-16" });
  expect(resolveGroupTenureMonths(r, [r, row({ quit_date: "2024-09-16" })]) === 100, "退職日 = 入社日 (空白なし) はリセットしない");
  expect(resolveGroupTenureMonths(r, [r, row({ quit_date: "2024-09-15" })]) === 5, "退職日 = 入社日の前日 はリセットする");
  expect(resolveGroupTenureMonths(row({ group_tenure_months: null }), []) === null, "group が null なら null");
  expect(resolveGroupTenureMonths(row({ group_tenure_months: 80, hire_date: null }), [row({ quit_date: "2000-01-01" })]) === 80, "入社日が無ければ 判定できないので通算のまま");
  const noOffice = row({ office_tenure_months: null, group_tenure_months: 90, hire_date: "2024-09-16" });
  expect(resolveGroupTenureMonths(noOffice, [noOffice, row({ quit_date: "2024-01-01" })]) === 90, "再入社でも office_tenure_months が無ければ 通算のまま (勝手に 0 にしない)");
  expect(resolveGroupTenureMonths(r, [r]) === 100, "自分 1 行だけなら リセットしない (自分の quit_date で自爆しない)");
}

console.log("=== 負のコントロール (わざと壊して鳴ることを見る) ===");
{
  const bad = (rw: LegacyTenureRow) => rw.office_tenure_months ?? rw.group_tenure_months ?? null; // 常にリセットする実装
  const hanami = row({ office_tenure_months: 24, group_tenure_months: 107, hire_date: "2024-08-01" });
  expect(bad(hanami) !== 107, "常にリセットする実装なら 松元綾子 で外れる (= この検査は効いている)");
  const bad2 = (rw: LegacyTenureRow) => rw.group_tenure_months; // 一度もリセットしない実装
  const oyumino = row({ office_tenure_months: 22, group_tenure_months: 178, hire_date: "2024-09-16" });
  expect(bad2(oyumino) !== 22, "一度もリセットしない実装なら 白石則子 で外れる (= この検査は効いている)");
}

console.log(ng === 0 ? "\nPASS" : `\nFAIL ${ng} 件`);
process.exit(ng === 0 ? 0 : 1);
