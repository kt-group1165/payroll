/**
 * 居宅 (ケアマネ) の給与計算を 総括表 (ケアマネ) と突き合わせる (2026-10-19)。手で回す診断 (check:all には入れない)。
 *
 *   npx tsx scripts/verify-kyotaku-soukatsu.mts <caremane_rows.json>
 *
 * <caremane_rows.json> = Box 01_総括表 の <拠点>_ケアマネ_YYYYMM を scratchpad にコピーして読んだもの (個人の金額なので repo には置かない)。
 *   ★ ファイルが無いときは「材料が無いので未実施」で終わる (合格ではない)。
 * user 判断 (2026-10-19): 居宅は 当方のやり方 (月遅れの請求を後の月に調整手当で払う) を正とする。
 *   総括表は 月遅れも含めた「提供月の担当件数」で その月に払うので、★ 突合では 月遅れの調整が無かったもの として当方を計算する
 *   (全部の実績を 提供月の翌月請求 = 通常 として数える)。
 *
 * 段A 式: 総括表の入力値 (本人給・職能給・固定残業・資格・勤続(固定)・特定処遇・介護単価・予防単価・介護件数・予防件数) を
 *         当方の calcSalary に入れて、ケアプラン手当・勤続手当・小計 が総括表と合うか。加算は入れない (段B で見る)
 * 段B 入力: 当方の DB (payroll_kyotaku_records = 介護アプリから写した実績) の 担当者別の件数・加算手当 が総括表と合うか (2026-06〜)
 * 当方に無い項目 (報奨金・認定調査・保障・役職手当・通勤費・欠勤控除 など) は 金額の合計を出す (= 今の差の内訳)
 * 段C 総支給: 給与設定・実績・出勤簿・単価は 当方の DB、手入力の欄 (予防件数・認定調査の件数・報奨金・その他手当) だけ 総括表の値を入れて
 *         当方の総支給 (月遅れの調整なし) を 総括表の総支給額 と比べる。当方に無い項目 (育児・通信・残業・移動・有給) は 総括表の値を足して比べる
 */
import { existsSync, readFileSync } from "node:fs";
import { calcSalary, type EmployeeSetting, type KyotakuAttendanceRecord, type KyotakuRecord, type ServiceUnit } from "../src/lib/payroll/kyotaku-calc.js";
import { getActiveKyotakuSalary, kyotakuSettingFromSalary, KYOTAKU_SALARY_COLUMNS, type KyotakuSalary } from "../src/lib/payroll/kyotaku-salary-history.js";
import { restAll } from "./_rest.mjs";

const SRC = process.argv[2] ?? process.env.CAREMANE_ROWS;
if (!SRC || !existsSync(SRC)) {
  console.log("材料 (総括表 ケアマネ の読み取り結果 caremane_rows.json) が無いので 未実施。★ 合格ではない");
  process.exit(0);
}
type Row = Record<string, number | string | null> & { office: string; file_month: string; name: string };
const rows = JSON.parse(readFileSync(SRC, "utf8")) as Row[];
const n = (v: unknown) => (v == null || v === "" || Number.isNaN(Number(v)) ? 0 : Number(v));
// 氏名の突き合わせ: 総括表と 介護アプリ (ケアマネ欄) で 字体が違う (渡邉/渡邊・齋藤/齊藤・髙/高)。1 文字ずつ 寄せてから比べる
const VARIANT: Record<string, string> = { 邊: "辺", 邉: "辺", 齊: "斉", 齋: "斉", 斎: "斉", 髙: "高", 﨑: "崎", 濵: "浜", 濱: "浜", 澤: "沢", 嶋: "島", 櫻: "桜" };
// 字体ではなく 別の字のもの (どちらかの入力の誤り。取り込みの NAME_ALIAS と同じ)
const ALIAS: Record<string, string> = { 坂本佑香: "坂本祐香" };
const nm = (s: unknown) => {
  const t = [...String(s ?? "").split("\n")[0].normalize("NFKC").replace(/[\s　]/g, "").replace(/[（(].*?[）)]/g, "")].map((c) => VARIANT[c] ?? c).join("");
  return ALIAS[t] ?? t;
};
const ym1 = (m: string) => `${m.slice(0, 4)}-${m.slice(4, 6)}-01`;
const next = (d: string) => { const t = new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 1)); return t.toISOString().slice(0, 10); };

