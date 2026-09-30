/**
 * check:legacy-daily-diff — 旧システムの日別データと 当方の実績を ★ 全職員・全日で突き合わせる。基準値方式・読み取り専用。
 *
 *   npm run check:legacy-daily-diff
 *   npm run check:legacy-daily-diff -- --update
 *   DETAIL=1 npm run check:legacy-daily-diff        # 食い違う日を 1 行ずつ出す
 *   MONTHS=202605 npm run check:legacy-daily-diff   # 月を絞る
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────────
 * `payroll_legacy_daily` は 旧システムが出した **1 日 1 行**のデータ
 * (visit_min 訪問 / accompany_min 同行 / actual_min 訪問−同行 / visit_count 件数)。
 * ★ 当方の `payroll_service_records` を同じ粒度に畳めば、★ 行の過不足・長さの違いが 日まで落ちる。
 *
 * 2026-09-30 に 勤続手当の残差 6 人月を この方法で 全件 1 日まで特定した。
 * ★ 6 件のうち 勤続の式の問題は 0 件で、★ 4 件が 行の過不足・1 件が 研修の扱い・1 件が 44分の行だった。
 * ★ 同じ型が他にも埋もれていないかを 全件で見るのが この検査。
 *
 * ── 分類 ──────────────────────────────────────────────────────────────────
 *   一致          … 実績分 (訪問−同行) が 旧と同じ
 *   当方だけ      … その日 当方に実績があるが 旧に行が無い
 *   旧だけ        … その日 旧に行があるが 当方に実績が無い
 *   件数が多い/少ない … 行の数そのものが違う (= 行の過不足)
 *   件数は同じで分が違う … 1 行の長さが違う
 *   └ うち 研修で説明できる … 当方が 研修・会議・面談 の行を 訪問に数えているぶん
 *   └ うち 完全重複で説明できる … 同じ (日・利用者・開始時刻・コード) が 2 行ある
 *
 * ── この検査が見ていないもの ──────────────────────────────────────────────
 *   ・202608 … ★ 旧の日別データが 0 行 (未取込)。★ 「差 0」ではなく「測れない」
 *   ・★ 訪問看護の 4 事業所 … ★ 当方は MEISAI の実績を持たない業態なので 突合できない。★ 別掲にして分母から外す
 *     (わたぼうし 977日 / 望み 807 / ひかり 551 / つくしんぼ 454 = 2,789 日。★ 混ぜると「旧だけ 4,259 日」に見える)
 *   ・★ 両方 0 分の日 (事務員など 訪問が無い日) … ★ 一致に数える。★ 「旧だけ」にすると 分母が膨らむ
 *   ・移動時間・出勤時間・残業 (work_min / overtime_min)。訪問の分だけを見る
 *   ・金額。★ 何円ずれるかは 項目ごとの検査 (check:tenure-rate ほか) で見る
 *
 * ── ⚠ ★ 旧の日別は「正」ではない (2026-09-30 に実証) ────────────────────────
 * ★ ① (総括表データ) の月次「訪介実績時間」と 3 者で比べると:
 * ```
 *   両方と一致 2,680 人月 / ★ 当方だけと一致 132 / ★ 旧の日別だけと一致 60 / どちらとも違う 3
 * ```
 * ★ **① は 当方と一致するほうが 2 倍多い。**旧の日別は ★ 旧システムの別の出力で、
 * ★ 総括表 (= 実際に払う元) とも食い違う。★ 日別の差をそのまま「当方の誤り」と読んではいけない。
 * → ★ この検査の使い道は **どの日か を落とすこと**。★ 直す候補は
 *   `SOUKATSU1_DIR` を渡したときに出る **「① も旧日別側」の人月**だけ。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { restAll, normEmpNo } from "./_rest.mjs";
// ★ 分を出す・同行を判定する・訪問に数えるかを決める のは ★ 本番の関数をそのまま呼ぶ。
//   ★ 書き写すと 片方だけ直したときに乖離する ([[feedback_test_verbatim_copy_and_wrong_expectation]])。
//   ★ 2026-09-30 に自前で書いて踏んだ: parseDurationMinutes は ★ 1440 分以上を 0 に落とす
//   (キャンセル・有給の行が 開始=終了 で 024:00 になるため。662 行)。自前の正規表現だと
//   ★ 1 日 2,880 分のような値が出て 「差 803,930 分」という偽の大事故に見えた。
import { parseDurationMinutes, isAccompaniedRecord, isCareRecord } from "../src/lib/payroll/payroll-calc.js";

const UPDATE = process.argv.includes("--update");
const DETAIL = process.env.DETAIL === "1";
const BASELINE = new URL("./check-legacy-daily-diff-baseline.json", import.meta.url);
const MONTHS = (process.env.MONTHS || "202603,202604,202605,202606,202607,202608").split(",");
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };

/** ★ 旧は 研修 を 訪問時間に数えない (① の HRD研修時間 に入れる。2026-09-30 林幸子 5/13 で確認)。
 *  ★ 会議・面談ほかは 本番も既に数えていない (NON_CARE_SERVICE_TYPES) ので ここでは 研修だけを見る */
