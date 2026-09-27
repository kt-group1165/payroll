/**
 * check:trip-km-route — 書式の 出張km が空でも 出張費が欠けないこと (手入力か出勤簿に km があること) を固定する
 * (2026-09-27 給与C 新設・読み取り専用)。
 *
 *   SOUKATSU1_DIR=<① の抽出物のある dir> npm run check:trip-km-route
 *   ... FORM_SNAPSHOT=<書式の行の写し.json>   # 書式を DB から読まない
 *   ... -- --update   (★ 悪化したまま更新しない)
 *
 * 【なぜ】
 * 書式の 出張km は 466 行が空で、そのうち ① (旧システム出力) が出張費を払っている人月が 115 (① ¥1,467,197) ある。
 * それでも欠けないのは 給与計算が 出張km を「手入力 business_km > 事業所書式 > 出勤簿 business_km」の順で取るから
 * (page.tsx tripKmOf。月給も travel_km_auto で同じ関数を通る)。★ この順が壊れると この人月は静かに 0 円になる。
 * 2026-09-27 に 115 人月すべてに 手入力か出勤簿の km があることを確かめた。★ それを検査に固定する。
 *
 * ── 不変条件 (★ 0 を目指してよい。現に 0 で、増えたら必ず金額に効くため) ──────────────
 *   書式の 出張km が空で 同じ人月に値のある行も無い人月のうち ① が出張費を払っているもの は
 *   手入力 (payroll_monthly_inputs business_km) か 出勤簿 (payroll_attendance_records business_km) に km > 0 がある
 *   → 「どちらも無い」= 0 件
 *
 * ── 補助 (基準値方式・増えたら FAIL) ───────────────────────────────────────
 *   経路の内訳 (出勤簿 / 手入力) / 入力の km が ① の出張距離と違う人月 / ① の 出張費 ≠ 切り上げ(① の距離 × 事業所の単価)
 *
 * ── この検査が見ていないもの ─────────────────────────────────────────────
 *   ・計算結果の出張費 (km × 単価 が payload に出ているか) → check:soukatsu-item-gap(-monthly) の「出張」で見ている
 *   ・① が払っていない人月 (書式が空・① も 0 なら 出張が無い月として正しい)
 *   ・通勤との二重払い → check:km-double
 *   ・経路の優先順そのもの (tripKmOf は page.tsx の中にあり 呼べない)。ここは「どこかに km があるか」だけ
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { restAll } from "./_rest.mjs";
import { num } from "./_soukatsu-items.mjs";

const UPDATE = process.argv.includes("--update");
const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), "check-trip-km-route-baseline.json");
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");

type FormRow = { office_number: string; employee_number: string; processing_month: string; record_type: string; item_name: string; numeric_value: number | null };
export type Inputs = {
  form: FormRow[];
  l1: Map<string, { sheet_kind: string; row_data: Record<string, unknown> }>;
  manualKm: Map<string, number>;
  attKm: Map<string, number>;
  unit: Map<string, number>;   // 事業所番号 → travel_unit_price
};
export type Result = {
  denom: { tripRows: number; emptyRows: number; emptyPm: number; withL1: number; target: number; targetYen: number; monthly: number; hourly: number };
  route: Record<string, number>;
  none: string[]; kmDiff: string[]; unitDiff: string[];
};

export function evaluate(inp: Inputs): Result {
  const trip = inp.form.filter((r) => r.record_type === "km" && r.item_name === "出張km");
  const pm = (r: FormRow) => `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`;
  const valued = new Set(trip.filter((r) => r.numeric_value != null).map(pm));
  const empty = trip.filter((r) => r.numeric_value == null);
  const emptyPm = [...new Set(empty.map(pm))].filter((k) => !valued.has(k));
  const withL1 = emptyPm.filter((k) => inp.l1.has(k));
  const target = withL1.filter((k) => num(inp.l1.get(k)!.row_data["出張費"]) > 0);
  const route: Record<string, number> = {};
  const none: string[] = [], kmDiff: string[] = [], unitDiff: string[] = [];
  let targetYen = 0, monthly = 0;
  for (const k of target) {
    const q = inp.l1.get(k)!;
    const yen = num(q.row_data["出張費"]), l1km = num(q.row_data["出張距離"]);
    targetYen += yen;
    if (q.sheet_kind !== "part") monthly++;
    const m = inp.manualKm.get(k), a = inp.attKm.get(k);
    const r = m !== undefined ? "手入力" : a !== undefined ? "出勤簿" : "どちらも無い";
    route[r] = (route[r] ?? 0) + 1;
    if (r === "どちらも無い") { none.push(`${k} ① ¥${yen} ${l1km}km`); continue; }
    const km = m ?? a!;
    if (Math.abs(km - l1km) > 0.05) kmDiff.push(`${k} ${r} ${km}km / ① ${l1km}km`);
    const u = inp.unit.get(k.split("|")[0]);
    if (l1km > 0 && (u == null || Math.ceil(l1km * u - 1e-6) !== yen)) unitDiff.push(`${k} ① ${l1km}km × 単価 ${u} → ${u == null ? "-" : Math.ceil(l1km * u - 1e-6)} / ① ¥${yen}`);
  }
  return {
    denom: { tripRows: trip.length, emptyRows: empty.length, emptyPm: emptyPm.length, withL1: withL1.length, target: target.length, targetYen, monthly, hourly: target.length - monthly },
    route, none, kmDiff, unitDiff,
  };
}

function negativeControl(inp: Inputs, base: Result) {
  const lines: string[] = [];
  let ok = true;
  const t = (label: string, broken: Inputs, f: (r: Result) => number, want: number, field: string) => {
    const got = f(evaluate(broken)) - f(base);
    const p = got === want;
    if (!p) ok = false;
    lines.push(`${label} → ${field} +${got}${p ? "  OK" : `  ★ NG (期待 +${want})`}`);
  };
  const attKey = [...inp.attKm.keys()].find((k) => base.route && !inp.manualKm.has(k) && evaluate({ ...inp, attKm: new Map([...inp.attKm].filter(([x]) => x !== k)) }).none.length > base.none.length);
  const manKey = [...inp.manualKm.keys()].find((k) => !inp.attKm.has(k) && evaluate({ ...inp, manualKm: new Map([...inp.manualKm].filter(([x]) => x !== k)) }).none.length > base.none.length);
  if (!attKey || !manKey) return { ok: false, lines: ["出勤簿だけ / 手入力だけ の対象人月が無く 作れない  ★ NG"] };
  t(`出勤簿の business_km を消す (${attKey})`, { ...inp, attKm: new Map([...inp.attKm].filter(([x]) => x !== attKey)) }, (r) => r.none.length, 1, "どちらも無い");
  t(`手入力を消す (${manKey})`, { ...inp, manualKm: new Map([...inp.manualKm].filter(([x]) => x !== manKey)) }, (r) => r.none.length, 1, "どちらも無い");
  const o = attKey.split("|")[0], u = inp.unit.get(o) ?? 0;
  const brokenUnit = { ...inp, unit: new Map([...inp.unit, [o, u - 0.3]]) };
  const moved = evaluate(brokenUnit).unitDiff.length - base.unitDiff.length;
  const p = moved > 0;
  if (!p) ok = false;
  lines.push(`事業所 ${o} の単価を ${u} → ${(u - 0.3).toFixed(1)} にする → 単価の逆算が外れる +${moved}${p ? "  OK" : "  ★ NG (期待 +1 以上)"}`);
  t(`入力の km を 1km ずらす (${attKey})`, { ...inp, attKm: new Map([...inp.attKm].map(([x, v]) => [x, x === attKey ? v + 1 : v])) }, (r) => r.kmDiff.length, 1, "km が ① と違う");
  return { ok, lines };
}

async function main() {
  console.log("=== check:trip-km-route (書式の出張km が空でも 手入力か出勤簿に km があるか) 2026-09-27 新設・読み取り専用 ===");
  console.log("★ check:all には入れていない (意図的・給与計算の順序が変わったときに回す診断系)。計算結果は読まない");
  console.log("★ この検査が見ていないもの: 計算結果の出張費 (check:soukatsu-item-gap(-monthly) の出張) / ① が払っていない月 / 通勤との二重 (check:km-double) / 優先順そのもの");
  const dir = process.env.SOUKATSU1_DIR;
  if (!dir) { console.log("★ SOUKATSU1_DIR=<① の抽出物 soukatsu_extract_YYYYMM.json のある dir> が要る"); process.exit(1); }
  const files = readdirSync(dir).filter((f) => /^soukatsu_extract_\d{6}\.json$/.test(f)).sort();
  if (!files.length) { console.log(`★ ${dir} に抽出物が 1 本もない (0 件と出さない)`); process.exit(1); }
  const l1: Inputs["l1"] = new Map();
  for (const f of files) {
    const ym = /_(\d{6})\.json$/.exec(f)![1];
    for (const r of JSON.parse(readFileSync(join(dir, f), "utf8")) as { office_number: string; employee_number: string; sheet_kind: string; row_data: Record<string, unknown> }[]) {
      const k = `${r.office_number}|${nn(r.employee_number)}|${ym}`;
      if (!l1.has(k)) l1.set(k, r);   // ① の写しの重複行は 先に出たほうを使う (他の検査と同じ)
    }
  }
  const snap = process.env.FORM_SNAPSHOT;
  const form: FormRow[] = snap && existsSync(snap) ? JSON.parse(readFileSync(snap, "utf8"))
    : await restAll<FormRow>("payroll_office_form_records?select=id,office_number,employee_number,processing_month,record_type,item_name,numeric_value&item_name=eq.出張km");
  const mi = await restAll<{ office_number: string; employee_number: string; processing_month: string; numeric_value: number | null }>(
    "payroll_monthly_inputs?select=id,office_number,employee_number,processing_month,numeric_value&item_key=eq.business_km");
  const att = await restAll<{ office_number: string; employee_number: string; year: number; month: number; business_km: number | null }>(
    "payroll_attendance_records?select=id,office_number,employee_number,year,month,business_km&business_km=gt.0");
  const offices = await restAll<{ office_number: string; travel_unit_price: number | null }>("payroll_offices?select=id,office_number,travel_unit_price");
  const attKm = new Map<string, number>();
  for (const a of att) {
    const k = `${a.office_number}|${nn(a.employee_number)}|${a.year}${String(a.month).padStart(2, "0")}`;
    attKm.set(k, (attKm.get(k) ?? 0) + Number(a.business_km ?? 0));
  }
  const inp: Inputs = {
    form, l1, attKm,
    manualKm: new Map(mi.filter((m) => Number(m.numeric_value ?? 0) > 0).map((m) => [`${m.office_number}|${nn(m.employee_number)}|${m.processing_month}`, Number(m.numeric_value)])),
    unit: new Map(offices.map((o) => [o.office_number, Number(o.travel_unit_price ?? 0)])),
  };
  const res = evaluate(inp);
  if (!res.denom.tripRows) { console.log("★ 書式の 出張km が 0 行。条件・列名を疑う (0 件と出さない)"); process.exit(1); }

  const neg = negativeControl(inp, res);
  console.log("\n負のコントロール (読み込んだ写しを壊す。DB もファイルも触らない):");
  for (const l of neg.lines) console.log("  " + l);

  const d = res.denom;
  console.log("\n母数 (★ 段ごとに全部出す。1 つだけ見ると取り違える):");
  console.log(`  書式の 出張km の行                         ${d.tripRows}`);
  console.log(`  うち 空 (numeric_value が null)            ${d.emptyRows} 行`);
  console.log(`  空で 同じ人月に値のある行も無い             ${d.emptyPm} 人月`);
  console.log(`  うち ① に行がある                          ${d.withL1} 人月`);
  console.log(`  ★ うち ① が出張費を払っている (対象)        ${d.target} 人月  ① ¥${d.targetYen.toLocaleString()}  (月給 ${d.monthly} / 時給 ${d.hourly})`);
  console.log("\n経路:");
  for (const [k, v] of Object.entries(res.route).sort()) console.log(`  ${k.padEnd(8)} ${v}`);
  console.log(`\n★ どちらも無い (不変条件・0 であること) ${res.none.length}`);
  for (const x of res.none) console.log(`  ★ ${x}`);
  console.log(`入力の km が ① の出張距離と違う ${res.kmDiff.length}`);
  for (const x of res.kmDiff) console.log(`  ${x}`);
  console.log(`① の出張費 ≠ 切り上げ(① の距離 × 事業所の単価) ${res.unitDiff.length}`);
  for (const x of res.unitDiff) console.log(`  ${x}`);

  const counts = { none: res.none.length, kmDiff: res.kmDiff.length, unitDiff: res.unitDiff.length, route: res.route, target: d.target };
  let failed = res.none.length > 0;
  if (failed) console.log("\n★ FAIL: 書式が空で ① が出張費を払っているのに 手入力にも出勤簿にも km が無い人月がある (当方は 0 円になる)");
  if (existsSync(BASELINE_PATH) && !UPDATE) {
    const b = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    console.log("\n--- 基準値との比較 ---");
    const worse: string[] = [];
    if (counts.kmDiff > b.counts.kmDiff) worse.push(`km が ① と違う ${b.counts.kmDiff}→${counts.kmDiff}`);
    if (counts.unitDiff > b.counts.unitDiff) worse.push(`単価の逆算が外れる ${b.counts.unitDiff}→${counts.unitDiff}`);
    for (const k of new Set([...Object.keys(b.counts.route), ...Object.keys(counts.route)])) {
      if ((counts.route[k] ?? 0) !== (b.counts.route[k] ?? 0)) console.log(`  経路の内訳が動いた: ${k} ${b.counts.route[k] ?? 0}→${counts.route[k] ?? 0} (対象 ${b.counts.target}→${counts.target})。★ 合否には使わない。中身を見てから --update`);
    }
    console.log(`  ★ 悪化 ${worse.length}`);
    for (const w of worse) console.log(`  ★ 悪化 ${w}`);
    if (worse.length) failed = true;
  } else if (!UPDATE) console.log("\n基準値ファイルがありません。--update で作成してください");
  if (UPDATE) {
    const prev = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
    writeFileSync(BASELINE_PATH, JSON.stringify({ _readme: prev._readme ?? "(新規)", updated_at: new Date().toISOString(), denom: res.denom, counts }, null, 2) + "\n");
    console.log(`\n基準値を更新しました: ${BASELINE_PATH}`);
  }
  if (!neg.ok) { console.log("★ 負のコントロールが通らないので PASS を出しません"); process.exit(1); }
  if (failed) { console.log("★ FAIL"); process.exit(1); }
  console.log("PASS (どちらも無い = 0 / km・単価の食い違いは基準値以内)");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e); process.exit(1); });
