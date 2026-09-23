/**
 * 事業所書式「Web 入力」が 給与に届くか の常設検査
 *
 *   npm run check:office-input-flow
 *   npm run check:office-input-flow -- --update   ★ 基準値方式の数だけ更新
 *
 * ── 何を見るか ────────────────────────────────────────────────────────────
 *   段1 射影 (fixture)   /office-input の 1 行を OfficeFormRecord に射影し、
 *                        **画面と同じ payroll-calc の関数** に通して 金額が動くことを示す。
 *                        ★ 負のコントロール付き (わざと壊して鳴ることを確認する)。
 *   段2 合流 (fixture)   (職員 × 項目) 単位で Web が CSV に勝つこと / Web 0 行なら
 *                        出力が CSV と完全に同じであること。
 *   段3 実データ         DB の payroll_office_form_records と payroll_office_input_entries を
 *                        実際に合流させ、
 *                          ・Web 0 行 → 現行と 1 行も変わらない (回帰していない証明)
 *                          ・Web 1 行以上 → その (職員 × 項目) が本当に合流後に存在し、
 *                            かつ 金額に届く項目かを 1 件ずつ出す
 *                        職員が引けない (office_number, employee_number) は基準値方式。
 *   段4 カタログ         画面で入力できるが payroll-calc に読む側が無い項目を列挙する。
 *                        ★ 「緑 = 全項目が給与に届く」ではない。ここが その差。
 *
 * ── 基準値方式 (なぜこの数か) ──────────────────────────────────────────────
 *   unresolvedPairs  書式に居るが payroll_employees に居ない (事業所, 職員番号) の組。
 *                    2026-09-23 実測で 3 組 / 14 行 (全 673 組中)。入社直後で職員マスタに
 *                    未登録とみられる (番号が 260802/260803 = 入社日ベース)。
 *                    ★ これは Web 入力の問題ではなく 職員マスタ側の欠落。
 *                    ★ 登録されれば 0 になる。増えたら落ちる。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  computeMeetingFee, computeChildcareAllowance, trainingMinutes, meetingMinutes,
  hrdTrainingMinutes, shoninshaTrainingMinutes, trainingMinutesByDay,
  officeFormPaidLeaveDays, type OfficeFormRecord,
} from "@/lib/payroll/payroll-calc";
import {
  officeInputEntryToFormRecord, mergeOfficeFormSources, normEmp,
  officeInputEntriesToFormRecords, RECORD_TYPE_BY_CATEGORY,
} from "@/lib/office-input/to-form-records";
import { OFFICE_INPUT_ITEMS, type OfficeInputEntry } from "@/lib/office-input/types";

const UPDATE = process.argv.includes("--update");
const BASELINE_PATH = "scripts/check-office-input-flow-baseline.json";

let failed = 0;
const fail = (msg: string) => { console.log(`  x ${msg}`); failed++; };
const pass = (msg: string) => console.log(`  o ${msg}`);
function expect(cond: boolean, msg: string) { if (cond) pass(msg); else fail(msg); }

/** テスト用の Web 入力 1 行を作る */
function entry(p: Partial<OfficeInputEntry> & Pick<OfficeInputEntry, "category" | "item_name">): OfficeInputEntry {
  return {
    id: "e1", tenant_id: "kt-group", employee_id: "emp-1", billing_month: "2026-06",
    numeric_value: null, time_minutes: null, date_value: null,
    start_time: null, end_time: null, break_minutes: null,
    child_name: null, reference_month: null, notes: null,
    created_at: "", updated_at: "", ...p,
  } as OfficeInputEntry;
}

// === 段1 射影 — 画面と同じ関数に通して金額が動くか ========================
console.log("\n-- 段1 射影 (fixture): /office-input の 1 行 → 給与の金額 --");

