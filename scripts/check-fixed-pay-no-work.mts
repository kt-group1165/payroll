/**
 * check:fixed-pay-no-work  働いた記録が 1 つも無い月に 月給者の固定給を払っている人月 (2026-09-26 給与D)
 *
 *   npx tsx scripts/check-fixed-pay-no-work.mts
 *   npx tsx scripts/check-fixed-pay-no-work.mts -- --update        ★ 基準値方式の数だけ更新
 *   SNAPSHOT=<path.json> npx tsx scripts/check-fixed-pay-no-work.mts   1 回目は保存し 2 回目から使い回す
 *
 * 【何を数えるか】
 *   payroll_calc_results (給与計算を実行したときの結果) の 月給者 (payload.monthly) の 1 人月ずつについて
 *     記録なし = 実績件数・出勤日数・出勤時間・訪問時間・有給/半休/特休・研修・会議・通勤km・出張km が すべて 0
 *     かつ 当方の総支給 (grand_total) > 0
 *   を数える。★ ① (総括表 xlsm) は読まない。当方の計算結果だけで判定するので軽い。
 *
 * 【なぜ】 (2026-09-26 実測)
 *   ② (総括表の支払用シート) に載っていない月給者 10 名 36 人月に 当方は ¥10,301,764 の固定給を出していた。
 *   実績・出勤簿・事業所書式は すべて 0 件。① (旧システム出力) にも出勤の記録は無い。
 *   休職・産休・育休・退職が 職員マスタ (在職者のまま) と給与設定に反映されていない疑い。
 *
 * 【基準値方式】0 を目指す検査ではない。★ いまの件数を固定し、**増えたら落ちる**。
 *   ★ なぜ 0 にできないか: 働いた記録が無い月でも 固定給を払うのが正しい場合がある
 *     (有給を使い切った後の特別休暇・会社都合の休業・記録が別の事業所に付いている兼務者 など)。
 *     在籍状態は人にしか分からないので、当方の計算だけでは正誤を決められない。
 *   ★ --update は 1 件ずつ在籍を確かめてからにすること。悪化したまま更新すると穴を焼き付ける。
 *
 * 【負のコントロール】全部通る検査は「効いていない検査」と区別が付かないので、毎回わざと壊して鳴ることを確かめる。
 *   ★ DB は壊さない。取得結果の写し (配列のコピー) を壊して、数え方の関数が反応するかを見る。
 *     ① 記録のある人月を 1 つ 記録なしに書き換える → 件数が 1 増えること
 *     ② 記録なしの人月を 1 つ 実績 1 件に書き換える → 件数が 1 減ること
 *   加えて SNAPSHOT の写しを壊して 1 回確かめた (2026-09-26):
 *     記録のある 岡林真美 1270402116 202606 の summary を全部 0 にした写し → 60 → 61 人月 / exit 1
 *
 * ★ 2026-09-26 時点の payroll_calc_results は 全件 2026-09-23 22:17〜22:31 (UTC) の計算。
 *   その後の手入力・設定・プログラムの変更は入っていない。再計算したら基準値を取り直すこと (baseline の _readme 参照)。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { restAll, normEmpNo } from "./_rest.mjs";

const BASELINE = new URL("./check-fixed-pay-no-work-baseline.json", import.meta.url);
const UPDATE = process.argv.includes("--update");

type Summary = Record<string, number | undefined>;
type Monthly = { employee_number: string; employee_name: string; grand_total?: number; summary?: Summary } & Record<string, unknown>;
type CalcRow = { id: string; office_number: string; processing_month: string; calculated_at: string; monthly: Monthly[] | null };
type PM = { office: string; month: string; num: string; name: string; total: number; summary: Summary; top: Summary; calculatedAt: string };

console.log("=== check:fixed-pay-no-work  働いた記録が無い月に 月給者の固定給を払っている人月 ===\n");
console.log("⚠ この検査が見ていないもの:");
console.log("  - 在籍状態が正しいか (休職・産休・退職は人にしか分からない。件数を出すだけ)");
console.log("  - 給与計算を実行した時点の結果だけを見る (calculated_at より後に取り込んだ実績・出勤簿は反映されない)");
console.log("  - 時給者 (固定給が無いので対象外) / 居宅介護支援 (別の計算で payroll_calc_results に入らない)");
console.log("  - 記録が 1 件でもある月の金額の正しさ (それは総括表との突合の担当)\n");

const SNAPSHOT = process.env.SNAPSHOT ?? "";
let calc: CalcRow[];
if (SNAPSHOT && existsSync(SNAPSHOT)) {
  calc = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as CalcRow[];
  console.log(`(SNAPSHOT を使いました: ${SNAPSHOT})`);
} else {
  // payload 全体は重いので 月給者の配列だけ取る
  calc = await restAll<CalcRow>("payroll_calc_results?select=id,office_number,processing_month,calculated_at,monthly:payload->monthly");
  if (SNAPSHOT) { writeFileSync(SNAPSHOT, JSON.stringify(calc)); console.log(`(SNAPSHOT に保存しました: ${SNAPSHOT})`); }
}



/** 記録の有無を見る項目 (実績 / 出勤簿 / 事業所書式 / 有給) */
// ★ summary に入らない手入力もある: 有給の手入力額・出張km・欠勤日数 (欠勤控除として処理済み) 等は payload の直下にある
//   (2026-09-26: 和田有希 202607 は 有給 25 日を手入力していて summary.paidLeave は 0 だった)
const TOP_KEYS = ["paid_leave_allowance_override", "travel_km", "travel_km_auto", "business_trip_fee", "absence_days", "care_minutes", "office_worker_care_pay"];
const WORK_KEYS = ["recordCount", "workDays", "helperDays", "workHoursMin", "visitMinutes", "paidLeave", "halfLeave", "specialLeave",
  "hrdCount", "hrdMinutes", "meetingCount", "commuteKmTotal", "businessKmTotal", "commuteYenTotal"];
