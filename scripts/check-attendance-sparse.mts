/**
 * check:attendance-sparse — 出勤簿の **時刻が入っている日** が 月によって急に減っていないかを見る。★ 基準値方式・読み取り専用。
 *
 *   npm run check:attendance-sparse
 *   npm run check:attendance-sparse -- --update
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────────
 * 出勤時間は **出勤簿 → 旧システムの日計 → 推定 (訪問+移動+研修)** の順に出す (employeeWorkMinutes)。
 * ★ 出勤簿の **行はあるのに 時刻が空** の日があると、★ その日は 0 分として足され 静かに短くなる。
 * ★ 行数は月の日数ぶん揃うので、★ 「行数が減ったら気付ける」検査では **検知できない**。
 *
 * 2026-10-01 に ② との 出勤時間の差 433 人月を追って見つけた:
 * ```
 *   八千代 202608  時刻ありが **0 日** (他の月は 22.7 日)  → 小川千晴 当方 0 分 / ② 11,295 分
 *   いすみ 202604  時刻ありが 15.5 日 (他の月は 21.5〜22.7) → 戸田幸子ほか 3 名が +3,360 分 (56h) ずれる
 * ```
 * ★ どちらも 出勤簿の行は 30〜31 行そろっていた。★ 中身が空なだけ。
 *
 * ── 測り方 ────────────────────────────────────────────────────────────────
 * 事業所ごとに 月の「1 人あたり 時刻が入っている日数」の平均を出し、
 * ★ その事業所の **中央値の 7 割を下回る月** を挙げる。
 * ⚠ 事業所ごとに 勤務日数の水準が違う (木更津 18.4 日 / やわた 23.7 日) ので
 *   **全社共通の閾値では測れない**。★ 事業所の中央値と比べる。
 *
 * ── この検査が見ていないもの ──────────────────────────────────────────────
 *   ・時刻が入っている日の **値が正しいか** (→ check:attendance-hours-gap)
 *   ・出勤簿そのものが無い人。★ 出勤簿は 提責・事務員・管理者だけなので 無いのが正常
 *     (パート 3,099 人月・社員 831 人月 は 1 件も無い)
 *   ・1 人だけ空の月。★ 事業所の平均で見るので 大勢の中の 1 人は埋もれる
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { restAll } from "./_rest.mjs";

const UPDATE = process.argv.includes("--update");
const BASELINE = new URL("./check-attendance-sparse-baseline.json", import.meta.url);
/** 事業所の中央値の何割を下回ったら挙げるか */
const RATIO = 0.75;
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };

type Att = { office_number: string; employee_number: string; year: number; month: number; start_time_1: string | null };
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");

/** 出勤簿から 事業所×月 の「1 人あたり 時刻が入っている日数」を出す。★ 検査の本体 (負のコントロールからも呼ぶ) */
export function sparseByOfficeMonth(att: Att[], ratio = RATIO) {
  const byOM = new Map<string, Map<string, { rows: number; withT: number }>>();
  for (const r of att) {
    const m = `${r.year}${String(r.month).padStart(2, "0")}`;
    const k = `${r.office_number}|${m}`;
    const v = byOM.get(k) ?? new Map<string, { rows: number; withT: number }>();
    const e = nn(r.employee_number);
    const c = v.get(e) ?? { rows: 0, withT: 0 };
    c.rows++; if (String(r.start_time_1 ?? "").trim() !== "") c.withT++;
    v.set(e, c); byOM.set(k, v);
  }
  const byOffice = new Map<string, { m: string; n: number; avg: number }[]>();
  for (const [k, v] of byOM) {
    const [on, m] = k.split("|");
    const people = [...v.values()];
    const avg = people.reduce((s, c) => s + c.withT, 0) / people.length;
    const o = byOffice.get(on) ?? [];
    o.push({ m, n: people.length, avg });
    byOffice.set(on, o);
  }
  const flagged: { on: string; m: string; avg: number; med: number; n: number }[] = [];
  for (const [on, list] of byOffice) {
    list.sort((a, b) => a.m.localeCompare(b.m));
    const med = [...list.map((x) => x.avg)].sort((a, b) => a - b)[Math.floor(list.length / 2)];
    for (const x of list) if (med > 0 && x.avg < med * ratio) flagged.push({ on, m: x.m, avg: x.avg, med, n: x.n });
  }
  return { byOffice, flagged };
}

