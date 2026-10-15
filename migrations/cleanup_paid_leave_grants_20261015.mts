/**
 * 有給の付与 (payroll_paid_leave_grants) の後片付け (2026-10-15 user「OK」)。
 *
 *   npx tsx migrations/cleanup_paid_leave_grants_20261015.mts <box_grant_days.json> <backup.json>            # DRY RUN
 *   npx tsx migrations/cleanup_paid_leave_grants_20261015.mts <box_grant_days.json> <backup.json> --execute
 *
 * ① 消す: 9 月の取込が 初回付与 (入社 + 6 か月) の人に 余分に作った「4/1 付与」の行。
 *    条件 = 付与日数・前年度日当・今年度日当 が全部空 / Box のその人の行は 4/1 以外の付与日 / その日付の付与が DB に既にある
 * ② 付与日を直す: 同じ Box ファイルのその人の行の付与日・付与日数に揃える (fix_paid_leave_grant_dates_from_box.mts と同じ判定)
 * ③ 付与日数を空に戻す: 10/8 に Box から入れた 0 日のうち 年度途中の初回付与 (Box の欄が未計算と見られる) と
 *    今井 好広 2026-04-01 (月給・7 か月で 139.5 日 = 式なら 11 日)。画面では「?」になる
 * 書き換える前の行を <backup.json> に保存する (戻すとき用)。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { restAll } from "../scripts/_rest.mjs";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [SRC, BACKUP] = args;
const EXECUTE = process.argv.includes("--execute");
if (!SRC || !BACKUP) { console.error("box_grant_days.json と backup.json を指定してください"); process.exit(1); }

type BoxRow = { source: string; emp_no: string; name: string; grant_date: string | null; grant_days: number | null };
type G = { id: string; employee_id: string; grant_date: string; grant_days: number | null; carry_days: number | null; prev_rate: number | null; cur_rate: number | null; source: string | null; updated_at: string };
const box = JSON.parse(readFileSync(SRC, "utf8")) as BoxRow[];
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");
const nm = (s: unknown) => String(s ?? "").split("\n")[0].replace(/[\s　]/g, "").replace(/\(.*?\)|（.*?）/g, "");
const normSrc = (s: string | null) => String(s ?? "").replace(/コピー/g, "").replace(/_20\d\d(?=\.xls)/, "").replace(/\/20\d\d(?=\/)/, "").replace(/\/20\d\d_/, "/");

const emps = await restAll<{ id: string; employee_number: string; name: string }>("payroll_employees?select=id,employee_number,name");
const grants = await restAll<G>("payroll_paid_leave_grants?select=id,employee_id,grant_date,grant_days,carry_days,prev_rate,cur_rate,source,updated_at");
const empById = new Map(emps.map((e) => [e.id, e]));
const boxByPerson = new Map<string, BoxRow[]>();
for (const r of box) { const k = `${nn(r.emp_no)}|${nm(r.name)}`; boxByPerson.set(k, [...(boxByPerson.get(k) ?? []), r]); }
const label = (g: G) => { const e = empById.get(g.employee_id); return `${e?.employee_number} ${e?.name} ${g.grant_date}`; };
const has = (empId: string, date: string) => grants.some((x) => x.employee_id === empId && x.grant_date === date);

const del: G[] = [], move: { g: G; to: string; days: number }[] = [], toNull: G[] = [];
for (const g of grants.filter((x) => x.grant_days == null)) {
  const e = empById.get(g.employee_id);
  if (!e) continue;
  const mine = boxByPerson.get(`${nn(e.employee_number)}|${nm(e.name)}`) ?? [];
  if (mine.length === 0 || mine.some((r) => r.grant_date === g.grant_date)) continue;
  // ① 余分な 4/1 行
  if (g.grant_date.slice(5) === "04-01" && g.prev_rate == null && g.cur_rate == null
      && mine.some((r) => r.grant_date && r.grant_date.slice(5) !== "04-01" && has(g.employee_id, r.grant_date))) { del.push(g); continue; }
  // ② 付与日を直す
  const year = /\/(20\d\d)\//.exec(g.source ?? "")?.[1];
  const same = mine.filter((r) => normSrc(r.source) === normSrc(g.source) && (!year || r.source.includes(`/${year}/`)));
  if (same.length === 1 && same[0].grant_date && same[0].grant_days != null && !has(g.employee_id, same[0].grant_date)) {
    move.push({ g, to: same[0].grant_date, days: same[0].grant_days });
  }
}
// ③ 0 日に入れたもののうち 怪しいもの
for (const g of grants) {
  if (g.grant_days == null || Number(g.grant_days) !== 0) continue;
  if (!(g.updated_at >= "2026-10-08T00:00:00" && g.updated_at < "2026-10-14T00:00:00")) continue;
  const e = empById.get(g.employee_id);
  const imai = nn(e?.employee_number) === "250902" && nm(e?.name) === nm("今井 好広") && g.grant_date === "2026-04-01";
  if (g.grant_date.slice(5) !== "04-01" || imai) toNull.push(g);
}

console.log(`① 消す ${del.length} 行`); for (const g of del) console.log(`  ✗ ${label(g)} (日数・日当 空 / ${g.source})`);
console.log(`② 付与日を直す ${move.length} 行`); for (const m of move) console.log(`  ✎ ${label(m.g)} → ${m.to} / 付与日数 ${m.days}`);
console.log(`③ 付与日数を空に戻す ${toNull.length} 行`); for (const g of toNull) console.log(`  ↺ ${label(g)} (0 → 空)`);
if (!EXECUTE) { console.log("\nDRY RUN。書き込むときは --execute"); process.exit(0); }

writeFileSync(BACKUP, JSON.stringify({ at: new Date().toISOString(), del, move: move.map((m) => m.g), toNull }, null, 1));
console.log(`書き換える前の行を保存: ${BACKUP}`);
const env: Record<string, string> = {};
for (const f of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const base = `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/payroll_paid_leave_grants`;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" };
const now = new Date().toISOString();
let ok = 0; const fails: string[] = [];
const run = async (what: string, url: string, method: string, body?: unknown) => {
  const r = await fetch(url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) fails.push(`${what}: ${r.status} ${(await r.text()).slice(0, 160)}`); else ok++;
};
for (const g of del) await run(`消す ${label(g)}`, `${base}?id=eq.${g.id}&grant_days=is.null&cur_rate=is.null&prev_rate=is.null`, "DELETE");
for (const m of move) await run(`直す ${label(m.g)}`, `${base}?id=eq.${m.g.id}&grant_date=eq.${m.g.grant_date}&grant_days=is.null`, "PATCH", { grant_date: m.to, grant_days: m.days, updated_at: now });
for (const g of toNull) await run(`空に ${label(g)}`, `${base}?id=eq.${g.id}&grant_days=eq.0`, "PATCH", { grant_days: null, updated_at: now });
console.log(`書き込み ${ok} / 失敗 ${fails.length}`);
for (const f of fails) console.log("  ✗ " + f);
// 確かめ
const after = await restAll<G>("payroll_paid_leave_grants?select=id,employee_id,grant_date,grant_days,carry_days,prev_rate,cur_rate,source,updated_at");
const ids = new Set(after.map((x) => x.id));
console.log(`確認: 消した行で残っているもの ${del.filter((g) => ids.has(g.id)).length} / 直した行の付与日 ${move.filter((m) => after.find((x) => x.id === m.g.id)?.grant_date === m.to).length}/${move.length} / 空に戻した行 ${toNull.filter((g) => after.find((x) => x.id === g.id)?.grant_days == null).length}/${toNull.length}`);
if (fails.length > 0) process.exit(1);
