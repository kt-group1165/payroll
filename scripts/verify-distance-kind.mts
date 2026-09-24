/**
 * 距離の種別 (通勤 / 出張) の検査。
 *
 *   npm run check:distance-kind
 *
 * user 2026-09-24 のルール:
 *   ヘルパー (事務員でない) … 距離は **出張距離**。通勤距離は出ない
 *   事務員                 … 家と事業所の往復 = **通勤距離**。
 *                            役所に行った / ヘルパーとして訪問した分だけ 出張距離も出る
 *   訪問入浴も同じ (入浴をやりながら一部ヘルパーをしたらその分が出張)。
 *
 * ★ 境界値だけを見る純関数の検査。実データの件数は 画面 (給与計算) の警告で見る。
 */
import { distanceKindWarning } from "../src/lib/payroll/payroll-calc.js";

let ng = 0;
const expect = (ok: boolean, label: string) => { console.log(`  ${ok ? "OK  " : "NG  "}${label}`); if (!ok) ng++; };
const w = (isOfficeWorker: boolean, commuteKm: number, commuteYen: number, businessKm: number) =>
  distanceKindWarning({ isOfficeWorker, commuteKm, commuteYen, businessKm });

console.log("=== ヘルパー (事務員でない) ===");
expect(w(false, 0, 0, 825.3) === null, "出張距離だけ → 正常");
expect(w(false, 0, 0, 0) === null, "どちらも無い → 正常 (訪問が無い月)");
expect(w(false, 825.3, 0, 0) === "ヘルパーに通勤距離", "通勤距離だけ → 警告 (五井 西川裕美子 202604 の形)");
expect(w(false, 74, 0, 12) === "ヘルパーに通勤距離", "両方 → 警告");
expect(w(false, 0, 21390, 116) === "ヘルパーに通勤費(円)", "通勤が円 (定期代) → 別の警告 (船橋 金子百恵 の形)");
expect(w(false, 10, 21390, 0) === "ヘルパーに通勤費(円)", "円が入っていれば km より 円の警告を優先する");

console.log("=== 事務員 ===");
expect(w(true, 357, 0, 0) === null, "通勤距離だけ → 正常");
expect(w(true, 0, 0, 0) === null, "どちらも無い → 警告しない (出張が無ければ判断しない)");
expect(w(true, 357, 0, 3) === "事務員に出張距離", "両方 → 確認 (役所・ヘルパー訪問)");
expect(w(true, 0, 12000, 3) === "事務員に出張距離", "通勤が円でも 両方なら同じ扱い");
expect(w(true, 0, 0, 69) === "事務員に通勤距離が無い", "出張だけ → 通勤の入力漏れの疑い (高品 福田八重子 の形)");

console.log("=== 境界 ===");
expect(w(false, 0.1, 0, 0) === "ヘルパーに通勤距離", "0 より大きければ km は警告");
expect(w(true, 0, 0, 0.1) === "事務員に通勤距離が無い", "出張が 0 より大きければ 事務員は判定する");
expect(w(false, -5, 0, 0) === null, "マイナスは 0 と同じ (警告しない)");

console.log("=== 負のコントロール (わざと壊して鳴ることを見る) ===");
{
  const always = () => "ヘルパーに通勤距離";
  expect(always() !== (w(false, 0, 0, 825.3) ?? "なし"), "常に警告する実装なら 正常ケースで外れる");
  const never = () => null;
  expect(never() !== w(false, 825.3, 0, 0), "一度も警告しない実装なら 西川のケースで外れる");
  const ignoreRole = (ck: number) => (ck > 0 ? "ヘルパーに通勤距離" : null);
  expect(ignoreRole(357) !== w(true, 357, 0, 0), "役職を見ない実装なら 事務員の通勤を誤って警告する");
}

console.log(ng === 0 ? "\nPASS" : `\nFAIL ${ng} 件`);
process.exit(ng === 0 ? 0 : 1);
