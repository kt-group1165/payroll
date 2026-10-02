/**
 * check:attendance-coverage — ★ 働いているのに **出勤簿を 1 日も出していない月給者** を数える。読み取り専用 (2026-10-02 新設)
 *
 *   npm run check:attendance-coverage
 *   PAYROLL_ENV=staging npm run check:attendance-coverage
 *   npm run check:attendance-coverage -- --update      ★ 減ったときだけ
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────────
 * ★ 移行後 (旧システムの日別が消えたあと)、月給者の残業は **出勤簿からしか出せない**。
 *   → ★ 「働いているのに 出勤簿が 1 日も無い人月」は そのまま 残業 0 になる。
 *
 * ★ 2026-10-02 実測。★ 出勤簿を出す役職 (提責・事務員・管理者) に絞ると:
 * ```
 *   分母 (その月に訪問実績がある) 753 人月 … ★ 出勤簿が 1 日も無い 195 人月 (25.9%)
 *   月別  202512 93 / 202601 87 / ★ 202603〜08 は 1・2・1・2・4・5 = **15 人月だけ**
 *   → ★ 突合している 202603〜08 では 出勤簿は ほぼ揃っている。欠けは 古い 2 か月に偏る
 * ```
 * ⚠ ★ 社員 803 人月・パート 16 人月は **出勤簿を出す役職ではない**ので 分母に入れない
 *   ([[feedback_payroll_staff_presence_and_attendance_rules]] /
 *    [[feedback_structural_absence_vs_actual_diff]])。
 *   ★ 混ぜると 1,007 人月 (64.1%) になり 「出勤簿が足りない」と誤読する。実際に足りないのは 15 人月。
 *
 * ── ★ 2026-10-02 の総当たり: 「訪問・移動を足せば ② に近づく」は **棄却** ─────────
 * 202603〜07 の 旧の日別 21,071 日で、★ 旧の `work_min` を 当方のデータから作れるか 13 通り試した:
 * ```
 *   ★ 出勤簿がある日 10,234 日
 *     G 出勤簿 ∪ 訪問 の和 (休憩を引く)   4,983 (48.7%)  ±15分 62.6%   ★ 最良
 *     A 出勤簿の実働 (いまの実装)          4,982 (48.7%)  ±15分 62.5%   ★ ほぼ同じ
 *     K 出勤簿の実働 + 旧 travel         4,121 (40.3%)  ±15分 56.2%   ★ 足すと **悪化**
 *     F max(出勤簿の実働, 訪問の拘束)      3,299 (32.2%)
 *   出勤簿が無い日 10,837 日 … 当方のデータだけでは 5.0% (旧 travel を使えば 99%)
 * ```
 * → ★ **訪問や移動を足しても ほとんど改善しない** (48.7% → 48.7%)。
 *   ★ 旧の `work_min` は 出勤簿・訪問・移動のどの組み合わせでも再現できない。
 * → ★ 残業の差の本体は 提責。202608 (旧なし) で 80 人月ずれており、★ **78/80 は出勤簿がある**。
 *   = ★ データ不足ではなく **「何時間働いたとみなすか」の定義が ② と違う**。
 *
 * ── `check:attendance-sparse` との違い ────────────────────────────────────
 *   あちら … ★ 事業所の中で **急に減った月**を見る (行はあるが時刻が空、等)
 *   ★ ここ … ★ **1 日も無い人月**を見る。★ 最初から出していない人は あちらでは挙がらない
 *
 * ── この検査が見ていないもの ──────────────────────────────────────────────
 *   ・時給者 (パート)。★ 出勤簿は 提責と事務員だけ ([[feedback_payroll_staff_presence_and_attendance_rules]])
 *   ・出勤簿の **中身**が正しいか (→ check:attendance-sparse / check:attendance-daily-scan)
 *   ・★ 分母は `payroll_calc_results` の payload。再計算していない事業所月は古い
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { restAll, normEmpNo, SB_REF } from "./_rest.mjs";

const UPDATE = process.argv.includes("--update");
const BASELINE = "scripts/check-attendance-coverage-baseline.json";
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);

type Calc = { office_number: string; processing_month: string; payload: { monthly?: { employee_number: string; employee_name?: string; role_type?: string; summary?: { visitMinutes?: number; workHoursMin?: number } }[] } };

let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };

async function main() {
  console.log("=== check:attendance-coverage (働いているのに出勤簿が 1 日も無い月給者) 2026-10-02 新設・読み取り専用 ===");

  const att = await restAll<{ office_number: string; employee_number: string; year: number; month: number }>("payroll_attendance_records?select=office_number,employee_number,year,month");
  const has = new Set(att.map((a) => `${a.office_number}|${normEmpNo(a.employee_number)}|${a.year}${String(a.month).padStart(2, "0")}`));
  const oName = new Map((await restAll<{ name: string; business_number: string }>("offices?select=name,business_number")).map((o) => [o.business_number, o.name]));
  const calc = await restAll<Calc>("payroll_calc_results?select=office_number,processing_month,payload");

  const SHOULD_HAVE = new Set(["提責", "事務員", "管理者"]);
  type Hit = { off: string; offName: string; m: string; no: string; name: string; role: string; visit: number };
  function measure(mutate?: (k: string) => boolean) {
    const hits: Hit[] = [];
    const other: string[] = [];
    let denom = 0;
    for (const c of calc) {
      for (const e of (c.payload?.monthly ?? [])) {
        // ★ 分母 = その月に **訪問実績がある** 人のうち、★ 出勤簿を出す役職だけ。
        //   ★ 出勤簿は **提責と事務員 (と管理者)** だけ ([[feedback_payroll_staff_presence_and_attendance_rules]])。
        //   ★ 社員・パートを混ぜると 803 人月が乗って 数字が誤解を生む
        //   ([[feedback_structural_absence_vs_actual_diff]])
        if (num(e.summary?.visitMinutes) <= 0) continue;
        const role0 = String(e.role_type ?? "?");
        if (!SHOULD_HAVE.has(role0)) { other.push(role0); continue; }
        denom++;
        const n = normEmpNo(String(e.employee_number ?? ""));
        const k = `${c.office_number}|${n}|${c.processing_month}`;
        if (mutate ? mutate(k) : has.has(k)) continue;
        hits.push({ off: c.office_number, offName: oName.get(c.office_number) ?? c.office_number, m: c.processing_month, no: n, name: String(e.employee_name ?? ""), role: String(e.role_type ?? "?"), visit: num(e.summary?.visitMinutes) });
      }
    }
    return { hits, denom, other };
  }

  const { hits, denom, other } = measure();
  const otherBy = new Map<string, number>();
  for (const r of other) otherBy.set(r, (otherBy.get(r) ?? 0) + 1);
  console.log(`  [${SB_REF}] 分母 = その月に訪問実績がある **提責・事務員・管理者** ${denom} 人月`);
  console.log(`  (参考・分母に入れていない: ${[...otherBy].sort((a, b) => b[1] - a[1]).map(([r, c]) => `${r} ${c}`).join(" / ")} … ★ 出勤簿を出す役職ではない)`);
  console.log(`  ★ 出勤簿が 1 日も無い: ${hits.length} 人月 (${((hits.length / denom) * 100).toFixed(1)}%)`);

  const byOff = new Map<string, number>(), byM = new Map<string, number>(), byRole = new Map<string, number>();
  for (const h of hits) {
    byOff.set(h.offName, (byOff.get(h.offName) ?? 0) + 1);
    byM.set(h.m, (byM.get(h.m) ?? 0) + 1);
    byRole.set(h.role, (byRole.get(h.role) ?? 0) + 1);
  }
  console.log("\n--- 役職別");
  for (const [r, c] of [...byRole].sort((a, b) => b[1] - a[1])) console.log(`  ${String(r).padEnd(8)} ${c} 人月`);
  console.log("\n--- 月別");
  for (const [m, c] of [...byM].sort()) console.log(`  ${m}  ${c} 人月`);
  console.log("\n--- 事業所別 (多い順 15)");
  for (const [o, c] of [...byOff].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${o.slice(0, 26).padEnd(28)} ${c} 人月`);

  console.log("\n--- 負のコントロール (検査が効いていることの確認)");
  const none = measure(() => false);
  expect(none.hits.length === none.denom, `★ 出勤簿を 1 件も無いことにすると 分母と同じになる (${none.hits.length} = ${none.denom})`);
  const allHave = measure(() => true);
  expect(allHave.hits.length === 0, `★ 全員にあることにすると 0 件になる (${allHave.hits.length})`);
  expect(denom > 0, `★ 分母が 0 でない (${denom})。★ 0 なら この検査は何も言っていない`);

  console.log("\n--- 基準値");
  const cur = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) as { _readme: string[]; count: number } : { _readme: [], count: hits.length };
  if (UPDATE) {
    cur.count = hits.length;
    writeFileSync(BASELINE, JSON.stringify(cur, null, 2) + "\n", "utf8");
    console.log(`  基準値を ${hits.length} 人月に更新しました`);
  } else if (hits.length > cur.count) { console.log(`  ★ FAIL 基準値から増えた (${hits.length} > ${cur.count})`); fail++; }
  else console.log(`  o ${hits.length} 人月 (基準値 ${cur.count})${hits.length < cur.count ? "  ★ 減っています。-- --update で下げてください" : ""}`);

  console.log("\n⚠ ★ 202603〜08 の欠けは 15 人月だけ。★ 残業の差の原因は 出勤簿の不足ではない (ヘッダの総当たりを参照)");
  console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS (★ 0 件 PASS ではない。件数を許容したうえでの PASS)");
  process.exit(fail ? 1 : 0);
}

await main();
