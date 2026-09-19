/**
 * 社員の残業代から 介護超過の支払額 (入浴・HRD 込み) を差し引く事業所 を payroll_app_settings に入れる (2026-09-19)。
 *
 *   node migrations/set_overtime_offset_full_care_offices.mjs            # DRY RUN
 *   node migrations/set_overtime_offset_full_care_offices.mjs --execute
 *
 * 総括表「120h以上+深夜」= 介護 の支払額 と一致する事業所。3〜7月で 生の訪問時間の式と食い違ったのは リンクス茂原 だけ
 * (寺内・鶴岡・木村 = HRD 1h 分 / HO = 入浴時間 + HRD 分)。冪等。
 */
import { readFileSync } from "node:fs";
const EXECUTE = process.argv.includes("--execute");
const VALUE = { offices: ["1271500942"] }; // リンクスヘルパーステーション (茂原)
const env = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL + "/rest/v1/";
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
const cur = await (await fetch(`${SB}payroll_app_settings?select=value&key=eq.overtime_offset_full_care_offices`, { headers: H })).json();
console.log("現在:", JSON.stringify(cur[0]?.value ?? null), "/ 入れる:", JSON.stringify(VALUE));
if (JSON.stringify(cur[0]?.value ?? null) === JSON.stringify(VALUE)) { console.log("変更なし"); process.exit(0); }
if (!EXECUTE) { console.log("DRY RUN (--execute で書き込み)"); process.exit(0); }
const r = await fetch(`${SB}payroll_app_settings?on_conflict=key`, { method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates" },
  body: JSON.stringify({ key: "overtime_offset_full_care_offices", value: VALUE, updated_at: new Date().toISOString() }) });
if (!r.ok) { console.error(`★ 失敗: ${await r.text()}`); process.exit(1); }
console.log("完了");
