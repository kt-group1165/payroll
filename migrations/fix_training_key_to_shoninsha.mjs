/**
 * 手入力の item_key を training_minutes から shoninsha_training_minutes に付け替える (2026-09-27)。
 *
 *   node migrations/fix_training_key_to_shoninsha.mjs            # DRY RUN
 *   node migrations/fix_training_key_to_shoninsha.mjs --execute   # 本番
 *   node migrations/fix_training_key_to_shoninsha.mjs --delete --execute   # 撤去 (元のキーに戻す)
 *
 * 【なぜ】
 * 2026-09-23 の set_training_minutes_from_soukatsu.mjs (f55c1da) が、
 * ① の HRD研修 + 研修 + 会議 + 初任者研修 の時間を **合計して** training_minutes に入れていた。
 * 初任者研修用の shoninsha_training_minutes は 2026-09-26 (ad477d0) にできたが、
 * この 3 行は移されていない。
 *
 * 【総支給は変わらない】
 * page.tsx 1334-1338: trainingPay = 書式の研修 + 初任者の分 + training_minutes。
 * どちらのキーでも研修手当の合計は同じで、単価も同じ 1,150 円/時。
 * 変わるのは振り分けだけ (shoninsha_pay が 0 から その額になる。総括表では本人給)。
 * manualTrainingMinByNum を介護時間に足す箇所 (1885 行) は月給者だけなので、
 * この 3 名 (パート) には効かない。
 *
 * 【2 つ以上の材料が一致することを確認済み (2026-09-27 実測)】
 *   今井美穂   1270402116|240705|202606  当方 1530 分
 *     ② 内初任者研修時間 25:30 (=1530 分) / 初任者研修費 29,325 = 1530 / 60 x 1150
 *     ② の HRD研修・内研修時間・会議費 は すべて空 = 研修は初任者だけ
 *   杉尾加奈子 1271500942|260603|202606  当方 3390 分
 *     ② 内初任者研修時間 3390 / 初任者研修費 64,975 = 3390 / 60 x 1150
 *   江波戸祐子 1279000366|260704|202607  当方 60 分
 *     「初任者研修である」ことは ① と ② で一致。分は ① 1:00 (=60) で 当方と一致
 *     ⚠ ② は 3030 分 だが ② だけが根拠なので 値は動かさない (キーだけ付け替える)
 *
 * ⚠ 付け替えても その事業所月を再計算するまで振り分けは変わらない。
 *   要る再計算: 1270402116 202606 / 1271500942 202606 / 1279000366 202607
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");
const BACKUP = "migrations/_backup_training_key_to_shoninsha_20260927.json";
const NOTE = "[初任者研修のキー付け替え 2026-09-27] training_minutes -> shoninsha_training_minutes";
const FROM = "training_minutes";
const TO = "shoninsha_training_minutes";

/** 対象。office_number | employee_number | processing_month | 期待する分 */
const TARGETS = [
  { office_number: "1270402116", employee_number: "240705", processing_month: "202606", minutes: 1530, name: "今井美穂" },
  { office_number: "1271500942", employee_number: "260603", processing_month: "202606", minutes: 3390, name: "杉尾加奈子" },
  { office_number: "1279000366", employee_number: "260704", processing_month: "202607", minutes: 60, name: "江波戸祐子" },
];

const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, K = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !K) { console.error("[NG] .env.local が読めません"); process.exit(1); }
const H = { apikey: K, Authorization: "Bearer " + K, "Content-Type": "application/json" };

