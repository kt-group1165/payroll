/**
 * 入浴の数え方 (事業所ごと) と 会議1/2/3 の単価 (事業所ごと) の検査。
 *
 *   npm run check:bath-meeting
 *
 * 【入浴】事業所で記録の仕方が違う (2026-09-24 実測)。
 *   minutes … 総括表に 入浴時間(分) の列がある      リンクス茂原 (1,500分/16件 ≈ 94分/件)
 *   count   … 件数しか無い。1 件 = 1.12h で換算     Ｈａｎａおゆみ野 (換算は 67.2分/件)
 *   none    … 介護時間に足さない
 *   ⚠ **両方足すと二重になる。**茂原の総括表には 訪問件数 列もあるが、入浴時間と
 *     同じ入浴を別の単位で表しているだけ (入浴時間 0 の月は件数も 0)。
 *
 * 【会議】会議1 = 1,500 が 21 事業所 263 行で一致。会議2/3 を使うのは 3 事業所だけで
 *   **同じ「会議3」でも単価が違う** (八千代 1,500 / おゆみ野 1,150)。
 */
import {
  bathCareMinutes, computeMeetingFee, DEFAULT_BATH_CARE_MODE,
  MEETING1_UNIT_PRICE, type OfficeFormRecord,
} from "../src/lib/payroll/payroll-calc.js";

let ng = 0;
const expect = (ok: boolean, label: string) => { console.log(`  ${ok ? "OK  " : "NG  "}${label}`); if (!ok) ng++; };
const cnt = (item: string, n: number): OfficeFormRecord =>
  ({ record_type: "km", item_name: item, numeric_value: n } as unknown as OfficeFormRecord);

console.log("=== 入浴の数え方 ===");
expect(bathCareMinutes("minutes", 1080, 12) === 1080, "minutes: 分をそのまま (件数は見ない)");
expect(bathCareMinutes("count", 1080, 12) === 12 * 1.12 * 60, "count: 件数 × 1.12h (分は見ない)。★丸めない (元の bathVisitCareMinutes と同じ)");
expect(bathCareMinutes("none", 1080, 12) === 0, "none: 足さない");
expect(bathCareMinutes("minutes", 0, 12) === 0, "★ minutes で 分が 0 なら 0 (件数で代用しない)");
expect(bathCareMinutes("count", 1080, 0) === 0, "★ count で 件数が 0 なら 0 (分で代用しない)");
expect(bathCareMinutes("minutes", -5, 0) === 0, "マイナスは 0");
expect(DEFAULT_BATH_CARE_MODE === "count", "既定は count (従来の挙動)");
{
  // 二重計上の再現: 茂原 202603 木村 入浴時間1500分 / 訪問件数16件
  const both = 1500 + 16 * 1.12 * 60;
  expect(bathCareMinutes("minutes", 1500, 16) !== both, "★ 方式を選べば 二重にならない (1500 + 1075 にならない)");
  expect(bathCareMinutes("minutes", 1500, 16) === 1500, "茂原は 1,500 分だけ");
}

console.log("=== 会議の単価 ===");
expect(computeMeetingFee([cnt("会議1件数", 1)], 1500) === MEETING1_UNIT_PRICE, "会議1 は既定 1,500");
expect(computeMeetingFee([cnt("会議2件数", 1)], 1500) === 1500, "設定が無ければ 会議2 は事業所の単価 (従来)");
expect(computeMeetingFee([cnt("会議2件数", 1)], 1500, { 会議2: 500 }) === 500, "★ ムツミ: 会議2 = 500");
expect(computeMeetingFee([cnt("会議1件数", 1), cnt("会議2件数", 1)], 1500, { 会議2: 500 }) === 2000,
  "★ ムツミ 複合: 会議1 1,500 + 会議2 500 = 2,000");
expect(computeMeetingFee([cnt("会議3件数", 1)], 1500, { 会議3: 1500 }) === 1500, "★ 八千代: 会議3 = 1,500");
expect(computeMeetingFee([cnt("会議3件数", 1)], 1500, { 会議3: 1150 }) === 1150, "★ おゆみ野: 会議3 = 1,150");
expect(computeMeetingFee([cnt("会議2件数", 1), cnt("会議3件数", 1)], 1500, { 会議2: 1150, 会議3: 1150 }) === 2300,
  "おゆみ野 会議2+会議3 = 2,300");
expect(computeMeetingFee([cnt("会議3件数", 3)], 1500, { 会議3: 1500 }) === 4500, "件数 3 なら 3 倍");
expect(computeMeetingFee([cnt("会議1件数", 1150)], 1500) === 1150, "件数欄に 100 以上が入っていたら 円とみなす (入力ミス救済)");

console.log("=== 負のコントロール ===");
{
  const lumped = (p2: number) => 1 * p2 + 1 * p2;   // 会議2と3を同じ単価でまとめる旧実装
  expect(lumped(1500) !== computeMeetingFee([cnt("会議2件数",1), cnt("会議3件数",1)], 1500, { 会議2: 500, 会議3: 1500 }),
    "会議2と3をまとめる実装なら 単価が違う事業所で外れる");
  expect(bathCareMinutes("minutes", 1500, 16) !== 1500 + 16*1.12*60, "両方足す実装なら外れる");
}
console.log(ng === 0 ? "\nPASS" : `\nFAIL ${ng} 件`);
process.exit(ng === 0 ? 0 : 1);