// ── 段A 式 ──────────────────────────────────────────────
const items = { プラン手当: [0, 0], 勤続手当: [0, 0], 役職手当: [0, 0], 通勤費: [0, 0], 小計: [0, 0] } as Record<string, [number, number]>;
const planMiss: string[] = [], kinzokuMiss = new Map<string, number>();
let noRate = 0;
for (const r of rows) {
  const sm = ym1(r.file_month);
  const setting: EmployeeSetting = {
    staff_name: "X", honnin_kyu: n(r.本人給), shokuno_kyu: n(r.職能給), kotei_zangyo: n(r.固定残業手当), shikaku_teate: n(r.資格手当),
    kotei: n(r.勤続_固定), tokutei_shogu: n(r.特定処遇改善), kaigo_rate: r.介護単価 == null ? null : n(r.介護単価), shien_rate: r.予防単価 == null ? null : n(r.予防単価),
    // 総括表 (ケアマネ) の項目 (取り込みと同じ決め方: 固定が空なら 月給の社員は 本人給+職能給+固定残業・時給は 0 = 全額)
    care_plan_fixed: r.ケアプラン固定 != null ? n(r.ケアプラン固定) : n(r.本人給) > 0 ? n(r.本人給) + n(r.職能給) + n(r.固定残業手当) : 0,
    position_allowance: n(r.役職手当), kinzoku_type: r.勤続手当対象 === 2 ? 2 : 1, kinzoku_unit: r.勤続手当単価 == null ? null : n(r.勤続手当単価),
    commute_cap: n(r.通勤費) === 25000 && n(r.通勤距離) * n((r.consts as unknown as Record<string, number> | undefined)?.単価 ?? 12) > 25000 ? 25000 : null,
  };
  const recs: KyotakuRecord[] = Array.from({ length: n(r.介護件数) }, () => ({ service_month: sm, billing_month: next(sm), staff_name: "X", detail_row_no: "1", insurer_name: null, service_name: "居宅介護支援", unit_total: null, care_level: "要介護１" }));
  const yobou = n(r.予防件数) > 0 ? [{ service_month: sm, billing_month: next(sm), staff_name: "X", yobou1_count: n(r.予防件数), yobou2_count: 0 }] : [];
  const unit = n((r.consts as unknown as Record<string, number> | undefined)?.単価);
  const att = n(r.通勤距離) > 0 ? [{ staff_name: "X", work_date: `${sm.slice(0, 7)}-15`, business_km: 0, commute_km: n(r.通勤距離) }] : [];
  const b = calcSalary(recs, "X", sm, { settings: [setting], units: [], rates: [], yobouRecords: yobou, attendanceRecords: att, officeCommuteUnitPrice: unit });
  const theirsPlan = n(r.ケアプラン手当);
  // 単価の欄が無いブック (姉崎ムツミ 2026-01〜08。ケアプランの金額を直接入れていた) は 式で比べられない → 入力不足として数えない
  if (r.介護単価 == null && theirsPlan > 0) { noRate++; continue; }
  items.プラン手当[1]++; if (b.plan === theirsPlan) items.プラン手当[0]++; else if (planMiss.length < 12) planMiss.push(`${r.file_month} ${r.office} ${r.name}: 当方 ${b.plan} / 総括表 ${theirsPlan} (固定 ${r.ケアプラン固定 ?? "空"} / 本人+職能+固残 ${b.base})`);
  items.役職手当[1]++; if (b.position === n(r.役職手当)) items.役職手当[0]++;
  if (unit > 0 && n(r.通勤距離) > 0 && r.通勤費 != null) { items.通勤費[1]++; if (b.commute_teate === n(r.通勤費)) items.通勤費[0]++; }
  // 勤続手当の合計の欄が無いブック (2026-09 の一部など) は 固定 + 件数分 + 介護時間分 が合計
  const theirsKinzoku = r.勤続_合計 != null ? n(r.勤続_合計) : n(r.勤続_固定) + n(r.勤続_変動) + n(r.勤続_介護);
  items.勤続手当[1]++; if (b.kotei + b.kinzoku_variable === theirsKinzoku) items.勤続手当[0]++; else {
    const why = n(r.勤続_変動) ? "変動型 (件数×単価)" : n(r.勤続_介護) ? "介護時間型" : "その他";
    kinzokuMiss.set(why, (kinzokuMiss.get(why) ?? 0) + 1);
  }
  const ours = b.base + b.plan + b.shikaku + b.kotei + b.kinzoku_variable + b.tokutei + b.position;
  const theirs = n(r.本人給) + n(r.職能給) + n(r.固定残業手当) + theirsPlan + n(r.資格手当) + theirsKinzoku + n(r.特定処遇改善) + n(r.役職手当);
  items.小計[1]++; if (ours === theirs) items.小計[0]++;
}
console.log(`段A 式 (総括表の入力値を当方の計算に入れる。${rows.length} 行。うち 単価の欄が無く比べられない ${noRate} 行)`);
for (const [k, [ok, all]] of Object.entries(items)) console.log(`  ${k}: ${ok}/${all} 一致 (${((ok / all) * 100).toFixed(1)}%)`);
console.log(`  勤続手当の外れの内訳: ${[...kinzokuMiss].map(([k, v]) => `${k} ${v}`).join(" / ") || "なし"}`);
for (const m of planMiss) console.log("   " + m);