async function main() {
  console.log("=== check:attendance-sparse (出勤簿の 時刻が入っている日が 月で急に減っていないか) 2026-10-01 新設・読み取り専用 ===");
  console.log("★ check:all には入れていない (診断系。落ちる/落ちないではなく 件数を見張るもの)");
  const att = await restAll<Att>("payroll_attendance_records?select=id,office_number,employee_number,year,month,start_time_1");
  const pofs = await restAll<{ id: string; office_number: string; office_id: string }>("payroll_offices?select=id,office_number,office_id");
  const offs = await restAll<{ id: string; name: string }>("offices?select=id,name");
  const nameOf = new Map(offs.map((o) => [o.id, o.name]));
  const disp = (on: string) => nameOf.get(pofs.find((o) => o.office_number === on)?.office_id ?? "") ?? on;
  console.log(`出勤簿 ${att.length} 行`);

  const { byOffice, flagged } = sparseByOfficeMonth(att);
  console.log(`\n--- 事業所ごとの 月平均「時刻が入っている日数」 (★ 中央値の ${RATIO * 100}% を下回る月に ←)`);
  for (const [on, list] of [...byOffice].sort()) {
    const med = [...list.map((x) => x.avg)].sort((a, b) => a - b)[Math.floor(list.length / 2)];
    const cells = list.map((x) => `${x.m.slice(4)}:${x.avg.toFixed(1)}${med > 0 && x.avg < med * RATIO ? "←" : " "}`);
    console.log(`  ${on} ${disp(on).padEnd(22)} 中央値 ${med.toFixed(1)}  ` + cells.join("  "));
  }
  console.log(`\n--- ★ 挙がった 事業所×月 ${flagged.length} 件`);
  for (const f of flagged.sort((a, b) => a.avg / a.med - b.avg / b.med))
    console.log(`  ${f.on} ${disp(f.on).padEnd(22)} ${f.m}  平均 ${f.avg.toFixed(1)} 日 (中央値 ${f.med.toFixed(1)} / ${f.n} 名)  ← ${(100 * f.avg / f.med).toFixed(0)}%`);

  console.log("\n--- 負のコントロール");
  const base: Att[] = [];
  for (const m of [3, 4, 5, 6]) for (let d = 1; d <= 20; d++) base.push({ office_number: "X", employee_number: "1", year: 2026, month: m, start_time_1: "09:00" });
  expect(sparseByOfficeMonth(base).flagged.length === 0, "どの月も同じなら 挙がらない");
  const holed = base.map((r) => (r.month === 4 ? { ...r, start_time_1: "" } : r));
  const f2 = sparseByOfficeMonth(holed).flagged;
  expect(f2.length === 1 && f2[0].m === "202604", "★ 1 か月だけ時刻を空にすると その月が挙がる (行数は同じまま)");
  const half = base.map((r, i) => (r.month === 4 && i % 2 === 0 ? { ...r, start_time_1: "" } : r));
  expect(sparseByOfficeMonth(half).flagged.length === 1, "★ 半分空でも挙がる (いすみ 202604 と同じ形)");
  const few = base.map((r) => (r.month === 4 && Number(r.employee_number) === 1 ? r : r));
  expect(sparseByOfficeMonth(few).flagged.length === 0, "値を変えていなければ 挙がらない (手を加えた分だけ効く)");

  const counts: Record<string, number> = { "時刻が急に減っている 事業所×月": flagged.length };
  for (const f of flagged) counts[`${f.on}|${f.m}`] = Math.round(100 * f.avg / f.med);

  type Baseline = { _readme: string[]; counts: Record<string, number> };
  const baseline: Baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline : { _readme: [], counts: {} };
  if (UPDATE) {
    baseline.counts = counts;
    writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n", "utf8");
    console.log("\n基準値を更新しました");
  } else {
    console.log("\n--- 基準値");
    for (const [k, v] of Object.entries(counts)) {
      const b = baseline.counts[k];
      if (b == null) { console.log(`  ${k === "時刻が急に減っている 事業所×月" ? "・" : "★ "}${k} = ${v} (基準値なし)`); if (k !== "時刻が急に減っている 事業所×月") fail++; continue; }
      // ★ 件数は 増えたら FAIL。★ 割合は **下がったら** FAIL (もっと空になった)
      if (k === "時刻が急に減っている 事業所×月") { if (v > b) expect(false, `${k} が基準値から増えた (${v} > ${b})`); else console.log(`  o ${k} = ${v} (基準値 ${b})`); }
      else if (v < b) expect(false, `${k} の割合が下がった (${v}% < ${b}%)`);
      else console.log(`  o ${k} = ${v}% (基準値 ${b}%)`);
    }
  }
  console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS (★ 0 件 PASS ではない。基準値の件数を許容したうえでの PASS)");
  process.exit(fail ? 1 : 0);
}
await main();
