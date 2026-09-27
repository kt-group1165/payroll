/**
 * check:no-source-data — ② (支払用の総括表) が払っているのに 当方に元データが 1 か月も無い人月 (2026-09-27 給与D)
 *
 *   npm run check:no-source-data
 *   SNAPSHOT=<path.json> npm run check:no-source-data      1 回目は保存し 2 回目から使い回す
 *   npm run check:no-source-data -- --update              ★ 基準値方式の数だけ更新
 *
 * ★★ これは入力漏れではない。★ 元データ (出勤簿・事業所書式・手入力) が その人に 1 か月も無い。
 *    ★ ② の額を写して埋めてはいけない (② を写すと 突合の意味が消える = 循環)。
 *    ★ 埋めるなら 元データを 出どころ (ほのぼの / 事業所) からもらう。出力の「もらうもの」を見ること。
 *    入力漏れ (前後の月には元データがある) は migrations/fix_missing_commute_input.mjs などが扱う。
 *
 * 何を数えるか (項目ごと): 当方と ② の両方に居る人月で
 *   ② の額 > 0 / 当方の額 = 0 / ★ その人に その項目の元データが どの月にも無い
 *   項目と元データ:
 *     通勤  ② 通勤費          ← 出勤簿 commute_km / 書式「通勤km」/ 手入力 commute_yen
 *     出張  ② 出張費          ← 出勤簿 business_km / 書式「出張km」/ 手入力 business_km
 *     育児  ② 育児手当        ← 書式「保育料」/ 手入力 childcare_allowance
 *     研修会議 ② その他手当 (無ければ HRD研修 + 研修) ← 書式「研修」「HRD研修」「初任者研修」「会議N件数」/ 手入力 training_minutes・shoninsha (時給だけ)
 *       ★ ② の「研修」列には 事業所によって 会議費が入る (おゆみ野: ② 研修 1,150 = 当方 meeting_fee 1,150)。
 *         研修だけで比べると 当方の会議費を「払っていない」と誤って数える (2026-09-27 に 112 人月を誤検知して直した)
 *   当方の額: 時給は payload の commute_fee / business_trip_fee / childcare_allowance / training_pay + meeting_fee、
 *            月給は payroll-calc.ts の commuteFeeAmount / travelFeeAmount (+ business_trip_fee) / childcare_allowance
 *   ★ 書式に 項目の行はあるが 値が空 (0) のものは「欄はあるが空」と出す (事業所が値を入れていない)
 * 基準値方式: 2026-09-27 時点の件数を固定し 増えたら落ちる。★ 元データが届いて埋まれば減る。
 * 負のコントロール: 写しで ① 該当する人月に元データを 1 行足すと −1 ② 元データのある人から全部の元データを消して 当方の額も 0 にすると +1
 * 見ていないもの: 当方にだけ居る/② にだけ居る人月 (check:soukatsu-row-only) / 有給・会議・入浴 など他の項目 /
 *   月給の研修会議 (月給は別に払わない) / 当方も払っているが額が違うもの (例: 岩坪恵 202608 ② HRD研修 4,600 を 当方は払っていない が 会議費 6,000 は払っている) / 元データが「ある月」の入れ漏れ (fix_missing_* の script)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { restAll } from "./_rest.mjs";
import { commuteFeeAmount, travelFeeAmount, type MonthlyPayroll } from "../src/lib/payroll/payroll-calc.js";

const UPDATE = process.argv.includes("--update");
const BASELINE = new URL("./check-no-source-data-baseline.json", import.meta.url);
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^-?[\d,]+(\.\d+)?$/.test(v.trim()) ? Number(v.replace(/,/g, "")) : 0);
const ITEMS = ["通勤", "出張", "育児", "研修会議"] as const;
type Item = typeof ITEMS[number];

type Hourly = { employee_number: string; employee_name: string; commute_fee: number; business_trip_fee: number; childcare_allowance: number; training_pay: number; meeting_fee: number };
type Monthly = MonthlyPayroll & { employee_number: string; employee_name: string };
type Calc = { office_number: string; processing_month: string; calculated_at: string; hourly: Hourly[] | null; monthly: Monthly[] | null };
type Att = { office_number: string; employee_number: string; year: number; month: number; commute_km: number | null; business_km: number | null };
type Form = { office_number: string; employee_number: string; processing_month: string; item_name: string; numeric_value: number | null; start_time: string | null };
type MI = { office_number: string; employee_number: string; processing_month: string; item_key: string; numeric_value: number | null };
type L2 = { office_number: string; employee_number: string; processing_month: string; row_data: Record<string, unknown> };
type Snap = { calc: Calc[]; att: Att[]; form: Form[]; mi: MI[]; l2: L2[] };
const SNAPSHOT = process.env.SNAPSHOT ?? "";
let snap: Snap;
if (SNAPSHOT && existsSync(SNAPSHOT)) snap = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snap;
else {
  snap = {
    calc: await restAll<Calc>("payroll_calc_results?select=id,office_number,processing_month,calculated_at,hourly:payload->hourly,monthly:payload->monthly"),
    att: await restAll<Att>("payroll_attendance_records?select=id,office_number,employee_number,year,month,commute_km,business_km&or=(commute_km.gt.0,business_km.gt.0)"),
    form: await restAll<Form>("payroll_office_form_records?select=id,office_number,employee_number,processing_month,item_name,numeric_value,start_time&or=(item_name.in.(通勤km,出張km,保育料,研修,HRD研修,初任者研修),item_name.like.会議*)"),
    mi: await restAll<MI>("payroll_monthly_inputs?select=id,office_number,employee_number,processing_month,item_key,numeric_value&item_key=in.(commute_yen,business_km,childcare_allowance,training_minutes,shoninsha_training_minutes)"),
    l2: await restAll<L2>("payroll_soukatsu_rows?select=id,office_number,employee_number,processing_month,row_data"),
  };
  if (SNAPSHOT) writeFileSync(SNAPSHOT, JSON.stringify(snap));
}
const calcAt = snap.calc.map((c) => c.calculated_at).sort();
console.log("=== check:no-source-data (② は払っているのに 当方に元データが 1 か月も無い人月) ===");
console.log("★ 入力漏れではない。元データが無い。★ ② の額を写して埋めてはいけない (循環になる)。埋めるなら 出どころから元データをもらう");
console.log(`計算: ${snap.calc.length} 事業所月 (${calcAt[0]} 〜 ${calcAt.at(-1)})`);

function run(s: Snap) {
  // 人 (事業所|職員) → 項目 → 元データのある月 / 欄はあるが空の月
  const src = new Map<string, Map<Item, Set<string>>>(), blank = new Map<string, Map<Item, Set<string>>>();
  const put = (m: typeof src, on: string, emp: string, item: Item, ym: string) => { const k = `${on}|${nn(emp)}`; if (!m.has(k)) m.set(k, new Map()); const x = m.get(k)!; if (!x.has(item)) x.set(item, new Set()); x.get(item)!.add(ym); };
  for (const r of s.att) { const ym = `${r.year}${String(r.month).padStart(2, "0")}`; if (Number(r.commute_km) > 0) put(src, r.office_number, r.employee_number, "通勤", ym); if (Number(r.business_km) > 0) put(src, r.office_number, r.employee_number, "出張", ym); }
  for (const r of s.form) {
    const item: Item | null = r.item_name === "通勤km" ? "通勤" : r.item_name === "出張km" ? "出張" : r.item_name === "保育料" ? "育児" : /研修|会議/.test(r.item_name) ? "研修会議" : null;
    if (!item) continue;
    const has = /研修/.test(r.item_name) ? !!r.start_time : /会議/.test(r.item_name) ? (Number(r.numeric_value ?? 0) > 0 || !!r.start_time) : Number(r.numeric_value ?? 0) > 0;
    put(has ? src : blank, r.office_number, r.employee_number, item, r.processing_month);
  }
  for (const r of s.mi) {
    if (!(Number(r.numeric_value ?? 0) > 0)) continue;
    const item: Item = r.item_key === "commute_yen" ? "通勤" : r.item_key === "business_km" ? "出張" : r.item_key === "childcare_allowance" ? "育児" : "研修会議";
    put(src, r.office_number, r.employee_number, item, r.processing_month);
  }
  const l2 = new Map<string, Record<string, number>>();
  for (const r of s.l2) {
    const k = `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`; const d = r.row_data;
    const cur = l2.get(k) ?? { 通勤: 0, 出張: 0, 育児: 0, 研修会議: 0 };
    cur.通勤 = Math.max(cur.通勤, num(d["通勤費"])); cur.出張 = Math.max(cur.出張, num(d["出張費"]));
    cur.育児 = Math.max(cur.育児, num(d["育児手当"])); cur.研修会議 = Math.max(cur.研修会議, num(d["その他手当"]) || num(d["HRD研修"]) + num(d["研修"]));
    l2.set(k, cur);
  }
  const hits: { key: string; item: Item; name: string; side: string; l2: number; blankMonths: string[]; otherNoSrc: Item[] }[] = [];
  let denom = 0;
  for (const c of s.calc) {
    const rows: { emp: string; name: string; side: string; ours: Record<Item, number> }[] = [
      ...(c.hourly ?? []).map((e) => ({ emp: nn(e.employee_number), name: e.employee_name, side: "時給", ours: { 通勤: e.commute_fee ?? 0, 出張: e.business_trip_fee ?? 0, 育児: e.childcare_allowance ?? 0, 研修会議: (e.training_pay ?? 0) + (e.meeting_fee ?? 0) } })),
      ...(c.monthly ?? []).filter((p) => p.settings).map((p) => ({ emp: nn(p.employee_number), name: p.employee_name, side: "月給", ours: { 通勤: commuteFeeAmount(p), 出張: travelFeeAmount(p) + (p.business_trip_fee ?? 0), 育児: p.childcare_allowance ?? 0, 研修会議: 0 } })),
    ];
    for (const r of rows) {
      const k = `${c.office_number}|${r.emp}|${c.processing_month}`; const b = l2.get(k); if (!b) continue;
      const person = `${c.office_number}|${r.emp}`;
      for (const item of ITEMS) {
        if (r.side === "月給" && item === "研修会議") continue;
        if (!(b[item] > 0) || r.ours[item] > 0) continue;
        denom++;
        if ((src.get(person)?.get(item)?.size ?? 0) > 0) continue; // 元データのある月がある = 入力漏れの側 (別の script)
        const otherNoSrc = ITEMS.filter((it) => it !== item && !(src.get(person)?.get(it)?.size));
        hits.push({ key: k, item, name: r.name, side: r.side, l2: b[item], blankMonths: [...(blank.get(person)?.get(item) ?? [])].sort(), otherNoSrc });
      }
    }
  }
  return { hits, denom, src };
}

const r0 = run(snap);
console.log(`\n分母 (② > 0 かつ 当方 = 0 の 人月×項目): ${r0.denom} / うち ★ 元データが 1 か月も無い: ${r0.hits.length} (¥${r0.hits.reduce((s, h) => s + h.l2, 0).toLocaleString()})`);
const WHAT: Record<Item, string> = {
  通勤: "出勤簿 (通勤km) か 事業所書式の「通勤km」の値 (または 通勤手当の月額・日額)",
  出張: "事業所書式の「出張km」の値 (または 交通費精算書)",
  育児: "事業所書式の「保育料」 (または 育児手当の額の根拠)",
  研修会議: "事業所書式の「研修」「HRD研修」の日時 (開始・終了・休憩) か「会議N件数」",
};
const byPerson = new Map<string, typeof r0.hits>();
for (const h of r0.hits) { const p = h.key.split("|").slice(0, 2).join("|"); byPerson.set(p, [...(byPerson.get(p) ?? []), h]); }
for (const [p, hs] of byPerson) {
  console.log(`\n  ${p} ${hs[0].name} (${hs[0].side})  ② 計 ¥${hs.reduce((s, h) => s + h.l2, 0).toLocaleString()}`);
  for (const h of hs) console.log(`    ${h.key.split("|")[2]} ${h.item} ② ¥${h.l2.toLocaleString()}${h.blankMonths.length ? `  (書式に「${h.item}」の欄はあるが空: ${h.blankMonths.join(",")})` : ""}`);
  const items = [...new Set(hs.map((h) => h.item))];
  console.log(`    他に元データが 1 か月も無い項目: ${hs[0].otherNoSrc.filter((i) => !items.includes(i)).join(" / ") || "なし"}`);
  console.log(`    ★ もらうもの: ${items.map((i) => WHAT[i]).join(" / ")}`);
}

console.log("\n--- 負のコントロール (写しを壊す)");
{
  const h = r0.hits.find((x) => x.item === "通勤") ?? r0.hits[0];
  let n = -1;
  if (h) {
    const [on, emp, m] = h.key.split("|");
    const add: MI = { office_number: on, employee_number: emp, processing_month: m, item_key: h.item === "通勤" ? "commute_yen" : h.item === "出張" ? "business_km" : h.item === "育児" ? "childcare_allowance" : "training_minutes", numeric_value: 1 };
    n = run({ ...snap, mi: [...snap.mi, add] }).hits.filter((x) => x.item === h.item && x.key.startsWith(`${on}|${emp}|`)).length;
    const before = r0.hits.filter((x) => x.item === h.item && x.key.startsWith(`${on}|${emp}|`)).length;
    expect(n === 0 && before > 0, `① 該当する人に ${h.item} の元データを 1 行足すと その人の ${h.item} が ${before} → ${n} (全部 入力漏れの側に移る)`);
  } else expect(false, "① 該当が 0 件なので 負のコントロールを作れない");
}
{
  // 元データがあって ② も当方も払っている 通勤 の人月を 1 つ選び、その人の通勤の元データを全部消し 当方の通勤費も 0 にする
  const pick = snap.calc.flatMap((c) => (c.hourly ?? []).filter((e) => (e.commute_fee ?? 0) > 0).map((e) => ({ c, e }))).find(({ c, e }) => {
    const b = snap.l2.find((x) => x.office_number === c.office_number && nn(x.employee_number) === nn(e.employee_number) && x.processing_month === c.processing_month);
    return b && num(b.row_data["通勤費"]) > 0;
  });
  let n = -1;
  if (pick) {
    const on = pick.c.office_number, emp = nn(pick.e.employee_number);
    const same = (o: string, e: string) => o === on && nn(e) === emp;
    const s2: Snap = {
      ...snap,
      att: snap.att.map((a) => (same(a.office_number, a.employee_number) ? { ...a, commute_km: 0 } : a)),
      form: snap.form.filter((f) => !(same(f.office_number, f.employee_number) && f.item_name === "通勤km")),
      mi: snap.mi.filter((m) => !(same(m.office_number, m.employee_number) && m.item_key === "commute_yen")),
      calc: snap.calc.map((c) => (c === pick.c ? { ...c, hourly: (c.hourly ?? []).map((e) => (e === pick.e ? { ...e, commute_fee: 0 } : e)) } : c)),
    };
    n = run(s2).hits.length;
  }
  expect(!!pick && n === r0.hits.length + 1, `② 元データのある人から 通勤の元データを全部消し 当方の通勤費も 0 にすると ${r0.hits.length} → ${n}`);
}

type Baseline = { _readme: string[]; counts: Record<string, number> };
const counts: Record<string, number> = { 合計: r0.hits.length };
for (const it of ITEMS) counts[it] = r0.hits.filter((h) => h.item === it).length;
const baseline: Baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline : { _readme: [], counts: {} };
if (UPDATE) {
  baseline.counts = counts;
  writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  console.log("\n基準値を更新しました");
} else {
  console.log(`\n基準値: ${JSON.stringify(baseline.counts)}`);
  for (const [k, v] of Object.entries(counts)) expect(v <= (baseline.counts[k] ?? Number.POSITIVE_INFINITY), `${k} が基準値から増えていない (${v} <= ${baseline.counts[k] ?? "∞"})`);
}
console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS");
process.exit(fail ? 1 : 0);
