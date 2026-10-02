/**
 * check:overtime-by-month — 月給者の **残業の分数** が ② とどれだけ合うかを **月ごと**に出す。★ 読み取り専用 (2026-10-02 新設)
 *
 *   npm run check:overtime-by-month
 *   PAYROLL_ENV=staging npm run check:overtime-by-month
 *   npm run check:overtime-by-month -- --update      ★ 良くなったときだけ
 *
 * ── なぜ月ごとに出すのか ──────────────────────────────────────────────────
 * ★ 当方は 提責の残業を **旧システムの日別** (`payroll_legacy_daily.overtime_min`) で上書きする
 *   (事務員だけ 出勤簿を優先。c2ab0fb)。★ ところが 旧の日別は **202603〜202607 までしか無い**。
 *   → ★ **202608 は 出勤簿だけで出している。= 移行後に起きることの予行演習**。
 *
 * ★ 2026-10-02 の実測。★ 202608 だけ 一致率が半分以下に落ちる:
 * ```
 *   月      人月  残業の一致   出勤時間の一致   金額に出る人月  金額差
 *   202603   219    84.5%        90.4%           15      ¥ 51,878
 *   202604   222    75.7%        80.6%           12      ¥ 56,899
 *   202605   221    84.2%        91.9%           11      ¥ 60,846
 *   202606   220    80.5%        86.4%           11      ¥ 95,778
 *   202607   219    61.6%        73.5%           35      ¥ 50,345
 *   202608   216  ★ 38.0%        88.0%        ★ 55      ¥252,456   ← 旧の日別が無い
 * ```
 * ★ **出勤時間は 88.0% で他の月と変わらない。**★ 落ちているのは 残業の分数だけ。
 *   = 時間は取れていて、★ **残業の出し方**が 旧データ抜きでは ② を再現できない。
 *   ★ 向きも一方向: 202608 は 当方が少ない 122 人月 / 多い 12 人月。
 *   ★ 旧の日別は 出勤簿の外の訪問・移動まで数えるので、訪問に出る提責では 出勤簿だけだと足りない。
 *
 * → ★ **移行までに決めること**: 提責の残業を 出勤簿 + 訪問・移動 から出すのか、
 *   出勤簿だけで良しとするのか。★ 今の実装のままだと 移行後は毎月 202608 の状態になる。
 *
 * ── この検査が見ていないもの ──────────────────────────────────────────────
 *   ・★ 金額そのもの。「金額差」は ② と同じ式 (max(0, 残業代 − 固定残業代)、提責・管理者は 0) で
 *     出した **目安**で、社員の「120h以上+深夜」を引く段を入れていないので **過大に出る**
 *     (本物の残差は → check:verification-verdicts の 残業総額)
 *   ・パート行 (② の「残業」列が 円なので 分で比べられない)
 *   ・分数のどちらが正しいか。★ ここは 一致するかだけを見る
 *
 * ⚠ ★ 当方の値は `payroll_calc_results` の payload から読む (= 旧システムの上書きを通った後の値)。
 *   ★ `computeSummary` を直接呼ぶと **上書きを通らず** 別の数字になる
 *   ([[feedback_check_same_input_as_calc]] / 2026-10-02 に実際に踏んだ)。
 *   ⚠ そのぶん **再計算していない事業所月は古い** ([[payroll_payload_check_logic_goes_stale]])。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { restAll, normEmpNo, SB_REF } from "./_rest.mjs";

const UPDATE = process.argv.includes("--update");
const BASELINE = "scripts/check-overtime-by-month-baseline.json";
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);

type Calc = { office_number: string; processing_month: string; payload: { monthly?: { employee_number: string; summary?: { overtimeMinutes?: number; workHoursMin?: number } }[] } };
type Souk = { office_number: string; processing_month: string; employee_number: string; row_data: Record<string, unknown> };

let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };

async function main() {
  console.log("=== check:overtime-by-month (残業の分数が ② と合うか・月ごと) 2026-10-02 新設・読み取り専用 ===");

  const legMonths = new Map<string, number>();
  for (const r of await restAll<{ processing_month: string }>("payroll_legacy_daily?select=processing_month"))
    legMonths.set(r.processing_month, (legMonths.get(r.processing_month) ?? 0) + 1);

  const souk = await restAll<Souk>("payroll_soukatsu_rows?select=office_number,processing_month,employee_number,row_data");
  const sOf = new Map(souk.map((s) => [`${s.office_number}|${normEmpNo(s.employee_number)}|${s.processing_month}`, s.row_data]));
  const emps = await restAll<{ employee_number: string; role_type: string; office_id: string }>("payroll_employees?select=employee_number,role_type,office_id");
  const po = await restAll<{ id: string; office_number: string }>("payroll_offices?select=id,office_number");
  const bnOf = new Map(po.map((o) => [o.id, o.office_number]));
  const roleOf = new Map(emps.map((e) => [`${bnOf.get(e.office_id)}|${normEmpNo(e.employee_number)}`, e.role_type]));
  const appSet = await restAll<{ key: string; value: Record<string, string[]> }>("payroll_app_settings?select=key,value&key=eq.overtime_excess_paid_employees&order=key");
  const excessPaid = new Set<string>();
  for (const [bn, nos] of Object.entries(appSet[0]?.value ?? {})) for (const no of nos) excessPaid.add(`${bn}|${normEmpNo(no)}`);
  const NO_EXCESS = new Set(["提責", "管理者"]);
  /** ② と同じ式で 残業総額を出す (社員の「120h以上+深夜」は入れていないので 目安) */
  const pay = (min: number, d: Record<string, unknown>, key: string, role: string) =>
    NO_EXCESS.has(role) && !excessPaid.has(key) ? 0
      : Math.max(0, Math.round((min / 60) * num(d["残業単価"])) - num(d["固定残業代"]));

  const calc = await restAll<Calc>("payroll_calc_results?select=office_number,processing_month,payload");
  type Row = { n: number; same: number; over: number; under: number; absMin: number; yen: number; yenN: number; wSame: number };
  const stat = new Map<string, Row>();
  for (const c of calc) {
    for (const e of (c.payload?.monthly ?? [])) {
      const n = normEmpNo(String(e.employee_number ?? ""));
      const d = sOf.get(`${c.office_number}|${n}|${c.processing_month}`);
      if (!d || !num(d["残業単価"])) continue;              // ★ 単価が無い = パート行。分母から外す
      const k = c.processing_month;
      if (!stat.has(k)) stat.set(k, { n: 0, same: 0, over: 0, under: 0, absMin: 0, yen: 0, yenN: 0, wSame: 0 });
      const s = stat.get(k)!;
      const ours = num(e.summary?.overtimeMinutes), theirs = num(d["残業"]);
      const ek = `${c.office_number}|${n}`, role = roleOf.get(ek) ?? "?";
      s.n++;
      if (num(e.summary?.workHoursMin) === num(d["出勤時間"])) s.wSame++;
      if (ours === theirs) s.same++;
      else { if (ours > theirs) s.over++; else s.under++; s.absMin += Math.abs(ours - theirs); }
      const dy = pay(ours, d, ek, role) - pay(theirs, d, ek, role);
      if (dy !== 0) { s.yen += Math.abs(dy); s.yenN++; }
    }
  }

  console.log(`  [${SB_REF}]  ★ 旧システムの日別がある月: ${[...legMonths.keys()].sort().join(" / ")}`);
  console.log("\n  月      人月  残業の一致     出勤時間の一致   当方が多い/少ない  分の差    金額に出る人月  金額差(目安)  旧の日別");
  const pct: Record<string, number> = {};
  for (const [m, s] of [...stat].sort()) {
    pct[m] = Math.round((s.same / s.n) * 1000) / 10;
    console.log(`  ${m}  ${String(s.n).padStart(5)}  ${String(s.same).padStart(4)}/${s.n} = ${String(pct[m]).padStart(5)}%` +
      `  ${String(s.wSame).padStart(4)}/${s.n} = ${((s.wSame / s.n) * 100).toFixed(1).padStart(5)}%` +
      `  ${String(s.over).padStart(5)} / ${String(s.under).padStart(5)}  ${String(s.absMin).padStart(7)}` +
      `  ${String(s.yenN).padStart(10)}  ¥${s.yen.toLocaleString().padStart(9)}  ${legMonths.has(m) ? `${legMonths.get(m)!.toLocaleString()} 行` : "★ 無し"}`);
  }

  console.log("\n--- 旧の日別が ある月 / 無い月");
  const withLeg = [...stat].filter(([m]) => legMonths.has(m));
  const noLeg = [...stat].filter(([m]) => !legMonths.has(m));
  const rate = (xs: [string, Row][]) => {
    const n = xs.reduce((a, [, s]) => a + s.n, 0), ok = xs.reduce((a, [, s]) => a + s.same, 0);
    return n ? { n, ok, p: (ok / n) * 100 } : { n: 0, ok: 0, p: 0 };
  };
  const a = rate(withLeg), b = rate(noLeg);
  console.log(`  ある月 ${withLeg.map(([m]) => m).join(",")}  ${a.ok}/${a.n} = ${a.p.toFixed(1)}%`);
  console.log(`  無い月 ${noLeg.map(([m]) => m).join(",")}  ${b.ok}/${b.n} = ${b.p.toFixed(1)}%   ★ これが **移行後の姿**`);

  console.log("\n--- 負のコントロール (この検査が何を言っているかの確認)");
  expect(noLeg.length > 0, `★ 旧の日別が無い月が 実在する (${noLeg.map(([m]) => m).join(",") || "なし"})`);
  expect(b.p < a.p, `★ 無い月のほうが 一致率が低い (${b.p.toFixed(1)}% < ${a.p.toFixed(1)}%) = 旧の日別に依存している`);
  const wNo = noLeg.reduce((s, [, x]) => s + x.wSame, 0), wNoN = noLeg.reduce((s, [, x]) => s + x.n, 0);
  expect(wNoN > 0 && (wNo / wNoN) * 100 > b.p + 20,
    `★ 無い月でも **出勤時間**は合っている (${((wNo / wNoN) * 100).toFixed(1)}% ≫ 残業 ${b.p.toFixed(1)}%) = 落ちているのは残業の出し方だけ`);

  console.log("\n--- 基準値 (月ごとの一致率。★ 下がったら落ちる)");
  const cur = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) as { _readme: string[]; pct: Record<string, number> } : { _readme: [], pct };
  if (UPDATE) {
    cur.pct = pct;
    writeFileSync(BASELINE, JSON.stringify(cur, null, 2) + "\n", "utf8");
    console.log(`  基準値を更新しました ${JSON.stringify(pct)}`);
  } else {
    for (const [m, p] of Object.entries(pct)) {
      const base = cur.pct[m];
      if (base == null) { console.log(`  ・${m} は基準値に無い (新しい月)。${p}%`); continue; }
      expect(p >= base - 0.05, `${m} ${p}% (基準値 ${base}%)`);
    }
  }
  console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS (★ 一致率を許容したうえでの PASS。★ 0 件 PASS ではない)");
  process.exit(fail ? 1 : 0);
}

await main();
