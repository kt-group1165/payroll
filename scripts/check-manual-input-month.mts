/**
 * check:manual-input-month  月ごとの手入力 (payroll_monthly_inputs) の「月」が怪しいものを数える (2026-09-27 給与D)
 *
 *   npx tsx scripts/check-manual-input-month.mts
 *   npx tsx scripts/check-manual-input-month.mts -- --update          ★ 基準値方式の数だけ更新
 *   SNAPSHOT=<path.json> npx tsx scripts/check-manual-input-month.mts   1 回目は保存し 2 回目から使い回す
 *
 * 【なぜ】 2026-09-27 に 木村江利 (五井 260803・8 月入社) の 研修 1,050 分 と 岩坪恵 (五井 260802) の 出張 58.7km が
 *   ★ 7 月 に入っていた。総括表 ② はどちらも ★ 8 月 に同じ値で払っている。
 *   このまま再計算すると 7 月に払い、8 月も書式から計算される = 二重払いになる。名前で気づいた 2 件だったので全数で数える。
 *
 * 【数えるもの】 値>0 の手入力 1 行ずつ (social_insurance・bonus_paid はフラグなので除く)
 *   ★T 在籍期間の外: 手入力の月 < 入社月 か > 退職月
 *      入社・退職の根拠は この順で使う (使ったものを出力に出す):
 *        1. 旧システムの職員 payroll_legacy_employee の hire_date / quit_date
 *           ★ (事業所, 職員番号) の対で引く。事業所は office_name を 共通マスタの事業所名 (NFKC で正規化) で番号に直す
 *        2. 職員マスタ payroll_employees の hire_date / resignation_date に ★ +1 日して月を取る
 *           (保存時の JST ずれで 1 日早い。6 桁番号 590 名中 195 名が「翌月」になっていた = 1 日ずれの型)
 *        3. 職員番号の YYMM (6 桁の番号だけ)。旧システムの入社日と 792 名中 739 名 (93%) が同じ月。
 *           例外は主に 2021-09 の一斉付番 (番号の月 > 入社月 にはならない = 2026 年の手入力を誤って外に出すことはない)
 *   ★M 月違い: 手入力の値が その月の総括表 ② の対応欄と合わず、★ 別の月の ② の対応欄と一致する
 *      ★ 値が「ありふれていない」ときだけ見る (分: 100 以上で 60 の倍数でない / km: 10 以上か小数あり / 円: 100 以上)。
 *        有給 0.5〜2 日 のような小さな値は 別の月と偶然一致するので数えない (試しに入れたら 42 件の大半が偶然の一致だった)
 *
 * 【見ていないもの】
 *   - 値が ありふれている手入力の月違い (有給日数・欠勤日数 など)
 *   - ② が無い月 (総括表を取り込んでいない月) の月違い
 *   - 手入力の「項目」の取り違え (研修 と 初任者研修 など)。
 *     ★ 杉尾加奈子 202606 の 研修 3,390 分 は ① の 初任者研修時間 56:30 と一致し、単価も同じなので金額は変わらない (2026-09-27 確認)
 *
 * 【基準値方式】0 を目指す検査ではない。★ 増えたら落ちる。
 *   ★ なぜ 0 にできないか: 退職後の月の有給日数 (退職時の消化・精算) のように 在籍期間の外でも正しい手入力がある。人の判断。
 *
 * 【負のコントロール】★ DB は壊さない。取得結果の写しを壊して 毎回確かめる。
 *     ① 在籍中の手入力 1 件の月を 入社より前にした写し → T が 1 増える
 *     ② M の 1 件を ② と一致する月に移した写し → M が 1 減る
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { restAll, normEmpNo } from "./_rest.mjs";

const BASELINE = new URL("./check-manual-input-month-baseline.json", import.meta.url);
const UPDATE = process.argv.includes("--update");

type Input = { id: string; office_number: string; employee_number: string; processing_month: string; item_key: string; numeric_value: number | null };
type Emp = { id: string; employee_number: string; name: string; office_id: string; hire_date: string | null; resignation_date: string | null };
type Office = { id: string; office_number: string; offices: { name: string | null } | null };
type Legacy = { id: number; office_name: string; employee_number: string; employee_name: string; hire_date: string | null; quit_date: string | null };
type L2 = { id: string; office_number: string; employee_number: string; processing_month: string; row_data: Record<string, unknown> };
type Snap = { inputs: Input[]; emps: Emp[]; offices: Office[]; legacy: Legacy[]; l2: L2[] };

console.log("=== check:manual-input-month  手入力の月が怪しいもの (在籍期間の外 / 別の月の総括表と一致) ===\n");
console.log("⚠ この検査が見ていないもの: 値がありふれた手入力 (有給・欠勤の日数) の月違い / 総括表 ② の無い月 / 手入力の項目の取り違え\n");

const SNAPSHOT = process.env.SNAPSHOT ?? "";
let snap: Snap;
if (SNAPSHOT && existsSync(SNAPSHOT)) {
  snap = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snap;
  console.log(`(SNAPSHOT を使いました: ${SNAPSHOT})`);
} else {
  snap = {
    inputs: await restAll<Input>("payroll_monthly_inputs?select=id,office_number,employee_number,processing_month,item_key,numeric_value"),
    emps: await restAll<Emp>("payroll_employees?select=id,employee_number,name,office_id,hire_date,resignation_date"),
    offices: await restAll<Office>("payroll_offices?select=id,office_number,offices(name)"),
    legacy: await restAll<Legacy>("payroll_legacy_employee?select=id,office_name,employee_number,employee_name,hire_date,quit_date"),
    l2: await restAll<L2>("payroll_soukatsu_rows?select=id,office_number,employee_number,processing_month,row_data"),
  };
  if (SNAPSHOT) { writeFileSync(SNAPSHOT, JSON.stringify(snap)); console.log(`(SNAPSHOT に保存しました: ${SNAPSHOT})`); }
}

const norm = (s: unknown) => String(s ?? "").normalize("NFKC").replace(/\s/g, "");
const toNum = (v: unknown): number | null => {
  if (v == null || v === "") return null; if (typeof v === "number") return v;
  const t = /^(-?\d+):(\d{2})/.exec(String(v).trim()); if (t) return Number(t[1]) * 60 + Number(t[2]);
  const n = Number(String(v).replace(/,/g, "")); return Number.isFinite(n) ? n : null;
};
const ym = (d: string | null, plusDay = 0): string | null => {
  if (!d) return null; const t = new Date(`${d.slice(0, 10)}T00:00:00Z`); if (Number.isNaN(t.getTime())) return null;
  t.setUTCDate(t.getUTCDate() + plusDay); return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
};
/** ② の対応欄。yen は 分 → 円 (研修の時給 1,150 円) で比べる欄 */
const CP: Record<string, { cols: string[]; yenCols?: string[] }> = {
  training_minutes: { cols: ["内研修時間", "内初任者研修時間"], yenCols: ["研修", "初任者研修費"] },
  shoninsha_training_minutes: { cols: ["内初任者研修時間"], yenCols: ["初任者研修費"] },
  business_km: { cols: ["距離(出)", "距離"] },
  commute_yen: { cols: ["通勤費"] },
  office_work_minutes: { cols: ["出勤時間"] },
  childcare_allowance: { cols: ["育児手当"] },
  overtime_minutes: { cols: ["残業"] },
};
const distinctive = (key: string, v: number) =>
  key === "business_km" ? v >= 10 || v % 1 !== 0 : v >= 100 && (/minutes/.test(key) ? v % 60 !== 0 : true);
