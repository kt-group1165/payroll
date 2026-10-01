/**
 * 初任者研修の時間 (と それに伴う交通費) を スキャンの受講記録から入れる (2026-10-01)。
 *
 *   node migrations/fix_shoninsha_inputs_20261001.mjs              # DRY RUN
 *   node migrations/fix_shoninsha_inputs_20261001.mjs --execute    # 本番
 *   PAYROLL_ENV=staging node migrations/fix_shoninsha_inputs_20261001.mjs --execute
 *
 * ── なぜ ────────────────────────────────────────────────────────────────
 * 初任者研修は **訪問ではない**ので MEISAI (稼働) にも 訪問カレンダーにも出ない。
 * 事業所書式か 月次手入力にしか入る場所が無く、★ 入れ忘れても どこにも警告が出なかった。
 * npm run check:shoninsha-input で 10 人月 ¥161,575 が見えるようになり、
 * ★ そのうち A (当方が不足) 7 人月のうち 江波戸 1 名は別 script で済。残り 6 人月がこれ。
 *
 * ── 根拠 ────────────────────────────────────────────────────────────────
 * ★ ② ではなく **スキャン PDF の受講記録 / 三幸福祉カレッジの交通費メモ** から読んだ。
 *   いずれも ② と 1 分 / 1 円まで一致する (2 つの独立した材料が揃ったものだけ入れる)。
 *
 *   杉尾 加奈子  茂原 R8.7 ﾊﾟｰﾄ p17  受講記録 合計 35:00 = 2,100分
 *                同 p16  茂原⇔千葉 往復 ¥1,240 × 6日間 = ¥7,440
 *   Ho Jian Kyle 茂原 R8.5 ﾊﾟｰﾄ p45  受講記録 6+6+6+6+5:20 = 合計 29:00 = 1,740分 (受講日数 5回)
 *                同 p48  茂原⇔千葉 往復 ¥1,240 × 5日間 = 印字 ¥6,200 に手書き訂正 6,33x (② 6,339)
 *   安藤 仁海    東郷 R8.6 ﾊﾟｰﾄ p36  受講記録 6/1 6:00 + 6/2 5:00 = 合計 11時間 = 660分 (受講日数 2日)
 *                同 p37  茂原〜船橋 往復 ¥2,040 × 2日間 = ¥4,080
 *   横山 みどり  大網 R8.4 ﾊﾟｰﾄ p7   「新人研修手当」4/20 2:00 + 4/27 2:00 = 240分
 *   長島 勉      同上                 「新人研修手当」4/24 1:00 + 4/30 2:00 = 180分
 *   田代 京子    大網 R8.3 ﾊﾟｰﾄ p10  「スキルアップ研修手当」3/12 13:30-14:30 = 60分
 *
 * ⚠ ★ **事業所の表は @1,100 で金額を書いている** (大網の新人研修手当 ¥3,300 / ¥4,400、
 *   スキルアップ研修手当 ¥1,100) が、★ ② と当方は @1,150。★ 入れるのは **時間**であって金額ではない。
 *   単価のどちらが正かは 別途 user 確認が要る (ここでは ②=当方 の 1,150 のまま)。
 * ⚠ ★ 大網の表は「新人研修手当」「スキルアップ研修手当」という名前だが、
 *   ★ ② はこれを **初任者研修費の欄**に入れている。再現のため shoninsha_training_minutes に入れる。
 * ⚠ 横山・長島・田代は ② の通勤費が 0 なので 交通費は入れない。
 * ⚠ 投入後に /payroll で 該当の 事業所×月 を **再計算**しないと金額に反映されない。
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

/** office_number, employee_number, processing_month, 研修分, 交通費(円。null なら入れない), 根拠 */
const ROWS = [
  { off: "1271500942", emp: "260603", month: "202607", min: 2100, yen: 7440, who: "杉尾 加奈子", src: "茂原 R8.7 ﾊﾟｰﾄ p17 受講記録 35:00 / p16 交通費 ¥1,240×6日" },
  { off: "1271500942", emp: "260403", month: "202605", min: 1740, yen: 6339, who: "Ho Jian Kyle", src: "茂原 R8.5 ﾊﾟｰﾄ p45 受講記録 29:00 / p48 交通費 ¥1,240×5日 手書き訂正" },
  { off: "1271502518", emp: "260503", month: "202606", min: 660, yen: 4080, who: "安藤 仁海", src: "東郷 R8.6 ﾊﾟｰﾄ p36 受講記録 11時間 / p37 交通費 ¥2,040×2日" },
  { off: "1275800892", emp: "230802", month: "202604", min: 240, yen: null, who: "横山 みどり", src: "大網 R8.4 ﾊﾟｰﾄ p7 新人研修手当 2:00+2:00" },
  { off: "1275800892", emp: "260104", month: "202604", min: 180, yen: null, who: "長島 勉", src: "大網 R8.4 ﾊﾟｰﾄ p7 新人研修手当 1:00+2:00" },
  { off: "1275800892", emp: "220502", month: "202603", min: 60, yen: null, who: "田代 京子", src: "大網 R8.3 ﾊﾟｰﾄ p10 スキルアップ研修手当 1:00" },
];

