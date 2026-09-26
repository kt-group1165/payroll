/**
 * check:numeric-cell — 表計算のセルを数値として読むところが 静かに壊れないことを確かめる。
 * ★ DB を読まない。fixture だけ。
 *
 * 【なぜ】
 * ★ `parseFloat("1,302")` は **1** を返す。落ちも警告も出ず、**もっともらしい値**になる。
 *   ★ 0 になるより危ない (0 なら「入っていない」と気づけるが 1 は本物の値に見える)。
 * ★ 2026-09-27 時点で 請求・国保連・予防・総括表の 4 パーサは カンマを外していたが、
 *   ★ **出勤簿のパーサだけ外していなかった**。実害は 0 件だったが 潜在の穴だったので塞いだ。
 *
 * 【見ていないもの】
 *   ・実際の CSV に何が入っているか (データ側。給与C が check:nonnumeric-cells で数えている)
 *   ・日付・時刻のセル (別の読み方をしている)
 *   ・パーサが **この関数を呼んでいるか** … 3. で静的に見る
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseNumericCell, parseNumericCellOrZero } from "../src/lib/csv/numeric-cell.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let fail = 0;
const ok = (cond: boolean, label: string) => { console.log(`  ${cond ? "o" : "★ NG"} ${label}`); if (!cond) fail++; };

console.log("=== check:numeric-cell  表計算のセルを数値として読む ===\n");

console.log("1. 読めるべきもの");
ok(parseNumericCell("1,302") === 1302, `"1,302" → 1302  ★ parseFloat だと 1 になる`);
ok(parseNumericCell("10,000") === 10000, `"10,000" → 10000`);
ok(parseNumericCell(" 58.7 ") === 58.7, `" 58.7 " → 58.7 (前後の空白)`);
ok(parseNumericCell("１０") === 10, `"１０" → 10 (全角。Number("１０") は NaN)`);
ok(parseNumericCell("１，２３４") === 1234, `"１，２３４" → 1234 (全角カンマ)`);
ok(parseNumericCell("1,000円") === 1000, `"1,000円" → 1000 (単位付き)`);
ok(parseNumericCell("12km") === 12, `"12km" → 12`);
ok(parseNumericCell("(1,000)") === -1000, `"(1,000)" → -1000 (表計算の負の書式)`);
ok(parseNumericCell(1302) === 1302, `数値はそのまま`);
ok(parseNumericCell(0) === 0, `0 はそのまま 0`);
ok(parseNumericCell("-58.7") === -58.7, `負の数`);

console.log("\n2. 読めないものは ★ 0 ではなく null");
ok(parseNumericCell("") === null, `"" → null`);
ok(parseNumericCell("   ") === null, `空白だけ → null`);
ok(parseNumericCell(null) === null, `null → null`);
ok(parseNumericCell(undefined) === null, `undefined → null`);
ok(parseNumericCell("#VALUE!") === null, `"#VALUE!" → null`);
ok(parseNumericCell("#REF!") === null, `"#REF!" → null`);
ok(parseNumericCell("あ") === null, `文字 → null`);
ok(parseNumericCell("欠22") === null, `"欠22" → null (総括表の有給列にある型)`);
ok(parseNumericCell(NaN) === null, `NaN → null`);
ok(parseNumericCell(Infinity) === null, `Infinity → null`);
ok(parseNumericCellOrZero("#VALUE!") === 0, `OrZero は 0 に倒す (使う場所を選ぶこと)`);

console.log("\n3. 配線: 出勤簿のパーサが この関数を呼んでいる");
for (const f of ["src/lib/csv/attendance-parser.ts", "src/lib/csv/attendance-record.ts"]) {
  const src = readFileSync(join(ROOT, f), "utf8");
  ok(src.includes("parseNumericCell"), `${f} が parseNumericCell を呼んでいる`);
  // ★ km の読みに parseFloat が残っていないこと (戻されたら鳴る)
  const kmLines = src.split("\n").filter((l) => /通勤km|出張km|commuteKm|businessKm/.test(l) && /parseFloat|parseInt/.test(l));
  ok(kmLines.length === 0, `${f} の km の読みに parseFloat/parseInt が残っていない`
    + (kmLines.length ? `  ★ 残り: ${kmLines[0].trim().slice(0, 70)}` : ""));
}

console.log("\n4. 負のコントロール (わざと壊した読み方が 落ちることを確かめる)");
const bad = (v: string) => parseFloat(v) || 0;   // 直す前の読み方
ok(bad("1,302") === 1, `直す前の読み方だと "1,302" が 1 になる (だから直した)`);
ok(bad("１０") === 0, `直す前の読み方だと 全角が 0 になる`);
ok(parseNumericCell("1,302") !== bad("1,302"), `新旧で結果が違う = この検査は効いている`);

console.log("\n⚠ この検査が見ていないもの:");
console.log("   ・実際の CSV / xlsm に何が入っているか (データ側。給与C の check:nonnumeric-cells)");
console.log("   ・日付・時刻のセル (別の読み方をしている)");
console.log("   ・請求・国保連・予防・総括表の 4 パーサ (それぞれ replace(/,/g,\"\") を持っている。統合は未実施)");

console.log(fail === 0 ? "\nPASS" : `\nFAIL — ${fail} 件`);
process.exit(fail === 0 ? 0 : 1);
