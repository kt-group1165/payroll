/**
 * 有給の付与 (payroll_paid_leave_grants) の 付与日数 (grant_days) が空の行を、Box の有給管理簿の値で埋める (2026-10-08 user「OK」)。
 *
 *   npx tsx migrations/backfill_paid_leave_grant_days_from_box.mts <box_grant_days.json>            # DRY RUN
 *   npx tsx migrations/backfill_paid_leave_grant_days_from_box.mts <box_grant_days.json> --execute
 *
 * <box_grant_days.json> は Box 03_有給/<法人>/<年度>/<事業所>.xlsm を scratchpad にコピーして
 *   「有給管理簿」シートの 社員No・氏名・付与日・今年度の付与日数 を抜き出したもの (Box には触らない)。
 * 引き方: (社員番号, 氏名) で職員 → その職員の Box の行のうち 付与日が同じもの。
 *   ★ 同じ付与日で値が食い違う (複数ファイルに違う日数) ときは 埋めない (一覧に出す)
 *   ★ 付与日数が入っている行は触らない。日当・繰越も触らない
 * 「空のまま」になった行は 理由ごとに出す (Box にその人がいない / Box の付与日が違う 等)。
 */
import { readFileSync } from "node:fs";
import { restAll } from "../scripts/_rest.mjs";
import { baseGrantDays } from "../src/lib/payroll/paid-leave-grant-rules.js";

const [SRC] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const EXECUTE = process.argv.includes("--execute");
if (!SRC) { console.error("box_grant_days.json を指定してください"); process.exit(1); }

type BoxRow = { source: string; emp_no: string; name: string; grant_date: string | null; grant_days: number | null };
const box = JSON.parse(readFileSync(SRC, "utf8")) as BoxRow[];
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");
const nm = (s: unknown) => String(s ?? "").split("\n")[0].replace(/[\s　]/g, "").replace(/\(.*?\)|（.*?）/g, "");

const emps = await restAll<{ id: string; employee_number: string; name: string }>("payroll_employees?select=id,employee_number,name");
const grants = await restAll<{ id: string; employee_id: string; grant_date: string; grant_days: number | null; source: string | null }>("payroll_paid_leave_grants?select=id,employee_id,grant_date,grant_days,source");
const empById = new Map(emps.map((e) => [e.id, e]));
const boxByPerson = new Map<string, BoxRow[]>();
for (const r of box) {
  const k = `${nn(r.emp_no)}|${nm(r.name)}`;
  boxByPerson.set(k, [...(boxByPerson.get(k) ?? []), r]);
}

const targets = grants.filter((g) => g.grant_days == null);
const plans: { id: string; label: string; days: number; from: string }[] = [];
const conflict: string[] = [], noPerson: string[] = [], dateDiff: string[] = [], boxEmpty: string[] = [];
for (const g of targets) {
  const e = empById.get(g.employee_id);
  if (!e) { noPerson.push(`(職員が引けない) ${g.employee_id} ${g.grant_date}`); continue; }
  const label = `${e.employee_number} ${e.name} ${g.grant_date}`;
  const mine = boxByPerson.get(`${nn(e.employee_number)}|${nm(e.name)}`) ?? [];
  if (mine.length === 0) { noPerson.push(`${label} (DB の出どころ: ${g.source ?? "空"})`); continue; }
  const same = mine.filter((r) => r.grant_date === g.grant_date);
  if (same.length === 0) {
    const dates = [...new Set(mine.map((r) => r.grant_date ?? "空"))].sort().join(", ");
    dateDiff.push(`${label}: Box の付与日 = ${dates} (DB の出どころ: ${g.source ?? "空"})`);
    continue;
  }
  const vals = [...new Set(same.map((r) => r.grant_days).filter((v): v is number => v != null))];
  if (vals.length === 0) { boxEmpty.push(`${label}: Box でも 付与日数が空 (${same.map((r) => r.source).join(", ")})`); continue; }
  if (vals.length > 1) { conflict.push(`${label}: ${same.map((r) => `${r.source}=${r.grant_days ?? "空"}`).join(" / ")}`); continue; }
  plans.push({ id: g.id, label, days: vals[0], from: same.find((r) => r.grant_days === vals[0])!.source });
}