// (1) 数値項目 (会議1件数) → 会議費
{
  const r = officeInputEntryToFormRecord(entry({ category: "数値項目", item_name: "会議1件数", numeric_value: 3 }), "100");
  expect(r.record_type === "km", `数値項目 → record_type "km" (実際: "${r.record_type}")`);
  const yen = computeMeetingFee([r], 1150);
  expect(yen === 4500, `会議1件数 3 件 → 会議費 4,500 円 (実際: ${yen})`);
  // ★ 負のコントロール: record_type を取り違えると 件数が 1 件に潰れる
  const broken = computeMeetingFee([{ ...r, record_type: "leave" }], 1150);
  expect(broken !== yen, `負のコントロール: record_type を "leave" にすると値が変わる (${broken} != ${yen})`);
}

// (2) 日付項目 (有給) → 有給日数
{
  const days = [3, 7, 18].map((d) =>
    officeInputEntryToFormRecord(entry({ category: "日付項目", item_name: "有給", date_value: `2026-06-${String(d).padStart(2, "0")}` }), "100"));
  expect(days[0].record_type === "leave", `日付項目 → record_type "leave"`);
  expect(days[0].item_date === "6/3", `date_value 2026-06-03 → item_date "6/3" (実際: "${days[0].item_date}")`);
  const half = officeInputEntryToFormRecord(entry({ category: "日付項目", item_name: "半有給", date_value: "2026-06-20" }), "100");
  const d = officeFormPaidLeaveDays([...days, half]);
  expect(d === 3.5, `有給 3 日 + 半有給 1 日 → 3.5 日 (実際: ${d})`);
  expect(/^\d{1,2}\/\d{1,2}$/.test(days[0].item_date ?? ""), `item_date が "M/D" 書式 (ISO のままにしない)`);
}

// (3) 日時項目 (研修 / HRD研修 / 初任者研修 / 会議) → 研修時間・会議時間
{
  const mk = (name: string, day: number, s: string, e: string, br: number | null) =>
    officeInputEntryToFormRecord(entry({
      category: "日時項目", item_name: name, date_value: `2026-06-${String(day).padStart(2, "0")}`,
      start_time: `${s}:00`, end_time: `${e}:00`, break_minutes: br,
    }), "100");
  const kenshu = mk("研修", 5, "18:30", "20:00", 0);
  const hrd = mk("HRD研修", 9, "09:00", "12:00", 30);
  const shonin = mk("初任者研修", 12, "09:30", "17:30", 60);
  const kaigi = mk("会議", 17, "14:00", "15:00", null);
  expect(kenshu.record_type === "training", `日時項目 → record_type "training"`);
  expect(kenshu.start_time === "18:30", `TIME "18:30:00" → "18:30" (実際: "${kenshu.start_time}")`);
  expect(hrd.break_time === "00:30", `break_minutes 30 → break_time "00:30" (実際: "${hrd.break_time}")`);
  const tm = trainingMinutes([kenshu, hrd, shonin, kaigi]);
  expect(tm === 90 + 150, `研修時間 = 研修90分 + HRD150分 = 240 分 (実際: ${tm})`);
  expect(hrdTrainingMinutes([kenshu, hrd]) === 150, `HRD だけ 150 分`);
  expect(shoninshaTrainingMinutes([shonin]) === 420, `初任者研修 420 分 (休憩60分控除)`);
  expect(meetingMinutes([kaigi]) === 60, `会議時間 60 分`);
  const byDay = trainingMinutesByDay([kenshu, hrd, kaigi], "202606");
  expect(byDay.get("2026/06/09") === 150, `日次の研修時間 2026/06/09 = 150 分 (残業判定に効く。実際: ${byDay.get("2026/06/09")})`);
  // ★ 負のコントロール: item_date を ISO にすると 日次の研修時間が丸ごと落ちる
  const iso = trainingMinutesByDay([{ ...hrd, item_date: "2026-06-09" }], "202606");
  expect(iso.size === 0, `負のコントロール: item_date が ISO だと日次集計が 0 件になる (実際: ${iso.size})`);
}

