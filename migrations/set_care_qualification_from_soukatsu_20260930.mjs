/**
 * 総括表で勤続手当が出ている人に has_care_qualification=true を立てる (2026-09-30)。
 *
 *   SOUKATSU1_DIR=<① の抽出物の dir> node migrations/set_care_qualification_from_soukatsu_20260930.mjs            # DRY RUN
 *   SOUKATSU1_DIR=… node migrations/set_care_qualification_from_soukatsu_20260930.mjs --execute
 *   SOUKATSU1_DIR=… node migrations/set_care_qualification_from_soukatsu_20260930.mjs --siblings --execute   # 兼務先の行も立てる
 *   node migrations/set_care_qualification_from_soukatsu_20260930.mjs --revert --execute                     # 書き込み前の値に戻す
 *
 * ── 根拠 (user 2026-09-30) ────────────────────────────────────────────────
 * ★ 「総括表で勤続手当が出てるなら資格者」。
 *   勤続手当の支給要件は 介護福祉士 / 実務者研修修了者 / 介護支援専門員 なので、
 *   ★ 総括表が勤続手当を払っていること自体が 資格を持っている証拠になる。
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────────
 * ★ 当方の payroll_employees.has_care_qualification が false のまま の人が多い。
 *   時給者 … computeTenureAllowance が 0 円を返すので ★ そのまま金額の欠落になる
 *   月給者 … payroll_salary_settings.tenure_allowance (手入力・auto=false) が使われるので
 *            ★ いまは金額が合っている。★ しかし 旗が false のままだと
 *            ① 資格手当・自動計算に切り替えたとき / ② 帳票・一覧の表示 で 誤る
 *   → ★ 金額に効くかどうかに関わらず 旗は直す (user 判断)。
 *
 * ── 判定 ──────────────────────────────────────────────────────────────────
 * ① (総括表データ) か ② (payroll_soukatsu_rows) の 勤続手当の額が ★ 1 円以上の月が 1 つでもあれば 資格者。
 *   額の列: ① 時給「勤続手当（パート）」/ ① 月給「勤続手当」/ ② 「勤続手当」または「資格or勤続手当」
 *   ⚠ ★ 「勤続手当2」は 額ではない (1 が入る) ので 使わない。
 *   ⚠ ★ 空欄は 0 円ではない。空欄しか無い人は 判定に使わない (資格が無いとは言えない)。
 *
 * ⚠ ★ 逆向き (当方 true だが 総括表が一度も払っていない) は **触らない**。
 *   勤続 1 年未満なら 資格があっても 0 円なので、★ 払っていないことは 資格が無い証拠にならない。
 *
 * 冪等。既に true の行は 触らない。
 * ★ --execute は 書き込む前の値を migrations/_backup_care_qualification_20260930.json に控える。
 *   --revert はそのファイルを読んで **1 行ずつ元の値に**戻す (kind の値では見分けられないため)。
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const EXECUTE = process.argv.includes("--execute");
const SIBLINGS = process.argv.includes("--siblings");
const REVERT = process.argv.includes("--revert");
/**
 * care_qualification_kind に入れる値。
 * ⚠ ★ この列には CHECK 制約がある (migrations/payroll_employees_care_qualification_kind.sql):
 *      '介護福祉士' / '実務者研修修了' / '介護支援専門員' / '不明（要件は満たす）'
 *   ★ 2026-09-30 に 独自の値 ("総括表の勤続手当より（要件は満たす）") を入れようとして
 *     ★ 1 行目で 23514 で落ちた (書き込みは 0 行)。★ 勝手な値を作らない。
 */
const KIND_ALLOWED = ["介護福祉士", "実務者研修修了", "介護支援専門員", "不明（要件は満たす）"];
const KIND_VALUE = "不明（要件は満たす）";
if (!KIND_ALLOWED.includes(KIND_VALUE)) { console.error(`★ care_qualification_kind の CHECK 制約に無い値です: ${KIND_VALUE}`); process.exit(2); }
/**
 * ★ 復元用のログ。★ kind の値では この script が立てた行を見分けられない
 *   (既に true の 142 行も同じ '不明（要件は満たす）' を持つ) ので、
 *   ★ 書き込む前の値を ここに控えて --revert でそのまま戻す。
 */
const BACKUP = "migrations/_backup_care_qualification_20260930.json";

