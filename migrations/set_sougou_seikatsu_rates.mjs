/**
 * 総合事業 (A…) で生活援助に結び付いている訪問の時給を事業所ごとに入れる (2026-09-18)。
 *
 *   node migrations/set_sougou_seikatsu_rates.mjs            # DRY RUN
 *   node migrations/set_sougou_seikatsu_rates.mjs --execute
 *
 * 根拠: 旧システムの確認用ブック (01_実績データ確認用.xlsm 202608)「総合事業身なし」のシステム単価。
 *   多くの事業所は生活援助と同じ時給。違うのは 船橋 1,400 円 (生活援助 1,750 円) だけ。
 *   2026-07 の総括表で 船橋の時給者の小計 4 → 17 / 19 人一致。
 * 冪等。⚠ 給与計算の画面 (getSougouSeikatsuRates) を先にデプロイしてから入れること。
 */
import { readFileSync } from "node:fs";
const EXECUTE = process.argv.includes("--execute");
const env = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const want = { "1270906546": 1400 }; // 船橋
const r = await fetch(`${SB}/rest/v1/payroll_app_settings?select=value&key=eq.sougou_seikatsu_rates`, { headers: H });
if (!r.ok) { console.error(await r.text()); process.exit(1); }
const [cur] = await r.json();
const norm = (v) => JSON.stringify(Object.fromEntries(Object.entries(v ?? {}).sort()));
console.log(`現在 ${JSON.stringify(cur?.value ?? null)} → ${JSON.stringify(want)}`);
if (norm(cur?.value) === norm(want)) { console.log("書き込み 0 件"); process.exit(0); }
console.log("書き込み 1 件");
if (!EXECUTE) { console.log("DRY RUN (--execute で書き込み)"); process.exit(0); }
const w = await fetch(`${SB}/rest/v1/payroll_app_settings?on_conflict=key`, { method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" },
  body: JSON.stringify({ key: "sougou_seikatsu_rates", value: want, updated_at: new Date().toISOString() }) });
if (!w.ok) { console.error(await w.text()); process.exit(1); }
console.log("完了");
