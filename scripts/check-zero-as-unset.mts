/**
 * check:zero-as-unset — 「未設定」が「0 円」として保存されていて、計算が黙って 0 円を払う箇所を数える。
 *
 * 【なぜ作ったか】(2026-09-26 給与A。内海典子の居宅給与設定が全部 0 だった件から)
 * migrations/seed_sodegaura_kyotaku_v2.mjs は内海を **意図的に NULL (未設定)** にしていたが、
 * migrations/payroll_salary_history.sql の初期投入が `COALESCE(e.kyotaku_honnin_kyu, 0)` で写したため
 * **NULL が 0 (給与 0 円) に化けた**。0 円は正しい値にも見えるので 落ちない・気づけない。
 * 列が `NOT NULL DEFAULT 0` だと そもそも「未設定」を表せない (payroll_salary_settings /
 * payroll_offices の単価 / payroll_employees.paid_leave_unit_price はこの形)。
 *
 * 【見ているもの】★ 金額に効き、かつ 0 と未設定で意味が変わるものだけ (表示・合計の ?? 0 は対象外)
 *   A 居宅の給与設定 (payroll_kyotaku_salary) 最新行の 8 項目が全部 0 の職員
 *   B 訪問介護の月給・在職者の給与設定 (payroll_salary_settings) 最新行の 本人給・職能給・事務時給が全部 0
 *   C 同じく 月給・在職者で 給与設定の行が 1 件も無い (未設定がそのまま見える形。参考として同じ基準値で見る)
 *   D 実在の訪問介護事業所 (payroll_offices。9999… の試験用・本社・居宅は除く) の 出張単価・通勤単価 が 0
 *   E 居宅の出勤簿 (payroll_kyotaku_attendance_records) で 休憩 0 分・6 時間超の日
 *     (訪問介護の出勤簿で「休憩空欄 → 0」が +60 分残業に化けた件と同じ型。居宅は今 0 件)
 *   ※ payroll_employees.paid_leave_unit_price=0 は在職者の過半 (2026-09-26 で 395/733) で、
 *     有給の付与ごとの単価が優先されるため 0 でも金額に効かないことが多い。件数だけ参考に出す (合否に入れない)。
 *
 * 【基準値方式】0 を目指す検査ではない。★ いまの対象者を固定し、**増えたら (新しい人が出たら) 落ちる**。
 *   ★ 2026-09-26 の基準: A 1 名 (内海典子。user 判断待ち) / B 4 名 / C 0 / D 0 / E 0
 *   ★ C は 0。「月給・在職 242 名のうち 9 名は設定行なし」と言われていた 9 名は **全員 居宅** で、
 *     居宅は payroll_kyotaku_salary を使うので payroll_salary_settings に行が無いのが正しい (誤警報だった)
 *   ★ 減るのは良い (直った)。--update は **原因を確かめてから**。悪化したまま更新すると穴を焼き付ける。
 *
 * 【負のコントロール】SNAPSHOT (取得結果の写し) を壊して鳴ることを確かめる。★ DB は壊さない。
 *   負のコントロールの結果 (2026-09-26):
 *   ```
 *   SNAPSHOT の写しを 3 か所壊す
 *     ① やわた 1272404508 の 通勤単価を 0   ② 居宅 天野恵子 の給与設定 8 項目を 0
 *     ③ 居宅出勤簿の 1 日を 9:00-18:00・休憩 0 分
 *   → exit 1。「A 1→2 + 天野恵子 / D 0→1 + 1272404508 通勤単価 / E 0→1 + 三枝裕紀子 2026-07-11」と名指しで出た
 *   元の SNAPSHOT に戻すと exit 0 (PASS)
 *   ```
 *
 * 使い方:
 *   npx tsx scripts/check-zero-as-unset.mts
 *   SNAPSHOT=<path.json> npx tsx scripts/check-zero-as-unset.mts   # 1 回目は保存、2 回目から使い回す
 *   npx tsx scripts/check-zero-as-unset.mts --update                # 基準値の更新 (原因を確かめてから)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { restAll } from "./_rest.mjs";

// ★ payroll_calc_results (計算結果) は使わない。再計算しても件数は変わらない (動いたら設定の表が書き換わった)
const BASELINE = new URL("./check-zero-as-unset-baseline.json", import.meta.url);
const UPDATE = process.argv.includes("--update");
const SNAPSHOT = process.env.SNAPSHOT ?? "";

type Office = { id: string; office_number: string; office_type: string | null; short_name: string | null;
  travel_unit_price: number | null; commute_unit_price: number | null };
type Emp = { id: string; office_id: string; employee_number: string; name: string;
  salary_type: string | null; job_type: string | null; employment_status: string | null; paid_leave_unit_price: number | null };
type Sal = { employee_id: string; effective_from: string; base_personal_salary: number | null;
  skill_salary: number | null; office_work_hourly_rate: number | null };
type KSal = { employee_id: string; effective_from: string; honnin_kyu: number; shokuno_kyu: number; kotei_zangyo: number;
  shikaku_teate: number; kotei: number; tokutei_shogu: number; kaigo_rate: number; shien_rate: number };
type KAtt = { employee_id: string; work_date: string; start_time: string | null; end_time: string | null; break_minutes: number | null };
type Snap = { offices: Office[]; emps: Emp[]; sal: Sal[]; ksal: KSal[]; katt: KAtt[] };

console.log("=== check:zero-as-unset  「未設定」が 0 円として保存されている箇所 ===\n");

let snap: Snap;
if (SNAPSHOT && existsSync(SNAPSHOT)) {
  snap = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snap;
  console.log(`(SNAPSHOT を使いました: ${SNAPSHOT})`);
} else {
  snap = {
    offices: await restAll<Office>("payroll_offices?select=id,office_number,office_type,short_name,travel_unit_price,commute_unit_price"),
    emps: await restAll<Emp>("payroll_employees?select=id,office_id,employee_number,name,salary_type,job_type,employment_status,paid_leave_unit_price"),
    sal: await restAll<Sal>("payroll_salary_settings?select=employee_id,effective_from,base_personal_salary,skill_salary,office_work_hourly_rate"),
    ksal: await restAll<KSal>("payroll_kyotaku_salary?select=employee_id,effective_from,honnin_kyu,shokuno_kyu,kotei_zangyo,shikaku_teate,kotei,tokutei_shogu,kaigo_rate,shien_rate"),
    katt: await restAll<KAtt>("payroll_kyotaku_attendance_records?select=employee_id,work_date,start_time,end_time,break_minutes"),
  };
  if (SNAPSHOT) { writeFileSync(SNAPSHOT, JSON.stringify(snap)); console.log(`(SNAPSHOT に保存しました: ${SNAPSHOT})`); }
}

const officeNo = new Map(snap.offices.map((o) => [o.id, o.office_number]));
const empById = new Map(snap.emps.map((e) => [e.id, e]));
/** 職員番号は事業所をまたぐと重複するので 必ず 事業所番号と対で名指しする */
const who = (e: Emp | undefined, id: string) => (e ? `${officeNo.get(e.office_id) ?? "?"}|${e.employee_number} ${e.name}` : `employee_id=${id}`);
const n0 = (v: number | null | undefined) => v != null && Number(v) === 0;
const latestOf = <T extends { employee_id: string; effective_from: string }>(rows: T[]) => {
  const m = new Map<string, T>();
  for (const r of rows) { const c = m.get(r.employee_id); if (!c || r.effective_from > c.effective_from) m.set(r.employee_id, r); }
  return m;
};