const KENSHU = /研修|ミーティング/;
const isoDay = (s: unknown): string => String(s ?? "").replace(/\//g, "-").slice(0, 10);

type Daily = { work_date: string; processing_month: string; office_number: string; employee_number: string; employee_name: string; visit_min: number | null; actual_min: number | null; accompany_min: number | null; visit_count: number | null };
type Rec = { office_number: string; processing_month: string; employee_number: string; employee_name: string; service_date: string; calc_duration: string; service_code: string; service_type: string | null; client_name: string | null; dispatch_start_time: string | null };

let counts3: Record<string, number> = {};

async function main() {
  console.log("=== check:legacy-daily-diff (旧の日別 と 当方の実績を 全職員・全日で突合) 2026-09-30 新設・読み取り専用 ===");
  console.log("★ check:all には入れていない (意図的)。診断系。落ちる/落ちないの話ではなく「いま どこまでズレているか」を測る");

  // ★ 訪問看護は 当方が MEISAI の実績を持たない業態。★ 事業所番号を決め打ちせず office_type で外す
  const offices = await restAll<{ office_number: string; office_type: string | null }>("payroll_offices?select=id,office_number,office_type");
  const kangoOffices = new Set(offices.filter((o) => String(o.office_type ?? "").includes("訪問看護")).map((o) => o.office_number));
  const dailyAll = (await restAll<Daily>("payroll_legacy_daily?select=id,work_date,processing_month,office_number,employee_number,employee_name,visit_min,actual_min,accompany_min,visit_count"))
    .filter((d) => MONTHS.includes(d.processing_month));
  const dailyKango = dailyAll.filter((d) => kangoOffices.has(d.office_number));
  const daily = dailyAll.filter((d) => !kangoOffices.has(d.office_number));
  const recs = (await restAll<Rec>(`payroll_service_records?select=id,office_number,processing_month,employee_number,employee_name,service_date,calc_duration,service_code,service_type,client_name,dispatch_start_time&processing_month=in.(${MONTHS.join(",")})`));
  const monthsWithDaily = [...new Set(daily.map((d) => d.processing_month))].sort();
  const monthsNoDaily = MONTHS.filter((m) => !monthsWithDaily.includes(m));
  console.log(`\n旧の日別 ${daily.length} 行 / 当方の実績 ${recs.length} 行`);
  console.log(`★ 旧の日別がある月 ${monthsWithDaily.join(",") || "なし"} / ★ 無い月 ${monthsNoDaily.join(",") || "なし"} → ★ 無い月は 測れない (差 0 ではない)`);
  if (!monthsWithDaily.length) { console.log("★ 旧の日別が 1 行も無いので 何も測れない (「合格」ではない)"); process.exit(1); }

  // 当方を (事業所|社員|日) に畳む
  type Day = { visit: number; doukou: number; nonVisit: number; n: number; dup: number; name: string; rows: Rec[] };
  const ours = new Map<string, Day>();
  for (const r of recs) {
    if (!monthsWithDaily.includes(r.processing_month)) continue;
    const k = `${r.office_number}|${normEmpNo(r.employee_number)}|${isoDay(r.service_date)}`;
    const d = ours.get(k) ?? { visit: 0, doukou: 0, nonVisit: 0, n: 0, dup: 0, name: r.employee_name, rows: [] };
    if (!isCareRecord(r)) continue;                       // ★ 会議・面談ほかは 本番も訪問に数えない
    const m = parseDurationMinutes(r.calc_duration);       // ★ 1440 分以上 (キャンセルの 024:00) は 0
    d.visit += m; d.n++;
    if (isAccompaniedRecord(r)) d.doukou += m;
    if (KENSHU.test(String(r.service_type ?? ""))) d.nonVisit += m;
    d.rows.push(r);
    ours.set(k, d);
  }
  // 完全重複の分を日ごとに数える
  for (const d of ours.values()) {
    const seen = new Set<string>();
    for (const r of d.rows) {
      const k = `${r.dispatch_start_time}|${r.client_name}|${r.service_code}`;
      if (seen.has(k)) d.dup += parseDurationMinutes(r.calc_duration); else seen.add(k);
    }
  }
  const theirs = new Map<string, Daily>();
  for (const d of daily) theirs.set(`${d.office_number}|${normEmpNo(d.employee_number)}|${isoDay(d.work_date)}`, d);

  const keys = new Set([...ours.keys(), ...theirs.keys()]);
  const c = { 一致: 0, 当方だけ: 0, 旧だけ: 0, 件数が多い: 0, 件数が少ない: 0, 件数同じで分が違う: 0, 研修で説明: 0, 完全重複で説明: 0, 説明できない: 0 };
  let sumOurs = 0, sumTheirs = 0;
  const detail: string[] = [];
  const gaps: number[] = [];
  const byOffice = new Map<string, { n: number; bad: number }>();
  for (const k of [...keys].sort()) {
    const o = ours.get(k), t = theirs.get(k);
    const off = k.split("|")[0];
    const st = byOffice.get(off) ?? { n: 0, bad: 0 }; st.n++;
    const oa = o ? o.visit - o.doukou : null;
    const ta = t ? (t.actual_min ?? 0) : null;
    sumOurs += oa ?? 0; sumTheirs += ta ?? 0;
    if (!o && t && (ta ?? 0) === 0) { c.一致++; }   // ★ 両方 0 分 (事務員など 訪問が無い日)。★ 分母を膨らませない
    else if (o && !t) { c.当方だけ++; st.bad++; if (DETAIL) detail.push(`  当方だけ ${k} ${o.name} ${o.n}行 ${oa}分`); }
    else if (!o && t) { c.旧だけ++; st.bad++; if (DETAIL) detail.push(`  旧だけ   ${k} ${t.employee_name} ${t.visit_count ?? "-"}件 ${ta}分`); }
    else if (o && t) {
      if (oa === ta) c.一致++;
      else {
        st.bad++;
        const tn = t.visit_count ?? 0;
        if (o.n > tn) c.件数が多い++;
        else if (o.n < tn) c.件数が少ない++;
        else c.件数同じで分が違う++;
        const gap = (oa ?? 0) - (ta ?? 0);
        gaps.push(gap);
        if (gap > 0 && gap === o.nonVisit) c.研修で説明++;
        else if (gap > 0 && gap === o.dup) c.完全重複で説明++;
        else c.説明できない++;
        if (DETAIL) detail.push(`  差${String(gap).padStart(5)}分 ${k} ${o.name} 当方 ${o.n}件/${oa}分 (研修等${o.nonVisit} 重複${o.dup}) vs 旧 ${tn}件/${ta}分`);
      }
    }
    byOffice.set(off, st);
  }
  console.log(`\n--- 日の突合 (${[...keys].length} 日分)`);
  for (const [k, v] of Object.entries(c)) console.log(`    ${k.padEnd(20, "　")} ${v}`);
  console.log(`    実績分の合計  当方 ${sumOurs.toLocaleString()}分 / 旧 ${sumTheirs.toLocaleString()}分 (差 ${(sumOurs - sumTheirs).toLocaleString()}分)`);
  const badOffices = [...byOffice].filter(([, v]) => v.bad > 0).sort((a, b) => b[1].bad - a[1].bad);
  // ★ 差の分布。★ 同じ値に山があれば 規則の差 / ばらけていれば データの差
  console.log("\n--- 差 (当方 − 旧) の分布");
  const hist = new Map<number, number>();
  for (const g of gaps) hist.set(g, (hist.get(g) ?? 0) + 1);
  for (const [g, n] of [...hist].sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log(`    ${String(g > 0 ? "+" + g : g).padStart(7)}分  ${String(n).padStart(4)} 日`);
  console.log(`    (差の種類 ${hist.size} 通り / 30分の倍数 ${gaps.filter((g) => g % 30 === 0).length} 日 / 15分の倍数 ${gaps.filter((g) => g % 15 === 0).length} 日 / それ以外 ${gaps.filter((g) => g % 15 !== 0).length} 日)`);
  console.log(`\n--- 事業所別 (食い違う日がある ${badOffices.length} 事業所)`);
  for (const [off, v] of badOffices.slice(0, 15)) console.log(`    ${off}  食い違い ${v.bad} / ${v.n} 日`);
  if (badOffices.length > 15) console.log(`    … ほか ${badOffices.length - 15} 事業所`);
  if (DETAIL) { console.log(`\n--- 食い違う日の明細 ${detail.length} 件`); for (const l of detail.slice(0, 200)) console.log(l); if (detail.length > 200) console.log(`  … ほか ${detail.length - 200} 件 (MONTHS= で絞ってください)`); }

  console.log("\n--- 負のコントロール");
  expect(parseDurationMinutes("001:30") === 90 && parseDurationMinutes("000:44") === 44, "calc_duration を分に直せる (001:30 = 90分 / 000:44 = 44分)");
  expect(parseDurationMinutes("024:00") === 0, "★ 開始=終了 で 024:00 になる行 (キャンセル・有給 662 行) は 0 分 (自前で書くと 1,440 分に化ける)");
  expect(isoDay("2026/05/01") === "2026-05-01" && isoDay("2026-05-01") === "2026-05-01", "日付の書式が 2 通り (スラッシュ/ハイフン) でも同じキーになる");
  expect(isAccompaniedRecord({ service_code: "010001" }) && !isAccompaniedRecord({ service_code: "111111" }), "同行の判定は サービスコード (本番の関数)");
  expect(!isCareRecord({ service_type: "会議" }) && isCareRecord({ service_type: "身1" }), "会議は 訪問に数えない / 身体介護は数える (本番の関数)");
  expect(KENSHU.test("研修") && !KENSHU.test("身1"), "研修は 旧が訪問に数えない側");
  expect(kangoOffices.size > 0 && dailyKango.length > 0, `訪問看護の事業所を office_type で外せている (${kangoOffices.size} 事業所 / ${dailyKango.length} 行)`);
  expect(!daily.some((d) => kangoOffices.has(d.office_number)), "突合する側に 訪問看護が 1 行も残っていない");
  {
    // ★ 既知の 1 件で 検査が鳴ることを確かめる (林幸子 202605-05-13 の 研修 15分)
    const k = "1279000366|230704|2026-05-13";
    const o = ours.get(k), t = theirs.get(k);
    expect(!!o && !!t && (o.visit - o.doukou) - (t.actual_min ?? 0) === o.nonVisit && o.nonVisit === 15,
      `既知の 1 件が 「研修で説明」に入る (林幸子 5/13 研修 15分) ${o && t ? `差${(o.visit - o.doukou) - (t.actual_min ?? 0)}分 / 研修${o.nonVisit}分` : "データなし"}`);
  }
  {
    const k = "1279000366|16030|2026-05-01";
    const o = ours.get(k), t = theirs.get(k);
    expect(!!o && !!t && o.n < (t.visit_count ?? 0), `既知の 1 件が 「件数が少ない」に入る (西沢佳子 5/1 当方 ${o?.n} 件 / 旧 ${t?.visit_count} 件)`);
  }

  // ── ★ ① を入れた 3 者比較。★ ここが 直す候補の本体
  const dir = process.env.SOUKATSU1_DIR;
  if (!dir) console.log("\n★ SOUKATSU1_DIR を渡すと ① との 3 者比較 (直す候補) も出ます");
  else {
    const { soukatsuMinutes } = await import("../src/lib/payroll/soukatsu-time.js");
    const files = readdirSync(dir).filter((f) => /^soukatsu_extract_\d{6}\.json$/.test(f)).sort();
    const l1 = new Map<string, Record<string, unknown>>();
    for (const f of files) { const m = /_(\d{6})\.json$/.exec(f)![1];
      for (const r of JSON.parse(readFileSync(join(dir, f), "utf8")) as { office_number: string; employee_number: string; row_data: Record<string, unknown> }[]) {
        const k = `${r.office_number}|${normEmpNo(r.employee_number)}|${m}`; if (!l1.has(k)) l1.set(k, r.row_data); } }
    const ourM = new Map<string, number>(), theirM = new Map<string, number>();
    for (const [k, d] of ours) { const [o, e, day] = k.split("|"); const mm = day.slice(0, 4) + day.slice(5, 7); const mk = `${o}|${e}|${mm}`; ourM.set(mk, (ourM.get(mk) ?? 0) + (d.visit - d.doukou)); }
    for (const d of daily) { const mk = `${d.office_number}|${normEmpNo(d.employee_number)}|${d.processing_month}`; theirM.set(mk, (theirM.get(mk) ?? 0) + (d.actual_min ?? 0)); }
    let nn3 = 0, both = 0, oursOnly = 0, theirsOnly = 0, none = 0;
    const fixables: string[] = [];
    for (const [k, ov] of ourM) {
      const tv = theirM.get(k); if (tv == null) continue;
      const d1 = l1.get(k); if (!d1) continue;
      const i1 = soukatsuMinutes(d1["訪介実績時間"], "minutes"); if (i1 == null) continue;
      nn3++;
      const a = ov === i1, b = tv === i1;
      if (a && b) both++; else if (a) oursOnly++;
      else if (b) { theirsOnly++; fixables.push(`    ★ ${k} ① ${i1}分 = 旧日別 ${tv}分 / 当方 ${ov}分 (差 ${ov - i1}分)`); }
      else none++;
    }
    console.log(`\n--- ★ ① を入れた 3 者比較 (${nn3} 人月)`);
    console.log(`    両方と一致 ${both} / 当方だけと一致 ${oursOnly} / ★ 旧の日別だけと一致 ${theirsOnly} / どちらとも違う ${none}`);
    console.log(`    ★ 「旧の日別だけと一致」= ★ ① も旧日別側 = ★ 直す候補。★ 「当方だけと一致」は 旧日別が古いだけ`);
    for (const l of fixables.slice(0, 25)) console.log(l);
    if (fixables.length > 25) console.log(`      … ほか ${fixables.length - 25} 人月`);
    counts3 = { "★ ①も旧日別側 (直す候補) 人月": theirsOnly, "① がどちらとも違う人月": none };
  }

  type Baseline = { _readme: string[]; counts: Record<string, number> };
  const baseline: Baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline : { _readme: [], counts: {} };
  const counts: Record<string, number> = { ...c, ...counts3 };
  delete (counts as Record<string, unknown>)["一致"];   // ★ 一致は 増えてよい
  if (UPDATE) { baseline.counts = counts; writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n", "utf8"); console.log("\n基準値を更新しました"); }
  else {
    console.log("\n--- 基準値");
    for (const [k, v] of Object.entries(counts)) {
      const b = baseline.counts[k];
      if (b == null) { console.log(`  ・${k} = ${v} (基準値なし)`); continue; }
      if (v > b) expect(false, `${k} が基準値から増えた (${v} > ${b})`);
      else console.log(`  o ${k} = ${v} (基準値 ${b})`);
    }
  }
  console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS (★ 0 件 PASS ではない。基準値の件数を許容したうえでの PASS)");
  process.exit(fail ? 1 : 0);
}
await main();