const eq = (a: number | null, b: number | null) => a != null && b != null && Math.abs(a - b) < 0.051;

type Hit = { key: string; office: string; num: string; month: string; value: number; name: string; id: string; detail: string; moveTo?: string };
function analyze(s: Snap) {
  const offNum = new Map(s.offices.map((o) => [o.id, o.office_number]));
  const nameToNum = new Map(s.offices.filter((o) => o.offices?.name).map((o) => [norm(o.offices!.name), o.office_number]));
  const emp = new Map(s.emps.map((e) => [`${offNum.get(e.office_id)}|${normEmpNo(e.employee_number)}`, e]));
  const leg = new Map<string, Legacy>();
  for (const r of s.legacy) { const on = nameToNum.get(norm(r.office_name)); if (on) leg.set(`${on}|${normEmpNo(r.employee_number)}`, r); }
  const l2 = new Map<string, Record<string, unknown>>();
  for (const r of s.l2) { const k = `${r.office_number}|${normEmpNo(r.employee_number)}|${r.processing_month}`; l2.set(k, { ...(l2.get(k) ?? {}), ...r.row_data }); }
  const l2Months = [...new Set(s.l2.map((r) => r.processing_month))].sort();
  const cpMatch = (key: string, v: number, k: string) => {
    const c = CP[key]; const d = l2.get(k); if (!c || !d) return false;
    if (c.cols.some((col) => eq(toNum(d[col]), v))) return true;
    return /minutes/.test(key) && !!c.yenCols?.some((col) => eq(toNum(d[col]), Math.round(v / 60 * 1150)));
  };
  const T: Hit[] = [], M: Hit[] = [];
  const basis: Record<string, number> = {};
  let total = 0;
  for (const r of s.inputs) {
    const v = Number(r.numeric_value ?? 0);
    if (!(v > 0) || r.item_key === "social_insurance" || r.item_key === "bonus_paid") continue;
    total++;
    const num = normEmpNo(r.employee_number), on = r.office_number, m = r.processing_month;
    const e = emp.get(`${on}|${num}`), lg = leg.get(`${on}|${num}`);
    let start: string | null = null, src = "根拠なし";
    if (lg?.hire_date) { start = ym(lg.hire_date); src = "旧システムの入社日"; }
    else if (e?.hire_date) { start = ym(e.hire_date, 1); src = "職員マスタの入社日(+1日)"; }
    else if (/^\d{6}$/.test(num) && Number(num.slice(2, 4)) >= 1 && Number(num.slice(2, 4)) <= 12) { start = `20${num.slice(0, 4)}`; src = "職員番号のYYMM"; }
    basis[src] = (basis[src] ?? 0) + 1;
    const end = lg?.quit_date ? ym(lg.quit_date) : e?.resignation_date ? ym(e.resignation_date, 1) : null;
    const base = { key: r.item_key, office: on, num, month: m, value: v, name: e?.name ?? lg?.employee_name ?? "", id: r.id };
    const outside = (start && m < start) ? `${src} ${start} より前` : (end && m > end) ? `退職 ${end} より後` : "";
    if (outside) T.push({ ...base, detail: outside });
    if (!CP[r.item_key] || !distinctive(r.item_key, v) || !l2Months.includes(m)) continue;
    if (cpMatch(r.item_key, v, `${on}|${num}|${m}`)) continue;
    const others = l2Months.filter((mm) => mm !== m && cpMatch(r.item_key, v, `${on}|${num}|${mm}`));
    if (others.length) M.push({ ...base, detail: `② の ${others.join(",")} と一致${outside ? ` / ${outside}` : ""}`, moveTo: others.length === 1 ? others[0] : undefined });
  }
  return { T, M, total, basis };
}