// (4) 育児手当 → 保育手当
{
  const r = officeInputEntryToFormRecord(entry({
    category: "育児手当", item_name: "保育料", numeric_value: 10000,
    child_name: "テスト太郎", reference_month: "2026-04",
  }), "100");
  expect(r.record_type === "childcare", `育児手当 → record_type "childcare"`);
  expect(r.year_month === "2026/04", `reference_month "2026-04" → year_month "2026/04" (実際: "${r.year_month}")`);
  expect(r.amount === 10000, `numeric_value → amount`);
  const yen = computeChildcareAllowance([r], "月給", new Map(), "100", "202606");
  expect(yen === 4000, `保育料 10,000 円 x 40% = 4,000 円 (実際: ${yen})`);
  // ★ 負のコントロール: year_month がハイフンのままだと normalizeYM が効かず参照月がバラける
  const badYm = { ...r, year_month: "2026-04" };
  const badGroups = computeChildcareAllowance([badYm, { ...r, year_month: "2026/04" }], "月給", new Map(), "100", "202606");
  expect(badGroups === 8000 && r.year_month === "2026/04",
    `負のコントロール: ハイフン形と スラッシュ形は別の参照月として扱われる (${badGroups})`);
}

// (5) 数値項目 (出張km)
{
  const r = officeInputEntryToFormRecord(entry({ category: "数値項目", item_name: "出張km", numeric_value: 207.3 }), "100");
  expect(r.record_type === "km" && r.numeric_value === 207.3, `出張km 207.3 が numeric_value に入る`);
}

// === 段2 合流 ============================================================
console.log("\n-- 段2 合流 (fixture): (職員 x 項目) 単位で Web が CSV に勝つ --");
{
  const mkCsv = (num: string, type: string, name: string, date: string | null, val: number | null): OfficeFormRecord => ({
    employee_number: num, record_type: type, item_name: name, item_date: date, numeric_value: val,
    start_time: null, end_time: null, break_time: null, year_month: null, child_name: null, amount: null,
  });
  const csv: OfficeFormRecord[] = [
    mkCsv("0100", "km", "出張km", null, 50),
    mkCsv("100", "leave", "有給", "6/1,6/2", null),
    mkCsv("200", "km", "出張km", null, 80),
  ];
  const web = [officeInputEntryToFormRecord(entry({ category: "数値項目", item_name: "出張km", numeric_value: 207.3 }), "100")];
  const m = mergeOfficeFormSources(csv, web);
  expect(m.csvDropped === 1, `職員100 の 出張km だけ CSV を 1 行落とす (実際: ${m.csvDropped})`);
  const mine = m.records.filter((r) => normEmp(r.employee_number) === "100" && r.item_name === "出張km");
  expect(mine.length === 1 && mine[0].numeric_value === 207.3, `職員100 の 出張km は Web の 207.3 だけになる`);
  expect(m.records.some((r) => normEmp(r.employee_number) === "100" && r.item_name === "有給"),
    `同じ職員でも 別項目 (有給) の CSV は残る`);
  expect(m.records.some((r) => normEmp(r.employee_number) === "200" && r.item_name === "出張km"),
    `別職員 (200) の 出張km の CSV は残る`);
  expect(normEmp("0100") === normEmp("100"), `先頭ゼロの職員番号も同一視される`);

  const none = mergeOfficeFormSources(csv, []);
  expect(none.records === csv, `Web が 0 行なら CSV の配列をそのまま返す (= 現行と完全に同じ)`);
}

// === 段4 カタログ (段3 より先に出す。DB 無しでも出せるので) ===============
console.log("\n-- 段4 カタログ: 入力できるが給与に届かない項目 --");
/** payroll-calc が実際に読む item_name の判定 (grep で確認した条件を写し取ったもの) */
const REACHES_PAYROLL = (name: string): boolean =>
  name === "出張km" || name === "通勤km"
  || /会議[123]/.test(name)
  || name.includes("有給")
  || name === "特休"
  || name.startsWith("半")                       // 半日換算 (computeSummary の halfDayNums)
  || name === "研修" || name === "HRD研修" || name === "初任者研修" || name === "会議"
  || name.includes("保育料") || name.includes("幼稚園") || name === "学童";
