/**
 * check:visit-time-l1 — 月の訪問時間そのものを ① (総括表データ) と突合する。★ 基準値方式・読み取り専用。
 *
 *   SOUKATSU1_DIR=<① の抽出物 soukatsu_extract_YYYYMM.json のある dir> npm run check:visit-time-l1
 *   SOUKATSU1_DIR=… npm run check:visit-time-l1 -- --update
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────────
 * 訪問時間は ★ 特日・土日祝・介護超過・夜朝・処遇改善 の **ほぼ全部の入力**。
 * ここがずれていると 下流の手当が全部ずれるが、★ 手当ごとの検査では
 * 「手当の式が違う」のか「入力の時間が違う」のかが 分けられない。
 * ★ 2026-09-30 に check:tokubi で ちはら台 202601 の 5 名が特日で合わないのを追ったところ、
 *   ★ 特日の規則ではなく **月の訪問時間そのものが 390〜915 分ずれていた**。
 *   ★ 入力の差と 金額の差を混ぜると こういう追い方になるので 入力だけを見る検査を分けた
 *   ([[feedback_input_broken_vs_money_broken]])。
 *
 * ── 何を比べるか ──────────────────────────────────────────────────────────
 *   当方  payroll_service_records の 介護の行 (isCareRecord) から 同行 (isAccompaniedRecord) を除いた 所要時間の和
 *   ①     総括表データの 「訪介実績時間」 (同行を含まない) / 「訪介同行時間」
 * ★ 所要時間は **本番の parseDurationMinutes** を使う (1440 分以上 = 取消・有給の `024:00` は 0)。
 * ★ 同行の判定は **サービスコード** ([[payroll_doukou_by_service_not_flag]])。
 *
 * ── 2026-09-30 の実測 ────────────────────────────────────────────────────
 *   202512  553/567   202601  548/565   202608  572/576
 *   ★ ずれは事業所に固まる: ちはら台 202601 (5 名 3,435分) / 四街道 202512 (8 名 755分) /
 *     八千代 202601 (2 名 1,380分) / いわね 202608 (1 名 585分)
 *
 * ── この検査が見ていないもの ──────────────────────────────────────────────
 *   ・② (支払用シート) との突合 … ★ 202512/202601 は ② が 0 行なので測れない
 *   ・出勤時間・残業 (→ check:soukatsu-time / check:overtime-minutes)
 *   ・日別のどこがずれているか (→ check:legacy-daily-diff。★ 旧システムの日別が要る)
 *   ・★ どちらが正しいか。★ ① が正とは限らない ([[payroll_layer1_total_is_not_authoritative]])
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { restAll, normEmpNo } from "./_rest.mjs";
import { isAccompaniedRecord, isCareRecord, parseDurationMinutes } from "../src/lib/payroll/payroll-calc.js";
import { soukatsuMinutes } from "../src/lib/payroll/soukatsu-time.js";

const UPDATE = process.argv.includes("--update");
const BASELINE = new URL("./check-visit-time-l1-baseline.json", import.meta.url);
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };

type L1Row = { office_number: string; employee_number: string; employee_name: string; sheet_kind: string; row_data: Record<string, unknown> };
type Rec = { office_number: string; processing_month: string; employee_number: string; calc_duration: string; service_code: string; accompanied_visit: string | null; service_type: string | null };

const fmt = (n: number) => `${n < 0 ? "-" : ""}${Math.floor(Math.abs(n) / 60)}:${String(Math.abs(n) % 60).padStart(2, "0")}`;

async function main() {
  console.log("=== check:visit-time-l1 (月の訪問時間を ① と突合) 2026-09-30 新設・読み取り専用 ===");
  console.log("★ check:all には入れていない (① の写しの dir が要る診断系)");
  const dir = process.env.SOUKATSU1_DIR;
  if (!dir) { console.log("★ SOUKATSU1_DIR=<① の抽出物のある dir> が要る"); process.exit(1); }
  const files = readdirSync(dir).filter((f) => /^soukatsu_extract_\d{6}\.json$/.test(f)).sort();
  if (!files.length) { console.log(`★ ${dir} に soukatsu_extract_YYYYMM.json が 1 本もない (0 件と出さない)`); process.exit(1); }
  const months = files.map((f) => /_(\d{6})\.json$/.exec(f)![1]);
  console.log(`① の写しがある月 ${months.join(",")}`);

  const recs = await restAll<Rec>(`payroll_service_records?select=id,office_number,employee_number,processing_month,calc_duration,service_code,accompanied_visit,service_type&processing_month=in.(${months.join(",")})`);
  console.log(`実績 ${recs.length} 行`);
  /** 当方の集計。mode で わざと壊して 負のコントロールにする */
  const sum = (mode: "正" | "同行を旗で除く" | "1440を切らない" | "会議も入れる") => {
    const care = new Map<string, number>(), dou = new Map<string, number>();
    for (const r of recs) {
      if (mode !== "会議も入れる" && !isCareRecord(r)) continue;
      const min = mode === "1440を切らない"
        ? (() => { const m = /^(\d+):(\d+)/.exec(String(r.calc_duration ?? "").trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; })()
        : parseDurationMinutes(r.calc_duration);
      const isDou = mode === "同行を旗で除く" ? !!r.accompanied_visit && r.accompanied_visit.trim() !== "" : isAccompaniedRecord(r);
      const k = `${r.office_number}|${normEmpNo(r.employee_number)}|${r.processing_month}`;
      const t = isDou ? dou : care;
      t.set(k, (t.get(k) ?? 0) + min);
    }
    return { care, dou };
  };
  const l1 = new Map<string, L1Row>();
  for (const [i, f] of files.entries()) for (const r of JSON.parse(readFileSync(join(dir, f), "utf8")) as L1Row[]) {
    const k = `${r.office_number}|${normEmpNo(r.employee_number)}|${months[i]}`;
    if (!l1.has(k)) l1.set(k, r);   // ① の写しの重複行は 先に出たほうを使う (他の検査と同じ)
  }
  const offices = await restAll<{ office_number: string; office_id: string }>("payroll_offices?select=id,office_number,office_id");
  const offNames = new Map((await restAll<{ id: string; name: string }>("offices?select=id,name")).map((o) => [o.id, o.name]));
  const nameOf = (on: string) => offNames.get(offices.find((o) => o.office_number === on)?.office_id ?? "") ?? on;

  /** ① と比べる。戻り値は 不一致の人月数 */
  const compare = (mode: Parameters<typeof sum>[0], verbose: boolean) => {
    const { care, dou } = sum(mode);
    let n = 0, ok = 0, okDou = 0, nDou = 0;
    const byOff = new Map<string, { n: number; ok: number; diffs: { emp: string; name: string; d: number }[] }>();
    for (const [k, r] of l1) {
      const i1 = soukatsuMinutes(r.row_data["訪介実績時間"], "minutes");
      const ours = care.get(k) ?? 0;
      if (i1 != null && !(ours === 0 && i1 === 0)) {
        n++;
        const hit = ours === i1;
        if (hit) ok++;
        const v = byOff.get(r.office_number) ?? { n: 0, ok: 0, diffs: [] };
        v.n++; if (hit) v.ok++; else v.diffs.push({ emp: normEmpNo(r.employee_number), name: r.employee_name, d: ours - i1 });
        byOff.set(r.office_number, v);
      }
      const i1d = soukatsuMinutes(r.row_data["訪介同行時間"], "minutes");
      const oursD = dou.get(k) ?? 0;
      if (i1d != null && !(oursD === 0 && i1d === 0)) { nDou++; if (oursD === i1d) okDou++; }
    }
    if (verbose) {
      const byMonth = new Map<string, { n: number; ok: number }>();
      for (const [k, r] of l1) {
        const i1 = soukatsuMinutes(r.row_data["訪介実績時間"], "minutes"); if (i1 == null) continue;
        const ours = care.get(k) ?? 0; if (ours === 0 && i1 === 0) continue;
        const m = k.split("|")[2];
        const v = byMonth.get(m) ?? { n: 0, ok: 0 }; v.n++; if (ours === i1) v.ok++; byMonth.set(m, v);
        void r;
      }
      console.log("\n--- 月ごと (訪介実績時間)");
      for (const [m, v] of [...byMonth].sort()) console.log(`    ${m}  一致 ${v.ok}/${v.n}`);
      console.log(`\n--- 事業所ごと (ずれのある事業所だけ)`);
      for (const [on, v] of [...byOff].sort((a, b) => b[1].diffs.reduce((s, x) => s + Math.abs(x.d), 0) - a[1].diffs.reduce((s, x) => s + Math.abs(x.d), 0))) {
        if (!v.diffs.length) continue;
        console.log(`    ${on} ${nameOf(on).padEnd(22)} 一致 ${v.ok}/${v.n}  ずれ合計 ${fmt(v.diffs.reduce((s, x) => s + Math.abs(x.d), 0))}`);
        for (const x of v.diffs.sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 5)) console.log(`         ${x.emp} ${x.name} ${x.d > 0 ? "+" : ""}${fmt(x.d)} (${x.d}分)`);
        if (v.diffs.length > 5) console.log(`         … ほか ${v.diffs.length - 5} 名`);
      }
      console.log(`\n    訪介実績時間 一致 ${ok}/${n}   訪介同行時間 一致 ${okDou}/${nDou}`);
    }
    return { bad: n - ok, badDou: nDou - okDou, n };
  };

  const main0 = compare("正", true);

  console.log("\n--- 負のコントロール (わざと壊して 差が増えることを確かめる)");
  for (const mode of ["同行を旗で除く", "1440を切らない"] as const) {
    const w = compare(mode, false);
    expect(w.bad > main0.bad, `${mode} にすると 訪介実績時間の不一致が増える (${main0.bad} → ${w.bad})`);
  }
  // ★ 会議・面談を入れる制御は **この月に 非介護の行がほとんど無い**ので空振りする。
  //   ★ 空振りを PASS と言わない (2026-09-30 に 35 → 35 なのに o が出た)
  const nonCare = recs.filter((r) => !isCareRecord(r)).length;
  const w3 = compare("会議も入れる", false);
  if (w3.bad > main0.bad) expect(true, `会議も入れる にすると 不一致が増える (${main0.bad} → ${w3.bad}) / 非介護 ${nonCare} 行`);
  else console.log(`  ・★ 「会議も入れる」制御は 効いていない (${main0.bad} → ${w3.bad})。★ 対象月の 非介護の行が ${nonCare} 行しか無いため。★ 合否には数えない`);

  const counts: Record<string, number> = { "訪介実績時間が違う人月": main0.bad, "訪介同行時間が違う人月": main0.badDou };
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
      if (b == null) { console.log(`  ・${k} = ${v} (基準値なし)`); continue; }
      if (v > b) expect(false, `${k} が基準値から増えた (${v} > ${b})`);
      else console.log(`  o ${k} = ${v} (基準値 ${b})`);
    }
  }
  console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS (★ 0 件 PASS ではない。基準値の件数を許容したうえでの PASS)");
  process.exit(fail ? 1 : 0);
}
await main();