const q = async (path, init) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: H, ...init });
  const body = await r.text();
  if (!r.ok) throw new Error(`${path} ${r.status} ${body}`);
  // ⚠ PostgREST は Prefer: return=representation が無いと 空ボディで返す
  return body ? JSON.parse(body) : null;
};

const cur = await q("payroll_monthly_inputs?select=id,office_number,employee_number,processing_month,item_key,numeric_value&item_key=in.(shoninsha_training_minutes,commute_yen)");
const curOf = new Map(cur.map((r) => [`${r.office_number}|${r.employee_number}|${r.processing_month}|${r.item_key}`, r]));

const ins = [], upd = [];
console.log("\n氏名           月      項目                        今の値    入れる値");
for (const r of ROWS) {
  const items = [["shoninsha_training_minutes", r.min]];
  if (r.yen !== null) items.push(["commute_yen", r.yen]);
  for (const [key, val] of items) {
    const e = curOf.get(`${r.off}|${r.emp}|${r.month}|${key}`);
    const now = e ? String(e.numeric_value) : "(無し)";
    console.log(`${r.who.padEnd(14)} ${r.month}  ${key.padEnd(28)} ${now.padStart(8)} → ${String(val).padStart(8)}`);
    if (!e) ins.push({ office_number: r.off, employee_number: r.emp, processing_month: r.month, item_key: key, numeric_value: val, note: `${r.src} より 2026-10-01` });
    else if (Number(e.numeric_value) !== val) upd.push({ id: e.id, val, note: `${r.src} より 2026-10-01` });
  }
}
console.log(`\n新規 ${ins.length} 件 / 更新 ${upd.length} 件`);

if (!EXECUTE) { console.log("\n(DRY RUN。--execute で実行します)"); process.exit(0); }

if (ins.length) await q("payroll_monthly_inputs", { method: "POST", body: JSON.stringify(ins) });
for (const u of upd) await q(`payroll_monthly_inputs?id=eq.${u.id}`, { method: "PATCH", body: JSON.stringify({ numeric_value: u.val, note: u.note }) });

console.log("\n入れた後:");
for (const r of ROWS) {
  const after = await q(`payroll_monthly_inputs?select=processing_month,item_key,numeric_value&office_number=eq.${r.off}&employee_number=eq.${r.emp}&processing_month=eq.${r.month}&item_key=in.(shoninsha_training_minutes,commute_yen)&order=item_key`);
  console.log(`  ${r.who.padEnd(14)} ${r.month}  ${after.map((x) => `${x.item_key}=${x.numeric_value}`).join(" / ")}`);
}
console.log("\n⚠ /payroll で 次の 事業所×月 を **再計算**してください:");
console.log("   リンクスヘルパーステーション       2026年5月 / 2026年7月");
console.log("   リンクスヘルパーステーション東郷    2026年6月");
console.log("   リンクスヘルパーステーション大網白里 2026年3月 / 2026年4月");
