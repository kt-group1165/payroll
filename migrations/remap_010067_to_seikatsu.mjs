/**
 * サービスコード 010067「移身無0.5」(移動支援・身体介護なし 0.5h) の給与区分を 身体介護 → 生活援助 にする (2026-09-27 給与D)。
 *
 *   node migrations/remap_010067_to_seikatsu.mjs            # DRY RUN
 *   node migrations/remap_010067_to_seikatsu.mjs --execute
 *
 * 根拠 (2 つ):
 *   1. 他の「移身無」010068〜010076 と「移動身なし」010307〜010312 は 全部 生活援助。010067 だけ 身体介護 だった。
 *   2. ② (総括表 支払用) の小計との差 (当方 − ②) = 010067 の時間 × (身体介護 − 生活援助) が ★ 4/4 一致
 *        鶴岡みどり 1270203191|250407|202603  90 分 × 300 = +450
 *        米倉靖子   1270203191|240604|202603 150 分 × 300 = +750
 *        鈴木弘子   1270201930|2060|202603   150 分 × 300 = +750
 *        餅原朋美   1272401967|702|202607    30 分 × 550 = +275
 *      負のコントロール: 010067 を使っていて いま ② と一致している人月 (= 付け替えると壊れる) は 0。
 *      比べられない 6 人月 (202602 = 総括表なし / 1270203191|240204|202603 = ② の行なし) は見ていない。
 *   (011002 を同じ理由で直した remap_011002_to_seikatsu.mjs と同じ形)
 * 対象: payroll_service_type_mappings の 010067 (全事業所共通)。冪等。直したら 該当月を再計算する。
 */
import { readFileSync } from "node:fs";
const EXECUTE = process.argv.includes("--execute");
const env = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL + "/rest/v1/";
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
const get = async (p) => { const r = await fetch(SB + p, { headers: H }); if (!r.ok) throw new Error(`${p}: ${await r.text()}`); return r.json(); };
const cats = await get("payroll_service_categories?select=id,name");
const seikatsu = cats.find((c) => c.name === "生活援助");
if (!seikatsu) { console.error("★ 区分「生活援助」が見つかりません"); process.exit(1); }
const rows = await get("payroll_service_type_mappings?select=id,service_code,service_name,category_id&service_code=eq.010067");
if (rows.length !== 1) { console.error(`★ 010067 の対応が ${rows.length} 行 (1 行のはず)`); process.exit(2); }
for (const r of rows) console.log(`010067 ${r.service_name}: ${cats.find((c) => c.id === r.category_id)?.name} → 生活援助`);
const ops = rows.filter((r) => r.category_id !== seikatsu.id);
console.log(`書き込み ${ops.length} 件`);
if (!EXECUTE) { console.log("DRY RUN (--execute で書き込み)"); process.exit(0); }
for (const r of ops) {
  const w = await fetch(`${SB}payroll_service_type_mappings?id=eq.${r.id}`, { method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify({ category_id: seikatsu.id }) });
  if (!w.ok) { console.error(`★ 失敗: ${await w.text()}`); process.exit(1); }
  const got = await w.json();
  if (!Array.isArray(got) || got.length !== 1) { console.error(`★ 更新された行が ${Array.isArray(got) ? got.length : "?"} 行`); process.exit(1); }
}
const after = await get("payroll_service_type_mappings?select=category_id&service_code=eq.010067");
console.log(after.every((r) => r.category_id === seikatsu.id) ? "完了 (確認: 010067 → 生活援助)" : "★ 確認で 生活援助 になっていない");
