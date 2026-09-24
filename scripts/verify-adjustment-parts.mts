/**
 * 総括表の「調整手当」の中身の検査。
 *
 *   npm run check:adjustment-parts
 *
 * 2026-09-24 に 762 人月で実測。★ **事業所ごとに違うのではなく 全 22 事業所で同じ式**だった。
 * 総括表は 介護超過・夜朝深夜・特日 を **個別の支給列として持たず 調整手当に畳み込む**。
 *
 *   調整手当 = 介護超過 (プラスのときだけ) + 夜朝深夜 + 特日 − 誤差
 *     介護+夜朝        451/762 (59.2%)
 *     + 特日           634/762 (83.2%)   ← 202608 は特日 (8/13-15) があるので効く
 *     + 特日 − 誤差    706/762 (92.7%)   11 事業所は 100%
 *
 * ⚠ 介護超過は **マイナスの月は足さない**。総括表は 時間外h × 単価 の生値をセルに残すだけで
 *   支給していない。
 */
import { soukatsuAdjustmentParts } from "../src/lib/payroll/soukatsu-diff.js";

let ng = 0;
const expect = (ok: boolean, label: string) => { console.log(`  ${ok ? "OK  " : "NG  "}${label}`); if (!ok) ng++; };
const row = (o: Record<string, number>) => ({ 介護: 0, "・夜朝・深夜": 0, "・特日": 0, 誤差: 0, ...o }) as Record<string, unknown>;

console.log("=== 調整手当の分解 ===");
{
  // 中央 岡田基之 202603 (実データ): 介護超過 211,563 + 夜朝 4,800 = 216,363
  const p = soukatsuAdjustmentParts(row({ 介護: 211563, "・夜朝・深夜": 4800 }));
  expect(p.total === 216363, "中央 岡田基之 202603: 介護 211,563 + 夜朝 4,800 = 216,363");
}
expect(soukatsuAdjustmentParts(row({ 介護: 10000 })).total === 10000, "介護だけの月");
expect(soukatsuAdjustmentParts(row({ "・夜朝・深夜": 4800 })).total === 4800, "夜朝だけの月");
expect(soukatsuAdjustmentParts(row({ 介護: 10000, "・特日": 2000 })).total === 12000, "★ 特日を足す (202608 の 183 件がこれ)");
expect(soukatsuAdjustmentParts(row({ 介護: 10000, 誤差: 1500 })).total === 8500, "★ 誤差は引く");
expect(soukatsuAdjustmentParts(row({ 介護: 10000, "・夜朝・深夜": 4800, "・特日": 2000, 誤差: 1500 })).total === 15300,
  "4 つ全部: 10,000 + 4,800 + 2,000 − 1,500 = 15,300");

console.log("=== 介護超過がマイナスの月 ===");
{
  // おゆみ野 飯泉喜代美 202608: 介護 −171,250 (時間外h × 2,500 の生値。支給していない)
  const p = soukatsuAdjustmentParts(row({ 介護: -171250, "・夜朝・深夜": 4800 }));
  expect(p.care === 0, "★ マイナスの介護は 0 にする (支給していないため)");
  expect(p.total === 4800, "夜朝だけが残る");
}
expect(soukatsuAdjustmentParts(row({ "・夜朝・深夜": -1000 })).yocho === 0, "夜朝もマイナスなら 0");
expect(soukatsuAdjustmentParts(row({ "・特日": -500 })).tokubi === -500, "特日はマイナスもそのまま (実績が無い)");

console.log("=== 内訳が取れること ===");
{
  const p = soukatsuAdjustmentParts(row({ 介護: 100, "・夜朝・深夜": 200, "・特日": 300, 誤差: 50 }));
  expect(p.care === 100 && p.yocho === 200 && p.tokubi === 300 && p.gosa === 50, "内訳をそれぞれ返す (どこがずれたか追える)");
}
expect(soukatsuAdjustmentParts({}).total === 0, "列が 1 つも無ければ 0");

console.log("=== 負のコントロール ===");
{
  const noTokubi = (d: Record<string, unknown>) => { const p = soukatsuAdjustmentParts(d); return p.care + p.yocho; };
  expect(noTokubi(row({ 介護: 10000, "・特日": 2000 })) !== soukatsuAdjustmentParts(row({ 介護: 10000, "・特日": 2000 })).total,
    "特日を足さない実装なら 202608 で外れる");
  const noClamp = (d: Record<string, unknown>) => {
    const n = (k: string) => Number(d[k] ?? 0);
    return n("介護") + n("・夜朝・深夜") + n("・特日") - n("誤差");
  };
  expect(noClamp(row({ 介護: -171250, "・夜朝・深夜": 4800 })) !== soukatsuAdjustmentParts(row({ 介護: -171250, "・夜朝・深夜": 4800 })).total,
    "マイナスをクランプしない実装なら 飯泉喜代美 202608 で外れる");
}
console.log(ng === 0 ? "\nPASS" : `\nFAIL ${ng} 件`);
process.exit(ng === 0 ? 0 : 1);
