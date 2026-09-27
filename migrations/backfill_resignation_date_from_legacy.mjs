/**
 * 退職者なのに 退職日 (payroll_employees.resignation_date) が空の職員に、旧システムの従業員データ
 * (payroll_legacy_employee.quit_date) から退職日を埋め戻す (2026-09-27)。
 *
 *   node migrations/backfill_resignation_date_from_legacy.mjs                     # DRY RUN (既定)
 *   node migrations/backfill_resignation_date_from_legacy.mjs --execute           # ★ user 判断のあとで
 *   node migrations/backfill_resignation_date_from_legacy.mjs --delete            # 戻す内容を見る (DRY RUN)
 *   node migrations/backfill_resignation_date_from_legacy.mjs --delete --execute  # ★ 控えの行だけ 退職日を空に戻す
 *
 * なぜ: 給与計算 (payroll/page.tsx → lib/payroll/employment-in-month.ts の isEmployedInMonth) は
 *   「退職者 でも 退職日 >= 月初 なら その月は在籍」とする。★ 退職日が空だと 全部の月で外れる。
 *   過去の月を再計算すると、退職前に働いていた月まで 0 円になる。
 *   実測 (2026-09-27): 退職者で退職日が空 114 名。旧システムに退職日があるのは 5 名 (うち 2026-03 以降の退職 4 名)。
 *   ② (総括表) が払っているのに外れるのは 久保田 明美 (1270501180|250207) 202608 ¥39,250 の 1 人月。
 *   検査: npm run check:status-excluded-paid
 *
 * 引き方 (★ 推定はしない。backfill_hire_date_from_legacy.mjs と同じ):
 *   ・(事業所名, 職員番号) の対で引く。★ 職員番号は事業所をまたぐと重複する
 *   ・事業所名は NFKC + 空白除去で揃える
 *   ・★ 氏名も一致し、退職日が 1 つに決まるものだけ入れる。それ以外は「要確認」に出す
 *   ・既に退職日が入っている人は触らない (PATCH の条件にも resignation_date=is.null を付ける)
 *   ・★ 旧の在職区分が 在職者 でも 退職日があれば入れる (久保田さんは 旧=在職者・退職 2026-07-31)。一覧に旧の在職区分を併記する
 *
 * 書き込み: payroll_employees.resignation_date だけ。notes 列が無いので 変更前の値 (空) と入れた値を
 *   migrations/_backup_resignation_date_<日付>.json に保存してから更新する。--delete はこの控えの id だけを空に戻す
 *   (★ 控えの値と今の値が同じ行だけ。後から人が直した行は戻さない)。
 * 件数確認 (実行後に SQL Editor で):
 *   select count(*) from payroll_employees where id in (<控えの id>) and resignation_date is not null;  -- 期待値 = 「入れる」の件数
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");

const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" };
/** 全件読む。★ PostgREST は 1 回 1000 行まで。order を付けてページングする */
const getAll = async (q) => {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${q}&order=id`, { headers: { ...H, Range: `${from}-${from + 999}` } });
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(`取得に失敗 (${q.slice(0, 60)}): ${JSON.stringify(j).slice(0, 200)}`);
    out.push(...j);
    if (j.length < 1000) break;
  }
  return out;
};
const nfkc = (s) => String(s ?? "").normalize("NFKC").replace(/[\s　]/g, "");
const nn = (s) => String(s ?? "").trim().replace(/^0+/, "");

// ── 撤去 (控えの行だけ 空に戻す) ──
if (DELETE) {
  const backups = readdirSync("migrations").filter((f) => /^_backup_resignation_date_\d{8}\.json$/.test(f)).sort();
  if (!backups.length) { console.log("控え (migrations/_backup_resignation_date_<日付>.json) がありません。戻すものはありません"); process.exit(0); }
  const path = `migrations/${backups.at(-1)}`;
  const rows = JSON.parse(readFileSync(path, "utf8"));
  const now = rows.length ? await getAll(`payroll_employees?select=id,resignation_date&id=in.(${rows.map((r) => r.id).join(",")})`) : [];
  const nowById = new Map(now.map((r) => [r.id, r.resignation_date]));
  const target = rows.filter((r) => nowById.get(r.id) === r.resignation_date_after);
  const changed = rows.filter((r) => nowById.get(r.id) !== r.resignation_date_after);
  console.log(`${EXECUTE ? "★ EXECUTE" : "DRY RUN"} 撤去: 控え ${path} ${rows.length} 行 / 空に戻す ${target.length} / 後から値が変わっているので触らない ${changed.length}`);
  for (const r of target) console.log(`  ${r.label}: ${r.resignation_date_after} → 空`);
  for (const r of changed) console.log(`  (触らない) ${r.label}: 今 ${nowById.get(r.id) ?? "空"} / 控え ${r.resignation_date_after}`);
  if (!EXECUTE) { console.log("\n(DRY RUN。--delete --execute で戻します)"); process.exit(0); }
  let ok = 0;
  for (const r of target) {
    const res = await fetch(`${SB_URL}/rest/v1/payroll_employees?id=eq.${r.id}&resignation_date=eq.${r.resignation_date_after}`, {
      method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify({ resignation_date: null }),
    });
    const j = await res.json();
    if (!res.ok || !Array.isArray(j) || j.length !== 1) { console.error(`  ✗ ${r.label}: ${JSON.stringify(j).slice(0, 200)}`); continue; }
    ok++;
  }
  console.log(`空に戻した ${ok} / ${target.length} 件`);
  if (ok !== target.length) process.exit(2);
  process.exit(0);
}

// ── 埋め戻し ──
const po = await getAll("payroll_offices?select=id,office_number,office_id");
const ofs = await getAll("offices?select=id,name");
const poById = new Map(po.map((p) => [p.id, p]));
const officeName = new Map(ofs.map((o) => [o.id, o.name]));
const emps = await getAll("payroll_employees?select=id,employee_number,name,office_id,resignation_date&employment_status=eq.退職者&resignation_date=is.null");
const legacy = await getAll("payroll_legacy_employee?select=id,office_name,employee_number,employee_name,employment_status,quit_date,leave_reason");
const legByKey = new Map();
for (const l of legacy) {
  const k = `${nfkc(l.office_name)}|${nn(l.employee_number)}`;
  legByKey.set(k, [...(legByKey.get(k) ?? []), l]);
}

const toFill = [], needCheck = [], none = [];
for (const e of emps) {
  const p = poById.get(e.office_id);
  const oname = officeName.get(p?.office_id) ?? "";
  const cand = legByKey.get(`${nfkc(oname)}|${nn(e.employee_number)}`) ?? [];
  const byName = cand.filter((l) => nfkc(l.employee_name) === nfkc(e.name));
  const dates = [...new Set(byName.map((l) => l.quit_date).filter(Boolean))];
  const label = `${p?.office_number} ${oname} #${e.employee_number} ${e.name}`;
  const legInfo = byName.map((l) => `旧=${l.employment_status ?? "?"}${l.leave_reason ? ` 理由 ${l.leave_reason}` : ""}`).join(" / ");
  if (byName.length >= 1 && dates.length === 1) toFill.push({ id: e.id, label, quit_date: dates[0], legInfo });
  else if (dates.length > 1) needCheck.push(`${label} — 旧に退職日が ${dates.length} 通り (${dates.join(", ")})`);
  else if (byName.length >= 1) none.push(`${label} — 旧システムにも退職日が無い (${legInfo})`);
  else if (cand.length) needCheck.push(`${label} — 番号は一致・氏名が違う (旧: ${cand.map((l) => `${l.employee_name} 退職${l.quit_date ?? "?"}`).join(" / ")})`);
  else none.push(`${label} — 旧システムに (事業所名, 職員番号) が無い`);
}

