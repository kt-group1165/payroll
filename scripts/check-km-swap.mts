/**
 * 事業所書式の 出張km/通勤km が 総括表と「桁違い」または「入れ替わり」になっていて、
 * かつ手入力でまだ補われていない (=実際に金額へ効いている) 人月を数える常設検査
 *
 *   npm run check:km-swap
 *   npm run check:km-swap -- --update   ★ 基準値方式の数だけ更新
 *
 * ── なぜこの検査があるか (2026-09-26) ────────────────────────────────────────
 *   migrations/fix_trip_km_outliers.mjs で見つかった型を再発見する常設検査にした。
 *   桁違い (白鳥梨恵 202606 出張km 9,494=正949.4 の10倍 等) と 入れ替わり
 *   (鎗田裕子 202603〜06 の通勤kmが出張km欄に入っていた) の2種類があり、
 *   **入れ替わりは必ず出張・通勤の2項目に効く。片方だけ手入力で直すと もう片方が残る。**
 *   実際 2026-09-26 に 出張km側だけ是正されていて 通勤側が4人月 ¥50,003 過少のまま
 *   放置されていた (鎗田裕子)。同じ事故を繰り返さないための検査。
 *
 * ── 何を見るか / 見ないか ────────────────────────────────────────────────────
 *   ★ 「書式が壊れているか」ではなく「金額に実害が残っているか」を見る。
 *     payroll_monthly_inputs (business_km / commute_yen) の手入力が総括表の値と
 *     一致していれば、書式が壊れていても実害は無いので対象外にする。
 *   ★ 総括表側の 距離×単価 が 出張費 と合わない人月は対象外 (総括表の距離列自体が誤記で、
 *     当方を直す理由にならない型。櫻井さとみ 202606 が実例)。
 *   ★ 判定のRATIO・除外条件は migrations/fix_trip_km_outliers.mjs と同じロジックを踏襲。
 *
 * ── 基準値方式 (なぜこの件数か) ────────────────────────────────────────────
 *   scripts/km-swap-baseline.json の _readme 参照。
 *
 * ── 負のコントロール ──────────────────────────────────────────────────────
 *   実データの1件を「書式は正しいが手入力が無い」ふりをするよう一時的に手入力マップから
 *   除外し、todoとして検知されることを確認する。★ 負のコントロール自身は集計に混ぜない
 *   (前回 check:soukatsu-source で踏んだ罠と同じ)。
 */
import { readFileSync, writeFileSync } from "node:fs";

const UPDATE = process.argv.includes("--update");
const BASELINE_PATH = "scripts/km-swap-baseline.json";

let failed = 0;
const fail = (msg: string) => { console.log(`  x ${msg}`); failed++; };
const pass = (msg: string) => console.log(`  o ${msg}`);
function expect(cond: boolean, msg: string) { if (cond) pass(msg); else fail(msg); }

console.log("=== check:km-swap (出張km/通勤kmの桁違い・入れ替わりで、手入力未補完=金額に実害があるもの) ===");
console.log("この検査が見ていないもの: 総括表の距離×単価が出張費と合わない人月(総括表側の誤記とみなし対象外) / RATIO(5倍)未満の小さなズレ");

const env: Record<string, string> = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) { fail("SUPABASE_SERVICE_ROLE_KEY が無いので検査できません"); process.exit(1); }
const SB = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY };
type Row = { office_number: string; employee_number?: string; employee_name?: string; processing_month?: string; item_name?: string; numeric_value?: number | null; row_data?: Record<string, unknown> | null; travel_unit_price?: number | null; commute_unit_price?: number | null };
async function all(q: string): Promise<Row[]> {
  let out: Row[] = [], from = 0;
  for (;;) {
    const r = await fetch(`${SB}/rest/v1/${q}&order=id&offset=${from}&limit=1000`, { headers: H });
    const j = await r.json();
    if (!Array.isArray(j)) { throw new Error(`読み込み失敗: ${q} ${JSON.stringify(j).slice(0, 300)}`); }
    out = out.concat(j); if (j.length < 1000) break; from += 1000;
  }
  return out;
}
const nn = (s: unknown) => String(s ?? "").replace(/^0+/, "");
const N = (v: unknown) => { if (v == null || v === "") return null; const n = Number(String(v).replace(/[, ]/g, "")); return Number.isFinite(n) ? n : null; };

