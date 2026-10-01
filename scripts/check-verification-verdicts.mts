/**
 * check:verification-verdicts — ② との不一致を **既に「許容」と決めた分** と **本当に未解明** に分ける。★ 基準値方式・読み取り専用。
 *
 *   npm run check:verification-verdicts
 *   npm run check:verification-verdicts -- --update
 *   ITEM=残業総額 npm run check:verification-verdicts     … その項目の明細を出す
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────────
 * `check:soukatsu-cause` は 総支給の差を 原因の型 (A/B/C/PZ/SZ…) に分けるが、
 * ★ 「その差が **すでに user と合意した許容差** なのか」は見ていない。
 * 合意は `src/lib/payroll/soukatsu-diff.ts` の RULES にコード化されていて、★ 画面 (/verification) だけが使う。
 * → ★ 画面を 182 事業所月ぶん開かないと 「残作業が何件か」が分からなかった。
 *
 * 2026-09-30 に これを作る動機になった実例:
 *   残業総額の差 44 人月 (¥215,743) を「当方の残業が違う」と読んで追いかけたが、
 *   ★ soukatsu-diff には 2026-09-23 に user が決めた許容規則が既に入っていた
 *   (「出勤簿の 勤務時間の欄 と 終了−開始−休憩 が食い違う人は 当システムの時刻を正とする」)。
 *   ★ 追う前に 許容かどうかを見るべきだった。
 *
 * ── 何を出すか ────────────────────────────────────────────────────────────
 *   項目 × 判定 (許容 / 要対応 / 参考 …) の人月と金額。★ 判定は 画面と同じ関数 (judgeItem/diffItems)。
 *   ★ 逐語コピーはしない。verificationItems / diffItems / pickSoukatsu を import する
 *   ([[feedback_test_verbatim_copy_and_wrong_expectation]])。
 *
 * ── この検査が見ていないもの ──────────────────────────────────────────────
 *   ・総支給の一致率そのもの (→ check:soukatsu-cause)
 *   ・① (旧システムの出力) … ここは ② だけを見る。★ ①② のどちらが正かは別の話
 *   ・片側にしか居ない人月 (→ check:soukatsu-match)
 *   ・許容規則そのものの妥当性。★ 規則が甘いと 残作業が過少に見える (だから件数を基準値で見張る)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { restAll, normEmpNo } from "./_rest.mjs";
import { diffItems, pickSoukatsu, type DiffContext, type DiffVerdict } from "../src/lib/payroll/soukatsu-diff.js";
import { verificationItems } from "../src/lib/payroll/verification-items.js";
import { attendanceWorkMinutes, parseWorkHoursMinutes, type OvertimeSetting } from "../src/lib/payroll/payroll-calc.js";

const UPDATE = process.argv.includes("--update");
const ITEM = process.env.ITEM ?? "";
/** ★ 1 人を追うとき: EMP="<事業所番号>|<社員番号>" で その人の **全項目** を出す */
const EMP = process.env.EMP ?? "";
const BASELINE = new URL("./check-verification-verdicts-baseline.json", import.meta.url);
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };

/**
 * 要確認 を **状況** で分ける (診断だけ。判定規則は変えない)。
 * ★ 順序が大事。★ 「原因として意味のあるもの」を先に、★ 意味のないものは最後に置く。
 *   ★ 最初に noAttendance を置くと パートの差が全部そこに吸われて 分布が見えなくなる (2026-09-30 に踏んだ)
 * ★ hasSubstitute = その項目の代わりになる 月ごとの手入力があるか。あるなら 出勤簿の不在は原因ではない
 */
function classifySituation(d: { item: string; ours: number; soukatsu: number; diff: number }, ctx: DiffContext,
  shouldHaveAtt: boolean, hasSubstitute: boolean): string {
  if (ctx.noAttendance && shouldHaveAtt && !hasSubstitute) return "★ 出勤簿が無い (提責・事務員は あるべき)";
  if (ctx.officeFormEmpty) return "事業所書式が 1 行も無い";
  if (ctx.hasRateGap) return "単価が引けず 0 円の訪問がある";
  if (Math.abs(d.ours) === 0) return "当方が 0 (②だけ払っている)";
  if (Math.abs(d.soukatsu) === 0) return "② が 0 (当方だけ払っている)";
  if (Math.abs(d.diff) <= 60) return "差が 60 以内 (端数・休憩の取り方の疑い)";
  const r = Math.abs(d.diff) / Math.max(Math.abs(d.soukatsu), 1);
  return r <= 0.02 ? "差が 2% 以内" : r <= 0.1 ? "差が 10% 以内" : "★ 差が 10% 超";
}