const found: Record<string, string[]> = { A: [], B: [], C: [], D: [], E: [] };

// A 居宅の給与設定 最新行が全部 0
for (const [id, s] of latestOf(snap.ksal)) {
  const all0 = [s.honnin_kyu, s.shokuno_kyu, s.kotei_zangyo, s.shikaku_teate, s.kotei, s.tokutei_shogu, s.kaigo_rate, s.shien_rate].every(n0);
  if (all0) found.A.push(who(empById.get(id), id));
}

// B / C 訪問介護の月給・在職者
const salLatest = latestOf(snap.sal);
const monthly = snap.emps.filter((e) => e.salary_type === "月給" && e.employment_status === "在職者" && e.job_type !== "居宅介護支援");
for (const e of monthly) {
  const s = salLatest.get(e.id);
  if (!s) { found.C.push(who(e, e.id)); continue; }
  if (n0(s.base_personal_salary) && n0(s.skill_salary) && n0(s.office_work_hourly_rate)) found.B.push(who(e, e.id));
}

// D 実在の訪問介護事業所の 出張・通勤単価 0 (試験用 9999…・本社・居宅 は対象外)
const realVisit = snap.offices.filter((o) => o.office_type === "訪問介護" && /^\d{10}$/.test(o.office_number) && !o.office_number.startsWith("99999"));
for (const o of realVisit) {
  if (n0(o.travel_unit_price)) found.D.push(`${o.office_number} 出張単価`);
  if (n0(o.commute_unit_price)) found.D.push(`${o.office_number} 通勤単価`);
}