const noWork = (p: PM) => WORK_KEYS.every((k) => !Number(p.summary[k] ?? 0)) && TOP_KEYS.every((k) => !Number(p.top[k] ?? 0));
const hitsOf = (list: PM[]) => list.filter((p) => p.total > 0 && noWork(p));

const pms: PM[] = calc.flatMap((c) => (c.monthly ?? []).map((m) => ({
  office: c.office_number, month: c.processing_month, num: normEmpNo(m.employee_number), name: String(m.employee_name ?? ""),
  total: Number(m.grand_total ?? 0), summary: m.summary ?? {}, calculatedAt: c.calculated_at,
  top: Object.fromEntries(TOP_KEYS.map((k) => [k, Number(m[k] ?? 0)])),
})));

let failed = 0;
const expect = (cond: boolean, msg: string) => { console.log(`  ${cond ? "o" : "x"} ${msg}`); if (!cond) failed++; };

// ── 負のコントロール (写しを壊す) ──
const base = hitsOf(pms).length;
{
  const worked = pms.findIndex((p) => p.total > 0 && !noWork(p));
  const idle = pms.findIndex((p) => p.total > 0 && noWork(p));
  if (worked < 0) { console.log("  x 負のコントロール用の「記録あり」の人月が無い"); process.exit(1); }
  const c1 = pms.map((p, i) => i === worked ? { ...p, summary: Object.fromEntries(WORK_KEYS.map((k) => [k, 0])), top: Object.fromEntries(TOP_KEYS.map((k) => [k, 0])) } : p);
  expect(hitsOf(c1).length === base + 1, `負のコントロール①: 記録のある人月を 1 つ記録なしにすると ${base} → ${base + 1} になる (実際 ${hitsOf(c1).length})`);
  if (idle >= 0) {
    const c2 = pms.map((p, i) => i === idle ? { ...p, summary: { ...p.summary, recordCount: 1 } } : p);
    expect(hitsOf(c2).length === base - 1, `負のコントロール②: 記録なしの人月に実績を 1 件足すと ${base} → ${base - 1} になる (実際 ${hitsOf(c2).length})`);
  }
  if (failed) { console.log("\n★ 負のコントロールが鳴らない = 検査が壊れている。基準値の判定はしません"); process.exit(1); }
}

// ── 本番の集計 ──
const hits = hitsOf(pms);
const paid = pms.filter((p) => p.total > 0);
const hitYen = hits.reduce((s, p) => s + p.total, 0);
console.log(`\n分母: 給与計算の結果 ${calc.length} 事業所月 / 月給者の人月 ${pms.length} (うち総支給>0: ${paid.length})`);
console.log(`★ 記録が 1 つも無いのに 総支給>0: ${hits.length} 人月 / ${new Set(hits.map((p) => `${p.office}|${p.num}`)).size} 名 / 当方の総支給計 ¥${hitYen.toLocaleString()}`);

