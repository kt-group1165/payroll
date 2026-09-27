/**
 * check:meeting-3way — 会議費を 事業所書式 / ① / ② の 3 つで 全事業所・全月 突き合わせる (2026-09-27 給与C 新設・読み取り専用)。
 *
 *   SOUKATSU1_DIR=<① の抽出物のある dir> npm run check:meeting-3way
 *   SOUKATSU1_DIR=... SNAPSHOT=<path.json> npm run check:meeting-3way   # ② を DB から読まず 保存済みを使う
 *   ... -- --detail=<型>   /   -- --update   (基準値の更新。★ 悪化したまま更新しない)
 *
 * ★ payroll_calc_results は読まない。当方の値は「書式から当方の式 (computeMeetingFee + meetingMinutes) で出した額」。
 *   再計算中でも測れる。★ 式は payroll-calc.ts をそのまま呼ぶ (逐語コピーしない)。
 *
 * ── 比べているもの ───────────────────────────────────────────────────────
 *   書式 = payroll_office_form_records の 会議1/2/3件数 (km) と 会議 (training・時間)
 *          件数の額 = computeMeetingFee (件数 × 事業所ごとの単価。件数欄の 100 以上は円とみなす)
 *          時間の額 = meetingMinutes × 1,150 円/時
 *   ①    = 旧システムの出力 (パート) の「会議費」
 *   ②    = 支払用シート (payroll_soukatsu_rows パート) の「会議費」
 *   ⚠ ① の会議費は 件数ぶんだけで、時間ぶんは その他手当計 に入ることがある (五井 山下愛望 202606: ① 1,500 / ② 3,800)。
 *     なので 金額の一致は「件数の額」か「件数の額 + 時間の額」のどちらかに合えば一致とする。
 *
 * ── 型 (1 人月 1 つ。母数 = 書式・①・② のどれかに会議がある パートの人月) ─────────
 *   一致                     書式にある / ①② とも払っていて 額も合う
 *   A:①②とも払っていない     書式にある / ①② とも 0            (里見 202606 型)
 *   B:①だけ払っている         書式にある / ① だけ               (宮﨑 202608 型)
 *   C:②だけ払っている         書式にある / ② だけ               (餅原 202608 型)
 *   D:書式に無い              書式に会議の行が無い / ①② とも払っている    (当方の元データ欠け)
 *   D1:書式に無い・①だけ     書式に無い / ① だけ
 *   D2:書式に無い・②だけ     書式に無い / ② だけ
 *   E:金額が合わない          書式にある / ①② とも払っている / ① か ② の額が 件数×単価 (+時間) と合わない (欄の取り違え・単価違い)
 *   書式だけ:総括表に行が無い  書式にある / ① にも ② にもパートの行が無い (社員・退職者など)
 *   払わない事業所            meeting_fee_unpaid_offices の事業所で 書式にある
 *
 * ── この検査が見ていないもの ─────────────────────────────────────────────
 *   ・月給者 (① ② の会議費はパートのシートにしか無い。2026-09-27 実測 ① 532 / ② 523 人月 すべて part)
 *   ・どれが正しいか。型は「どこがずれているか」の分類で、書式・① ・② のどれを直すかは人が決める
 *   ・当方の payload (再計算で入った額)。書式から出した額と payload が食い違うかは見ていない
 *   ・研修 (check:training-3way) / 初任者研修
 *   ・① の時間ぶんが その他手当計 のどこに入ったか (件数+時間 のどちらかに合えば一致にしている)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { restAll, empKey } from "./_rest.mjs";
import { num } from "./_soukatsu-items.mjs";
import {
  computeMeetingFee, meetingMinutes, trainingPayAmount, TRAINING_RATE_PER_HOUR, MEETING_COUNT_AS_YEN_THRESHOLD,
  type OfficeFormRecord, type MeetingUnitPrices,
} from "../src/lib/payroll/payroll-calc.js";
import { isEmployedInMonth, type EmploymentFields } from "../src/lib/payroll/employment-in-month.js";

const UPDATE = process.argv.includes("--update");
const DETAIL = process.argv.find((a) => a.startsWith("--detail="))?.split("=")[1];
const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), "check-meeting-3way-baseline.json");

type FormRec = OfficeFormRecord & { office_number: string; processing_month: string };
type R = { office_number: string; employee_number: string; processing_month: string; sheet_kind: string; row_data: Record<string, unknown> };
export type Inputs = {
  form: FormRec[];
  l1: Map<string, Record<string, unknown>>;   // key → ① パートの行
  l2: Map<string, Record<string, unknown>>;   // key → ② パートの行
  officeUnit: Map<string, number>;            // payroll_offices.meeting_unit_price
  prices: Record<string, MeetingUnitPrices>;
  unpaid: Set<string>;
  /** payroll_offices.office_type。訪問介護以外 (福祉用具貸与 等) は 総括表 ② が無く 対象外 */
  officeType: Map<string, string>;
  /** empKey(事業所番号, 職員番号) → 職員 (給与形態・在籍の判定に使う) */
  emps: Map<string, EmploymentFields & { salary_type?: string | null }>;
};
export type Row = { key: string; office: string; countYen: number; timeYen: number; counts: number; yenInCount: boolean; l1: number | null; l2: number | null; type: string };

