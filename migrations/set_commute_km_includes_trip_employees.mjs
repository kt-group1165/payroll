/**
 * 「出勤簿の通勤km 欄に 出張km も含めて書いている職員」を設定する (2026-10-04)。
 *   payroll_app_settings key = commute_km_includes_trip_employees, value = { "<事業所番号>": ["<社員番号>", ...] }
 *
 *   node migrations/set_commute_km_includes_trip_employees.mjs            # DRY RUN
 *   node migrations/set_commute_km_includes_trip_employees.mjs --execute
 *
 * 載っている人は 通勤km = 出勤簿の通勤km − 出張km で払う (src/lib/payroll/payroll-calc.ts paidCommuteKm)。
 * 根拠: 山武 黒田 202608 用紙の赤字「勤 64km」「出 24.8km」= 総括表 距離(通) 64 / 距離(出) 24.8。
 * ★ 入れる前に 対象者の 全人月 (保存済みの計算結果) で「出勤簿の通勤km − 出張km = ② 距離(通)」を確かめ、
 *   1 件でも合わなければ止める (exit 2)。
 * ⚠ 投入後に 該当の 事業所 × 月 を再計算すること。
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

const SETTING = "commute_km_includes_trip_employees";
const VALUE = {
  "1270303173": ["250202"],  // Ｈａｎａヘルパーステーション四街道 池谷 百子
  "1272603851": ["250207"],  // Ｈａｎａ八千代ヘルパーステーション 五十嵐 尚子
  "1273400844": ["9063"],  // 袖ヶ浦ムツミヘルパーステーション 中村 美彌子
  "1279000366": ["260302"],  // リンクスヘルパーステーション山武 黒田 美和
};

const q = async (path, init) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: H, ...init });
  const body = await r.text();                       // ★ PostgREST は空ボディを返すことがある
  if (!r.ok) throw new Error(`${path} ${r.status} ${body}`);
  return body ? JSON.parse(body) : null;
};
const norm = (v) => String(v ?? "").replace(/^0+/, "");

let bad = 0, n = 0;
console.log("\n月       事業所        社員     出勤簿通勤km  出張km  差引     ② 距離(通)  氏名");
for (const [off, emps] of Object.entries(VALUE)) {
  const calc = await q(`payroll_calc_results?select=processing_month,payload&office_number=eq.${off}&order=processing_month`);
  const souk = await q(`payroll_soukatsu_rows?select=processing_month,employee_number,row_data&office_number=eq.${off}&employee_number=in.(${emps.join(",")})`);
  for (const emp of emps) {
    let seen = 0;
    for (const c of calc) {
      const m = (c.payload?.monthly ?? []).find((x) => norm(x.employee_number) === norm(emp));
      const s = souk.find((x) => x.processing_month === c.processing_month && norm(x.employee_number) === norm(emp))?.row_data;
      if (!m || !s) continue;
      const commute = Number(m.summary?.commuteKmTotal ?? 0);
      if (!(commute > 0)) continue;
      seen++; n++;
      const raw = Number(m.travel_km > 0 ? m.travel_km : m.travel_km_auto ?? 0);
      // 出張 = 通勤 ちょうどは「同じ km を両方に書いた」型で 出張を落とす (payroll-calc.ts tripKmExcludingCommute と同じ)
      const trip = Math.abs(raw - commute) < 0.05 ? 0 : raw;
      const net = Math.round((commute - trip + Number(m.commute_km_carry ?? 0)) * 10) / 10;
      const want = Number(s["距離(通)"] ?? NaN);
      const comparable = Number.isFinite(want);
      const ok = !comparable || Math.abs(net - want) < 0.05;
      if (!ok) bad++;
      console.log(`${c.processing_month}  ${off}  ${emp.padEnd(7)} ${commute.toFixed(1).padStart(10)}  ${trip.toFixed(1).padStart(6)}  ${net.toFixed(1).padStart(6)}  ${String(comparable ? want : "(列なし)").padStart(9)}  ${s["氏名"]}${ok ? "" : "   ★ 不一致"}`);
    }
    if (!seen) { console.error(`★ ${off} ${emp} の 通勤km がある人月が見つかりません (社員番号の誤り?)`); bad++; }
  }
}
if (bad) { console.error(`\n★ ${bad} 件 合いません。中止します`); process.exit(2); }

const cur = (await q(`payroll_app_settings?select=value&key=eq.${SETTING}`))?.[0]?.value ?? null;
console.log(`\n${n} 人月 (② に距離(通) の列がある月は すべて一致)\n現在: ${JSON.stringify(cur)}\n入れる: ${JSON.stringify(VALUE)}`);
if (JSON.stringify(cur) === JSON.stringify(VALUE)) { console.log("既に入っています。何もしません"); process.exit(0); }
if (!EXECUTE) { console.log("\n(DRY RUN。--execute で実行します)"); process.exit(0); }
await q("payroll_app_settings", {
  method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates" },
  body: JSON.stringify({ key: SETTING, value: VALUE, updated_at: new Date().toISOString() }),
});
const after = (await q(`payroll_app_settings?select=value&key=eq.${SETTING}`))?.[0]?.value ?? null;
if (JSON.stringify(after) !== JSON.stringify(VALUE)) { console.error(`★ 書いた値が読めません: ${JSON.stringify(after)}`); process.exit(2); }
console.log("  入れました。⚠ 該当の 事業所 × 月 を再計算してください");
