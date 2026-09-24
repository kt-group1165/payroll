/**
 * 研修・会議の「複数日を 1 行にまとめた書き方」を 日数ぶん数えるかの検査。
 *
 *   npm run check:multiday-training
 *
 * 事業所書式の item_date に "6/10,6/17" のように複数日が入る行がある。
 * 2026-09-24 まで 1 回ぶんとしか数えておらず、時間が半分になっていた
 * (四街道 202606 関根絢子・横田沙紀 で 240 分 = ¥4,600 の不足。総括表との差と完全に一致)。
 *
 * ⚠ 有給側は前から listedDateCount で日数を数えていた。研修・会議側だけ数えていない非対称だった。
 * ⚠ trainingMinutesByDay は **列挙された日付すべてにキーを配る**必要がある
 *   (残業の日8h/週40h の判定に効くので ここだけ直し忘れると別方向に壊れる)。
 */
import {
  hrdTrainingMinutes, listedDateCount, meetingMinutes,
  shoninshaTrainingMinutes, trainingMinutes, trainingMinutesByDay,
  type OfficeFormRecord,
} from "../src/lib/payroll/payroll-calc.js";

let ng = 0;
const expect = (ok: boolean, label: string) => { console.log(`  ${ok ? "OK  " : "NG  "}${label}`); if (!ok) ng++; };
const rec = (item: string, date: string, st: string, en: string, br = "0:00"): OfficeFormRecord =>
  ({ record_type: "training", item_name: item, item_date: date, start_time: st, end_time: en, break_time: br } as unknown as OfficeFormRecord);

console.log("=== 日数の数え方 ===");
expect(listedDateCount("6/10") === 1, "1 日なら 1");
expect(listedDateCount("6/10,6/17") === 2, "カンマ区切りで 2 日");
expect(listedDateCount("6/10、6/17，6/24") === 3, "全角カンマ・読点も区切りとして数える");
expect(listedDateCount("") === 1 && listedDateCount(null) === 1, "空でも 1 (0 にしない)");

console.log("=== 研修・会議の時間 ===");
for (const [label, fn, item] of [
  ["研修", trainingMinutes, "研修"], ["HRD研修", trainingMinutes, "HRD研修"],
  ["HRDだけ", hrdTrainingMinutes, "HRD研修"], ["初任者研修", shoninshaTrainingMinutes, "初任者研修"],
  ["会議", meetingMinutes, "会議"],
] as [string, (r: OfficeFormRecord[]) => number, string][]) {
  expect(fn([rec(item, "6/10", "10:00", "12:00")]) === 120, `${label}: 1 日なら 120 分`);
  expect(fn([rec(item, "6/10,6/17", "10:00", "12:00")]) === 240, `★ ${label}: 2 日まとめ書きなら 240 分`);
  expect(fn([rec(item, "6/10,6/17,6/24", "10:00", "12:00")]) === 360, `${label}: 3 日なら 360 分`);
}
expect(trainingMinutes([rec("研修", "6/10,6/17", "9:00", "12:00", "1:00")]) === 240, "休憩は 1 日ぶんずつ引く (3h−1h)×2 = 240 分");

console.log("=== 日ごとの割り振り (残業の判定に効く) ===");
{
  const m = trainingMinutesByDay([rec("HRD研修", "6/10,6/17", "10:00", "12:00")], "202606");
  expect(m.size === 2, "★ 2 日ぶんのキーができる");
  expect(m.get("2026/06/10") === 120 && m.get("2026/06/17") === 120, "★ 各日に 120 分ずつ配る (240 をまとめて 1 日に入れない)");
  const one = trainingMinutesByDay([rec("研修", "6/10", "10:00", "12:00")], "202606");
  expect(one.size === 1 && one.get("2026/06/10") === 120, "1 日なら従来どおり");
  const jp = trainingMinutesByDay([rec("会議", "6月10日,6月17日", "10:00", "11:00")], "202606");
  expect(jp.get("2026/06/10") === 60 && jp.get("2026/06/17") === 60, "「6月10日」形式のまとめ書きも配る");
}

console.log("=== 負のコントロール (わざと壊して鳴ることを見る) ===");
{
  const once = (r: OfficeFormRecord) => { const t = (x: string) => { const [h, m] = x.split(":").map(Number); return h*60 + m; };
    return t(r.end_time as string) - t(r.start_time as string); };
  expect(once(rec("研修", "6/10,6/17", "10:00", "12:00")) !== trainingMinutes([rec("研修", "6/10,6/17", "10:00", "12:00")]),
    "日数を掛けない実装なら まとめ書きで外れる");
  const lump = new Map([["2026/06/10", 240]]);
  const got = trainingMinutesByDay([rec("HRD研修", "6/10,6/17", "10:00", "12:00")], "202606");
  expect(!(got.size === lump.size && got.get("2026/06/10") === 240), "240 をまとめて初日に入れる実装なら外れる");
}

console.log(ng === 0 ? "\nPASS" : `\nFAIL ${ng} 件`);
process.exit(ng === 0 ? 0 : 1);