type Calc = { office_number: string; processing_month: string; payload: Record<string, unknown> };
type Souk = { office_number: string; processing_month: string; employee_number: string; sheet_kind: string; row_data: Record<string, unknown> };
type Emp = { employee_number: string; office_id: string; role_type: string | null; is_office_worker: boolean | null };
type Att = Record<string, unknown> & { employee_number: string; office_number: string; year: number; month: number; work_hours: string | null };
type OFR = { office_number: string; processing_month: string };
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);

async function main() {
  console.log("=== check:verification-verdicts (② との差を 許容 / 要対応 に分ける) 2026-09-30 新設・読み取り専用 ===");
  console.log("★ check:all には入れていない (許容規則は user の判断で動くため。診断系)");

  const calc = await restAll<Calc>("payroll_calc_results?select=id,office_number,processing_month,payload");
  const souk = await restAll<Souk>("payroll_soukatsu_rows?select=id,office_number,processing_month,employee_number,sheet_kind,row_data");
  const pofs = await restAll<{ id: string; office_number: string }>("payroll_offices?select=id,office_number");
  const offNumOf = new Map(pofs.map((o) => [o.id, o.office_number]));
  const emps = await restAll<Emp>("payroll_employees?select=id,employee_number,office_id,role_type,is_office_worker");
  // ★ 出勤簿は year / month 列 (processing_month でない) ・日の中の 5 区間。★ 画面と同じ列を読む
  const att = await restAll<Att>("payroll_attendance_records?select=id,employee_number,office_number,year,month,work_hours,break_time,start_time_1,end_time_1,start_time_2,end_time_2,start_time_3,end_time_3,start_time_4,end_time_4,start_time_5,end_time_5");
  const ofr = await restAll<OFR>("payroll_office_form_records?select=id,office_number,processing_month");
  const ofrHas = new Set(ofr.map((r) => `${r.office_number}|${r.processing_month}`));
  // ★ 出勤簿が無くても **月ごとの手入力が代わりになる**項目がある (2026-10-01 に踏んだ)。
  //   実例: 五井 加瀬真紀江 は 202603〜08 の 6 か月とも 出勤簿が 1 件も無いが、
  //   ★ overtime_minutes が手入力されている 5 か月は 残業総額が ② と完全一致していて 差が無い。
  //   → ★ 「出勤簿が無い」を原因として出してよいのは **その項目の代わりになる手入力も無いとき だけ**。
  //   ★ これを分けないと「出勤簿を書き写せば直る件数」を 何倍にも見積もる (実際に 1 度やった)。
  const mi = await restAll<{ office_number: string; processing_month: string; employee_number: string; item_key: string; numeric_value: number | null }>(
    "payroll_monthly_inputs?select=id,office_number,processing_month,employee_number,item_key,numeric_value&item_key=in.(office_work_minutes,overtime_minutes,commute_yen)");
  const manualOf = new Set(mi.filter((r) => Number(r.numeric_value ?? 0) > 0)
    .map((r) => `${r.office_number}|${r.processing_month}|${normEmpNo(r.employee_number)}|${r.item_key}`));
  /** その項目の「出勤簿の代わりになる手入力」のキー。★ 無い項目は 出勤簿でしか埋まらない */
  const MANUAL_SUBSTITUTE: Record<string, string> = { 残業総額: "overtime_minutes", 出勤時間: "office_work_minutes", 通勤費: "commute_yen" };
  console.log(`計算結果 ${calc.length} 事業所月 / ② ${souk.length} 行 / 出勤簿 ${att.length} 行 / 事業所書式のある事業所月 ${ofrHas.size}`);

  const soukOf = new Map(souk.map((s) => [`${s.office_number}|${s.processing_month}|${normEmpNo(s.employee_number)}|${s.sheet_kind}`, s]));
  const roleOf = new Map(emps.map((e) => [`${offNumOf.get(e.office_id) ?? "?"}|${normEmpNo(e.employee_number)}`, String(e.role_type ?? "")]));
  const officeWorker = new Set(emps.filter((e) => e.is_office_worker).map((e) => `${offNumOf.get(e.office_id) ?? "?"}|${normEmpNo(e.employee_number)}`));
  // 出勤簿の「欄」と「時刻」の食い違い (分)。★ 画面と同じ関数で出す
  const gapOf = new Map<string, number>(), hasAtt = new Set<string>();
  for (const r of att) {
    const k = `${r.office_number}|${String(r.year)}${String(r.month).padStart(2, "0")}|${normEmpNo(r.employee_number)}`;
    hasAtt.add(k);
    const fromTimes = attendanceWorkMinutes(r as never);
    const fromColumn = parseWorkHoursMinutes(String(r.work_hours ?? ""));
    if (fromTimes > 0 && fromTimes !== fromColumn) gapOf.set(k, (gapOf.get(k) ?? 0) + (fromTimes - fromColumn));
  }

  type Cell = { n: number; yen: number };
  const byItem = new Map<string, Map<DiffVerdict, Cell>>();
  const detail: string[] = [];
  let pairs = 0, withDiff = 0;
  const reasonOf = new Map<string, Map<string, number>>();
  /** 要確認 の状況別内訳 (診断用。判定規則とは別) */
  const sitOf = new Map<string, Map<string, number>>();
  /** 要確認 × 総支給が一致しているか (金額に出ているか) */
  const tmOf = new Map<string, Map<string, { n: number; yen: number }>>();
  /** ★ ② が他事業所の兼務を表示している行 (比べられない) */
  const kenmuOf = new Map<string, { n: number; yen: number }>();
  let kenmuRows = 0;

  for (const c of calc) {
    const p = c.payload ?? {};
    const otMap = new Map(((p.overtime_settings ?? []) as OvertimeSetting[]).map((r) => [r.job_type, r]));
    const officeFormEmpty = !ofrHas.has(`${c.office_number}|${c.processing_month}`);
    for (const [kind, list] of [["part", (p.hourly ?? []) as Record<string, unknown>[]], ["shaseki", (p.monthly ?? []) as Record<string, unknown>[]]] as const) {
      for (const e of list) {
        const n = normEmpNo(String(e.employee_number ?? ""));
        const s = soukOf.get(`${c.office_number}|${c.processing_month}|${n}|${kind}`);
        if (!s) continue;
        pairs++;
        const ek = `${c.office_number}|${n}`;
        const ctx: DiffContext = {
          roleType: roleOf.get(ek) ?? String(e.role_type ?? ""),
          attendanceGapMinutes: gapOf.get(`${c.office_number}|${c.processing_month}|${n}`) ?? 0,
          noAttendance: !hasAtt.has(`${c.office_number}|${c.processing_month}|${n}`),
          hasRateGap: num(e.unmappedCount) > 0,
          isOfficeWorker: officeWorker.has(ek),
          officeNumber: c.office_number,
          officeFormEmpty,
          adjustmentFolded: pickSoukatsu(s.row_data, "調整手当") !== 0,
          soukatsuGosa: pickSoukatsu(s.row_data, "誤差"),
          // ★ KNOWN_DIFFS (1 件ずつ user が許容と判断した差) の照合に使う
          processingMonth: c.processing_month,
          employeeNumber: n,
        };
        const { items } = verificationItems(e, kind, otMap, s.row_data);
        const ds = diffItems(items, ctx);
        // ★ ② の氏名に「_<事業所名>」が付いた行は **他事業所の兼務の表示**で、
        //   ★ ② の額は「この事業所で払った額」ではない。★ 比べられないので 要確認 に数えない
        //   (check:soukatsu-cause の 型 KX と同じ判定。2026-10-01 に ここにも入れた)
        //   ⚠ 入れる前は 本人給の要確認 ¥990,126 のうち ★ ¥711k (72%) が この 2 名だった
        //     (花見川 松元綾子 6 人月 / さつきが丘 本郷美江 6 人月)。★ 残作業を大きく見せていた
        // ⚠ 接尾辞は **② の氏名** に付く (当方の payload の氏名には付かない)。2026-10-01 に 1 度間違えた
        if (/[_＿]/.test(String(s.row_data["氏名"] ?? ""))) {
          for (const d of ds) {
            const c2 = kenmuOf.get(d.item) ?? { n: 0, yen: 0 };
            c2.n++; c2.yen += Math.abs(d.diff); kenmuOf.set(d.item, c2);
          }
          kenmuRows++;
          continue;
        }
        if (ds.length) withDiff++;
        // ★ 総支給が一致している人月の 項目差は **相殺されていて金額に出ない**。優先度が違うので分ける
        //   (2026-10-01 追加。★ これを混ぜると「¥6.88M の要確認」が 実際は金額に出ていない分を含む)
        const totalMatched = !ds.some((x) => x.item === "総支給額");
        for (const d of ds) {
          if (!byItem.has(d.item)) byItem.set(d.item, new Map());
          const m = byItem.get(d.item)!;
          const cell = m.get(d.verdict) ?? { n: 0, yen: 0 };
          cell.n++; cell.yen += Math.abs(d.diff); m.set(d.verdict, cell);
          // ★ 要確認 (理由が分かっていない) を **状況で** 分ける。★ 判定規則は変えない (診断だけ足す)
          if (d.verdict === "要確認") {
            const tk = totalMatched ? "総支給は一致 (相殺されている)" : "★ 総支給も不一致";
            if (!tmOf.has(d.item)) tmOf.set(d.item, new Map());
            const t2 = tmOf.get(d.item)!;
            const cell2 = t2.get(tk) ?? { n: 0, yen: 0 };
            cell2.n++; cell2.yen += Math.abs(d.diff); t2.set(tk, cell2);
          }
          if (d.verdict === "要確認") {
            // ⚠ ★ 出勤簿は **提責・事務員・管理者だけ**が付ける (1 日 1 行)。
            //   ★ パート・社員は 元々無いので「出勤簿が無い」を原因として出すと 誤った宿題になる
            //   (2026-09-30 実測: パート 3,099 人月・社員 831 人月 は 1 件も無く、それが正常)
            const shouldHaveAtt = /提責|事務員|管理者/.test(ctx.roleType) || Boolean(ctx.isOfficeWorker);
            // ★ 順序が大事。★ 「原因として意味のあるもの」を先に、★ 意味のないものは最後に置く。
            //   ★ 最初に noAttendance を置くと パートの差が全部そこに吸われて 分布が見えなくなる (2026-09-30 に踏んだ)
            // ★ その項目の代わりになる手入力があるなら 出勤簿の不在は 原因ではない (上の MANUAL_SUBSTITUTE 参照)
            const subKey = MANUAL_SUBSTITUTE[d.item];
            const hasSubstitute = Boolean(subKey) && manualOf.has(`${c.office_number}|${c.processing_month}|${n}|${subKey}`);
            const sit = classifySituation(d, ctx, shouldHaveAtt, hasSubstitute);
            if (!sitOf.has(d.item)) sitOf.set(d.item, new Map());
            const sm = sitOf.get(d.item)!;
            sm.set(sit, (sm.get(sit) ?? 0) + 1);
          }
          if (d.verdict === "要対応") {
            if (!reasonOf.has(d.item)) reasonOf.set(d.item, new Map());
            const rm = reasonOf.get(d.item)!;
            const key = String(d.reason ?? "(理由なし)");
            rm.set(key, (rm.get(key) ?? 0) + 1);
          }
          if (EMP === `${c.office_number}|${n}`) detail.push(`    ${c.processing_month} ${d.item.padEnd(20)} 当方 ${Math.round(d.ours)} / ② ${Math.round(d.soukatsu)} (差 ${Math.round(d.diff)}) [${d.verdict}] ${d.reason ?? ""}`);
          else if (ITEM && d.item === ITEM) detail.push(`    ${c.processing_month} ${c.office_number} ${n.padStart(6)} ${String(e.employee_name ?? "").replace(/\s+/g, " ").padEnd(12)} ${kind} 当方 ${Math.round(d.ours)} / ② ${Math.round(d.soukatsu)} (差 ${Math.round(d.diff)}) [${d.verdict}] ${d.reason ?? ""}`);
        }
      }
    }
  }

  console.log(`\n② と対になった人月 ${pairs} / ★ 何かの項目がずれている人月 ${withDiff}`);
  const verdicts = [...new Set([...byItem.values()].flatMap((m) => [...m.keys()]))].sort();
  console.log(`\n--- 項目 × 判定 (人月 / 差の絶対値計)`);
  console.log(`  ${"項目".padEnd(24)}${verdicts.map((v) => String(v).padStart(18)).join("")}`);
  const totals = new Map<DiffVerdict, Cell>();
  for (const [item, m] of [...byItem].sort((a, b) => [...b[1].values()].reduce((s, x) => s + x.n, 0) - [...a[1].values()].reduce((s, x) => s + x.n, 0))) {
    const cells = verdicts.map((v) => {
      const c = m.get(v);
      if (c) { const t = totals.get(v) ?? { n: 0, yen: 0 }; t.n += c.n; t.yen += c.yen; totals.set(v, t); }
      return c ? `${c.n}人¥${c.yen.toLocaleString()}`.padStart(18) : "".padStart(18);
    });
    console.log(`  ${item.padEnd(24)}${cells.join("")}`);
  }
  console.log(`  ${"合計".padEnd(24)}${verdicts.map((v) => { const t = totals.get(v); return t ? `${t.n}人¥${t.yen.toLocaleString()}`.padStart(18) : "".padStart(18); }).join("")}`);

  console.log(`\n--- ★ 要対応 の理由の内訳 (= これが残作業)`);
  const needs = [...reasonOf].sort((a, b) => [...b[1].values()].reduce((s, x) => s + x, 0) - [...a[1].values()].reduce((s, x) => s + x, 0));
  if (!needs.length) console.log("    (なし)");
  for (const [item, rm] of needs) {
    console.log(`    ${item} 計 ${[...rm.values()].reduce((s, x) => s + x, 0)} 人月`);
    for (const [r, n2] of [...rm].sort((a, b) => b[1] - a[1])) console.log(`      ${String(n2).padStart(4)} 人月  ${r}`);
  }
  console.log(`
--- ★ ② が他事業所の兼務を表示している行 (氏名に 「_事業所名」が付く)。★ 比べられないので 上の表に入れていない`);
  console.log(`    対象 ${kenmuRows} 人月`);
  for (const [item, c2] of [...kenmuOf].sort((a, b) => b[1].yen - a[1].yen)) console.log(`    ${item.padEnd(22)} ${String(c2.n).padStart(4)} 人月 ¥${Math.round(c2.yen).toLocaleString()}`);

  console.log(`
--- ★ 要確認 × 総支給が一致しているか (★ 一致しているなら 項目差は相殺されて 金額に出ていない)`);
  {
    const a = { n: 0, yen: 0 }, b = { n: 0, yen: 0 };
    for (const [item, t2] of [...tmOf].sort((x, y) => (y[1].get("★ 総支給も不一致")?.n ?? 0) - (x[1].get("★ 総支給も不一致")?.n ?? 0))) {
      const m1 = t2.get("★ 総支給も不一致"), m2 = t2.get("総支給は一致 (相殺されている)");
      if (m1) { a.n += m1.n; a.yen += m1.yen; }
      if (m2) { b.n += m2.n; b.yen += m2.yen; }
      console.log(`    ${item.padEnd(22)} ★ 総支給も不一致 ${String(m1?.n ?? 0).padStart(5)} 人月 ¥${Math.round(m1?.yen ?? 0).toLocaleString().padStart(12)}  /  相殺済 ${String(m2?.n ?? 0).padStart(5)} 人月 ¥${Math.round(m2?.yen ?? 0).toLocaleString().padStart(12)}`);
    }
    console.log(`    ${"合計".padEnd(22)} ★ 総支給も不一致 ${String(a.n).padStart(5)} 人月 ¥${Math.round(a.yen).toLocaleString().padStart(12)}  /  相殺済 ${String(b.n).padStart(5)} 人月 ¥${Math.round(b.yen).toLocaleString().padStart(12)}`);
  }

  console.log(`
--- ★ 要確認 (理由が分かっていない) の **状況別** 内訳`);
  console.log("    ★ 判定規則は変えていない。★ 「出勤簿が無い」等は 原因が分かっているので 規則を足す余地がある");
  for (const [item, sm] of [...sitOf].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))) {
    console.log(`    ${item} 計 ${[...sm.values()].reduce((x, y) => x + y, 0)} 人月`);
    for (const [k, v] of [...sm].sort((a, b) => b[1] - a[1])) console.log(`      ${String(v).padStart(4)} 人月  ${k}`);
  }
  if (ITEM || EMP) { console.log(`\n--- ${EMP ? `社員 ${EMP}` : `項目 ${ITEM}`} の明細 (${detail.length})`); for (const d of detail.sort()) console.log(d); }

  console.log("\n--- 負のコントロール (判定が効いていることの確認)");
  const base: DiffContext = { roleType: "社員", attendanceGapMinutes: 0, noAttendance: false, hasRateGap: false, officeNumber: "1270501180", officeFormEmpty: false };
  const one = (item: string, ctx: DiffContext) => diffItems([{ item, ours: 1000, soukatsu: 2000 }], ctx)[0];
  expect(one("残業総額", base).verdict === "要確認", "★ 出勤簿の食い違いが無ければ 残業総額の差は 要確認 (= 理由が分かっていない)");
  expect(one("残業総額", { ...base, attendanceGapMinutes: 30 }).verdict === "許容", "★ 出勤簿の食い違いがあれば 残業総額の差は 許容 (user 2026-09-23)");
  expect(one("出勤時間", { ...base, attendanceGapMinutes: 30 }).verdict === "許容", "出勤時間も同じ理由で 許容");
  expect(one("特日", { ...base, adjustmentFolded: true }).verdict === "許容", "調整手当に畳み込まれていれば 特日は 許容 (突合は内訳計で)");
  expect(one("特日", base).verdict !== "許容", "★ 畳み込まれていなければ 特日の差は 許容にしない");
  // ★ 調整手当(内訳計) の 誤差規則 (2026-10-01 追加)
  expect(diffItems([{ item: "調整手当(内訳計)", ours: 0, soukatsu: -2300 }], { ...base, soukatsuGosa: 2300 })[0].verdict === "許容",
    "★ 差が ②の誤差と同額なら 調整手当(内訳計) は 許容");
  expect(diffItems([{ item: "調整手当(内訳計)", ours: 0, soukatsu: -2300 }], { ...base, soukatsuGosa: 999 })[0].verdict === "要確認",
    "★ 誤差と額が違えば 許容にしない");
  // ★ 状況の分け方 (2026-10-01 追加)。★ 出勤簿が無くても 手入力が代わりになるなら 原因にしない
  const dOt = { item: "残業総額", ours: 0, soukatsu: 2000, diff: 2000 };
  const noAtt: DiffContext = { ...base, roleType: "事務員", noAttendance: true };
  expect(classifySituation(dOt, noAtt, true, false) === "★ 出勤簿が無い (提責・事務員は あるべき)",
    "★ 出勤簿も 代わりの手入力も無ければ 「出勤簿が無い」");
  expect(classifySituation(dOt, noAtt, true, true) === "当方が 0 (②だけ払っている)",
    "★ overtime_minutes の手入力があれば 「出勤簿が無い」とは言わない (五井 加瀬 で踏んだ)");
  expect(classifySituation(dOt, { ...base, roleType: "パート", noAttendance: true }, false, false) === "当方が 0 (②だけ払っている)",
    "★ パートは 出勤簿が元々無いので 原因にしない");
  expect(diffItems([{ item: "調整手当(内訳計)", ours: 0, soukatsu: -2300 }], { ...base, soukatsuGosa: 0 })[0].verdict === "要確認",
    "★ 誤差が 0 のときは 許容にしない (この規則を空打ちで使わない)");
  expect(diffItems([{ item: "残業総額", ours: 1000, soukatsu: 1000 }], base).length === 0, "差が 0 の項目は 出さない");
  expect(diffItems([{ item: "残業総額", ours: 1000, soukatsu: 1001 }], base).length === 0, "差 1 円は 許容範囲 (MONEY_TOLERANCE)");

  const counts: Record<string, number> = {};
  for (const [item, rm] of reasonOf) counts[`要対応:${item}`] = [...rm.values()].reduce((s, x) => s + x, 0);
  counts["要対応 合計"] = Object.entries(counts).filter(([k]) => k.startsWith("要対応:")).reduce((s, [, v]) => s + v, 0);
  // ★ 要確認 (= 理由が分かっていない) も 項目ごとに見張る。★ こちらが 本当の残作業
  //   ★ 要対応 は「何をすればよいか分かっている」もの (データ入力)。★ 要確認 は「分かっていない」もの
  for (const [item, m] of byItem) { const c = m.get("要確認"); if (c) counts[`要確認:${item}`] = c.n; }
  counts["要確認 合計"] = [...byItem.values()].reduce((s, m) => s + (m.get("要確認")?.n ?? 0), 0);

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