const keyOf = (office: string, emp: string, month: string) => `${empKey(office, emp)}|${month}`;
const hasValue = (r: FormRec) => (r.record_type === "km" && (r.numeric_value ?? 0) > 0) || (r.record_type === "training" && !!r.start_time && !!r.end_time);

export function classify(r: Omit<Row, "type">, unpaid: boolean): string | null {
  const f = r.countYen + r.timeYen;
  const p1 = (r.l1 ?? 0) > 0, p2 = (r.l2 ?? 0) > 0;
  if (f <= 0 && !p1 && !p2) return null;
  if (f > 0 && unpaid) return "払わない事業所";
  if (f > 0) {
    if (r.l1 == null && r.l2 == null) return "書式だけ:総括表に行が無い";
    if (p1 && p2) {
      const fits = (v: number | null) => v != null && (Math.abs(v - r.countYen) <= 1 || Math.abs(v - f) <= 1);
      return fits(r.l1) && fits(r.l2) ? "一致" : "E:金額が合わない";
    }
    if (!p1 && !p2) return "A:①②とも払っていない";
    return p1 ? "B:①だけ払っている" : "C:②だけ払っている";
  }
  if (p1 && p2) return "D:書式に無い";
  return p1 ? "D1:書式に無い・①だけ" : "D2:書式に無い・②だけ";
}

/**
 * ② の会議費。★ ② は列名で取れない (2026-09-27 実測。① の値と一致する列を事業所ごとに数えた):
 *   ・おゆみ野 (1270501180) には「会議費」列が無く、会議費は「研修」列に入る (① 会議費 = ② 研修 141/150)
 *   ・いすみ・高品・船橋・四街道・さつき 等は「会議費」列に ① の研修費も入る (いすみ ① 研修費 = ② 会議費 34/35)
 *   → ② の 研修・会議 の列は「研修 + 会議」の合計として読み、① の研修費を引いて 会議ぶんとする。
 *     ① の行が無いときは 合計のまま (研修が混ざっていても分けられない)。
 *   ⚠ ② に「会議費」と書いてあるから会議、とはしない (これで D2 が 143 件出た)。
 */
export function l2Meeting(d2: Record<string, unknown>, d1: Record<string, unknown> | undefined): number {
  const both = num(d2["会議費"]) + num(d2["研修"]);
  return Math.max(0, both - (d1 ? num(d1["研修費"]) : 0));
}

/**
 * 型を実データで細かく分ける (2026-09-27 指示役の指摘で追加)。見立てで止めない。
 *   ・訪問介護以外の事業所 → 「対象外:訪問介護以外」(1271502500 = リンクス福祉用具 / 福祉用具貸与。② が 0 行)
 *   ・書式だけ (当方が払い ①② が払っていない = 過払いの候補) を 3 つに:
 *       月給者 → 対象外でよい (①② の会議費はパートのシートにしか無い)
 *       その月に在籍していない → isEmployedInMonth (lib/payroll/employment-in-month) で決める。★ 逐語コピーしない
 *       どちらでもない → ★ 本物の過払い候補
 */
function refine(type: string, key: string, inp: Inputs): string {
  const [office, emp, month] = key.split("|");
  const ot = inp.officeType.get(office);
  if (ot && ot !== "訪問介護") return "対象外:訪問介護以外";
  if (type !== "書式だけ:総括表に行が無い") return type;
  const e = inp.emps.get(empKey(office, emp));
  if (!e) return "書式だけ:職員マスタに無い";
  if (e.salary_type === "月給") return "書式だけ:月給者";
  if (!isEmployedInMonth(e, month)) return "書式だけ:在籍外";
  return "書式だけ:説明できない";
}

