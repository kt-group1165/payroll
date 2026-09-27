/**
 * check:soukatsu-carryover — ② (総括表 支払用) が 前月の値をそのまま持ち越している疑いを数える (2026-09-27 給与D)。★ 基準値方式・読み取り専用
 *
 *   npm run check:soukatsu-carryover
 *   L2_SNAPSHOT=<json> ATT_SNAPSHOT=<json> npm run check:soukatsu-carryover     # 取得結果を使い回す (無ければ取得して保存)
 *   npm run check:soukatsu-carryover -- --update                                 ★ 基準値を更新 (中身を見てから)
 *
 * ── なぜ ───────────────────────────────────────────────────────────────
 * 2026-09-27 に ② が前月の値を持っている例が 2 つ出た:
 *   中村素子 1272401561|793|202608 (事務員): ② 出勤時間 8,310 分 = 7 月と同じ / 当方の出勤簿は 6,570 分 (15 日) → 差 ¥35,588 は ② の持ち越し
 *   大藪明美 1271101295|426|202608 (事務員): ② 法内残業 90 分・2,114 円 = 7 月と同じ / 当方の出勤簿に法内残業なし
 * ★ 「前月と同じ」だけでは使えない: 連続する 2 か月の組 3,132 で 本人給が前月と同じ 1,106 件 (35.3%。固定給なので同じで当然) など 偽陽性の山になる。
 * → ★ 「② が前月と同じ かつ 当方の元データと違う」を持ち越しの疑いとする。
 *
 * ── 項目と 当方の元データ ───────────────────────────────────────────────
 *   出勤時間  ← payroll_attendance_records の work_hours の合計 (その月の出勤簿)
 *   法内残業  ← 当方の計算結果 (payroll_calc_results の月給 legal_within_minutes)
 *             ★ 出勤簿の legal_overtime 列の合計ではない (江尻 1270906546|917|202606 は 列の合計 600 / 計算が使う値 120。列の意味が違う)
 *   (保育料 = 事業所書式 は 別の検査 check:childcare-repeat)
 * ── 3 段 (② の値が 0 より大きく 前月と同じもの を分ける) ───────────────────────
 *   ★ 持ち越しの疑い   当方の出勤簿がある かつ ② と違う
 *   偶然の一致         当方の出勤簿がある かつ ② と同じ
 *   判定できない       当方にその月の出勤簿が無い (★ 出勤簿の依頼リスト行き)
 * ★ 差の小さいもの (片岡久美子 1272401561|880|202608 −180 分 / 小林千里 1278600398|11067|202605 +60 分) は 持ち越しか丸めか 決められない。
 *
 * ── 判定 ─────────────────────────────────────────────────────────────
 *   「持ち越しの疑い」の一覧が基準値に無いものを含んだら FAIL。偶然の一致・判定できない は表示だけ
 * 負のコントロール: ② の値を前月の値にコピーすると 疑い +1 / 当方の出勤簿を ② と同じにすると 偶然の一致に移る
 * 見ていないもの: 出勤時間・法内残業 以外の項目 / ① (旧の出力) / パート (出勤簿は提責と事務員だけ)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { restAll } from "./_rest.mjs";
import { soukatsuMinutes } from "../src/lib/payroll/soukatsu-time.js";

const UPDATE = process.argv.includes("--update");
const BASELINE = new URL("./check-soukatsu-carryover-baseline.json", import.meta.url);
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");

async function cached<T>(envName: string, path: string): Promise<T[]> {
  const p = process.env[envName] ?? "";
  if (p && existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as T[];
  const rows = await restAll<T>(path);
  if (p) writeFileSync(p, JSON.stringify(rows));
  return rows;
}
type L2 = { office_number: string; employee_number: string; processing_month: string; sheet_kind: string; row_data: Record<string, unknown> };
type Att = { office_number: string; employee_number: string; year: number; month: number; work_hours: string | null; legal_overtime: string | null };
const l2rows = await cached<L2>("L2_SNAPSHOT", "payroll_soukatsu_rows?select=id,office_number,employee_number,processing_month,sheet_kind,row_data");
const att = await cached<Att>("ATT_SNAPSHOT", "payroll_attendance_records?select=id,office_number,employee_number,year,month,work_hours,legal_overtime");
type Calc = { office_number: string; processing_month: string; monthly: { employee_number: string; legal_within_minutes?: number | null }[] | null };
const calc = await cached<Calc>("CALC_M_SNAPSHOT", "payroll_calc_results?select=id,office_number,processing_month,monthly:payload->monthly");
const legalWithin = new Map<string, number>();
for (const c of calc) for (const e of c.monthly ?? []) legalWithin.set(`${c.office_number}|${nn(e.employee_number)}|${c.processing_month}`, e.legal_within_minutes ?? 0);

const hm = (v: string | null) => soukatsuMinutes(v ?? "", "minutes") ?? 0;
const ITEMS: { item: string; l2Col: string; attCol: "work_hours" | "legal_overtime" }[] = [
  { item: "出勤時間", l2Col: "出勤時間", attCol: "work_hours" },
  { item: "法内残業", l2Col: "法内残業", attCol: "legal_overtime" },
];
type Src = Map<string, Record<string, number>>;
const srcOf = (rows: Att[]): Src => {
  const m: Src = new Map();
  for (const a of rows) {
    const k = `${a.office_number}|${nn(a.employee_number)}|${a.year}${String(a.month).padStart(2, "0")}`;
    const x = m.get(k) ?? { work_hours: 0, legal_overtime: 0 };
    x.work_hours += hm(a.work_hours);
    m.set(k, x);
  }
  for (const [k, x] of m) x.legal_overtime = legalWithin.get(k) ?? 0;
  return m;
};
const prevMonth = (m: string) => { const y = Number(m.slice(0, 4)), mo = Number(m.slice(4, 6)); return mo === 1 ? `${y - 1}12` : `${y}${String(mo - 1).padStart(2, "0")}`; };

function measure(rows: L2[], src: Src) {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const r of rows) byKey.set(`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}|${r.sheet_kind}`, r.row_data);
  let pairs = 0, sameHonnin = 0;
  const out: Record<string, { sus: string[]; coincide: number; unknown: number; same: number }> = {};
  for (const it of ITEMS) out[it.item] = { sus: [], coincide: 0, unknown: 0, same: 0 };
  for (const [k, d] of byKey) {
    const [o, e, m, kind] = k.split("|");
    const prev = byKey.get(`${o}|${e}|${prevMonth(m)}|${kind}`);
    if (!prev) continue;
    pairs++;
    if (d["本人給"] != null && d["本人給"] !== "" && String(d["本人給"]) === String(prev["本人給"])) sameHonnin++;
    for (const it of ITEMS) {
      const cur = soukatsuMinutes(d[it.l2Col], "minutes"), pv = soukatsuMinutes(prev[it.l2Col], "minutes");
      if (cur == null || pv == null || !(cur > 0) || cur !== pv) continue;
      const o2 = out[it.item]; o2.same++;
      const s = src.get(`${o}|${e}|${m}`);
      if (!s || !(s.work_hours > 0)) { o2.unknown++; continue; }
      if (s[it.attCol] === cur) o2.coincide++;
      else o2.sus.push(`${o}|${e}|${m} ${it.item} ② ${cur} (前月と同じ) / 当方 ${s[it.attCol]} 差 ${s[it.attCol] - cur} 分`);
    }
  }
  return { pairs, sameHonnin, out };
}

console.log("=== check:soukatsu-carryover (② が前月の値を持ち越している疑い。★ 前月と同じ かつ 当方の出勤簿と違う) ===");
const src = srcOf(att);
const cur = measure(l2rows, src);
console.log(`母数: ② の 連続する 2 か月が両方ある 人月の組 ${cur.pairs} (出勤簿 ${att.length} 行)`);
console.log(`  参考: 本人給が前月と同じ ${cur.sameHonnin} 組 (${(cur.sameHonnin / cur.pairs * 100).toFixed(1)}%) ← ★ 「前月と同じ」だけで鳴らすと こうなる`);
for (const it of ITEMS) {
  const o = cur.out[it.item];
  console.log(`\n--- ${it.item}: ② が前月と同じ (0 より大) ${o.same} → ★ 持ち越しの疑い ${o.sus.length} / 偶然の一致 ${o.coincide} / 判定できない (当方に出勤簿なし) ${o.unknown}`);
  for (const x of o.sus) console.log(`  ★ ${x}`);
}

console.log("\n--- 負のコントロール");
{
  const target = cur.out["出勤時間"].sus[0];
  // 1) 出勤簿がある人月で ② の出勤時間を前月の値にコピー (当方と違う値になる月を探す)
  let done = false;
  for (const r of l2rows) {
    const k = `${r.office_number}|${nn(r.employee_number)}`;
    const s = src.get(`${k}|${r.processing_month}`);
    const prev = l2rows.find((x) => x.office_number === r.office_number && nn(x.employee_number) === nn(r.employee_number) && x.sheet_kind === r.sheet_kind && x.processing_month === prevMonth(r.processing_month));
    const pv = prev ? soukatsuMinutes(prev.row_data["出勤時間"], "minutes") : null;
    if (!s || !(s.work_hours > 0) || !pv || pv === s.work_hours || soukatsuMinutes(r.row_data["出勤時間"], "minutes") === pv) continue;
    const m2 = measure(l2rows.map((x) => (x === r ? { ...x, row_data: { ...x.row_data, 出勤時間: pv } } : x)), src);
    expect(m2.out["出勤時間"].sus.length === cur.out["出勤時間"].sus.length + 1, `② の出勤時間を前月の値にコピーすると 疑い +1 (${cur.out["出勤時間"].sus.length} → ${m2.out["出勤時間"].sus.length})`);
    done = true; break;
  }
  if (!done) expect(false, "コピーを試す人月が見つからない");
  // 2) 疑いの 1 件について 当方の出勤簿を ② と同じにすると 偶然の一致に移る
  if (target) {
    const [key] = target.split(" "); const val = Number(/② (\d+)/.exec(target)![1]);
    const src2: Src = new Map(src); src2.set(key, { ...(src.get(key) ?? { work_hours: 0, legal_overtime: 0 }), work_hours: val });
    const m3 = measure(l2rows, src2);
    expect(m3.out["出勤時間"].sus.length === cur.out["出勤時間"].sus.length - 1 && m3.out["出勤時間"].coincide === cur.out["出勤時間"].coincide + 1, `当方の出勤簿を ② と同じにすると 疑い −1・偶然の一致 +1`);
  } else expect(false, "持ち越しの疑いが 0 件 (負のコントロールを当てられない)");
}

type Baseline = { _readme: string[]; suspects: string[] };
const baseline: Baseline | null = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline : null;
const sus = ITEMS.flatMap((it) => cur.out[it.item].sus.map((x) => x.split(" ").slice(0, 2).join(" "))).sort();
console.log("\n--- 基準値");
if (UPDATE || !baseline) {
  writeFileSync(BASELINE, JSON.stringify({ _readme: baseline?._readme ?? [], suspects: sus }, null, 2) + "\n", "utf8");
  console.log("  基準値を保存しました");
} else {
  const added = sus.filter((x) => !baseline.suspects.includes(x));
  expect(added.length === 0, `基準値に無い 持ち越しの疑い ${added.length} 件${added.length ? `: ${added.join(" / ")}  ★ ② が前月の値を持っていないか 出勤簿と見比べる` : ""}`);
}
console.log("\n見ていないもの: 出勤時間・法内残業 以外 / ① / パート / 判定できない (当方に出勤簿が無い) 人月の中身");
console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS");
process.exit(fail ? 1 : 0);