/** 書式と総括表がこの倍率以上ズレたら「桁違い/入れ替わり」とみなす (fix_trip_km_outliers.mjs と同じ) */
const RATIO = 5;

const offices = await all("payroll_offices?select=id,office_number,travel_unit_price,commute_unit_price");
const priceOf = new Map(offices.map((o) => [o.office_number, Number(o.travel_unit_price ?? 0)]));
const commutePriceOf = new Map(offices.map((o) => [o.office_number, Number(o.commute_unit_price ?? 0)]));
const sk = await all("payroll_soukatsu_rows?select=office_number,employee_number,employee_name,processing_month,row_data");
const of2 = await all("payroll_office_form_records?select=office_number,employee_number,processing_month,item_name,numeric_value");

const formKm = new Map<string, { trip: number | null; commute: number | null }>();
for (const r of of2) {
  if (r.numeric_value == null) continue;
  if (r.item_name !== "出張km" && r.item_name !== "通勤km") continue;
  const k = `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`;
  const cur = formKm.get(k) ?? { trip: null, commute: null };
  if (r.item_name === "出張km") cur.trip = Number(r.numeric_value);
  else cur.commute = Number(r.numeric_value);
  formKm.set(k, cur);
}

type Op = { on: string; num: string; name: string; m: string; from: number; to: number };
const tripOps: Op[] = [], commuteOps: Op[] = [];
let skippedCount = 0;

for (const r of sk) {
  const k = `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`;
  const f = formKm.get(k);
  if (!f || f.trip == null) continue;
  const d = r.row_data ?? {};
  const soDist = N(d["距離(出)"]), soFee = N(d["出張費"]);
  if (soDist == null || soDist <= 0 || soFee == null) continue;
  const ratio = f.trip / soDist;
  if (ratio <= RATIO && ratio >= 1 / RATIO) continue;

  const price = priceOf.get(r.office_number) ?? 0;
  const calc = Math.ceil(soDist * price - 1e-6);
  if (price <= 0 || Math.abs(calc - soFee) > 1) { skippedCount++; continue; }

  const name = String(r.employee_name ?? "").replace(/\s/g, "");
  tripOps.push({ on: r.office_number, num: nn(r.employee_number), name, m: String(r.processing_month), from: f.trip, to: soDist });

  const soCommuteFee = N(d["通勤費"]);
  if (soCommuteFee != null && soCommuteFee > 0) {
    const commutePrice = commutePriceOf.get(r.office_number) ?? 0;
    const mineCommute = f.commute != null && commutePrice > 0 ? Math.ceil(f.commute * commutePrice - 1e-6) : 0;
    if (Math.abs(mineCommute - soCommuteFee) > 1) {
      commuteOps.push({ on: r.office_number, num: nn(r.employee_number), name, m: String(r.processing_month), from: mineCommute, to: soCommuteFee });
    }
  }
}

const existTrip = await all("payroll_monthly_inputs?select=office_number,employee_number,processing_month,numeric_value&item_key=eq.business_km");
const haveTrip = new Map(existTrip.map((r) => [`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, Number(r.numeric_value)]));
const existCom = await all("payroll_monthly_inputs?select=office_number,employee_number,processing_month,numeric_value&item_key=eq.commute_yen");
const haveCom = new Map(existCom.map((r) => [`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, Number(r.numeric_value)]));

