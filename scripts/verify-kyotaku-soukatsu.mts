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
 */
import { existsSync, readFileSync } from "node:fs";
import { calcSalary, type EmployeeSetting, type KyotakuRecord } from "../src/lib/payroll/kyotaku-calc.js";
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
console.log("  ※ ★ 見立て (未確認): 少ない側は 月遅れ (翌々月以降に請求したレセプト) が まだ介護アプリに無いもの (8月10日送信の KK を取り込んだのは 四街道 だけ)。KK が届いたら 取り込んで回し直すと確かめられる");
console.log("    ★ 見立て (未確認): 多い側は 担当ケアマネを 今の担当 (client_insurance_records.care_manager) で決めているため 担当替えが ずれるもの");
for (const m of cMiss) console.log("   " + m);
console.log("\n見ていないもの: 予防件数 (手入力) / 給与設定の DB の値 (段A は総括表の入力値を使った) / 出張費 / 総支給の合計");
