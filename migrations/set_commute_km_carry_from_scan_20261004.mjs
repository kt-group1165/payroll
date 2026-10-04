/**
 * 月給者の「通勤km の繰越」(payroll_monthly_inputs commute_km_carry) を スキャンの欄外の手書きから入れる (2026-10-04)。
 *
 *   node migrations/set_commute_km_carry_from_scan_20261004.mjs              # DRY RUN
 *   node migrations/set_commute_km_carry_from_scan_20261004.mjs --execute
 *
 * ── なぜ ────────────────────────────────────────────────────────────────
 * 前月の出勤簿を月末前に予定値で出し、翌月に実績で出し直して 差を翌月に払っている。
 * 残業 (set_overtime_minutes_from_scan_20261002.mjs の 森田・福田) と同じ用紙の欄外に 通勤km も書いてある。
 *
 * ★ 出どころは 2 つ: ① スキャンの欄外の手書き / ② 総括表の「距離(通)」「距離(出)」。
 *   ② (通 + 出) = 当方が払っている km (計算結果の 通勤km + 出張km) + 繰越 になっていなければ 入れない (exit 2)。
 *   ★ 通勤と出張を足して比べるのは 高品の用紙が「通勤km | 出張km」の列順で (他事業所と逆)、
 *     福田の 5 月 69km が出張km として取り込まれているため。単価は同じなので金額は変わらない。
 * ⚠ 投入後に /payroll で 君津 202605 / 高品 202605 を再計算すること。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const STAGING = process.env.PAYROLL_ENV === "staging";
const env = {};
for (const p of STAGING ? [".env.staging"] : ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) { console.error("★ 接続情報が読めません"); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
console.log(`[DB] ${STAGING ? "staging" : "本番"} ${/https:\/\/([a-z0-9]+)\./.exec(SB)?.[1]}`);

const ITEM = "commute_km_carry";
const PLAN = [
  // 森田 由香理 (君津ムツミヘルパーステーション・事務員) 君津 R8.5 社員.pdf p23 欄外「通 ⑤72km + ④14.4km = 86.4km」
  { off: "1273001626", emp: "211102", m: "202605", km: 14.4, src: "君津 R8.5 p23 欄外「通 ⑤72km+④14.4km=86.4km」" },
  // 福田 八重子 (Ｈａｎａヘルパーステーション高品・事務員) 高品 R8.5 社員.pdf p64 欄外 青字「+④18km 87km」
  { off: "1270402116", emp: "221006", m: "202605", km: 18, src: "高品 R8.5 p64 欄外 青字「+④18km → 87km」" },
];

const q = async (path, init) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: H, ...init });
  const body = await r.text();                       // ★ PostgREST は空ボディを返すことがある
  if (!r.ok) throw new Error(`${path} ${r.status} ${body}`);
  return body ? JSON.parse(body) : null;
};
const kOf = (o, e, m) => `${o}|${String(e).replace(/^0+/, "")}|${m}`;

let bad = 0;
console.log("\n事業所        職員     月       当方km(通+出)  繰越km  計      ② 距離(通+出)  氏名");
for (const p of PLAN) {
  // ★ 当方が実際に払っている km = 保存済みの計算結果の 通勤km (出勤簿) + 出張km (手入力 > 事業所書式 > 出勤簿)。
  //   出張 = 通勤 なら出張は払わない (effectiveTravelKm と同じ)。森田の出張 8km は事業所書式から来ている
  const calc = await q(`payroll_calc_results?select=payload&office_number=eq.${p.off}&processing_month=eq.${p.m}`);
  const e = (calc[0]?.payload?.monthly ?? []).find((x) => String(x.employee_number).replace(/^0+/, "") === p.emp);
  if (!e) { console.error(`★ ${p.off} ${p.emp} ${p.m} の計算結果がありません`); bad++; continue; }
  const commute = Number(e.summary?.commuteKmTotal ?? 0);
  const tripRaw = Number(e.travel_km > 0 ? e.travel_km : e.travel_km_auto ?? 0);
  const trip = commute > 0 && Math.abs(tripRaw - commute) < 0.05 ? 0 : tripRaw;
  const attKm = Math.round((commute + trip) * 10) / 10;
  const s = (await q(`payroll_soukatsu_rows?select=row_data&office_number=eq.${p.off}&employee_number=eq.${p.emp}&processing_month=eq.${p.m}`))[0]?.row_data ?? {};
  const want = Math.round((Number(s["距離(通)"] ?? NaN) + Number(s["距離(出)"] ?? 0)) * 10) / 10;
  const sum = Math.round((attKm + p.km) * 10) / 10;
  const ok = Math.abs(sum - want) < 0.05;
  if (!ok) bad++;
  console.log(`${p.off}  ${String(p.emp).padEnd(7)} ${p.m}  ${String(attKm).padStart(7)}  ${String(p.km).padStart(6)}  ${String(sum).padStart(6)}  ${String(want).padStart(9)}  ${s["氏名"] ?? "★ ② に無い"}${ok ? "" : "   ★ 不一致"}`);
}
if (bad) { console.error(`\n★ ${bad} 件で ② と合いません。中止します`); process.exit(2); }

const offs = [...new Set(PLAN.map((p) => p.off))], emps = [...new Set(PLAN.map((p) => p.emp))];
const cur = await q(`payroll_monthly_inputs?select=office_number,employee_number,processing_month,numeric_value&item_key=eq.${ITEM}&office_number=in.(${offs.join(",")})&employee_number=in.(${emps.join(",")})`);
const curOf = new Map(cur.map((r) => [kOf(r.office_number, r.employee_number, r.processing_month), Number(r.numeric_value ?? 0)]));
const todo = PLAN.filter((p) => curOf.get(kOf(p.off, p.emp, p.m)) !== p.km);
console.log(`\n対象 ${PLAN.length} 人月 / 入れる・直すもの ${todo.length} 人月`);
if (!todo.length) { console.log("既に入っています。何もしません"); process.exit(0); }
if (!EXECUTE) { console.log("\n(DRY RUN。--execute で実行します)"); process.exit(0); }

for (const p of todo) {
  const note = `スキャンPDF (欄外の手書き) ${p.src}。② 距離(通) と一致。2026-10-04`;
  if (curOf.has(kOf(p.off, p.emp, p.m))) {
    await q(`payroll_monthly_inputs?office_number=eq.${p.off}&employee_number=eq.${p.emp}&processing_month=eq.${p.m}&item_key=eq.${ITEM}`,
      { method: "PATCH", body: JSON.stringify({ numeric_value: p.km, note }) });
    console.log(`  更新 ${p.off} ${p.emp} ${p.m} → ${p.km} km`);
  } else {
    await q("payroll_monthly_inputs", { method: "POST", body: JSON.stringify({ office_number: p.off, employee_number: p.emp, processing_month: p.m, item_key: ITEM, numeric_value: p.km, note }) });
    console.log(`  追加 ${p.off} ${p.emp} ${p.m} → ${p.km} km`);
  }
}
console.log("\n⚠ /payroll で 再計算してください: 君津 202605 / 高品 202605");