const reach = OFFICE_INPUT_ITEMS.filter((i) => REACHES_PAYROLL(i.name)).map((i) => i.name);
const noReach = OFFICE_INPUT_ITEMS.filter((i) => !REACHES_PAYROLL(i.name)).map((i) => i.name);
console.log(`  金額に届く   ${reach.length} 項目: ${reach.join(" / ")}`);
console.log(`  届かない     ${noReach.length} 項目: ${noReach.join(" / ")}`);
console.log(`  ⚠ 届かない項目は 画面で入力できても 給与に一切出ません。`);
console.log(`    消すか 読む側を作るかは user 判断 (勝手に消さない)。`);
for (const cat of Object.keys(RECORD_TYPE_BY_CATEGORY) as (keyof typeof RECORD_TYPE_BY_CATEGORY)[]) {
  const n = OFFICE_INPUT_ITEMS.filter((i) => i.category === cat).length;
  console.log(`    ${cat.padEnd(6)} ${String(n).padStart(2)} 項目 → record_type "${RECORD_TYPE_BY_CATEGORY[cat]}"`);
}

// === 段3 実データ ========================================================
console.log("\n-- 段3 実データ: DB の CSV 取込と Web 入力を実際に合流させる --");
const env: Record<string, string> = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
type Baseline = { _readme: string[]; unresolvedPairs: number; unresolvedRows: number };
const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

