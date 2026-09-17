/**
 * Google Distance Matrix API の月間上限判定 (allowedChunkCount / usageMonthJst) の境界値検証
 *
 *   npx tsx scripts/verify-distance-usage.mts
 *
 * ⚠ 証明していないこと: /api/distance が実際に記録・停止すること (DB と Google を伴うため)
 */
import { allowedChunkCount, usageMonthJst } from "../src/lib/distance-usage";

let pass = 0;
const fail: string[] = [];
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fail.push(`${name}\n     期待 ${JSON.stringify(want)}\n     実際 ${JSON.stringify(got)}`);
};

eq("残り十分なら全チャンク送る", allowedChunkCount([25, 25, 10], 0, 10000), 3);
eq("ちょうど上限まで使い切るのは送る (9,940+60=10,000)", allowedChunkCount([25, 25, 10], 9940, 10000), 3);
eq("1件でも超えるチャンクは送らない (9,941+60)", allowedChunkCount([25, 25, 10], 9941, 10000), 2);
eq("チャンクは途中で割らない: 残り24で25件チャンクは0", allowedChunkCount([25], 9976, 10000), 0);
eq("既に上限到達なら0", allowedChunkCount([1], 10000, 10000), 0);
eq("上限超過済み (記録ずれ) でも0 (負の残りで送らない)", allowedChunkCount([1], 10500, 10000), 0);
eq("先頭が入らなければ後ろの小さいチャンクも送らない (順序を保つ)", allowedChunkCount([25, 5], 9980, 10000), 0);
eq("上限0なら何も送らない", allowedChunkCount([1], 0, 0), 0);

eq("JST 月: 2026-09-30 23:30 JST (= 14:30 UTC) は 2026-09", usageMonthJst(new Date("2026-09-30T14:30:00Z")), "2026-09");
eq("JST 月: 2026-10-01 00:30 JST (= 09-30 15:30 UTC) は 2026-10 (UTCでは9月)", usageMonthJst(new Date("2026-09-30T15:30:00Z")), "2026-10");
eq("JST 月: 年またぎ 2027-01-01 08:59 JST は 2027-01", usageMonthJst(new Date("2026-12-31T23:59:00Z")), "2027-01");

console.log(`合格 ${pass} / ${pass + fail.length}`);
for (const f of fail) console.log(`   ${f}`);
process.exit(fail.length ? 1 : 0);
