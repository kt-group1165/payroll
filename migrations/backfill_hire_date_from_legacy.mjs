/**
 * 月給者の payroll_employees.hire_date (空) を 旧システムの従業員データ (payroll_legacy_employee) から埋め戻す (2026-09-26)。
 *
 *   node migrations/backfill_hire_date_from_legacy.mjs              # DRY RUN (既定)
 *   node migrations/backfill_hire_date_from_legacy.mjs --execute    # ★ user 判断のあとで
 *   ALL_MONTHLY=1 node ...   # 訪問介護以外 (居宅など) の月給者も対象にする
 *
 * なぜ: payroll/page.tsx の monthlyEmps は hiredAfterMonth() で「入社日より後に始まる月」を外すが、
 *   hire_date が空だと効かず、入社前の月にも固定給が満額付く。
 *   実測 (2026-09-26、訪問介護の月給者 357 名中 hire_date 空 9 名 / 202603〜08 / payload は 9/23 計算):
 *   9 人月 ¥2,586,112。いずれも総括表に行が無い = 旧システムは払っていない月。
 *   検査: npx tsx scripts/check-prehire-monthly-pay.mts
 *
 * 引き方 (★ 推定はしない):
 *   ・(事業所名, 職員番号) の対で引く。★ 職員番号は事業所をまたぐと重複する
 *     (260403 は 五井=橘真悟 / 四街道=熊谷美耶 / 茂原=Ho Jian の 3 人)
 *   ・事業所名は NFKC + 空白除去で揃える (旧システムは「KT」、offices は「ＫＴ」)
 *   ・★ 氏名も一致したものだけ入れる。1 字違い (秋元/秋本) やローマ字の揺れ (HO JINAN KYLE / Ho Jian) は
 *     同一人物の可能性が高くても 自動では入れず「要確認」に出す。人が確かめてから画面 (/employees) で入れる
 *   ・既に hire_date が入っている人は触らない (PATCH の条件にも hire_date=is.null を付ける)
 *
 * 書き込み: payroll_employees.hire_date だけ。payroll_employees に notes 列が無いため、
 *   マーカーの代わりに 変更前の値を migrations/_backup_hire_date_<日付>.json に保存してから更新する。
 * 件数確認 (実行後に SQL Editor で):
 *   select count(*) from payroll_employees where id in (<バックアップの id>) and hire_date is not null;
 *   -- 期待値 = 「入れる」の件数。戻すときは バックアップの id について hire_date を null に戻す
 */
import { readFileSync, writeFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const ALL_MONTHLY = process.env.ALL_MONTHLY === "1";

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

const po = await getAll("payroll_offices?select=id,office_number,office_id,office_type");
const ofs = await getAll("offices?select=id,name");
const poById = new Map(po.map((p) => [p.id, p]));
const officeName = new Map(ofs.map((o) => [o.id, o.name]));
const emps = (await getAll("payroll_employees?select=id,employee_number,name,office_id,hire_date&salary_type=eq.月給&hire_date=is.null"))
  .filter((e) => ALL_MONTHLY || poById.get(e.office_id)?.office_type === "訪問介護");
const legacy = await getAll("payroll_legacy_employee?select=office_name,employee_number,employee_name,hire_date");
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
  const label = `${p?.office_number} ${oname} #${e.employee_number} ${e.name}`;
  if (byName.length === 1 && byName[0].hire_date) toFill.push({ id: e.id, label, hire_date: byName[0].hire_date });
  else if (byName.length > 1) needCheck.push(`${label} — 同じ事業所・番号・氏名が ${byName.length} 行`);
  else if (byName.length === 1) none.push(`${label} — 旧システムにも入社日が無い`);
  else if (cand.length) needCheck.push(`${label} — 番号は一致・氏名が違う (旧: ${cand.map((l) => `${l.employee_name} 入社${l.hire_date ?? "?"}`).join(" / ")})`);
  else none.push(`${label} — 旧システムに (事業所名, 職員番号) が無い`);
}

console.log(`${EXECUTE ? "★ EXECUTE" : "DRY RUN"}  対象: 月給者 ${ALL_MONTHLY ? "(全業態)" : "(訪問介護)"} で hire_date が空 ${emps.length} 名`);
console.log(`\n入れる ${toFill.length} 名`);
for (const t of toFill) console.log(`  ${t.label} → hire_date ${t.hire_date}`);
console.log(`\n要確認 (自動では入れない) ${needCheck.length} 名`);
for (const s of needCheck) console.log(`  ${s}`);
console.log(`\n埋め戻せない ${none.length} 名`);
for (const s of none) console.log(`  ${s}`);

if (!EXECUTE) { console.log("\n(DRY RUN。書き込みはしていません。--execute で実行)"); process.exit(0); }

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const backupPath = `migrations/_backup_hire_date_${stamp}.json`;
writeFileSync(backupPath, JSON.stringify(toFill.map((t) => ({ id: t.id, label: t.label, hire_date_before: null, hire_date_after: t.hire_date })), null, 2));
console.log(`\n変更前の値を保存: ${backupPath}`);
let ok = 0;
for (const t of toFill) {
  const r = await fetch(`${SB_URL}/rest/v1/payroll_employees?id=eq.${t.id}&hire_date=is.null`, {
    method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify({ hire_date: t.hire_date }),
  });
  const j = await r.json();
  if (!r.ok || !Array.isArray(j)) { console.error(`  ✗ ${t.label}: ${JSON.stringify(j).slice(0, 200)}`); continue; }
  if (j.length === 1) ok++; else console.error(`  ✗ ${t.label}: 更新 ${j.length} 行 (期待 1)`);
}
// 件数確認: 実際に入ったかを読み直す
const ids = toFill.map((t) => t.id);
const after = ids.length ? await getAll(`payroll_employees?select=id,hire_date&id=in.(${ids.join(",")})`) : [];
const filled = after.filter((a) => a.hire_date).length;
console.log(`更新 ${ok} / ${toFill.length} 件。読み直し: hire_date が入っている ${filled} / ${ids.length} 件`);
if (ok !== toFill.length || filled !== ids.length) { console.error("★ 件数が合いません。バックアップを見て確認してください"); process.exit(2); }