if (!env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log("  ⚠ SUPABASE_SERVICE_ROLE_KEY が無いので段3はスキップ (anon だと RLS で 0 行になり誤判定する)");
  console.log("  ⚠ 段3 未実施 = 「合格」ではありません");
} else {
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const page = async <T,>(table: string, select: string): Promise<T[]> => {
    const out: T[] = [];
    for (let f = 0; ; f += 1000) {
      const { data, error } = await sb.from(table).select(select).order("id").range(f, f + 999);
      if (error) throw new Error(`${table} 取得失敗: ${error.message}`);
      out.push(...((data ?? []) as T[]));
      if (!data || data.length < 1000) break;
    }
    return out;
  };
  type Rec = OfficeFormRecord & { office_number: string; processing_month: string };
  const csvRows = await page<Rec>("payroll_office_form_records",
    "id,office_number,employee_number,processing_month,record_type,item_name,item_date,numeric_value,start_time,end_time,break_time,year_month,child_name,amount");
  const webRows = await page<OfficeInputEntry>("payroll_office_input_entries", "*");
  const emps = await page<{ id: string; employee_number: string; office_id: string }>("payroll_employees", "id,employee_number,office_id");
  const offices = await page<{ id: string; office_number: string }>("payroll_offices", "id,office_number");
  const officeNumById = new Map(offices.map((o) => [o.id, o.office_number]));
  console.log(`  分母: CSV 取込 ${csvRows.length} 行 / Web 入力 ${webRows.length} 行 / 職員 ${emps.length} 名 / 事業所 ${offices.length}`);

  // (1) 職員が引けない (事業所, 職員番号) — 基準値方式
  const empKey = new Set(emps.map((e) => `${officeNumById.get(e.office_id) ?? "?"}|${normEmp(e.employee_number)}`));
  const csvPairs = new Set(csvRows.map((r) => `${r.office_number}|${normEmp(r.employee_number)}`));
  const unresolved = [...csvPairs].filter((k) => !empKey.has(k));
  const unresolvedRows = csvRows.filter((r) => !empKey.has(`${r.office_number}|${normEmp(r.employee_number)}`)).length;
  console.log(`  職員が引けない (事業所, 職員番号): ${unresolved.length} 組 / ${unresolvedRows} 行 (基準値 ${baseline.unresolvedPairs} 組 / ${baseline.unresolvedRows} 行)`);
  if (unresolved.length > 0) console.log(`    ${unresolved.join(", ")}`);
  if (UPDATE) {
    baseline.unresolvedPairs = unresolved.length; baseline.unresolvedRows = unresolvedRows;
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n", "utf8");
    console.log("  → 基準値を更新しました");
  } else {
    expect(unresolved.length <= baseline.unresolvedPairs,
      `職員が引けない組が基準値から増えていない (${unresolved.length} <= ${baseline.unresolvedPairs})`);
  }

  // (2) 事業所 x 月ごとに実際に合流させる
  const empNumById = new Map(emps.map((e) => [e.id, e.employee_number]));
  const officeIdByEmpId = new Map(emps.map((e) => [e.id, e.office_id]));
  const csvByOm = new Map<string, Rec[]>();
  for (const r of csvRows) {
    const k = `${r.office_number}|${r.processing_month}`;
    csvByOm.set(k, [...(csvByOm.get(k) ?? []), r]);
  }
  const webByOm = new Map<string, OfficeInputEntry[]>();
  for (const w of webRows) {
    const on = officeNumById.get(officeIdByEmpId.get(w.employee_id) ?? "") ?? "?";
    const k = `${on}|${w.billing_month.replace("-", "")}`;
    webByOm.set(k, [...(webByOm.get(k) ?? []), w]);
  }

  if (webRows.length === 0) {
    // Web 0 行のとき: 合流しても 1 行も変わらないこと (= 今回の改修が回帰していない証明)
    let same = 0, diff = 0;
    for (const [k, rows] of csvByOm) {
      const m = mergeOfficeFormSources(rows, []);
      if (m.records.length === rows.length && m.csvDropped === 0 && m.records.every((r, i) => r === rows[i])) same++;
      else { diff++; console.log(`  x ${k} で出力が変わった`); }
    }
    expect(diff === 0, `Web 入力 0 行 → 全 ${same} (事業所 x 月) で出力が CSV と 1 行も変わらない`);
    console.log("  ⚠ Web 入力が 0 行なので「Web の値が給与に出る」ことは **実データでは示せていません**。");
    console.log("    実データで示すには: node migrations/office_input_flow_demo.mjs --execute");
    console.log("    (サンプルを入れて前後を出し、必ず --delete --execute で撤去する)");
  } else {
    let reached = 0, missing = 0, notMoney = 0;
    for (const [k, entries] of webByOm) {
      const { records: webRecs, unresolved: un } = officeInputEntriesToFormRecords(entries, empNumById);
      if (un.length > 0) fail(`${k}: 職員が引けない Web 入力 ${un.length} 件 (= 給与から黙って落ちる)`);
      const m = mergeOfficeFormSources(csvByOm.get(k) ?? [], webRecs);
      for (const w of webRecs) {
        const hit = m.records.some((r) => normEmp(r.employee_number) === normEmp(w.employee_number)
          && r.item_name === w.item_name && r.record_type === w.record_type);
        if (!hit) { missing++; fail(`${k}: 職員${w.employee_number} ${w.item_name} が合流後に居ない`); }
        else if (!REACHES_PAYROLL(w.item_name)) { notMoney++; console.log(`  ⚠ ${k}: 職員${w.employee_number} ${w.item_name} — 合流はするが payroll-calc に読む側が無い`); }
        else reached++;
      }
      console.log(`  ${k}: Web ${webRecs.length} 行 採用 / CSV ${m.csvDropped} 行 差し替え / 合流後 ${m.records.length} 行`);
    }
    expect(missing === 0, `Web 入力 ${reached + notMoney + missing} 行がすべて合流後に存在する`);
    console.log(`  → 金額に届く ${reached} 行 / 届かない項目 ${notMoney} 行`);
  }
}

// === 結果 ================================================================
console.log(`\n${"=".repeat(70)}`);
console.log("この検査が見ていないもの:");
console.log("  ・/office-input の画面そのもの (入力 UI の挙動)。射影から下だけを見ている");
console.log("  ・payroll_office_form_records の CSV 取込そのもの (office-form-parser)");
console.log("  ・届かない項目を「消すべきか」の判断 — 一覧を出すだけ");
console.log("  ・Web 入力は 在職者しか入力できない (listEmployeesByOffice が employment_status で絞る)。");
console.log("    給与計算は 退職日が月初以降の退職者も含めるので、その差は この検査の対象外");
console.log(failed === 0 ? "\n[PASS]" : `\n[FAIL] ${failed} 件`);
process.exit(failed === 0 ? 0 : 1);
