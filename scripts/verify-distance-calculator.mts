// 移動手当の距離・時間算出 (calcDayRoute / collectAddressPairs) の境界値検証
// (純関数のみ・Google Distance Matrix API も DB も一切触らない)
//
//   npx tsx scripts/verify-distance-calculator.mts
//
// ── なぜ API を呼ばずに検証できるか ───────────────────────────────────────
//   calcDayRoute は「距離・所要時間そのもの」を計算しない。住所ペアごとの
//   distance_meters/duration_seconds を **外から distMap として受け取る**
//   純関数で、API 呼び出しと計算ロジックは既に分離されている
//   (呼出元 (payroll/page.tsx) が payroll_distance_cache または Google
//   Distance Matrix API から distMap を組み立てて渡す)。
//   → 計算ロジック (通勤/移動の区別・2時間ギャップ除外・15分控除) は
//     distMap を fixture で与えれば API 無しで固定できる。
//
// ⚠ この検証が証明していないこと:
//   ・distMap の中身 (実際の距離・所要時間) が正しいか — Google Distance Matrix
//     API または payroll_distance_cache の値そのものの妥当性はここでは見ない
//   ・payroll_distance_cache のキャッシュ更新ロジック (期限切れ・再取得判定)
//   ・実データでの妥当性 (呼出元が distMap をどう組み立てているかは別ファイル)
import { calcDayRoute, collectAddressPairs, type VisitForRoute } from "../src/lib/distance-calculator";

let pass = 0;
const fail: string[] = [];
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fail.push(`${name}\n     期待 ${JSON.stringify(want)}\n     実際 ${JSON.stringify(got)}`);
};

const HOME = "自宅";
const visit = (client_number: string, client_address: string, start: string, end: string): VisitForRoute =>
  ({ client_number, client_address, dispatch_start_time: start, dispatch_end_time: end });

// distMap の fixture: from|||to → {distance_meters, duration_seconds}
function map(entries: [string, string, number, number][]): Map<string, { distance_meters: number; duration_seconds: number }> {
  const m = new Map<string, { distance_meters: number; duration_seconds: number }>();
  for (const [from, to, dm, ds] of entries) m.set(`${from}|||${to}`, { distance_meters: dm, duration_seconds: ds });
  return m;
}

console.log("══ 基本経路: 自宅→A→B→自宅 (3 leg) ══");
{
  const visits = [visit("A", "A宅", "09:00", "10:00"), visit("B", "B宅", "11:00", "12:00")];
  const dist = map([
    [HOME, "A宅", 5000, 600],   // 自宅→A: 5km/10分 (home leg)
    ["A宅", "B宅", 3000, 1200], // A→B: 3km/20分 (travel leg, gap=60分<120分)
    ["B宅", HOME, 6000, 700],   // B→自宅: 6km/約12分 (home leg)
  ]);
  const r = calcDayRoute("2026-06-15", HOME, visits, dist)!;
  eq("commute_distance_m = 全区間合計 (5000+3000+6000)", r.commute_distance_m, 14000);
  eq("travel_distance_m = 自宅区間を除いた A→B のみ", r.travel_distance_m, 3000);
  eq("travel_time_sec = 20分(1200秒) − 15分(900秒) = 300秒", r.travel_time_sec, 300);
  eq("travel_time_full_sec = A→B の全量 1200秒 (自宅区間は含めない・15分控除なし)", r.travel_time_full_sec, 1200);
  eq("legs は 3件、home leg フラグが両端だけ true", r.legs.map((l) => l.is_home_leg), [true, false, true]);
  eq("A→B leg は gap_excluded=false (60分)", r.legs[1].gap_excluded, false);
}

