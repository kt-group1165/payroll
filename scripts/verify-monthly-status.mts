/**
 * 月次ステータスと 確定後の過誤 の検査。
 *
 *   npm run check:monthly-status
 *
 * user 2026-09-24:「確定した後に計算しなおして差額が出たら 過誤で翌月や翌々月で清算」
 * 確定した月の金額は動かさない。差額は後の月の 調整手当 (adjustment) に乗せる。
 */
import {
  addMonths, canOverwriteResult, canRevert, defaultSettlementMonth,
  findDiscrepancies, nextManualStatus, SETTLEMENT_TOLERANCE,
} from "../src/lib/payroll/monthly-status.js";

let ng = 0;
const expect = (ok: boolean, label: string) => { console.log(`  ${ok ? "OK  " : "NG  "}${label}`); if (!ok) ng++; };
const t = (num: string, total: number, name = num) => ({ employee_number: num, employee_name: name, grand_total: total });

console.log("=== 状態 ===");
expect(canOverwriteResult("計算済") === true, "計算済は上書きできる");
expect(canOverwriteResult("確認済") === true, "確認済も上書きできる");
expect(canOverwriteResult("確定") === false, "★確定は上書きできない");
expect(nextManualStatus("計算済") === "確認済" && nextManualStatus("確認済") === "確定", "人が押して進む道は 計算済→確認済→確定");
expect(nextManualStatus("確定") === null && nextManualStatus("未着手") === null, "確定の先と 未着手からは 人が押して進めない");
expect(canRevert("確定") === true && canRevert("確認済") === false, "解除できるのは 確定だけ");

console.log("=== 過誤の抽出 ===");
{
  const c = [t("1", 300000), t("2", 200000), t("3", 100000)];
  const r = [t("1", 300000), t("2", 205000), t("3", 95000)];
  const d = findDiscrepancies(c, r);
  expect(d.length === 2, "変わっていない人は出ない");
  expect(d[0].employee_number === "2" && d[0].difference === 5000 && d[0].kind === "不足", "増えた人は 不足 (+5,000)");
  expect(d[1].employee_number === "3" && d[1].difference === -5000 && d[1].kind === "過払い", "減った人は 過払い (-5,000)");
}
{
  const d = findDiscrepancies([t("1", 100000)], [t("1", 100000), t("9", 50000, "新人")]);
  expect(d.length === 1 && d[0].kind === "確定後に増えた人" && d[0].difference === 50000, "★確定後に足された職員は 満額が差額 (払い漏れを落とさない)");
}
{
  const d = findDiscrepancies([t("1", 100000), t("8", 40000)], [t("1", 100000)]);
  expect(d.length === 1 && d[0].kind === "確定後に消えた人" && d[0].difference === -40000, "★確定後に消えた職員も出す");
}
{
  const d = findDiscrepancies([t("1", 100000)], [t("1", 100000 + SETTLEMENT_TOLERANCE)]);
  expect(d.length === 0, "1 円以下は同じとみなす (端数の丸め)");
  expect(findDiscrepancies([t("1", 100000)], [t("1", 100002)]).length === 1, "2 円は出す");
}
{
  const d = findDiscrepancies([t("0056", 100000)], [t("56", 90000)]);
  expect(d.length === 1 && d[0].difference === -10000, "職員番号の先頭 0 は詰めて突き合わせる");
}
{
  const d = findDiscrepancies([], [t("1", 0)]);
  expect(d.length === 0, "0 円の人は出さない (確定後に増えた扱いにしない)");
}

console.log("=== 清算月 ===");
expect(addMonths("202612", 1) === "202701", "年をまたぐ (202612 + 1 = 202701)");
expect(addMonths("202601", -1) === "202512", "前に戻る");
expect(defaultSettlementMonth("202606", () => false) === "202607", "既定は翌月");
expect(defaultSettlementMonth("202606", (m) => m === "202607") === "202608", "★翌月も確定済みなら 翌々月へ送る");
expect(defaultSettlementMonth("202606", (m) => ["202607", "202608"].includes(m)) === "202609", "2 か月続けて確定済みなら さらに次へ");

console.log("=== 負のコントロール (わざと壊して鳴ることを見る) ===");
{
  const alwaysOverwrite = () => true;
  expect(alwaysOverwrite() !== canOverwriteResult("確定"), "確定でも上書きできる実装なら 外れる");
  const onlyChanged = (c: ReturnType<typeof t>[], r: ReturnType<typeof t>[]) =>
    r.filter((x) => c.some((y) => y.employee_number === x.employee_number && y.grand_total !== x.grand_total));
  expect(onlyChanged([t("1", 100000)], [t("1", 100000), t("9", 50000)]).length !== 1,
    "増えた人を見ない実装なら 確定後に足された職員を落とす");
}

console.log(ng === 0 ? "\nPASS" : `\nFAIL ${ng} 件`);
process.exit(ng === 0 ? 0 : 1);