// --- 負のコントロール: tripOps に実在する1件を、手入力マップから「消えた」ことにして
//     tripTodo として検知されるかを確認する。★ 集計には混ぜない(検知確認専用)。
if (tripOps.length === 0) { fail("負のコントロール用の出張km異常が1件も無い (検査データが空)"); process.exit(1); }
const negOp = tripOps.find((o) => haveTrip.get(`${o.on}|${o.num}|${o.m}`) === o.to);
if (!negOp) { fail("負のコントロール用に「既に是正済み」の行が見つからない"); process.exit(1); }
const negKey = `${negOp.on}|${negOp.num}|${negOp.m}`;
const negOrigValue = haveTrip.get(negKey);
haveTrip.delete(negKey); // 手入力が無かったことにする → todoとして検知されるはず
const negativeControlCaught = tripOps.some((o) => `${o.on}|${o.num}|${o.m}` === negKey && haveTrip.get(negKey) !== o.to);
haveTrip.set(negKey, negOrigValue as number); // 元に戻す (集計はこの後で正しい状態を使う)

console.log(`\n負のコントロール(是正済み1件の手入力を無かったことにする): ${negativeControlCaught ? "検知OK" : "★検知できず"}`);
expect(negativeControlCaught, "負のコントロールが検知される");
if (!negativeControlCaught) { console.log("  ★ 検知できない = この検査自体が壊れている可能性が高い。baseline判定はスキップします。"); process.exit(1); }

// --- 本番の集計 (負のコントロールは戻した状態) ---
const tripTodo = tripOps.filter((o) => haveTrip.get(`${o.on}|${o.num}|${o.m}`) !== o.to);
const commuteTodo = commuteOps.filter((o) => haveCom.get(`${o.on}|${o.num}|${o.m}`) !== o.to);

// 入れ替わりの「片方だけ直った」型: 出張側は手入力済みだが通勤側がまだ、または逆
const tripFixedKeys = new Set(tripOps.filter((o) => !tripTodo.includes(o)).map((o) => `${o.on}|${o.num}|${o.m}`));
const commuteFixedKeys = new Set(commuteOps.filter((o) => !commuteTodo.includes(o)).map((o) => `${o.on}|${o.num}|${o.m}`));
const halfFixed = [
  ...commuteTodo.filter((o) => tripFixedKeys.has(`${o.on}|${o.num}|${o.m}`)).map((o) => ({ ...o, side: "通勤側が未是正" as const })),
  ...tripTodo.filter((o) => commuteFixedKeys.has(`${o.on}|${o.num}|${o.m}`)).map((o) => ({ ...o, side: "出張側が未是正" as const })),
];

console.log(`\n対象(桁違い/入れ替わり候補、総括表の内部整合性は取れているもの): 出張${tripOps.length}件 / 通勤${commuteOps.length}件`);
console.log(`対象外(総括表側の距離×単価が出張費と合わない=総括表の誤記とみなす): ${skippedCount}件`);
console.log(`\n手入力で未補完=実害が残っている: 出張${tripTodo.length}件 / 通勤${commuteTodo.length}件`);
console.log(`★ 片方だけ是正されている(入れ替わりの片側放置): ${halfFixed.length}件`);
for (const o of halfFixed) console.log(`  ${o.name} ${o.m} ${o.on}  ${o.side}`);

const total = tripTodo.length + commuteTodo.length;
console.log(`\n合計(実害あり件数): ${total}`);

type Baseline = { _readme: string[]; total: number; tripTodo: number; commuteTodo: number; halfFixed: number };
const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
console.log(`基準値: ${baseline.total} (出張${baseline.tripTodo}/通勤${baseline.commuteTodo}/片方是正${baseline.halfFixed})`);

if (UPDATE) {
  baseline.total = total; baseline.tripTodo = tripTodo.length; baseline.commuteTodo = commuteTodo.length; baseline.halfFixed = halfFixed.length;
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  pass(`基準値を更新しました (${total}件)`);
} else {
  expect(total <= baseline.total, `実害あり件数が基準値から増えていない (${total} <= ${baseline.total})`);
  expect(halfFixed.length <= baseline.halfFixed, `片方だけ是正の件数が基準値から増えていない (${halfFixed.length} <= ${baseline.halfFixed})`);
}

process.exit(failed === 0 ? 0 : 1);