async function rowsOf(t, key) {
  const q = `payroll_monthly_inputs?select=id,office_number,employee_number,processing_month,item_key,numeric_value,note`
    + `&office_number=eq.${t.office_number}&employee_number=eq.${t.employee_number}`
    + `&processing_month=eq.${t.processing_month}&item_key=eq.${key}`;
  const r = await fetch(`${SB}/rest/v1/${q}`, { headers: H });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(`配列でない: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

if (DELETE) {
  if (!existsSync(BACKUP)) { console.error(`[NG] 控え ${BACKUP} がありません`); process.exit(1); }
  const back = JSON.parse(readFileSync(BACKUP, "utf8"));
  console.log(`撤去対象 ${back.rows.length} 行 (${TO} -> ${FROM} に戻す)`);
  for (const b of back.rows) console.log(`  ${b.processing_month} ${b.office_number} ${b.employee_number} ${b.name} ${b.numeric_value} 分`);
  if (!EXECUTE) { console.log("DRY RUN。--delete --execute で戻します"); process.exit(0); }
  let done = 0;
  for (const b of back.rows) {
    const r = await fetch(`${SB}/rest/v1/payroll_monthly_inputs?id=eq.${b.id}`, {
      method: "PATCH", headers: { ...H, Prefer: "return=representation" },
      body: JSON.stringify({ item_key: FROM, note: b.note_before ?? null }),
    });
    if (!r.ok) { console.error(`[NG] 戻せません ${b.id}: ${await r.text()}`); process.exit(1); }
    const j = await r.json();
    if (j.length !== 1) { console.error(`[NG] 1 行のはずが ${j.length} 行`); process.exit(2); }
    done++;
  }
  console.log(`${done} 行を戻しました。★ 該当の事業所月を再計算してください`);
  process.exit(0);
}

console.log(`=== 初任者研修のキー付け替え ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log(`${FROM} -> ${TO} 。値は動かしません。総支給も変わりません (振り分けだけ)`);
console.log("");

const plan = [], skipped = [];
for (const t of TARGETS) {
  const from = await rowsOf(t, FROM);
  const to = await rowsOf(t, TO);
  const label = `${t.processing_month} ${t.office_number} ${t.employee_number} ${t.name}`;
  if (to.length > 0) { skipped.push(`  ${label}  [SKIP] 既に ${TO} の行がある (${to.map((x) => x.numeric_value).join(",")})`); continue; }
  if (from.length === 0) { skipped.push(`  ${label}  [SKIP] ${FROM} の行が無い (付け替え済みか撤去済み)`); continue; }
  if (from.length > 1) { skipped.push(`  ${label}  [NG] ${FROM} が ${from.length} 行ある。手で確かめること`); continue; }
  const row = from[0];
  const got = Number(row.numeric_value ?? 0);
  if (got !== t.minutes) { skipped.push(`  ${label}  [NG] 分が期待と違う (期待 ${t.minutes} / 実 ${got})`); continue; }
  plan.push({ ...t, id: row.id, numeric_value: got, note_before: row.note ?? null });
}

console.log(`--- 付け替える ${plan.length} 行`);
for (const p of plan) console.log(`  ${p.processing_month} ${p.office_number} ${p.employee_number} ${p.name}  ${p.numeric_value} 分`);
if (skipped.length) { console.log(""); console.log(`--- 付け替えない ${skipped.length} 行`); for (const s of skipped) console.log(s); }

if (!EXECUTE) { console.log(""); console.log("DRY RUN。--execute で書き込みます"); process.exit(0); }
if (plan.length === 0) { console.log(""); console.log("対象がありません"); process.exit(0); }
if (plan.length !== TARGETS.length) {
  console.error("");
  console.error(`[NG] 対象 ${TARGETS.length} 件のうち ${plan.length} 件しか揃いません。止めます (部分適用しない)`);
  process.exit(2);
}

const done = [];
for (const p of plan) {
  const r = await fetch(`${SB}/rest/v1/payroll_monthly_inputs?id=eq.${p.id}`, {
    method: "PATCH", headers: { ...H, Prefer: "return=representation" },
    body: JSON.stringify({ item_key: TO, note: p.note_before ? `${p.note_before} ${NOTE}` : NOTE }),
  });
  if (!r.ok) { console.error(`[NG] 書き込みに失敗 ${p.id}: ${await r.text()}`); process.exit(1); }
  const j = await r.json();
  if (j.length !== 1 || j[0].item_key !== TO) { console.error(`[NG] 想定どおりに更新されていません: ${JSON.stringify(j).slice(0, 200)}`); process.exit(2); }
  done.push(p);
}
writeFileSync(BACKUP, JSON.stringify({ at: new Date().toISOString(), note: NOTE, from: FROM, to: TO, rows: done }, null, 2));
console.log("");
console.log(`${done.length} 行を付け替えました。控え: ${BACKUP}`);
console.log("");
console.log("⚠ 振り分けはまだ変わっていません。次の事業所月を再計算してください:");
console.log("   1270402116 202606 / 1271500942 202606 / 1279000366 202607");
console.log("★ 撤去: node migrations/fix_training_key_to_shoninsha.mjs --delete --execute");
