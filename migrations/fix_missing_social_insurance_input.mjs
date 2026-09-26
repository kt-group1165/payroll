/**
 * 社保の手入力が 月の途中で抜けている人月を埋める (2026-09-27)。
 *
 *   node migrations/fix_missing_social_insurance_input.mjs            # DRY RUN
 *   node migrations/fix_missing_social_insurance_input.mjs --execute  # 本番
 *   node migrations/fix_missing_social_insurance_input.mjs --delete --execute   # 撤去 (控えの行だけ消す)
 *
 * 【なぜ】
 * 処遇改善は「社保あり かつ 訪問あり」のときだけ 事業所の額が出る (payroll-calc.ts treatmentSubsidyAmount)。
 * ★ 社保は payroll_monthly_inputs の item_key='social_insurance' の手入力を先に見て、
 *   無ければ 職員マスタの social_insurance (= 今の値) に落ちる。
 * ★ 実測 (2026-09-27): 手入力がある 45 名のうち ★ 29 名で「1 の月があるのに 行が無い月もある」。
 *   76 人月。★ その月は 社保なし扱いになり 処遇改善が 0 円になる。
 *
 * 【入れる条件 — ★ 3 つ全部を満たす人月だけ】
 *   1. その人に 社保=1 の月が 1 つ以上ある (= もともと社保に入っている人)
 *   2. その月の行が **無い** (★ 明示的に 0 が入っている月は触らない。意図して外している可能性があるため)
 *   3. ★ **② (支払用の総括表) が その月に処遇改善を払っている**
 *      → 社保があった月と読める。★ ここが根拠。② が払っていない月は入れない
 *
 * ⚠ 「行が無い = 入れ漏れ」とは限らない。社保を外れた月かもしれない。
 *   ★ だから 3 を課している。★ ② が払っていない 17 人月 (¥340,000) は **入れない**。
 *
 * ⚠ 入れても payroll_calc_results は変わらない。★ 138 件の再計算をするまで 支給額は動かない。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");
const BACKUP = "migrations/_backup_social_insurance_input_20260927.json";
const NOTE = "[社保の入れ漏れ是正 2026-09-27]";
const MONTHS = ["202603", "202604", "202605", "202606", "202607", "202608"];

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
if (!SB || !KEY) { console.error("★ .env.local が読めません"); process.exit(1); }
const H = { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" };

const nn = (s) => String(s ?? "").trim().replace(/^0+/, "");
const num = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (v && typeof v === "object" && "result" in v) return num(v.result);
  const n = Number(String(v ?? "").normalize("NFKC").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
// ★ order 無しのページングは行が抜ける
async function all(q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const url = `${SB}/rest/v1/${q}${q.includes("?") ? "&" : "?"}order=id&offset=${from}&limit=1000`;
    const r = await fetch(url, { headers: H });
    if (!r.ok) throw new Error(`${r.status} ${q.slice(0, 60)}: ${await r.text()}`);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(`配列でない: ${JSON.stringify(j).slice(0, 200)}`);
    out.push(...j);
    if (j.length < 1000) break;
  }
  return out;
}

// ── 撤去 ──
if (DELETE) {
  if (!existsSync(BACKUP)) { console.error(`★ 控え ${BACKUP} がありません。撤去できません`); process.exit(1); }
  const ids = JSON.parse(readFileSync(BACKUP, "utf8")).inserted_ids ?? [];
  console.log(`撤去対象 ${ids.length} 行`);
  if (!EXECUTE) { console.log("DRY RUN。--delete --execute で消します"); process.exit(0); }
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const r = await fetch(`${SB}/rest/v1/payroll_monthly_inputs?id=in.(${chunk.join(",")})`, { method: "DELETE", headers: H });
    if (!r.ok) throw new Error(`削除に失敗: ${await r.text()}`);
  }
  console.log(`${ids.length} 行を消しました`);
  process.exit(0);
}

const offs = await all("payroll_offices?select=id,office_number,treatment_subsidy_amount");
const offOf = new Map(offs.map((o) => [o.office_number, o]));
const offNumOfId = new Map(offs.map((o) => [o.id, o.office_number]));
const emps = await all("payroll_employees?select=office_id,employee_number,name,salary_type,employment_status");
const empOf = new Map(emps.map((e) => [`${offNumOfId.get(e.office_id) ?? ""}|${nn(e.employee_number)}`, e]));

const mis = await all("payroll_monthly_inputs?select=office_number,employee_number,processing_month,numeric_value&item_key=eq.social_insurance");
const si = new Map();
for (const m of mis) {
  const k = `${m.office_number}|${nn(m.employee_number)}`;
  if (!si.has(k)) si.set(k, new Map());
  si.get(k).set(m.processing_month, Number(m.numeric_value ?? 0));
}

const recs = await all("payroll_service_records?select=office_number,employee_number,processing_month");
const visit = new Set(recs.map((r) => `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`));

/**
 * ② の「処遇改善補助金手当」だけを見る。
 * ★ 2026-09-27 に ② の列を全部出して確かめた。「処遇改善」を含む列は 7 種あり、
 *   ★ 当方の treatmentSubsidyAmount が返す **事業所の額** と一致するのは 処遇改善補助金手当 だけ。
 * ```
 * 吉田 美幸 202604  処遇改善手当=90,000 / 特定処遇改善手当=40,000 / ★ 処遇改善補助金手当=20,000
 *                   事業所の額 = 20,000  → 処遇改善補助金手当 が対応する列
 * ```
 * ★ 緩く拾うと 90,000 を「払っている」と読んでしまう。★ 列は 1 つに決めること。
 * (この列は 3,815 行すべてに存在する。値が 0 の行もあるので「> 0」が意味を持つ)
 */
