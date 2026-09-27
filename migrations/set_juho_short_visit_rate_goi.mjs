/**
 * 五井 (1272401967) の 重度訪問 1 回 1.5h 以下の時給 1,550 円を payroll_app_settings.juho_short_visit_rates に足す (2026-09-27 給与D)。
 *
 *   node migrations/set_juho_short_visit_rate_goi.mjs             # DRY RUN (今の値と 書いた後の値を出す)
 *   node migrations/set_juho_short_visit_rate_goi.mjs --execute   # 五井のキーだけ足す (他の事業所の値は そのまま)
 *   node migrations/set_juho_short_visit_rate_goi.mjs --delete    # 五井のキーだけ消す (DRY RUN。--delete --execute で実行)
 *
 * 根拠 (3 つ):
 *   (a) ② (総括表 支払用) の小計との差 (当方 − ②) = −(重度訪問の 1.5h 以下の時間 × 50) が 8/8 一致。
 *       五井の全人月 (重度 1.5h 以下の訪問がある時給者): 直る 11 / いま一致していて壊れる 0 / どちらでもない 1
 *       (佐藤晴香 745|202604 +1,000 = 30 分多い訪問 +1,050 と −50 の合成で説明がつく)
 *   (b) 既存の 5 事業所すべてで「短時間 = 区分の時給 + 50」(中央・高品・おゆみ野・花見川・やわた)。
 *       五井の区分の時給 (payroll_category_hourly_rates 重度訪問) は 1,500 → 1,550 で同じ形になる
 *   (c) 旧システムの確認用ブック (Box 10F内共有/02_共有/10_給与/01_総括表/01_実績データ確認用.xlsm「02_実績データ」、五井 202601 分)
 *       のシステム単価: 重度訪問 1.5h 以下 22 件 = 1,550 / 1.5h 超 13 件 = 1,500
 * 経緯: 2026-09-18 の set_juho_short_visit_rates.mjs では「五井は 8 月のブックでは同じ形だが 7 月の総括表とは合わないので入れない」とした。
 *   ★ 2026-09-27 の データでは 7 月も 3/3 直る (当時は別の原因が重なっていたとみられる)。
 * 冪等。五井以外のキーには触らない (書く前に今の値を読み、五井のキーだけ差し替える)。直したら 五井の 202603〜202608 を再計算する。
 */
import { readFileSync } from "node:fs";
const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");
const OFFICE = "1272401967", CATEGORY = "重度訪問", RATE = 1550;
const env = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
async function req(method, p, body, extra = {}) {
  const r = await fetch(`${SB}/rest/v1/${p}`, { method, headers: { ...H, ...extra }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${p}: ${await r.text()}`);
  return r.json();
}

const rows = await req("GET", "payroll_app_settings?select=key,value&key=eq.juho_short_visit_rates");
if (rows.length !== 1) { console.error(`★ juho_short_visit_rates が ${rows.length} 行 (1 行のはず)。止めます`); process.exit(2); }
const cur = rows[0].value ?? {};
const next = JSON.parse(JSON.stringify(cur));
if (DELETE) delete next[OFFICE];
else next[OFFICE] = { ...(cur[OFFICE] ?? {}), [CATEGORY]: RATE };

// 他の事業所のキーが変わっていないことを確かめてから書く
const others = (v) => JSON.stringify(Object.fromEntries(Object.entries(v).filter(([k]) => k !== OFFICE).sort()));
if (others(cur) !== others(next)) { console.error("★ 五井以外の値が変わってしまう。止めます"); process.exit(2); }

console.log(`今      : ${JSON.stringify(cur)}`);
console.log(`書いた後: ${JSON.stringify(next)}`);
if (JSON.stringify(cur) === JSON.stringify(next)) { console.log("変更なし (既にこの値)"); process.exit(0); }
if (!EXECUTE) { console.log(`DRY RUN (${DELETE ? "--delete --execute" : "--execute"} で書き込み)`); process.exit(0); }

await req("PATCH", "payroll_app_settings?key=eq.juho_short_visit_rates", { value: next, updated_at: new Date().toISOString() }, { Prefer: "return=representation" });
const [after] = await req("GET", "payroll_app_settings?select=value&key=eq.juho_short_visit_rates");
if (JSON.stringify(after.value) !== JSON.stringify(next)) { console.error(`★ 書いた後の確認で一致しない: ${JSON.stringify(after.value)}`); process.exit(1); }
console.log(`完了 (確認済み)。五井 ${DELETE ? "を消した" : `${CATEGORY} ${RATE}`}。五井の 202603〜202608 を再計算すること`);
