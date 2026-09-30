/**
 * check:tokubi — 特日手当 (会社休日 = お盆 8/13〜15・年末年始) を ① ② と突合する。★ 基準値方式・読み取り専用。
 *
 *   SOUKATSU1_DIR=<① の抽出物の dir> npm run check:tokubi
 *   SOUKATSU1_DIR=… npm run check:tokubi -- --update
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────────
 * 特日手当 = 特日の訪問時間 (同行を除く) × 200円/時。★ 2 つの前提が埋まっている:
 *   (a) ★ 0.75 掛け  … 0.75 事業所 (Hana 系) だけ 0.75 掛け対象を ×0.75 した時間で払う
 *   (b) ★ 同行の除外 … ★ サービスコードで決める (payroll_doukou_by_service_not_flag)
 * 2026-09-30 に (b) が **月給の特日だけ 旗/区分のまま残っていた**のを見つけた
 * (船橋 金子百恵・小針由美: code=111111 身体介護 なのに 旗=同行 の 30 分が落ちて ¥100 過少)。
 * ★ どちらの前提も「直したあと 誰も見ていない」状態だったので 常設にする。
 *
 * ── 2026-09-30 の実測 (202608。★ 202603〜07 に 特日は 1 日も無い) ─────────────
 *   (a) 0.75 で値が変わる 42 人 → ★ 0.75 事業所 30/30 が「0.75 が正」/ 通常 12/12 が「素が正」
 *       = ★ 事業所フラグで完全に説明できる
 *   (b) コード判定に直して 値が変わるのは 2 人。★ 2/2 が ① に近づく (副作用 0)
 *   保存済の payload  ① と一致 パート 267/268 / 月給 183/187
 *
 * ── この検査が見ていないもの ──────────────────────────────────────────────
 *   ・特日の時給 200 円そのもの (→ verify-payroll-calc-boundary の 3 本)
 *   ・土日祝手当・日曜祝日 (特日の日は そちらに数えない。→ check:soukatsu-item-gap)
 *   ・会社休日マスタ (payroll_company_holidays) が正しいか。★ 人が入れるもの
 *   ・202612 / 202701 の年末年始。★ まだ実績が無い
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { restAll, restOne, normEmpNo } from "./_rest.mjs";
import { isSpecialDay, isAccompaniedRecord, tokubiAllowanceAmount } from "../src/lib/payroll/payroll-calc.js";
import { isCareHours075 } from "../src/lib/payroll/care-hours-075.js";

const UPDATE = process.argv.includes("--update");
const BASELINE = new URL("./check-tokubi-baseline.json", import.meta.url);
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };

/** ★ 特日の列名は シートで違う: パート「特日」/ 提責・社員「・特日」。★ 片方だけ見ると 分母が 0 になる */
const TOKUBI_COLS = ["特日", "・特日"] as const;
const num = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?[\d,]+(\.\d+)?$/.test(v.trim())) return Number(v.replace(/,/g, ""));
  return 0;
};
const pickTokubi = (d: Record<string, unknown> | undefined): number => {
  for (const k of TOKUBI_COLS) if (d && d[k] != null && String(d[k]).trim() !== "") return num(d[k]);
  return 0;
};
const durMin = (d: string): number => { const m = /^(\d+):(\d+)/.exec(String(d ?? "").trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; };

type L1Row = { office_number: string; employee_number: string; sheet_kind: string; row_data: Record<string, unknown> };
type L2Row = { office_number: string; employee_number: string; processing_month: string; sheet_kind: string; row_data: Record<string, unknown> };
type Rec = { office_number: string; employee_number: string; employee_name: string; service_date: string; calc_duration: string; service_code: string; accompanied_visit: string | null; service_type: string | null };
type Emp = { employee_number: string; employee_name: string; tokubi_allowance?: number };
type Calc = { office_number: string; processing_month: string; payload: { hourly?: Emp[]; monthly?: Emp[] } };

async function main() {
  console.log("=== check:tokubi (特日手当を ① ② と突合) 2026-09-30 新設・読み取り専用 ===");
  console.log("★ check:all には入れていない (意図的)。① の写しの dir が要る診断系");
  const dir = process.env.SOUKATSU1_DIR;
  if (!dir) { console.log("★ SOUKATSU1_DIR=<① の抽出物 soukatsu_extract_YYYYMM.json のある dir> が要る"); process.exit(1); }
  const files = readdirSync(dir).filter((f) => /^soukatsu_extract_\d{6}\.json$/.test(f)).sort();
  if (!files.length) { console.log(`★ ${dir} に soukatsu_extract_YYYYMM.json が 1 本もない (0 件と出さない)`); process.exit(1); }
  const months = files.map((f) => /_(\d{6})\.json$/.exec(f)![1]);

  const holidays = new Set((await restAll<{ holiday_date: string }>("payroll_company_holidays?select=id,holiday_date"))
    .map((h) => h.holiday_date.replace(/\D/g, "").slice(0, 8)));
  const care075 = new Set((await restOne<{ value: { offices?: string[] } }>("payroll_app_settings?select=value&key=eq.care_075_offices"))?.value?.offices ?? []);
  console.log(`会社休日 ${holidays.size} 日 / 0.75 掛けの事業所 ${care075.size} 件`);
  const monthsWithTokubi = months.filter((m) => [...holidays].some((h) => h.startsWith(m)));
  console.log(`① の写しがある月 ${months.join(",")} / ★ そのうち 特日がある月 ${monthsWithTokubi.join(",") || "なし"}`);
  if (!monthsWithTokubi.length) { console.log("★ 特日がある月が 1 つも無いので 何も測れない (「合格」ではない)"); process.exit(1); }

  const l1 = new Map<string, Record<string, unknown>>();
  for (const [i, f] of files.entries()) for (const r of JSON.parse(readFileSync(join(dir, f), "utf8")) as L1Row[]) {
    const k = `${r.office_number}|${normEmpNo(r.employee_number)}|${months[i]}|${r.sheet_kind}`;
    if (!l1.has(k)) l1.set(k, r.row_data);   // ① の写しの重複行は 先に出たほうを使う (他の検査と同じ)
  }
  const l2 = new Map<string, Record<string, unknown>>();
  for (const r of await restAll<L2Row>("payroll_soukatsu_rows?select=id,office_number,employee_number,processing_month,sheet_kind,row_data")) {
    const k = `${r.office_number}|${normEmpNo(r.employee_number)}|${r.processing_month}|${r.sheet_kind}`;
    if (!l2.has(k)) l2.set(k, r.row_data);
  }
  const recs = (await restAll<Rec>(`payroll_service_records?select=id,office_number,employee_number,employee_name,processing_month,service_date,calc_duration,service_code,accompanied_visit,service_type&processing_month=in.(${monthsWithTokubi.join(",")})`))
    .filter((r) => isSpecialDay(r.service_date, holidays));
  const byEmp = new Map<string, Rec[]>();
  for (const r of recs) { const k = `${r.office_number}|${normEmpNo(r.employee_number)}`; const a = byEmp.get(k) ?? []; a.push(r); byEmp.set(k, a); }
  const calc = (await restAll<Calc>("payroll_calc_results?select=id,office_number,processing_month,payload")).filter((c) => monthsWithTokubi.includes(c.processing_month));

  // ── 保存済の payload を ① ② と突合 (★ 再導出しない。分母を本番と揃えるため)
  const counts: Record<string, number> = {};
  for (const kind of ["hourly", "monthly"] as const) {
    const sk = kind === "hourly" ? "part" : "shaseki";
    let n = 0, ok1 = 0, ok2 = 0, no2 = 0;
    const bad: string[] = [];
    for (const c of calc) for (const e of (c.payload?.[kind] ?? [])) {
      const base = `${c.office_number}|${normEmpNo(e.employee_number)}|${c.processing_month}`;
      const d1 = l1.get(`${base}|${sk}`); if (!d1) continue;
      const d2 = l2.get(`${base}|${sk}`);
      const ours = Math.round(e.tokubi_allowance ?? 0), v1 = pickTokubi(d1), v2 = d2 ? pickTokubi(d2) : null;
      if (d2 == null) no2++;
      if (ours === 0 && v1 === 0 && (v2 ?? 0) === 0) continue;   // 両方 0 は 分母に入れない
      n++; if (ours === v1) ok1++; if (v2 != null && ours === v2) ok2++;
      if (ours !== v1) bad.push(`    ★ ${base} ${e.employee_name} 当方 ${ours} / ① ${v1} / ② ${v2 ?? "(行なし)"}`);
    }
    const label = kind === "hourly" ? "パート(時給)" : "提責・社員(月給)";
    console.log(`\n--- ${label}: 特日が 0 でない ${n} 人 (② の行が無い ${no2} 人)`);
    console.log(`    当方 = ①  ${ok1}/${n}   当方 = ②  ${ok2}/${n}`);
    for (const l of bad) console.log(l);
    counts[`${label} ①と違う`] = n - ok1;
    counts[`${label} ②と違う`] = n - ok2;
  }

  // ── 前提 (a) 0.75 掛けは 事業所フラグで説明できるか
  console.log("\n--- 前提 (a) 0.75 掛けは 0.75 事業所だけか");
  let chg = 0, byFlag = 0, against = 0;
  for (const c of calc) for (const e of (c.payload?.monthly ?? [])) {
    const base = `${c.office_number}|${normEmpNo(e.employee_number)}|${c.processing_month}`;
    const d1 = l1.get(`${base}|shaseki`); if (!d1) continue;
    const rs = (byEmp.get(`${c.office_number}|${normEmpNo(e.employee_number)}`) ?? []).filter((r) => !isAccompaniedRecord(r));
    const raw = rs.reduce((s, r) => s + durMin(r.calc_duration), 0);
    const m075 = rs.reduce((s, r) => s + durMin(r.calc_duration) * (isCareHours075(r.service_code) ? 0.75 : 1), 0);
    const aRaw = tokubiAllowanceAmount(raw), a075 = tokubiAllowanceAmount(m075);
    if (aRaw === a075) continue;
    chg++;
    const v1 = pickTokubi(d1), want075 = care075.has(c.office_number);
    if ((want075 && a075 === v1) || (!want075 && aRaw === v1)) byFlag++;
    else if ((want075 && aRaw === v1) || (!want075 && a075 === v1)) { against++; console.log(`    ★ フラグと逆 ${base} ${e.employee_name} ①${v1} / 素${aRaw} / 0.75後${a075} / 0.75事業所=${want075}`); }
  }
  console.log(`    0.75 で値が変わる ${chg} 人 → フラグどおり ${byFlag} / ★ フラグと逆 ${against} / どちらでもない ${chg - byFlag - against}`);
  counts["0.75がフラグと逆の人月"] = against;

  // ── 前提 (b) 同行の除外は コード判定か (旗で落としていないか)
  console.log("\n--- 前提 (b) 同行の除外は サービスコードか (★ 旗で落としていないか)");
  const flagNotCode = recs.filter((r) => !!r.accompanied_visit && r.accompanied_visit.trim() !== "" && !isAccompaniedRecord(r));
  console.log(`    特日の実績のうち 「旗=同行 だが コードは同行でない」${flagNotCode.length} 行 (★ 旗で落とすと この分だけ過少になる)`);
  for (const r of flagNotCode.slice(0, 8)) console.log(`      ${r.office_number}|${normEmpNo(r.employee_number)} ${r.employee_name} ${r.service_date} ${r.calc_duration} code=${r.service_code} 名=${r.service_type}`);
  counts["特日で旗だけ同行の行"] = flagNotCode.length;

  console.log("\n--- 負のコントロール");
  expect(isSpecialDay("2026/08/13", holidays), "2026/08/13 は 特日 (スラッシュ区切りでも判定できる)");
  expect(!isSpecialDay("2026/08/12", holidays), "2026/08/12 は 特日でない");
  expect(tokubiAllowanceAmount(215) === 717, "215分 → 717円 (200円/時 四捨五入)");
  expect(tokubiAllowanceAmount(0) === 0, "0分 → 0円");
  expect(isAccompaniedRecord({ service_code: "010001" }) && !isAccompaniedRecord({ service_code: "111111" }), "同行の判定は コード (010001 は同行 / 111111 は同行でない)");
  expect(pickTokubi({ "・特日": 1250 }) === 1250 && pickTokubi({ 特日: 700 }) === 700, "特日の列は 「特日」「・特日」の両方を引ける (★ 片方だけだと 月給が全員 0 になる)");
  expect(pickTokubi({ 特日2: 999 }) === 0, "似た名前の列 (特日2) は 拾わない");

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