console.log("\n══ 2時間ギャップ除外 ══");
{
  // A終了10:00 → B開始12:30 = 150分ギャップ (>=120分) → 除外
  const visits = [visit("A", "A宅", "09:00", "10:00"), visit("B", "B宅", "12:30", "13:30")];
  const dist = map([
    [HOME, "A宅", 5000, 600],
    ["A宅", "B宅", 3000, 1200],
    ["B宅", HOME, 6000, 700],
  ]);
  const r = calcDayRoute("2026-06-15", HOME, visits, dist)!;
  eq("★ 150分ギャップは travel_distance_m から除外される", r.travel_distance_m, 0);
  eq("★ 150分ギャップは travel_time_sec からも除外される", r.travel_time_sec, 0);
  eq("★ 150分ギャップは travel_time_full_sec からも除外される", r.travel_time_full_sec, 0);
  eq("★ ただし commute_distance_m には含まれる (全区間合計 14000)", r.commute_distance_m, 14000);
  eq("★ gap_excluded=true になる", r.legs[1].gap_excluded, true);
}

console.log("\n══ ちょうど120分・ちょうど15分の境界 ══");
{
  // ちょうど120分ギャップ → 含む (総括表 2026-06 で ちょうど120分の区間 21 件が全部計上されていた)
  const visits120 = [visit("A", "A宅", "09:00", "10:00"), visit("B", "B宅", "12:00", "13:00")];
  const dist120 = map([[HOME, "A宅", 1, 1], ["A宅", "B宅", 1000, 1000], ["B宅", HOME, 1, 1]]);
  eq("★ ちょうど120分ギャップは含む (> 境界)",
    calcDayRoute("2026-06-15", HOME, visits120, dist120)!.travel_distance_m, 1000);
  const visits121 = [visit("A", "A宅", "09:00", "10:00"), visit("B", "B宅", "12:01", "13:00")];
  eq("★ 121分ギャップは除外",
    calcDayRoute("2026-06-15", HOME, visits121, dist120)!.travel_distance_m, 0);

  // ちょうど15分(900秒)の移動時間 → 控除後0 (境界は超過分のみ計上、ちょうどは0)
  const dist15 = map([[HOME, "A宅", 1, 1], ["A宅", "B宅", 1000, 900], ["B宅", HOME, 1, 1]]);
  const visitsAB = [visit("A", "A宅", "09:00", "10:00"), visit("B", "B宅", "10:30", "11:00")];
  eq("★ ちょうど15分(900秒)の移動は travel_time_sec=0",
    calcDayRoute("2026-06-15", HOME, visitsAB, dist15)!.travel_time_sec, 0);
  // 区間は分単位切り捨て: 15分59秒 → 15分 → 0 / 16分 → 60秒
  const dist15p59 = map([[HOME, "A宅", 1, 1], ["A宅", "B宅", 1000, 959], ["B宅", HOME, 1, 1]]);
  eq("★ 15分59秒の移動は切り捨てて15分 → travel_time_sec=0",
    calcDayRoute("2026-06-15", HOME, visitsAB, dist15p59)!.travel_time_sec, 0);
  eq("★ 15分59秒の移動の全量は 900秒",
    calcDayRoute("2026-06-15", HOME, visitsAB, dist15p59)!.travel_time_full_sec, 900);
  const dist16 = map([[HOME, "A宅", 1, 1], ["A宅", "B宅", 1000, 960], ["B宅", HOME, 1, 1]]);
  eq("★ 16分の移動は travel_time_sec=60",
    calcDayRoute("2026-06-15", HOME, visitsAB, dist16)!.travel_time_sec, 60);
}

console.log("\n══ 訪問の並び替え (dispatch_start_time順に組み直す) ══");
{
  // 入力順は B→A だが、start_time は A(09:00) が先 → 経路は 自宅→A→B→自宅 になるはず
  const visits = [visit("B", "B宅", "11:00", "12:00"), visit("A", "A宅", "09:00", "10:00")];
  const dist = map([
    [HOME, "A宅", 100, 10], ["A宅", "B宅", 200, 20], ["B宅", HOME, 300, 30],
    // 逆順で計算された場合に混同を検出するためのダミー値 (もし並び替えていなければ違う値になる)
    [HOME, "B宅", 9999, 9999], ["B宅", "A宅", 9999, 9999], ["A宅", HOME, 9999, 9999],
  ]);
  const r = calcDayRoute("2026-06-15", HOME, visits, dist)!;
  eq("★ 入力順に関わらず dispatch_start_time 順の経路になる (自宅→A→B→自宅)",
    r.legs.map((l) => `${l.from}→${l.to}`), ["自宅→A宅", "A宅→B宅", "B宅→自宅"]);
}