console.log(`${EXECUTE ? "★ EXECUTE" : "DRY RUN"}  対象: 退職者で 退職日が空 ${emps.length} 名`);
console.log(`\n入れる ${toFill.length} 名`);
for (const t of toFill.sort((a, b) => a.quit_date.localeCompare(b.quit_date))) console.log(`  ${t.label} → resignation_date ${t.quit_date}  (${t.legInfo})`);
console.log(`\n要確認 (自動では入れない) ${needCheck.length} 名`);
for (const s of needCheck) console.log(`  ${s}`);
console.log(`\n埋め戻せない ${none.length} 名 (★ 給与計算は 全部の月で外す。計算画面に警告を出す)`);
for (const s of none.slice(0, 20)) console.log(`  ${s}`);
if (none.length > 20) console.log(`  …他 ${none.length - 20} 名`);

if (!EXECUTE) { console.log("\n(DRY RUN。書き込みはしていません。--execute で実行)"); process.exit(0); }

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const backupPath = `migrations/_backup_resignation_date_${stamp}.json`;
if (existsSync(backupPath)) { console.error(`★ 控え ${backupPath} が既にあります。上書きしません (先に中身を確認してください)`); process.exit(2); }
writeFileSync(backupPath, JSON.stringify(toFill.map((t) => ({ id: t.id, label: t.label, resignation_date_before: null, resignation_date_after: t.quit_date })), null, 2));
console.log(`\n変更前の値を保存: ${backupPath}`);
let ok = 0;
for (const t of toFill) {
  const r = await fetch(`${SB_URL}/rest/v1/payroll_employees?id=eq.${t.id}&resignation_date=is.null`, {
    method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify({ resignation_date: t.quit_date }),
  });
  const j = await r.json();
  if (!r.ok || !Array.isArray(j)) { console.error(`  ✗ ${t.label}: ${JSON.stringify(j).slice(0, 200)}`); continue; }
  if (j.length === 1) ok++; else console.error(`  ✗ ${t.label}: 更新 ${j.length} 行 (期待 1)`);
}
const ids = toFill.map((t) => t.id);
const after = ids.length ? await getAll(`payroll_employees?select=id,resignation_date&id=in.(${ids.join(",")})`) : [];
const filled = after.filter((a) => a.resignation_date).length;
console.log(`更新 ${ok} / ${toFill.length} 件。読み直し: 退職日が入っている ${filled} / ${ids.length} 件`);
console.log(`★ 撤去: node migrations/backfill_resignation_date_from_legacy.mjs --delete --execute`);
if (ok !== toFill.length || filled !== ids.length) { console.error("★ 件数が合いません。控えを見て確認してください"); process.exit(2); }
