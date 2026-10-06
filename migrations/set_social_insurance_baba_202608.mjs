/**
 * 君津ムツミ 馬場 麻帆 (251105・パート) の 202608 の社会保険を 1 にする (2026-10-06)。
 *
 *   node migrations/set_social_insurance_baba_202608.mjs            # DRY RUN
 *   node migrations/set_social_insurance_baba_202608.mjs --execute
 *
 * ── なぜ ────────────────────────────────────────────────────────────────
 * ② (支払用の総括表) は 202608 から 社保=1・処遇改善補助金手当 20,000 を払っている (202603〜07 は 0)。
 * 当方は 社保の月別入力 (payroll_monthly_inputs social_insurance) が無く、職員マスタも社保なし → 補助金 0 円。
 * user 方針「基本は金額に合わせる」(2026-09-21・align_social_insurance_to_payment.mjs) を 202608 に当てる
 * (user 承認 2026-10-06)。② の パート 611 人月のうち 当方が 0 なのは この件と 杉尾 202606 (入社月・訪問 0) だけ。
 *
 * ★ 入れる前に確かめる: ② の 202608 に 補助金 > 0 / 当方の 202608 に訪問がある / まだ社保の行が無い。
 * ⚠ 投入後に 君津 202608 を再計算すること (再計算は包括許可)。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
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
console.log(`[DB] 本番 ${/https:\/\/([a-z0-9]+)\./.exec(SB)?.[1]}`);
const q = async (path, init) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: H, ...init });
  const body = await r.text();                       // ★ PostgREST は空ボディを返すことがある
  if (!r.ok) throw new Error(`${path} ${r.status} ${body}`);
  return body ? JSON.parse(body) : null;
};

const OFF = "1273001626", EMP = "251105", YM = "202608";
const s = (await q(`payroll_soukatsu_rows?select=row_data&office_number=eq.${OFF}&employee_number=eq.${EMP}&processing_month=eq.${YM}&sheet_kind=eq.part`))?.[0]?.row_data;
const subsidy = Number(s?.["処遇改善補助金手当"] ?? 0);
const visits = (await q(`payroll_service_records?select=id&office_number=eq.${OFF}&employee_number=eq.${EMP}&processing_month=eq.${YM}&limit=1`)) ?? [];
const cur = (await q(`payroll_monthly_inputs?select=numeric_value&office_number=eq.${OFF}&employee_number=eq.${EMP}&processing_month=eq.${YM}&item_key=eq.social_insurance`)) ?? [];
console.log(`${s?.["氏名"] ?? "★ ② に無い"} ${YM}  ② 補助金 ${subsidy} / ② 社保列 ${s?.["社保"] ?? "-"} / 当方の訪問 ${visits.length ? "あり" : "なし"} / 社保の月別入力 ${cur.length ? cur[0].numeric_value : "なし"}`);
if (!(subsidy > 0)) { console.error("★ ② が補助金を払っていません。中止します"); process.exit(2); }
if (!visits.length) { console.error("★ 当方に訪問がありません (入れても 0 円)。中止します"); process.exit(2); }
if (cur.length && Number(cur[0].numeric_value) === 1) { console.log("既に 1 です。何もしません"); process.exit(0); }
if (cur.length) { console.error(`★ 既に ${cur[0].numeric_value} が入っています (意図して外した可能性)。中止します`); process.exit(2); }
if (!EXECUTE) { console.log("\n(DRY RUN。--execute で 社保=1 を入れます)"); process.exit(0); }
await q("payroll_monthly_inputs", { method: "POST", body: JSON.stringify({
  office_number: OFF, employee_number: EMP, processing_month: YM, item_key: "social_insurance", numeric_value: 1,
  note: "② (総括表) 202608 から社保=1・処遇改善補助金 20,000。user 方針「金額に合わせる」2026-10-06",
}) });
const after = (await q(`payroll_monthly_inputs?select=numeric_value&office_number=eq.${OFF}&employee_number=eq.${EMP}&processing_month=eq.${YM}&item_key=eq.social_insurance`)) ?? [];
if (Number(after[0]?.numeric_value) !== 1) { console.error("★ 書いた値が読めません"); process.exit(2); }
console.log("  入れました。⚠ 君津 202608 を再計算してください");