console.log("\n══ 単一訪問 (自宅→A→自宅、2 leg とも home leg) ══");
{
  const visits = [visit("A", "A宅", "09:00", "10:00")];
  const dist = map([[HOME, "A宅", 5000, 600], ["A宅", HOME, 5000, 600]]);
  const r = calcDayRoute("2026-06-15", HOME, visits, dist)!;
  eq("★ 単一訪問は移動区間が無い (travel_distance_m=0)", r.travel_distance_m, 0);
  eq("★ 単一訪問は移動時間も無い (travel_time_sec=0)", r.travel_time_sec, 0);
  eq("commute_distance_m は往復分 (5000+5000)", r.commute_distance_m, 10000);
  eq("2 leg とも home leg", r.legs.every((l) => l.is_home_leg), true);
}

console.log("\n══ 異常系 ══");
{
  eq("★ 訪問0件は null を返す", calcDayRoute("2026-06-15", HOME, [], map([])), null);
  // distMap にキーが無い leg は継続してスキップされる (crashしない・0加算もしない)
  const visits = [visit("A", "A宅", "09:00", "10:00"), visit("B", "B宅", "11:00", "12:00")];
  const partial = map([["A宅", "B宅", 3000, 1200]]); // 自宅絡みの2legが欠けている
  const r = calcDayRoute("2026-06-15", HOME, visits, partial)!;
  eq("★ distMapに無いleg (自宅→A, B→自宅) はスキップされ commute には計上されない",
    r.commute_distance_m, 3000);
  eq("legsの本数もスキップぶん減る (3件中1件のみ)", r.legs.length, 1);
}

console.log("\n══ collectAddressPairs (API送信前の重複排除) ══");
{
  const byDay = new Map<string, VisitForRoute[]>([
    ["2026-06-15", [visit("A", "A宅", "09:00", "10:00"), visit("B", "B宅", "11:00", "12:00")]],
    ["2026-06-16", [visit("A", "A宅", "09:00", "10:00")]], // 同じA宅が別日にも出る → 重複排除されるはず
  ]);
  const pairs = collectAddressPairs(HOME, byDay);
  eq("★ 同じ(自宅→A宅)ペアは2日にまたがっても1回だけ",
    pairs.filter((p) => p.origin === HOME && p.destination === "A宅").length, 1);
  eq("ユニークなペア数 (自宅→A, A→B, B→自宅, 自宅→A(16日目はA→自宅のみ追加))",
    pairs.length, 4);
  eq("★ 自己ループ (origin===destination) は除外される",
    collectAddressPairs(HOME, new Map([["2026-06-15", [visit("A", HOME, "09:00", "10:00")]]])).length, 0);
  eq("★ 空文字の住所は除外される",
    collectAddressPairs("", new Map([["2026-06-15", [visit("A", "", "09:00", "10:00")]]])).length, 0);
}

console.log(`\n合格 ${pass} / ${pass + fail.length}`);
if (fail.length) { console.log("\n★ 不一致:"); for (const f of fail) console.log("   " + f); process.exit(1); }
console.log("");
console.log("⚠ この検証が証明していないこと:");
console.log("   ・distMap の中身 (Google Distance Matrix API / payroll_distance_cache の値そのもの)");
console.log("   ・payroll_distance_cache のキャッシュ更新ロジック (期限切れ判定・再取得)");
console.log("   ・呼出元 (payroll/page.tsx) が distMap をどう組み立てて渡しているか");
console.log("   ・実データでの妥当性");