let failed = 0;
const expect = (cond: boolean, msg: string) => { console.log(`  ${cond ? "o" : "x"} ${msg}`); if (!cond) failed++; };
const clone = (s: Snap): Snap => JSON.parse(JSON.stringify(s)) as Snap;
const r0 = analyze(snap);
{
  // ① 在籍期間の中にある手入力を 1 件、2000 年 1 月に動かす → T が 1 増える
  const tIds = new Set(r0.T.map((x) => x.id));
  const pick = snap.inputs.find((r) => Number(r.numeric_value ?? 0) > 0 && r.item_key !== "social_insurance" && r.item_key !== "bonus_paid" && !tIds.has(r.id));
  if (!pick) { console.log("  x 負のコントロール①用の手入力が無い"); process.exit(1); }
  const s1 = clone(snap); s1.inputs.find((r) => r.id === pick.id)!.processing_month = "200001";
  const t1 = analyze(s1).T.length;
  expect(t1 === r0.T.length + 1, `負のコントロール①: 在籍中の手入力を 200001 に動かすと T が ${r0.T.length} → ${r0.T.length + 1} (実際 ${t1})`);
  // ② M の 1 件を ② と一致する月に移す → M が 1 減る
  const mv = r0.M.find((x) => x.moveTo);
  if (mv) {
    const s2 = clone(snap); s2.inputs.find((r) => r.id === mv.id)!.processing_month = mv.moveTo!;
    const m2 = analyze(s2).M.length;
    expect(m2 === r0.M.length - 1, `負のコントロール②: M の 1 件 (${mv.name}) を ${mv.moveTo} に移すと M が ${r0.M.length} → ${r0.M.length - 1} (実際 ${m2})`);
  } else console.log("  (負のコントロール②: 移せる M が無いので省略)");
  if (failed) { console.log("\n★ 負のコントロールが鳴らない = 検査が壊れている。基準値の判定はしません"); process.exit(1); }
}

console.log(`\n分母: 値>0 の手入力 ${r0.total} 行 (social_insurance・bonus_paid を除く)`);
console.log(`  入社月の根拠: ${Object.entries(r0.basis).map(([k, v]) => `${k} ${v}`).join(" / ")}`);
console.log(`★T 在籍期間の外: ${r0.T.length} 行`);
for (const x of r0.T) console.log(`   ${x.month} ${x.office} ${x.num} ${x.name} ${x.key}=${x.value} (${x.detail})`);
console.log(`★M 月違い (別の月の総括表 ② と一致): ${r0.M.length} 行`);
for (const x of r0.M) console.log(`   ${x.month} ${x.office} ${x.num} ${x.name} ${x.key}=${x.value} (${x.detail})${x.moveTo ? ` → 正しい月 ${x.moveTo} (★ 移す先の事業所書式に同じ値があれば 移すと二重。fix_manual_input_wrong_month.mjs で判定)` : ""}`);

type Baseline = { _readme: string[]; T: number; M: number };
const baseline: Baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline : { _readme: [], T: Number.POSITIVE_INFINITY, M: Number.POSITIVE_INFINITY };
if (UPDATE) {
  Object.assign(baseline, { T: r0.T.length, M: r0.M.length });
  writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  console.log(`\n基準値を更新しました: T ${r0.T.length} / M ${r0.M.length}`);
} else {
  console.log(`\n基準値: T ${baseline.T} / M ${baseline.M}`);
  expect(r0.T.length <= baseline.T, `T (在籍期間の外) が基準値から増えていない (${r0.T.length} <= ${baseline.T})`);
  expect(r0.M.length <= baseline.M, `M (月違い) が基準値から増えていない (${r0.M.length} <= ${baseline.M})`);
}
process.exit(failed ? 1 : 0);
