/**
 * 有給の付与 (payroll_paid_leave_grants) のうち 付与日が Box と違う行を 直す (2026-10-15)。
 *
 *   npx tsx migrations/fix_paid_leave_grant_dates_from_box.mts <box_grant_days.json>            # DRY RUN
 *   npx tsx migrations/fix_paid_leave_grant_dates_from_box.mts <box_grant_days.json> --execute
 *
 * 9 月の取込 (import_paid_leave_grants.mjs) は ファイルの年度の付与日 (A1) を その年度の全員に付けていたため、
 * 年度の途中で初回付与された人 (入社 + 6 か月) まで 4/1 付与として入っていた (例: 長谷部 純子 DB 2025-04-01 / Box 2025-11-20)。
 * 直し方: その付与を取り込んだのと **同じ Box ファイル** の その人の行の付与日・付与日数 に揃える。
 *   ★ 次のときは直さずに一覧に出す (人が決める):
 *     ・同じファイルに その人の行が無い / 複数ある
 *     ・Box の付与日に その人の付与が DB に既にある (直すと重なる)
 *     ・Box でも付与日数が空
 * 対象は 付与日数が空の付与だけ (付与日数が入っている行は 取込のあと人が直した可能性があるので触らない)。
 */
import { readFileSync } from "node:fs";
import { restAll } from "../scripts/_rest.mjs";

const [SRC] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const EXECUTE = process.argv.includes("--execute");
if (!SRC) { console.error("box_grant_days.json を指定してください"); process.exit(1); }

type BoxRow = { source: string; emp_no: string; name: string; grant_date: string | null; grant_days: number | null };
const box = JSON.parse(readFileSync(SRC, "utf8")) as BoxRow[];
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");
const nm = (s: unknown) => String(s ?? "").split("\n")[0].replace(/[\s　]/g, "").replace(/\(.*?\)|（.*?）/g, "");
/** 出どころのファイル名を比べられる形に (「コピー」・年度のフォルダ・ファイル名の _2024 を落とす) */
const normSrc = (s: string | null) => String(s ?? "").replace(/コピー/g, "").replace(/_20\d\d(?=\.xls)/, "").replace(/\/20\d\d(?=\/)/, "").replace(/\/20\d\d_/, "/");

const emps = await restAll<{ id: string; employee_number: string; name: string; hire_date: string | null }>("payroll_employees?select=id,employee_number,name,hire_date");
const grants = await restAll<{ id: string; employee_id: string; grant_date: string; grant_days: number | null; source: string | null }>("payroll_paid_leave_grants?select=id,employee_id,grant_date,grant_days,source");
const empById = new Map(emps.map((e) => [e.id, e]));
const boxByPerson = new Map<string, BoxRow[]>();
for (const r of box) { const k = `${nn(r.emp_no)}|${nm(r.name)}`; boxByPerson.set(k, [...(boxByPerson.get(k) ?? []), r]); }

const plans: { id: string; label: string; from: string; to: string; days: number; src: string }[] = [];
const skipped: string[] = [];
for (const g of grants.filter((x) => x.grant_days == null)) {
  const e = empById.get(g.employee_id);
  if (!e) continue;
  const mine = boxByPerson.get(`${nn(e.employee_number)}|${nm(e.name)}`) ?? [];
  if (mine.length === 0 || mine.some((r) => r.grant_date === g.grant_date)) continue; // 付与日が合っている (別の理由で空) は対象外
  const label = `${e.employee_number} ${e.name} (入社 ${e.hire_date ?? "?"})`;
  // DB の出どころのファイルの年度 (source に年度のフォルダがあれば それ)
  const year = /\/(20\d\d)\//.exec(g.source ?? "")?.[1];
  const sameFile = mine.filter((r) => normSrc(r.source) === normSrc(g.source) && (!year || r.source.includes(`/${year}/`)));
  const allDates = [...new Set(mine.map((r) => `${r.grant_date}(${r.source.split("/").slice(1, 2)})`))].join(", ");
  if (sameFile.length !== 1) { skipped.push(`${label} DB ${g.grant_date}: 同じファイル (${g.source}) の行が ${sameFile.length} 件 / Box の付与日 ${allDates}`); continue; }
  const b = sameFile[0];
  if (!b.grant_date) { skipped.push(`${label} DB ${g.grant_date}: Box の付与日が空`); continue; }
  if (grants.some((x) => x.employee_id === g.employee_id && x.grant_date === b.grant_date)) {
    skipped.push(`${label} DB ${g.grant_date}: Box の付与日 ${b.grant_date} の付与が DB に既にある (重なるので直さない) / ${b.source}`); continue;
  }
  if (b.grant_days == null) { skipped.push(`${label} DB ${g.grant_date} → Box ${b.grant_date}: Box でも付与日数が空`); continue; }
  plans.push({ id: g.id, label, from: g.grant_date, to: b.grant_date, days: b.grant_days, src: b.source });
}

console.log(`直す ${plans.length} 行 / 直さない ${skipped.length} 行`);
for (const p of plans) console.log(`  ✎ ${p.label}: 付与日 ${p.from} → ${p.to} / 付与日数 ${p.days} (${p.src})`);
if (skipped.length) { console.log("\n--- 直さない (人が決める) ---"); for (const s of skipped) console.log("  " + s); }
if (!EXECUTE) { console.log("\nDRY RUN。書き込むときは --execute"); process.exit(0); }

const env: Record<string, string> = {};
for (const f of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" };
let ok = 0; const fails: string[] = [];
for (const p of plans) {
  // 付与日・付与日数が 試し実行のときのままの行だけ
  const r = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/payroll_paid_leave_grants?id=eq.${p.id}&grant_date=eq.${p.from}&grant_days=is.null`, {
    method: "PATCH", headers: H, body: JSON.stringify({ grant_date: p.to, grant_days: p.days, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) fails.push(`${p.label}: ${r.status} ${(await r.text()).slice(0, 160)}`); else ok++;
}
console.log(`更新 ${ok} 行 / 失敗 ${fails.length} 行`);
for (const f of fails) console.log("  ✗ " + f);
const after = await restAll<{ id: string }>("payroll_paid_leave_grants?select=id&grant_days=is.null");
console.log(`確認: 付与日数が空の付与 ${after.length} 行`);
if (fails.length > 0) process.exit(1);