// E 居宅の出勤簿 休憩0・6時間超
const toMin = (t: string | null) => { const m = /^(\d{1,2}):(\d{2})/.exec(t ?? ""); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
for (const r of snap.katt) {
  const s = toMin(r.start_time), e = toMin(r.end_time);
  if (s == null || e == null) continue;
  if (n0(r.break_minutes) && e - s > 360) found.E.push(`${who(empById.get(r.employee_id), r.employee_id)} ${r.work_date}`);
}

const LABEL: Record<string, string> = {
  A: "居宅の給与設定が全部0 (payroll_kyotaku_salary 最新行)",
  B: "月給・在職で 本人給・職能給・事務時給が全部0 (payroll_salary_settings 最新行)",
  C: "月給・在職で 給与設定の行が無い",
  D: "実在の訪問介護事業所で 出張・通勤単価が0 (payroll_offices)",
  E: "居宅の出勤簿で 休憩0分・6時間超の日",
};
const denom: Record<string, string> = {
  A: `分母 居宅の給与設定がある職員 ${latestOf(snap.ksal).size} 名`,
  B: `分母 月給・在職 (居宅を除く) ${monthly.length} 名`,
  C: `分母 月給・在職 (居宅を除く) ${monthly.length} 名`,
  D: `分母 実在の訪問介護事業所 ${realVisit.length} × 2 列`,
  E: `分母 居宅の出勤簿 ${snap.katt.length} 行`,
};
for (const k of Object.keys(LABEL)) {
  console.log(`${k} ${LABEL[k]}: ${found[k].length} 件   (${denom[k]})`);
  for (const x of found[k].slice(0, 20)) console.log(`     ${x}`);
}
const leave0 = snap.emps.filter((e) => e.employment_status === "在職者" && n0(e.paid_leave_unit_price)).length;
console.log(`\n(参考・合否に入れない) 在職者の 職員マスタ有給単価 = 0: ${leave0} / ${snap.emps.filter((e) => e.employment_status === "在職者").length} 名`);

// ── 基準値との比較: 名指しで「新しく出た人」を出す ──
if (UPDATE || !existsSync(BASELINE)) {
  writeFileSync(BASELINE, JSON.stringify({
    _readme: "check:zero-as-unset の基準値。★ 増えたら落ちる。減るのは良い。--update は原因を確かめてから。"
      + " 2026-09-26 時点: A=内海典子 (袖ケ浦居宅・user 判断待ち) / B=月給なのに role パートの 4 名 (salary_type の誤りか未設定か未確認) / C=0 (以前の「9名」は全員居宅で誤警報) / D=0 / E=0",
    ...found,
  }, null, 1) + "\n");
  console.log(`\n基準値を ${UPDATE ? "更新" : "作成"} しました`);
  process.exit(0);
}
const base = JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, string[]>;
let fail = false;
for (const k of Object.keys(LABEL)) {
  const before = new Set(base[k] ?? []);
  const added = found[k].filter((x) => !before.has(x));
  const removed = (base[k] ?? []).filter((x) => !found[k].includes(x));
  if (added.length) { fail = true; console.log(`\n★ ${k} が増えました (${before.size} → ${found[k].length}):`); for (const x of added) console.log(`     + ${x}`); }
  if (removed.length) console.log(`\n○ ${k} が減りました (直った可能性): ${removed.join(" / ")}  → 確かめてから --update`);
}
if (fail) { console.log("\n✗ FAIL  未設定が 0 円になっている人・箇所が増えました"); process.exit(1); }
console.log("\n✓ PASS  基準値より増えていません (A/B/C は既知の未解決。0 になったわけではない)");
