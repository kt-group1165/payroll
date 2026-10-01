/**
 * 江波戸 祐子 (リンクスヘルパーステーション山武) の 初任者研修時間 と 交通費 を入れる (2026-10-01)。
 *
 *   node migrations/fix_ebato_shoninsha_20261001.mjs              # DRY RUN
 *   node migrations/fix_ebato_shoninsha_20261001.mjs --execute    # 本番
 *   PAYROLL_ENV=staging node migrations/fix_ebato_shoninsha_20261001.mjs --execute   # staging
 *
 * ── なぜ ────────────────────────────────────────────────────────────────
 * 総支給の差が 10% を超える 20 人月のうち 最大 (¥73,565)。
 * ★ 当初「山武の MEISAI 再出力が要る」と誤診した。実際は:
 *   - MEISAI は正しく Box にある
 *   - 彼女は **訪問が 1 件も無い月** (丸ごと初任者研修)。だから MEISAI に出ない
 *   - 初任者研修は 事業所書式か 月次手入力にしか入る場所が無い (山武の書式は km/leave のみ)
 *
 * ── 根拠 (★ ② とは独立した 2 つ目の材料。スキャン PDF から読んだ) ──────────
 *   研修時間  02_スキャン/K13 山武/山武 R8/山武 R8.7/R8.7 山武 ﾊﾟｰﾄ.pdf  p9
 *             「所属 リンクスヘルパーステーション山武 / 名前 江波戸 祐子 / 2026年7月」
 *             赤字の支払対象時間 7+6+6+6.5+7+6+6+6 = 50.5h → 合計時間 50:30 = 3,030分
 *             同 R8.8 p29  2026年8月  6+6 = 12.0h = 720分 (受講日数 2)
 *   交通費    同 R8.7 p5   三幸福祉カレッジ 飯倉駅⇔千葉駅 往復 ¥2,080 × 8日間 = ¥16,640
 *             同 R8.8 p30  ¥4,160 (= ¥2,080 × 2日。受講日数 2 と整合)
 *
 *   ★ いずれも ② の値と 1 円 / 1 分まで一致する:
 *     202607  3,030分 ÷ 60 × 1,150 = ¥58,075 = ② の初任者研修費
 *     202608    720分 ÷ 60 × 1,150 = ¥13,800 = ② の初任者研修費
 *     202608  ② 総支給 17,960 = 13,800 + 4,160
 *
 * ⚠ 当方の 202607 には 既に shoninsha_training_minutes=60 が入っている (値が違う)。上書きする。
 * ⚠ 投入後に /payroll で 山武 202607 / 202608 を **再計算**しないと金額に反映されない。
 */
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const STAGING = process.env.PAYROLL_ENV === "staging";
const ENV_FILES = STAGING ? [".env.staging"] : ["../kaigo-app/.env.local", ".env.local"];
const env = {};
for (const p of ENV_FILES) {
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

const OFFICE = "1279000366";   // リンクスヘルパーステーション山武
const EMP = "260704";          // 江波戸 祐子
const NOTE = "初任者研修 受講記録 (スキャン R8.7 p9 / R8.8 p29) と 三幸福祉カレッジ 交通費 (R8.7 p5 / R8.8 p30) より 2026-10-01";

/** ★ ② ではなく **受講記録と交通費のメモ** から取った値 */
const ROWS = [
  { processing_month: "202607", item_key: "shoninsha_training_minutes", numeric_value: 3030 },
  { processing_month: "202607", item_key: "commute_yen", numeric_value: 16640 },
  { processing_month: "202608", item_key: "shoninsha_training_minutes", numeric_value: 720 },
  { processing_month: "202608", item_key: "commute_yen", numeric_value: 4160 },
];

const q = async (path, init) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: H, ...init });
  if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
};

const cur = await q(`payroll_monthly_inputs?select=id,processing_month,item_key,numeric_value&office_number=eq.${OFFICE}&employee_number=eq.${EMP}`);
const curOf = new Map(cur.map((r) => [`${r.processing_month}|${r.item_key}`, r]));

console.log("\n月      項目                        今の値    入れる値");
const ins = [], upd = [];
for (const r of ROWS) {
  const e = curOf.get(`${r.processing_month}|${r.item_key}`);
  const now = e ? String(e.numeric_value) : "(無し)";
  console.log(`${r.processing_month}  ${r.item_key.padEnd(28)} ${now.padStart(8)} → ${String(r.numeric_value).padStart(8)}`);
  if (!e) ins.push({ office_number: OFFICE, employee_number: EMP, ...r, note: NOTE });
  else if (Number(e.numeric_value) !== r.numeric_value) upd.push({ id: e.id, ...r });
}
console.log(`\n新規 ${ins.length} 件 / 更新 ${upd.length} 件 / 変更なし ${ROWS.length - ins.length - upd.length} 件`);

if (!EXECUTE) { console.log("\n(DRY RUN。--execute で実行します)"); process.exit(0); }

if (ins.length) await q("payroll_monthly_inputs", { method: "POST", body: JSON.stringify(ins) });
for (const u of upd) {
  await q(`payroll_monthly_inputs?id=eq.${u.id}`, { method: "PATCH", body: JSON.stringify({ numeric_value: u.numeric_value, note: NOTE }) });
}
const after = await q(`payroll_monthly_inputs?select=processing_month,item_key,numeric_value&office_number=eq.${OFFICE}&employee_number=eq.${EMP}&order=processing_month`);
console.log("\n入れた後:");
for (const r of after) console.log(`  ${r.processing_month} ${r.item_key.padEnd(28)} ${r.numeric_value}`);
console.log("\n⚠ /payroll で 山武 の 2026年7月 / 2026年8月 を **再計算**してください。再計算するまで金額は変わりません。");