// 当方に無い項目の金額 (総括表の合計)
const missingCols = ["報奨金", "調整手当", "出張費", "育児手当", "その他手当", "通信手当", "残業総額", "移動手当", "有給"];
console.log("\n段A で比べていない項目 (総括表の金額の合計 / 0 でない行数。報奨金・その他は手入力、調整手当 = 認定調査+加算+保障):");
for (const c of missingCols) {
  const vals = rows.map((r) => n(r[c])).filter((v) => v !== 0);
  if (vals.length) console.log(`  ${c}: ${vals.reduce((a, b) => a + b, 0).toLocaleString()} 円 / ${vals.length} 行`);
}
console.log("  ※ 調整手当 = 認定調査 (3,000円×件数) + 加算手当合計 (+ 保障の調整額)。当方の加算手当は 段B で見る。出張費は 当方にもある (出勤簿の km × 単価。総括表は円未満切り上げ)");

// ── 段B 入力 (DB の実績) ─────────────────────────────────
const months = [...new Set(rows.map((r) => r.file_month))].filter((m) => m >= "202606").sort();
const recs = await restAll<{ office_number: string; staff_name: string; service_month: string; detail_row_no: string | null; service_name: string | null; care_level: string | null }>(
  `payroll_kyotaku_records?select=id,office_number,staff_name,service_month,detail_row_no,service_name,care_level&service_month=gte.${ym1(months[0] ?? "209901")}`);