const byMonth = new Map<string, [number, number]>();
for (const g of targets) { const k = g.grant_date.slice(0, 7); const v = byMonth.get(k) ?? [0, 0]; v[0]++; byMonth.set(k, v); }
for (const p of plans) { const k = p.label.split(" ").at(-1)!.slice(0, 7); const v = byMonth.get(k)!; v[1]++; }
console.log(`付与日数が空の付与 ${targets.length} 行 → 埋められる ${plans.length} 行`);
console.log(`  付与日ごと (空 → 埋まる): ${[...byMonth].sort().map(([k, [a, b]]) => `${k} ${a}→${b}`).join(" / ")}`);
console.log(`空のまま: Box にその人がいない ${noPerson.length} / Box の付与日が違う ${dateDiff.length} / Box でも空 ${boxEmpty.length} / Box で値が食い違う ${conflict.length}`);
for (const [title, list] of [["Box の付与日が違う", dateDiff], ["Box で値が食い違う", conflict], ["Box でも空", boxEmpty], ["Box にその人がいない", noPerson]] as const) {
  if (list.length === 0) continue;
  console.log(`\n--- ${title} (${list.length}) ---`);
  for (const l of list.slice(0, 40)) console.log("  " + l);
  if (list.length > 40) console.log(`  … ほか ${list.length - 40}`);
}
// ── 正しさの確かめ (2026-10-08 user「正しいデータならOK」) ──
//   ① 埋める値が DB のその付与を取り込んだのと 同じ Box ファイル から来ているか
//   ② 値が あり得る範囲か (0.5 刻み・4/1 は 20 日以下・初回 (4/1 以外) は 10 日以下)
//   ③ 付与の決まり (paid-leave-grant-rules) の 基準日数 を超えていないか (職員一覧の入社日から)
{
  const normSrc = (s: string | null) => String(s ?? "").replace(/コピー/g, "").replace(/_20\d\d(?=\.xls)/, "").replace(/\/20\d\d_/, "/");
  const gById = new Map(grants.map((g) => [g.id, g]));
  let sameSrc = 0; const otherSrc: string[] = [], outOfRange: string[] = [], overBase: string[] = [];
  const hires = new Map((await restAll<{ id: string; hire_date: string | null }>("payroll_employees?select=id,hire_date")).map((e) => [e.id, e.hire_date]));
  for (const p of plans) {
    const g = gById.get(p.id)!;
    if (normSrc(g.source) === normSrc(p.from)) sameSrc++; else otherSrc.push(`${p.label}: DB ${g.source ?? "空"} / 値 ${p.from}`);
    const isApril = g.grant_date.slice(5) === "04-01";
    if (p.days < 0 || p.days * 2 !== Math.round(p.days * 2) || p.days > (isApril ? 20 : 10)) outOfRange.push(`${p.label} → ${p.days}`);
    const hd = hires.get(g.employee_id);
    const b = hd ? baseGrantDays(hd, g.grant_date) : 0;
    if (b > 0 && p.days > b) overBase.push(`${p.label} → ${p.days} (入社 ${hd} の基準 ${b})`);
  }
  console.log(`\n確かめ: ① 同じ Box ファイルから ${sameSrc}/${plans.length} (違うファイル ${otherSrc.length}) / ② 範囲外 ${outOfRange.length} / ③ 基準日数を超える ${overBase.length}`);
  for (const l of [...otherSrc.slice(0, 15), ...outOfRange, ...overBase.slice(0, 20)]) console.log("  " + l);
}
console.log("\n--- 埋める例 ---");
for (const p of plans.slice(0, 8)) console.log(`  ${p.label} → ${p.days} 日 (${p.from})`);

if (!EXECUTE) { console.log("\nDRY RUN。書き込むときは --execute"); process.exit(0); }

const env: Record<string, string> = {};
for (const f of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" };
let ok = 0; const fails: string[] = [];
for (const p of plans) {
  // 空の行だけ (画面で入れた値を上書きしない)
  const r = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/payroll_paid_leave_grants?id=eq.${p.id}&grant_days=is.null`, {
    method: "PATCH", headers: H, body: JSON.stringify({ grant_days: p.days, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) fails.push(`${p.label}: ${r.status} ${(await r.text()).slice(0, 160)}`); else ok++;
}
console.log(`更新 ${ok} 行 / 失敗 ${fails.length} 行`);
for (const f of fails.slice(0, 10)) console.log("  ✗ " + f);
const after = await restAll<{ id: string }>("payroll_paid_leave_grants?select=id&grant_days=is.null");
console.log(`確認: 付与日数が空の付与 ${targets.length} → ${after.length} 行`);
if (fails.length > 0) process.exit(1);