const SUBSIDY_KEY = "処遇改善補助金手当";
const s2 = await all("payroll_soukatsu_rows?select=office_number,processing_month,row_data");
const paid = new Map();
for (const r of s2) {
  const n = nn(r.row_data?._code ?? r.row_data?.["№"] ?? r.row_data?.["社員番号"] ?? "");
  if (!n) continue;
  const v = num(r.row_data?.[SUBSIDY_KEY]);
  const key = `${r.office_number}|${n}|${r.processing_month}`;
  paid.set(key, Math.max(paid.get(key) ?? 0, v));
}

const rows = [], skipped = [];
for (const [k, m] of si) {
  if (!MONTHS.some((y) => m.get(y) === 1)) continue;          // 条件1
  const [offNum, empNum] = k.split("|");
  const e = empOf.get(k);
  const amt = offOf.get(offNum)?.treatment_subsidy_amount ?? 0;
  for (const y of MONTHS) {
    if (m.has(y)) continue;                                    // 条件2 (0 が入っている月は触らない)
    const v = visit.has(`${k}|${y}`);
    const p = paid.get(`${offNum}|${empNum}|${y}`) ?? 0;
    const label = `${y} ${offNum} ${empNum} ${e?.name ?? "?"}`;
    if (p <= 0) { skipped.push(`  ${label}  ★ ② が払っていないので入れない (訪問${v ? "あり" : "なし"})`); continue; }  // 条件3
    if (!v) { skipped.push(`  ${label}  訪問なし (入れても 0 円)  ② は ¥${p.toLocaleString()}`); continue; }
    rows.push({ office_number: offNum, employee_number: empNum, processing_month: y, item_key: "social_insurance", numeric_value: 1, note: NOTE, _label: label, _amt: amt, _paid: p });
  }
}

console.log(`=== 社保の入れ漏れを埋める ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log(`条件: 社保=1 の月がある / その月の行が無い / ★ ② がその月に処遇改善を払っている\n`);
console.log(`--- 入れる ${rows.length} 件 (再計算後に 処遇改善が出る見込み 計 ¥${rows.reduce((s, r) => s + r._amt, 0).toLocaleString()})`);
for (const r of rows) console.log(`  ${r._label}  → 社保=1  (② は ¥${r._paid.toLocaleString()} / 出る額 ¥${r._amt.toLocaleString()})`);
console.log(`\n--- 入れない ${skipped.length} 件`);
for (const s of skipped) console.log(s);

if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }
if (rows.length === 0) { console.log("\n対象がありません"); process.exit(0); }

// ★ _ で始まる表示用の項目は DB に送らない (分割代入で捨てると eslint の未使用警告が出るので明示的に組む)
const payload = rows.map((x) => ({
  office_number: x.office_number, employee_number: x.employee_number,
  processing_month: x.processing_month, item_key: x.item_key,
  numeric_value: x.numeric_value, note: x.note,
}));
const r = await fetch(`${SB}/rest/v1/payroll_monthly_inputs`, {
  method: "POST", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(payload),
});
if (!r.ok) { console.error(`★ 書き込みに失敗: ${await r.text()}`); process.exit(1); }
const inserted = await r.json();
writeFileSync(BACKUP, JSON.stringify({ restored_at: new Date().toISOString(), note: NOTE, inserted_ids: inserted.map((x) => x.id), rows: payload }, null, 2));
console.log(`\n${inserted.length} 行を入れました。控え: ${BACKUP}`);
if (inserted.length !== rows.length) { console.error(`★ 件数が合いません (期待 ${rows.length})`); process.exit(2); }
console.log(`\n確認 SQL:
SELECT office_number, employee_number, processing_month, numeric_value, note
  FROM payroll_monthly_inputs WHERE note = '${NOTE}' ORDER BY office_number, employee_number, processing_month;
★ 期待 ${rows.length} 行

⚠ 支給額はまだ変わっていません。138 事業所月の再計算をするまで payload は古いままです。
★ 撤去: node migrations/fix_missing_social_insurance_input.mjs --delete --execute`);
