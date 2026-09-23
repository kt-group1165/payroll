// 法定休日労働の割増の境界値検証 (純関数のみ・DB は一切触らない)
//
//   npx tsx scripts/verify-legal-holiday.mts
//
// 規則 (user 2026-09-23「日曜起算で7日連続勤務の土曜」):
//   週の起算は日曜。日〜金の 6 日すべてに稼働があり かつ 土曜にも稼働がある週の その土曜が法定休日。
//   支給額 = その土曜の訪問の本体額 × 0.35 (1.35 倍の上乗せぶん)。該当土曜が複数なら合算。
//
// 総括表① の「法定休日残業手当」と 2026-03〜07 全社で突合して 7/7 が 1 円まで一致し、
// 当方だけ払ってしまう誤検出は 0 件だった (実データの突合は node_modules/.tmp-compare/legal_holiday_check.mts)。
// ここは実データに依存しない形で 規則そのものを固定するのが目的。
import {
  legalHolidaySaturdays,
  legalHolidayPremiumAmount,
  LEGAL_HOLIDAY_PREMIUM_RATE,
} from "../src/lib/payroll/payroll-calc";

let pass = 0;
const fail: string[] = [];
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fail.push(`${name}\n     期待 ${JSON.stringify(want)}\n     実際 ${JSON.stringify(got)}`);
};

// 2026-06: 5/31(日) 6/1(月) … 6/6(土) が 1 週間
const WEEK_0531 = ["2026-05-31", "2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05", "2026-06-06"];

// ── legalHolidaySaturdays ────────────────────────────────────────────────
eq("日〜土の7日そろえば その土曜", legalHolidaySaturdays(WEEK_0531), ["2026-06-06"]);

// 6 日しか無い週は 0 件 (どの 1 日が欠けても成立しない)
for (const drop of WEEK_0531.slice(0, 6)) {
  eq(`${drop} が欠けたら 0 件`, legalHolidaySaturdays(WEEK_0531.filter((d) => d !== drop)), []);
}
// 土曜が無ければ 0 件 (日〜金だけ働いた週)
eq("土曜に稼働が無ければ 0 件", legalHolidaySaturdays(WEEK_0531.slice(0, 6)), []);

// 月をまたぐ週: 前月の日付を渡さないと落ちる (= 前月の稼働日を必ず入れること)
eq("前月ぶんが無いと判定できない", legalHolidaySaturdays(WEEK_0531.filter((d) => d.startsWith("2026-06"))), []);

// 該当土曜が 2 つある月は 2 つとも返す (木更津 中村みどり 2026-06 の型)
const twoWeeks = [
  "2026-06-14", "2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19", "2026-06-20",
  "2026-06-21", "2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25", "2026-06-26", "2026-06-27",
];
eq("該当土曜が2つなら2つとも", legalHolidaySaturdays(twoWeeks), ["2026-06-20", "2026-06-27"]);

// 日付の書式ゆれ (実績は "2026/06/06" で入っている) と 重複を吸収する
eq("スラッシュ区切りでも同じ", legalHolidaySaturdays(WEEK_0531.map((d) => d.replace(/-/g, "/"))), ["2026-06-06"]);
eq("同じ日が何度出ても同じ", legalHolidaySaturdays([...WEEK_0531, ...WEEK_0531]), ["2026-06-06"]);

// 8 日連続 (日〜翌日) でも 返るのは その週の土曜だけ
eq("8日連続でも土曜は1つ", legalHolidaySaturdays([...WEEK_0531, "2026-06-07"]), ["2026-06-06"]);

// ── legalHolidayPremiumAmount ────────────────────────────────────────────
const rec = (d: string, pay: number | null) => ({ service_date: d, pay });

eq("割増率は 0.35", LEGAL_HOLIDAY_PREMIUM_RATE, 0.35);
eq("該当土曜の本体 × 0.35",
  legalHolidayPremiumAmount([rec("2026-06-06", 10000), rec("2026-06-05", 99999)], ["2026-06-06"]), 3500);
eq("該当日が無ければ 0",
  legalHolidayPremiumAmount([rec("2026-06-06", 10000)], []), 0);
eq("pay が null の明細は 0 円として数える",
  legalHolidayPremiumAmount([rec("2026-06-06", null), rec("2026-06-06", 2000)], ["2026-06-06"]), 700);
eq("該当土曜が2日なら合算 (中村みどり 2026-06: 2,100+2,100 → 1,470)",
  legalHolidayPremiumAmount([rec("2026-06-20", 2100), rec("2026-06-27", 2100)], ["2026-06-20", "2026-06-27"]), 1470);
eq("端数は四捨五入 (滝下恵子 2026-06: 13,050 → 4,568)",
  legalHolidayPremiumAmount([rec("2026-06-06", 13050)], ["2026-06-06"]), 4568);
eq("スラッシュ区切りの明細も拾う",
  legalHolidayPremiumAmount([rec("2026/06/06", 10000)], ["2026-06-06"]), 3500);

// ── 実データで確かめた 7 件の再現 (本体額は突合で確定した値) ──────────────
const cases: [string, number[], number][] = [
  ["木更津 早坂結花 202603 (3/7 + 3/14)", [2100, 2875], 1741],
  ["東郷 古山ひろ美 202605 (5/30)", [3500], 1225],
  ["おゆみ野 松本松代 202605 (5/30)", [3151], 1103],
  ["さつき 滝下恵子 202606 (6/6)", [13050], 4568],
  ["東郷 鈴木順子 202606 (6/6)", [5400], 1890],
  ["木更津 重田あゆみ 202606 (6/27)", [7700], 2695],
  ["木更津 中村みどり 202606 (6/20 + 6/27)", [2100, 2100], 1470],
];
for (const [name, pays, want] of cases) {
  const recs = pays.map((p, i) => rec(`2026-06-${String(6 + i * 7).padStart(2, "0")}`, p));
  const days = recs.map((r) => r.service_date);
  eq(name, legalHolidayPremiumAmount(recs, days), want);
}

console.log(`=== 法定休日労働の割増 境界値 ===`);
console.log(`PASS ${pass} / FAIL ${fail.length}`);
for (const f of fail) console.log("  ✗ " + f);
if (fail.length > 0) process.exit(1);
console.log("⚠ この検査が見ていないもの: 前月の稼働日を呼出元 (payroll/page.tsx) が実際に渡しているか。");
console.log("   実データとの突合は node_modules/.tmp-compare/legal_holiday_check.mts (総括表① が要る)。");