// ② (総括表の支払用シート) に載っているか。移行期だけのテーブルなので 無ければ分けずに出す
let inL2: Set<string> | null = null;
const l2Total = new Map<string, number>();
try {
  const l2 = await restAll<{ id: string; office_number: string; employee_number: string; processing_month: string; total: string | null }>(
    "payroll_soukatsu_rows?select=id,office_number,employee_number,processing_month,total:row_data->>総支給額&sheet_kind=eq.shaseki");
  inL2 = new Set(l2.map((r) => `${r.office_number}|${normEmpNo(r.employee_number)}|${r.processing_month}`));
  for (const r of l2) l2Total.set(`${r.office_number}|${normEmpNo(r.employee_number)}|${r.processing_month}`, Number(r.total) || 0);
} catch (e) { console.log(`  (payroll_soukatsu_rows を読めないので ② での内訳は出しません: ${String(e).slice(0, 120)})`); }
if (inL2) {
  const monthsWithL2 = new Set([...inL2].map((k) => k.split("|")[2]));
  const scoped = hits.filter((p) => monthsWithL2.has(p.month));
  const key = (p: PM) => `${p.office}|${p.num}|${p.month}`;
  const onL2Paid = scoped.filter((p) => inL2!.has(key(p)) && (l2Total.get(key(p)) ?? 0) > 0);
  const onL2Zero = scoped.filter((p) => inL2!.has(key(p)) && !((l2Total.get(key(p)) ?? 0) > 0));
  const offL2 = scoped.filter((p) => !inL2!.has(key(p)));
  const yen = (l: PM[]) => l.reduce((s, p) => s + p.total, 0);
  console.log(`  ② のある月 (${[...monthsWithL2].sort().join(",")}) に限ると ${scoped.length} 人月  ★ ② は手入力を含むので 是非の判断には使わない (参考の内訳)`);
  console.log(`    ② に載っていて ② の総支給>0 (旧システムでも払っている): ${onL2Paid.length} 人月 当方¥${yen(onL2Paid).toLocaleString()} / ②¥${onL2Paid.reduce((s, p) => s + (l2Total.get(key(p)) ?? 0), 0).toLocaleString()}`);
  console.log(`    ② に載っているが ② の総支給=0 (旧システムは払っていない): ${onL2Zero.length} 人月 当方¥${yen(onL2Zero).toLocaleString()}`);
  console.log(`    ② に載っていない (旧システムは払っていない疑い): ${offL2.length} 人月 当方¥${yen(offL2).toLocaleString()}`);
}

console.log("\n人月の一覧 (事業所・職員ごと):");
const byPerson = new Map<string, PM[]>();
for (const p of hits) { const k = `${p.office}|${p.num}`; if (!byPerson.has(k)) byPerson.set(k, []); byPerson.get(k)!.push(p); }
for (const [k, list] of [...byPerson].sort()) {
  const l2mark = inL2 ? list.map((p) => { const k2 = `${p.office}|${p.num}|${p.month}`; return !inL2!.has(k2) ? "②無" : (l2Total.get(k2) ?? 0) > 0 ? `②¥${l2Total.get(k2)}` : "②0円"; }).join(" ") : "";
  console.log(`  ${k} ${list[0].name}  ${list.map((p) => p.month).sort().join(",")}  当方計 ¥${list.reduce((s, p) => s + p.total, 0).toLocaleString()}  ${l2mark}`);
}

// ── 基準値 ──
type Baseline = { _readme: string[]; hits: number; hitYen: number };
const baseline: Baseline = existsSync(BASELINE)
  ? JSON.parse(readFileSync(BASELINE, "utf8"))
  : { _readme: [], hits: Number.POSITIVE_INFINITY, hitYen: 0 };
if (UPDATE) {
  baseline.hits = hits.length; baseline.hitYen = hitYen;
  writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  console.log(`\n基準値を更新しました: ${hits.length} 人月 ¥${hitYen.toLocaleString()}`);
} else {
  console.log(`\n基準値: ${baseline.hits} 人月 ¥${Number(baseline.hitYen).toLocaleString()}`);
  expect(hits.length <= baseline.hits, `記録なし×固定給の人月が基準値から増えていない (${hits.length} <= ${baseline.hits})`);
}
process.exit(failed ? 1 : 0);