const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) { console.error("★ .env.local が読めません"); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const q = async (path, init) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: H, ...init });
  if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`);
  // ⚠ PostgREST の PATCH/POST/DELETE は Prefer: return=representation が無いと 本文を返さない
  const body = await r.text();
  return body ? JSON.parse(body) : null;
};
async function all(path, order = "id") {
  const out = []; let from = 0;
  for (;;) {
    const j = await q(`${path}${path.includes("?") ? "&" : "?"}order=${order}&offset=${from}&limit=1000`);
    out.push(...j); if (j.length < 1000) break; from += 1000;
  }
  return out;
}
const nn = (s) => String(s ?? "").trim().replace(/^0+/, "");
const normName = (s) => String(s ?? "").normalize("NFKC").replace(/[\s　]/g, "");
const num = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^-?[\d,]+(\.\d+)?$/.test(v.trim())) return Number(v.replace(/,/g, ""));
  return null;
};
const AMOUNT_COLS = ["勤続手当（パート）", "勤続手当", "資格or勤続手当"];
const amount = (d) => {
  for (const k of AMOUNT_COLS) { const v = d?.[k]; if (v != null && String(v).trim() !== "") { const n = num(v); if (n != null) return n; } }
  return null;
};

console.log(`=== 総括表の勤続手当から 資格の旗を立てる ${REVERT ? "【戻す】" : EXECUTE ? "【実行】" : "(DRY RUN)"} ${SIBLINGS ? "+兼務先も" : ""} ===`);

const offices = await all("payroll_offices?select=id,office_number");
const offNumOfId = new Map(offices.map((o) => [o.id, o.office_number]));
const emps = await all("payroll_employees?select=id,employee_number,name,office_id,role_type,salary_type,job_type,has_care_qualification,care_qualification_kind,care_qualification_from,employment_status");
const empByKey = new Map();
for (const e of emps) {
  const k = `${offNumOfId.get(e.office_id) ?? "?"}|${nn(e.employee_number)}`;
  const a = empByKey.get(k) ?? []; a.push(e); empByKey.set(k, a);
}

if (REVERT) {
  let log;
  try { log = JSON.parse(readFileSync(BACKUP, "utf8")); }
  catch { console.error(`★ ${BACKUP} が読めません。--execute をまだ回していないか、ログを消しています。★ 推測で戻しません`); process.exit(2); }
  console.log(`${BACKUP} に控えた行: ${log.rows.length} (書き込み ${log.executed_at})`);
  const byId = new Map(emps.map((e) => [e.id, e]));
  const changed = log.rows.filter((r) => {
    const now = byId.get(r.id);
    return now && (now.has_care_qualification !== r.has_care_qualification || (now.care_qualification_kind ?? null) !== (r.care_qualification_kind ?? null));
  });
  console.log(`いまの値が 控えと違う行 (= 戻す対象): ${changed.length}`);
  for (const r of changed.slice(0, 20)) console.log(`  ${r.office_number}|${r.employee_number} ${r.name} → 資格 ${r.has_care_qualification} / 種類 ${r.care_qualification_kind ?? "null"} に戻す`);
  if (changed.length > 20) console.log(`  … ほか ${changed.length - 20} 行`);
  if (!EXECUTE) { console.log("(DRY RUN。--revert --execute で戻します)"); process.exit(0); }
  for (const r of changed) await q(`payroll_employees?id=eq.${r.id}`, { method: "PATCH", body: JSON.stringify({ has_care_qualification: r.has_care_qualification, care_qualification_kind: r.care_qualification_kind ?? null }) });
  console.log(`${changed.length} 行を 書き込み前の値に戻しました`);
  process.exit(0);
}

// ── ① ② から「勤続手当を 1 円以上払っている (事業所|社員番号)」を集める
const dir = process.env.SOUKATSU1_DIR;
if (!dir) { console.error("★ SOUKATSU1_DIR=<① の抽出物 soukatsu_extract_YYYYMM.json のある dir> が要ります"); process.exit(2); }
const files = readdirSync(dir).filter((f) => /^soukatsu_extract_\d{6}\.json$/.test(f)).sort();
if (!files.length) { console.error(`★ ${dir} に soukatsu_extract_YYYYMM.json が 1 本もありません (0 件と出しません)`); process.exit(2); }

/** key -> { paid: [月], blankOnly: bool, src: Set } */
const evidence = new Map();
const note = (key, month, side, amt) => {
  const e = evidence.get(key) ?? { paid: [], zero: [], src: new Set() };
  if (amt != null && amt > 0) { e.paid.push(`${month}${side}`); e.src.add(side); }
  else if (amt != null) e.zero.push(`${month}${side}`);
  evidence.set(key, e);
};
for (const f of files) {
  const m = /_(\d{6})\.json$/.exec(f)[1];
  for (const r of JSON.parse(readFileSync(join(dir, f), "utf8"))) note(`${r.office_number}|${nn(r.employee_number)}`, m, "①", amount(r.row_data));
}
for (const r of await all("payroll_soukatsu_rows?select=office_number,employee_number,processing_month,row_data")) {
  note(`${r.office_number}|${nn(r.employee_number)}`, r.processing_month, "②", amount(r.row_data));
}
const paidKeys = [...evidence].filter(([, v]) => v.paid.length > 0).map(([k]) => k);
console.log(`① の写しがある月 ${files.map((f) => /_(\d{6})\.json$/.exec(f)[1]).join(",")}`);
console.log(`① ② に行がある 組 ${evidence.size} / ★ 勤続手当を 1 円以上払っている 組 ${paidKeys.length}`);

// ── 直す対象
const direct = [], unresolved = [], alreadyTrue = [];
for (const k of paidKeys) {
  const es = empByKey.get(k);
  if (!es || !es.length) { unresolved.push(k); continue; }
  for (const e of es) {
    if (e.has_care_qualification) { alreadyTrue.push(e); continue; }
    direct.push({ e, key: k, why: evidence.get(k).paid.slice(0, 3).join(" ") });
  }
}
// 兼務先 (同じ 社員番号 + 同じ氏名 の 別事業所の行)。★ 社員番号は事業所をまたいで重複するので 氏名も一致を要求する
const directIds = new Set(direct.map((d) => d.e.id));
const personKeys = new Set(direct.map((d) => `${nn(d.e.employee_number)}|${normName(d.e.name)}`));
const siblings = emps.filter((e) => !e.has_care_qualification && !directIds.has(e.id) && personKeys.has(`${nn(e.employee_number)}|${normName(e.name)}`));

const byType = (list) => {
  const m = new Map();
  for (const x of list) { const e = x.e ?? x; const k = `${e.salary_type}/${e.role_type}`; m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" / ");
};
console.log(`\n★ 立てる (総括表が直接その事業所で払っている): ${direct.length} 行`);
console.log(`   内訳 ${byType(direct)}`);
for (const d of direct.slice(0, 40)) console.log(`   ${d.key} ${d.e.name} ${d.e.salary_type}/${d.e.role_type}/${d.e.job_type} 在籍=${d.e.employment_status} 根拠 ${d.why}`);
if (direct.length > 40) console.log(`   … ほか ${direct.length - 40} 行`);
console.log(`\n${SIBLINGS ? "★ 立てる" : "(いまは立てない)"} 兼務先の行 (同じ社員番号+氏名): ${siblings.length} 行`);
for (const e of siblings.slice(0, 20)) console.log(`   ${offNumOfId.get(e.office_id)}|${nn(e.employee_number)} ${e.name} ${e.salary_type}/${e.role_type}`);
if (siblings.length > 20) console.log(`   … ほか ${siblings.length - 20} 行`);
console.log(`\n既に true だった行 ${alreadyTrue.length} (触りません)`);
if (unresolved.length) {
  console.log(`\n⚠ 当方の payroll_employees に引けなかった 組 ${unresolved.length} (★ 推測で埋めません)`);
  for (const k of unresolved.slice(0, 20)) console.log(`   ${k} 根拠 ${evidence.get(k).paid.slice(0, 2).join(" ")}`);
  if (unresolved.length > 20) console.log(`   … ほか ${unresolved.length - 20} 組`);
}
// 参考: 逆向き (当方 true だが 総括表が 0 円しか出していない)。★ 触らない
const trueButZero = emps.filter((e) => {
  if (!e.has_care_qualification) return false;
  const k = `${offNumOfId.get(e.office_id) ?? "?"}|${nn(e.employee_number)}`;
  const v = evidence.get(k);
  return v && v.paid.length === 0 && v.zero.length > 0;
});
console.log(`\n参考: 当方 true だが 総括表は 0 円しか出していない ${trueButZero.length} 行 → ★ 触りません (勤続 1 年未満なら 資格があっても 0 円)`);

const targets = SIBLINGS ? [...direct.map((d) => d.e), ...siblings] : direct.map((d) => d.e);
console.log(`\n書き込む行数 ${targets.length} / care_qualification_kind に入れる値 "${KIND_VALUE}" (★ CHECK 制約の許可値)`);
if (!EXECUTE) { console.log("(DRY RUN。--execute で書き込みます)"); process.exit(0); }
// ★ 書き込む前に いまの値を控える。★ これが無いと戻せない (kind の値では この script の行を見分けられない)
writeFileSync(BACKUP, JSON.stringify({
  executed_at: new Date().toISOString(),
  note: "set_care_qualification_from_soukatsu_20260930.mjs が書き込む前の値。--revert --execute でこの値に戻す",
  rows: targets.map((e) => ({
    id: e.id, office_number: offNumOfId.get(e.office_id) ?? null, employee_number: nn(e.employee_number), name: e.name,
    has_care_qualification: e.has_care_qualification ?? false, care_qualification_kind: e.care_qualification_kind ?? null,
  })),
}, null, 2) + "\n", "utf8");
console.log(`書き込む前の値を ${BACKUP} に控えました`);
const beforeTrue = emps.filter((e) => e.has_care_qualification).length;
let done = 0;
for (const e of targets) {
  const patch = { has_care_qualification: true };
  if (!e.care_qualification_kind) patch.care_qualification_kind = KIND_VALUE;
  await q(`payroll_employees?id=eq.${e.id}`, { method: "PATCH", body: JSON.stringify(patch) });
  done++;
  if (done % 50 === 0) console.log(`  ${done}/${targets.length}`);
}
console.log(`${done} 行に has_care_qualification=true を立てました`);
// ★ 「完了」と言う前に DB で数え直す
const after = await all("payroll_employees?select=id,has_care_qualification");
console.log(`確認: has_care_qualification=true の行 ${after.filter((e) => e.has_care_qualification).length} (書き込み前 ${beforeTrue} / 足した ${done})`);
console.log("★ 次に 全事業所・全月を再計算すること (時給者 5 名 約¥45,440 が ② と一致する方向へ動きます)");
console.log("★ 戻すときは node migrations/set_care_qualification_from_soukatsu_20260930.mjs --revert --execute");