export function buildRows(inp: Inputs): Row[] {
  const byKey = new Map<string, FormRec[]>();
  // ★ 値の無い行も 除かずに computeMeetingFee に渡す。給与計算 (page.tsx) は その職員の書式の行を全部渡しており、
  //   computeMeetingFee は 会議N件数 の値が null の行を 1 件と数える (numeric_value ?? 1)。
  //   2026-09-27 に null の行を除いて渡していたため、さつき 202606 の 14 人月を「書式の件数が null・当方 0 円」と誤って出した
  //   (実際の計算結果は 14 人とも meeting_fee 1,500)。★ 検査は計算と同じ入力で呼ぶ
  for (const r of inp.form) {
    const k = keyOf(r.office_number, r.employee_number, r.processing_month);
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const l1Pay = [...inp.l1].filter(([, d]) => num(d["会議費"]) > 0).map(([k]) => k);
  const l2Pay = [...inp.l2].filter(([k, d]) => l2Meeting(d, inp.l1.get(k)) > 0).map(([k]) => k);
  const keys = new Set([...byKey.keys(), ...l1Pay, ...l2Pay]);
  const out: Row[] = [];
  for (const k of keys) {
    const office = k.split("|")[0];
    const recs = byKey.get(k) ?? [];
    const countYen = computeMeetingFee(recs, inp.officeUnit.get(office) ?? 0, inp.prices[office]);
    const timeYen = trainingPayAmount(meetingMinutes(recs), TRAINING_RATE_PER_HOUR) ?? 0;
    const counts = recs.filter((r) => r.record_type === "km" && (r.numeric_value ?? 0) < MEETING_COUNT_AS_YEN_THRESHOLD).reduce((s, r) => s + Math.round(r.numeric_value ?? 1), 0);   // null は 1 件 (computeMeetingFee と同じ)
    const yenInCount = recs.some((r) => r.record_type === "km" && (r.numeric_value ?? 0) >= MEETING_COUNT_AS_YEN_THRESHOLD);
    const d1 = inp.l1.get(k), d2 = inp.l2.get(k);
    const base = { key: k, office, countYen, timeYen, counts, yenInCount, l1: d1 ? num(d1["会議費"]) : null, l2: d2 ? l2Meeting(d2, d1) : null };
    const type = classify(base, inp.unpaid.has(office));
    if (type) out.push({ ...base, type: refine(type, k, inp) });
  }
  return out;
}

const countOf = (rows: Row[]) => { const c: Record<string, number> = {}; for (const r of rows) c[r.type] = (c[r.type] ?? 0) + 1; return c; };

/** 入力を壊して buildRows から通す。DB もファイルも触らない (読み込んだ写しを壊す) */
function negativeControl(inp: Inputs, rows: Row[]) {
  const lines: string[] = [];
  let ok = true;
  const c0 = countOf(rows);
  const base = rows.find((r) => r.type === "一致" && r.timeYen === 0 && r.counts === 1 && !r.yenInCount);
  if (!base) return { ok: false, lines: ["件数 1 で一致している人月が無く 作れない  ★ NG"] };
  const [office, emp, month] = [base.office, base.key.split("|")[1], base.key.split("|")[2]];
  const isBase = (r: FormRec) => keyOf(r.office_number, r.employee_number, r.processing_month) === base.key && r.record_type === "km" && hasValue(r);
  const drop = (m: Map<string, Record<string, unknown>>) => new Map([...m].map(([k, d]) => [k, k === base.key ? { ...d, 会議費: 0, 研修: 0, 研修費: 0 } : d]));
  const cases: [string, Inputs, string][] = [
    ["書式の会議行を消す", { ...inp, form: inp.form.filter((r) => !isBase(r)) }, "D:書式に無い"],
    ["書式の件数を null にする (行は残す。計算は null を 1 件と数えるので 一致のまま)", { ...inp, form: inp.form.map((r) => (isBase(r) ? { ...r, numeric_value: null } : r)) }, "一致"],
    ["書式の件数を 2 にする (欄の取り違え)", { ...inp, form: inp.form.map((r) => (isBase(r) ? { ...r, numeric_value: 2 } : r)) }, "E:金額が合わない"],
    ["① の会議費を 0 にする", { ...inp, l1: drop(inp.l1) }, "C:②だけ払っている"],
    ["② の会議費を 0 にする", { ...inp, l2: drop(inp.l2) }, "B:①だけ払っている"],
    ["①② とも 0 にする", { ...inp, l1: drop(inp.l1), l2: drop(inp.l2) }, "A:①②とも払っていない"],
    ["件数欄に 1,500 円を入れる (100 以上は円とみなす規則が効くか)", { ...inp, form: inp.form.map((r) => (isBase(r) ? { ...r, numeric_value: base.countYen } : r)) }, "一致"],
    ["その事業所を 払わない事業所 にする", { ...inp, unpaid: new Set([...inp.unpaid, office]) }, "払わない事業所"],
  ];
  for (const [label, broken, want] of cases) {
    const rs = buildRows(broken);
    const got = rs.find((r) => r.key === base.key)?.type ?? "(行が無い)";
    const c = countOf(rs);
    const moved = want === "一致" ? (c["一致"] ?? 0) === (c0["一致"] ?? 0)
      : want === "払わない事業所" ? (c[want] ?? 0) > (c0[want] ?? 0)   // 事業所ごと動くので +1 ではない
      : (c[want] ?? 0) === (c0[want] ?? 0) + 1;
    const pass = got === want && moved;
    if (!pass) ok = false;
    lines.push(`${label} → ${got} (${want} ${c0[want] ?? 0}→${c[want] ?? 0})${pass ? "  OK" : `  ★ NG (期待 ${want})`}`);
  }
  // 突き合わせのキー: ② の職員番号を壊すと ② 側が結び付かなくなる
  const brokenL2 = new Map([...inp.l2].map(([k, d]) => [k === base.key ? `${empKey(office, "999999999")}|${month}` : k, d]));
  const got = buildRows({ ...inp, l2: brokenL2 }).find((r) => r.key === base.key)?.type;
  const pass = got === "B:①だけ払っている";
  if (!pass) ok = false;
  lines.push(`② の職員番号を壊す (${office} ${emp} ${month}) → ${got}${pass ? "  OK" : "  ★ NG (期待 B:①だけ払っている)"}`);
  // 書式だけ の分け方: 月給者の職員を 時給にする / 退職日を月より前にする
  const mg = rows.find((r) => r.type === "書式だけ:月給者");
  if (!mg) { ok = false; lines.push("書式だけ:月給者 の人月が無く 分け方のコントロールを作れない  ★ NG"); }
  else {
    const [mo, me, mm] = mg.key.split("|");
    const ek = empKey(mo, me);
    const e0 = inp.emps.get(ek)!;
    const prevMonthEnd = `${mm.slice(0, 4)}-${mm.slice(4, 6)}-01`;
    const ctl: [string, EmploymentFields & { salary_type?: string | null }, string][] = [
      ["月給者を時給にする", { ...e0, salary_type: "時給" }, "書式だけ:説明できない"],
      ["時給にして 退職日を月初より前・退職者にする", { ...e0, salary_type: "時給", employment_status: "退職者", resignation_date: `${Number(prevMonthEnd.slice(0, 4)) - 1}-01-01` }, "書式だけ:在籍外"],
    ];
    for (const [label, e, want] of ctl) {
      const got2 = buildRows({ ...inp, emps: new Map([...inp.emps, [ek, e]]) }).find((r) => r.key === mg.key)?.type;
      const p = got2 === want;
      if (!p) ok = false;
      lines.push(`${label} (${mg.key}) → ${got2}${p ? "  OK" : `  ★ NG (期待 ${want})`}`);
    }
  }
  return { ok, lines };
}

async function main() {
  console.log("=== check:meeting-3way (会議費を 書式 / ① / ② で) 2026-09-27 新設・読み取り専用 ===");
  console.log("★ check:all には入れていない (意図的)。② の手入力・書式の入力で件数が動く診断系");
  console.log("★ payroll_calc_results は読まない。当方 = 書式から当方の式 (computeMeetingFee + meetingMinutes) で出した額");
  console.log("★ この検査が見ていないもの: 月給者 / どれが正しいか / 当方の payload / 研修・初任者研修 / ① の時間ぶんの置き場所");
  const dir = process.env.SOUKATSU1_DIR;
  if (!dir) { console.log("★ SOUKATSU1_DIR=<① の抽出物 soukatsu_extract_YYYYMM.json のある dir> が要る"); process.exit(1); }
  const files = readdirSync(dir).filter((f) => /^soukatsu_extract_\d{6}\.json$/.test(f)).sort();
  if (!files.length) { console.log(`★ ${dir} に soukatsu_extract_YYYYMM.json が 1 本もない (0 件と出さない)`); process.exit(1); }
  const months = files.map((f) => /_(\d{6})\.json$/.exec(f)![1]);
  const l1 = new Map<string, Record<string, unknown>>();
  for (const [i, f] of files.entries()) for (const r of JSON.parse(readFileSync(join(dir, f), "utf8")) as R[]) {
    if (r.sheet_kind !== "part") continue;
    const k = keyOf(r.office_number, r.employee_number, months[i]);
    if (!l1.has(k)) l1.set(k, r.row_data);   // ① の写しの重複行は 先に出たほうを使う (給与D の検査と同じ)
  }
  const path = process.env.SNAPSHOT;
  const snap = path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  const l2rows: R[] = snap ? snap.soukatsu : await restAll<R>("payroll_soukatsu_rows?select=id,office_number,employee_number,processing_month,sheet_kind,row_data&sheet_kind=eq.part");
  const l2 = new Map<string, Record<string, unknown>>();
  for (const r of l2rows) if (r.sheet_kind === "part" && months.includes(r.processing_month)) l2.set(keyOf(r.office_number, r.employee_number, r.processing_month), r.row_data);
  const form = (await restAll<FormRec>("payroll_office_form_records?select=id,office_number,employee_number,processing_month,record_type,item_name,item_date,numeric_value,start_time,end_time,break_time&item_name=like.*会議*"))
    .filter((r) => months.includes(r.processing_month));
  const offices = await restAll<{ id: string; office_number: string; office_type: string | null; meeting_unit_price: number | null }>("payroll_offices?select=id,office_number,office_type,meeting_unit_price");
  const officeNumOfId = new Map(offices.map((o) => [o.id, o.office_number]));
  const empRows = await restAll<EmploymentFields & { office_id: string; employee_number: string; salary_type: string | null }>(
    "payroll_employees?select=id,office_id,employee_number,salary_type,employment_status,resignation_date");
  const settings = await restAll<{ key: string; value: Record<string, unknown> }>("payroll_app_settings?select=key,value&key=in.(meeting_fee_unpaid_offices,meeting_unit_prices)&order=key");
  const inp: Inputs = {
    form, l1, l2,
    officeUnit: new Map(offices.map((o) => [o.office_number, Number(o.meeting_unit_price ?? 0)])),
    officeType: new Map(offices.map((o) => [o.office_number, o.office_type ?? ""])),
    emps: new Map(empRows.map((e) => [empKey(officeNumOfId.get(e.office_id) ?? "", e.employee_number), e])),
    prices: (settings.find((s) => s.key === "meeting_unit_prices")?.value?.prices ?? {}) as Record<string, MeetingUnitPrices>,
    unpaid: new Set((settings.find((s) => s.key === "meeting_fee_unpaid_offices")?.value?.offices ?? []) as string[]),
  };
  if (!form.length) { console.log("★ 書式の会議行が 0 件。列名・条件を疑う (0 件と出さない)"); process.exit(1); }
  const rows = buildRows(inp);

  const neg = negativeControl(inp, rows);
  console.log("\n負のコントロール (読み込んだ写しを壊して 突き合わせから通す。DB もファイルも触らない):");
  for (const l of neg.lines) console.log("  " + l);

  const counts = countOf(rows);
  const withForm = rows.filter((r) => r.countYen + r.timeYen > 0).length;
  console.log(`\n母数: 対象月 ${months.join(",")} / 書式の会議行 ${form.length} 行 (値あり ${form.filter(hasValue).length})`);
  const nullPm = rows.filter((r) => inp.form.some((f) => f.record_type === "km" && /^会議[123]件数$/.test(f.item_name) && f.numeric_value == null
    && keyOf(f.office_number, f.employee_number, f.processing_month) === r.key));
  console.log(`  (参考) 会議N件数 の値が null の行がある人月 ${nullPm.length} — ★ 当方は 1 件と数えて払っている (computeMeetingFee の numeric_value ?? 1)。型: ${[...new Set(nullPm.map((r) => r.type))].join(" / ") || "-"}`);
  console.log(`  書式・①・② のどれかに会議がある パートの人月 ${rows.length} (うち 書式に会議がある ${withForm} / ① が払っている ${rows.filter((r) => (r.l1 ?? 0) > 0).length} / ② が払っている ${rows.filter((r) => (r.l2 ?? 0) > 0).length})`);
  for (const [k, c] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    const rs = rows.filter((r) => r.type === k);
    const yen = rs.reduce((s, r) => s + (r.countYen + r.timeYen) - (r.l2 ?? 0), 0);
    console.log(`  ${k.padEnd(22)} ${String(c).padStart(5)}  書式の額 − ② ${Math.round(yen).toLocaleString()}円`);
  }
  console.log(`  (参考) 件数欄に円が入っている人月 ${rows.filter((r) => r.yenInCount).length} — 100 以上は円とみなす規則で救われている分 (memory: payroll_meeting_count_field_has_yen)`);

  // 単価を決め打ちせず 逆算して見る: 書式の件数が 1 種類で 時間が無い人月の ① 会議費 ÷ 件数
  console.log("\n単価の逆算 (書式が 会議1 だけ・時間なし・① が払っている人月の ① 会議費 ÷ 件数。事業所ごと):");
  const unit = new Map<string, Map<number, number>>();
  for (const r of rows) {
    if (r.timeYen || !r.counts || !(r.l1 ?? 0) || r.yenInCount) continue;
    const kinds = new Set(inp.form.filter((f) => keyOf(f.office_number, f.employee_number, f.processing_month) === r.key && hasValue(f)).map((f) => f.item_name));
    if (kinds.size !== 1 || !kinds.has("会議1件数")) continue;
    const u = Math.round((r.l1 ?? 0) / r.counts);
    const m = unit.get(r.office) ?? new Map<number, number>();
    m.set(u, (m.get(u) ?? 0) + 1);
    unit.set(r.office, m);
  }
  for (const [o, m] of [...unit].sort()) console.log(`  ${o}  ${[...m].map(([u, n]) => `${u}円×${n}`).join(" / ")}${m.size > 1 ? "  ★ 単価が 2 通り以上" : ""}`);

  if (DETAIL) {
    console.log(`\n--- ${DETAIL} ---`);
    for (const r of rows.filter((r) => r.type === DETAIL)) console.log(`  ${r.key} 書式 件数${r.counts} ${r.countYen}+時間${r.timeYen}${r.yenInCount ? " (件数欄に円)" : ""} / ① ${r.l1} / ② ${r.l2}`);
  }

  let failed = false;
  if (existsSync(BASELINE_PATH) && !UPDATE) {
    const b = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    console.log("\n--- 基準値との比較 ---");
    if (b.months?.join(",") !== months.join(",")) console.log(`  対象月が変わった (${b.months?.join(",")}→${months.join(",")})。FAIL にしない。中身を見てから --update`);
    else {
      const keys = new Set([...Object.keys(b.counts), ...Object.keys(counts)]);
      const worse = [...keys].filter((k) => k !== "一致" && (counts[k] ?? 0) > (b.counts[k] ?? 0));
      const better = [...keys].filter((k) => k !== "一致" && (counts[k] ?? 0) < (b.counts[k] ?? 0));
      console.log(`  ★ 悪化 ${worse.length} / 改善 ${better.length}`);
      for (const k of worse) console.log(`  ★ 悪化 ${k} ${b.counts[k] ?? 0}→${counts[k]}`);
      for (const k of better) console.log(`  改善   ${k} ${b.counts[k]}→${counts[k] ?? 0}`);
      failed = worse.length > 0;
    }
  } else if (!UPDATE) console.log("\n基準値ファイルがありません。--update で作成してください");
  if (UPDATE) {
    const prev = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
    writeFileSync(BASELINE_PATH, JSON.stringify({ _readme: prev._readme ?? "(新規)", updated_at: new Date().toISOString(), months, total: rows.length, counts }, null, 2) + "\n");
    console.log(`\n基準値を更新しました: ${BASELINE_PATH}`);
  }
  if (!neg.ok) { console.log("★ 負のコントロールが通らないので PASS を出しません"); process.exit(1); }
  if (failed) { console.log("★ FAIL: 一致以外の型が増えました。--detail=<型> で見てください"); process.exit(1); }
  console.log("PASS (★ 0 件 PASS ではない。基準値の件数を許容したうえでの PASS)");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e); process.exit(1); });