const units = await restAll<{ item_name: string; unit_count: number; is_addition: boolean; is_office_addition: boolean; effective_from: string | null }>("payroll_kyotaku_service_units?select=*");
const cnt = new Map<string, number>(), kazan = new Map<string, number>();
for (const r of recs) {
  const k = `${r.service_month.slice(0, 7).replace("-", "")}|${nm(r.staff_name)}`;
  if (r.detail_row_no === "1" && String(r.care_level ?? "").startsWith("要介護")) cnt.set(k, (cnt.get(k) ?? 0) + 1);
  const u = units.find((x) => x.is_addition && !x.is_office_addition && !x.item_name.includes("特定事業所加算") && String(r.service_name ?? "").includes(x.item_name));
  if (u) kazan.set(k, (kazan.get(k) ?? 0) + u.unit_count * 10);
}
const pulledMonths = new Set([...cnt.keys()].map((k) => k.split("|")[0]));
const notPulled = months.filter((m) => !pulledMonths.has(m));
let cOk = 0, cNear = 0, cAll = 0, kOk = 0, kAll = 0, noRec = 0, cShort = 0, cOver = 0; const cMiss: string[] = [];
for (const r of rows.filter((x) => months.includes(x.file_month) && pulledMonths.has(x.file_month))) {
  const k = `${r.file_month}|${nm(r.name)}`;
  if (!cnt.has(k) && !kazan.has(k)) { noRec++; continue; }
  cAll++; const ours = cnt.get(k) ?? 0, theirs = n(r.介護件数);
  if (ours < theirs) cShort += theirs - ours; else cOver += ours - theirs;
  if (ours === theirs) cOk++; else { if (Math.abs(ours - theirs) <= 2) cNear++; if (cMiss.length < 10) cMiss.push(`${r.file_month} ${r.office} ${r.name}: 当方 ${ours} / 総括表 ${theirs}`); }
  kAll++; if ((kazan.get(k) ?? 0) === n(r.加算手当合計)) kOk++;
}
console.log(`\n段B 入力 (介護アプリから写した実績 ${[...pulledMonths].sort().join(",")}。月遅れも提供月で数える)`);
if (notPulled.length) console.log(`  ★ ${notPulled.join(",")} は 当方に実績が 1 件も無い (介護アプリに 居宅のレセプトが まだ無い月) → 比べていない`);
console.log(`  介護件数: ${cOk}/${cAll} 一致 (±2 以内 ${cOk + cNear}) / 当方が少ない 計 ${cShort} 件・多い 計 ${cOver} 件 / 加算手当: ${kOk}/${kAll} 一致 / 当方に実績が無い人 ${noRec}`);
console.log("  ※ 2026-10-19 に測った内訳: 総括表の介護件数の合計は 伝送 KK 8124 を 提供月で (当月分 + 月遅れ分) 数えたものと一致 (2026-06 で 2,810 = 2,810)。");
console.log("    当方が少ない側: 7 月は 9月10日送信の KK (月遅れ) が まだ無い分。人ごとの ±1 は 伝送のケアマネ番号で数えても残る (総括表の人への割り当ての決まりは未特定)");
for (const m of cMiss) console.log("   " + m);
// ── 段C 総支給 ───────────────────────────────────────────
const OFFICE: Record<string, string> = {
  KT姉崎: "1272401876", 花見川: "1270201922", 五井: "1272400506", おゆみ野: "1270501172", 袖ケ浦: "1273400851",
  いすみ: "1278600406", 姉崎ムツミ: "1272400837", 木更津ムツミ: "1271101287", Hana船橋: "1270907411", Hanaちはら台: "1272403492",
  高品居宅: "1270404229", Hana八千代: "1272603844", Hana四街道: "1270303272", リンクス大網: "1279200081", リンクス茂原: "1271500934",
};
if (pulledMonths.size) {
  const payOffices = await restAll<{ id: string; office_number: string; travel_unit_price: number | null; commute_unit_price: number | null }>(
    "payroll_offices?select=id,office_number,travel_unit_price,commute_unit_price&office_type=eq.居宅介護支援");
  const offById = new Map(payOffices.map((o) => [o.office_number, o]));
  const emps = await restAll<{ id: string; employee_number: string; name: string; office_id: string }>("payroll_employees?select=id,employee_number,name,office_id");
  const salRows = await restAll<KyotakuSalary>(`payroll_kyotaku_salary?select=${KYOTAKU_SALARY_COLUMNS.replace(/\s/g, "")}`);
  const unitRows = await restAll<ServiceUnit>("payroll_kyotaku_service_units?select=*");
  const allRecs = await restAll<KyotakuRecord & { office_number: string }>(`payroll_kyotaku_records?select=*&service_month=gte.${ym1([...pulledMonths].sort()[0])}`);
  const att = await restAll<{ employee_id: string; work_date: string; business_km: number | null; commute_km: number | null }>(
    `payroll_kyotaku_attendance_records?select=id,employee_id,work_date,business_km,commute_km&work_date=gte.${ym1([...pulledMonths].sort()[0])}`);
  // 予防件数・認定調査は DB (出勤簿の下の欄から入れた分・画面の入力) を使う。無ければ 総括表の値 (別に数える)
  const yobouDb = await restAll<{ office_number: string; service_month: string; staff_name: string; yobou1_count: number; yobou2_count: number }>(
    `payroll_kyotaku_yobou_records?select=id,office_number,service_month,staff_name,yobou1_count,yobou2_count&service_month=gte.${ym1([...pulledMonths].sort()[0])}`);
  const surveyDb = await restAll<{ office_number: string; employee_number: string; processing_month: string; numeric_value: number }>(
    "payroll_monthly_inputs?select=office_number,employee_number,processing_month,numeric_value&item_key=eq.kyotaku_survey_count", "office_number");
  let yobouFromSoukatsu = 0;
  const nn = (v: unknown) => String(v ?? "").trim().replace(/^0+/, "");
  const ITEMS = ["基本", "プラン", "勤続", "役職", "資格", "特定", "加算", "調整", "交通", "総支給"] as const;
  const okBy = Object.fromEntries(ITEMS.map((k) => [k, 0])) as Record<(typeof ITEMS)[number], number>;
  let all = 0, noEmp = 0, noSal = 0, noAtt = 0; const itemMiss = new Map<string, string[]>(); const totalMiss: { d: number; s: string }[] = [];
  for (const r of rows.filter((x) => pulledMonths.has(x.file_month))) {
    const on = OFFICE[r.office]; const off = on ? offById.get(on) : undefined;
    if (!off) continue;
    const e = emps.find((x) => x.office_id === off.id && nn(r.社員No) && nn(x.employee_number) === nn(r.社員No)) ?? emps.find((x) => x.office_id === off.id && nm(x.name) === nm(r.name));
    if (!e) { noEmp++; continue; }
    const sm = ym1(r.file_month);
    const active = getActiveKyotakuSalary(salRows, e.id, sm);
    if (!active) { noSal++; continue; }
    all++;
    // 月遅れの調整が無かったもの として: その提供月の行を 全部「翌月に請求した」扱いにする
    const recs = allRecs.filter((x) => x.office_number === on && x.service_month === sm && x.staff_name === e.name).map((x) => ({ ...x, staff_name: "X", billing_month: next(sm) }));
    const yRows = yobouDb.filter((y) => y.office_number === on && y.service_month === sm && nm(y.staff_name) === nm(e.name));
    const yobouCount = yRows.length ? yRows.reduce((a, y) => a + y.yobou1_count + y.yobou2_count, 0) : n(r.予防件数);
    if (!yRows.length && n(r.予防件数) > 0) yobouFromSoukatsu++;
    const yobou = yobouCount > 0 ? [{ service_month: sm, billing_month: next(sm), staff_name: "X", yobou1_count: yobouCount, yobou2_count: 0 }] : [];
    const surveyCount = Number(surveyDb.find((x) => x.office_number === on && nn(x.employee_number) === nn(e.employee_number) && x.processing_month === r.file_month)?.numeric_value ?? 0);
    let attRecs: KyotakuAttendanceRecord[] = att.filter((a) => a.employee_id === e.id && a.work_date.startsWith(sm.slice(0, 7)))
      .map((a) => ({ staff_name: "X", work_date: a.work_date, business_km: Number(a.business_km ?? 0), commute_km: Number(a.commute_km ?? 0) }));
    // ★ 居宅の出勤簿は DB にほぼ無い (2026-10-19: 2026-06/07 で 9 人・2 事業所・通勤 km 0 件)。
    //   無い人月は 総括表の「通勤距離」を入れる (単価・切り上げ・上限は当方)。
    //   総括表の 出張費 = 切り上げ(単価 × 距離) − 通勤費 なので 通勤費と出張費は 合計 (交通) で比べる
    //   (いすみは 全部を出張費で払い、7 月は 6 月分を 通勤費の欄で引いて出張費に入れ直してある。合計なら合う)
    const hasAtt = attRecs.some((a) => (a.business_km ?? 0) > 0 || (a.commute_km ?? 0) > 0);
    // 大網・茂原は 通勤距離が無く「出張距離」に入っている
    if (!hasAtt) { noAtt++; attRecs = n(r.通勤距離) + n(r.出張距離) > 0 ? [{ staff_name: "X", work_date: `${sm.slice(0, 7)}-15`, business_km: n(r.出張距離), commute_km: n(r.通勤距離) }] : []; }
    const b = calcSalary(recs, "X", sm, {
      settings: [kyotakuSettingFromSalary("X", active)], units: unitRows, rates: [], yobouRecords: yobou, attendanceRecords: attRecs,
      officeTravelUnitPrice: Number(off.travel_unit_price ?? 0), officeCommuteUnitPrice: Number(off.commute_unit_price ?? 0),
      monthlyExtras: [{ staff_name: "X", service_month: sm, survey_count: surveyCount, bonus: n(r.報奨金), other_allowance: n(r.その他手当) }],
    });
    const theirsKinzoku = r.勤続_合計 != null ? n(r.勤続_合計) : n(r.勤続_固定) + n(r.勤続_変動) + n(r.勤続_介護);
    const theirsChosei = n(r.調整手当); // = 調査 + 加算 + 保障
    const pairs: Record<(typeof ITEMS)[number], [number, number]> = {
      基本: [b.base, n(r.本人給) + n(r.職能給) + n(r.固定残業手当)], プラン: [b.plan, n(r.ケアプラン手当)], 勤続: [b.kotei + b.kinzoku_variable, theirsKinzoku],
      役職: [b.position, n(r.役職手当)], 資格: [b.shikaku, n(r.資格手当)], 特定: [b.tokutei, n(r.特定処遇改善)], 加算: [b.kazan, n(r.加算手当合計)],
      // 調整手当 = 認定調査 + 加算 + 保障 (総括表は 1 欄)
      調整: [b.survey + b.kazan + b.guarantee, theirsChosei],
      交通: [b.commute_teate + b.business_trip_teate, n(r.通勤費) + n(r.出張費)],
      // 当方に無い項目 (通信・移動・有給。育児は 保育料の手入力が無いときだけ) は 総括表の値を 当方にも足す
      総支給: [b.total + (b.childcare ? 0 : n(r.育児手当)) + n(r.通信手当) + n(r.残業総額) + n(r.移動手当) + n(r.有給), n(r.総支給額)],
    };
    for (const k of ITEMS) if (pairs[k][0] === pairs[k][1]) okBy[k]++; else {
      const l = itemMiss.get(k) ?? []; l.push(`${r.file_month} ${r.office} ${String(r.name).split("\n")[0]}: 当方 ${pairs[k][0].toLocaleString()} / 総括表 ${pairs[k][1].toLocaleString()}`); itemMiss.set(k, l);
    }
    const d = pairs.総支給[0] - pairs.総支給[1];
    if (d !== 0) totalMiss.push({ d, s: `${r.file_month} ${r.office} ${String(r.name).split("\n")[0]}: 差 ${d.toLocaleString()} (${ITEMS.filter((k) => k !== "総支給" && pairs[k][0] !== pairs[k][1]).map((k) => `${k} ${pairs[k][0] - pairs[k][1] > 0 ? "+" : ""}${(pairs[k][0] - pairs[k][1]).toLocaleString()}`).join(" / ")})` });
  }
  console.log(`\n段C 総支給 (${[...pulledMonths].sort().join(",")}。DB の給与設定・実績・出勤簿・単価・予防件数・認定調査 + 報奨金/その他だけ総括表の値。${all} 人月 / 職員が引けない ${noEmp} / 給与設定が無い ${noSal})`);
  console.log(`  ★ 出勤簿の距離が DB に無い ${noAtt} 人月は 総括表の通勤距離・出張距離を入れた (通勤費と出張費は 合計で比べる)`);
  console.log(`  ★ 予防件数が DB に無く 総括表の値を入れた ${yobouFromSoukatsu} 人月 (認定調査は DB の値だけ。報奨金・その他手当は 総括表の値)`);
  console.log("  " + ITEMS.map((k) => `${k} ${okBy[k]}`).join(" / ") + ` (各 ${all} 中の一致)`);
  const absSum = totalMiss.reduce((a, x) => a + Math.abs(x.d), 0);
  console.log(`  総支給が 1 円も違わない ${all - totalMiss.length}/${all} 人月。違う ${totalMiss.length} 人月の差の絶対値の合計 ${absSum.toLocaleString()} 円`);
  for (const x of totalMiss.sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 15)) console.log("   " + x.s);
  // 件数と加算 (原因が分かっている・材料待ち) 以外で 外れた項目の中身
  for (const [k, l] of itemMiss) if (!["プラン", "加算", "調整", "総支給"].includes(k)) { console.log(`  ${k} の外れ ${l.length}:`); for (const x of l.slice(0, 8)) console.log("     " + x); }
}

console.log("\n見ていないもの: 報奨金・その他手当 (手入力。段C は総括表の値) / 加算の出どころ (段B の加算手当) / 2026-08 以降 (当方に実績が無い)");
