/**
 * 総括表 (提責_社員シート) の 有給休暇手当 ÷ 有給の日数 から、月給者の有給単価 (円/日) を
 * 給与設定の履歴 (payroll_salary_settings.paid_leave_unit_price) に月ごとに入れる。
 *
 *   npx tsx migrations/set_paid_leave_unit_from_soukatsu.mts --extract-dir <dir> --months 202603,202604,...            # DRY RUN
 *   npx tsx migrations/set_paid_leave_unit_from_soukatsu.mts ... --execute
 *
 * <dir>/soukatsu<YYYYMM>/extract.json は sync-master-from-soukatsu.mts と同じもの。
 * 職員は (社員番号, 氏名) で引く (社員番号は全社で一意ではない)。
 * 有給の日数 = 「有給・特休・欠勤」列 (袖ケ浦は「有給」列)。"有3/欠2.5" のような文字列は 有 の数だけ使う。
 * 単価は 四捨五入(金額 ÷ 日数)。その単価 × 日数 を四捨五入して金額に戻らない月は 入れずに表示する。
 *
 * 入れ方: その月で有効な給与設定の行が その月から始まる行なら PATCH、
 *         そうでなければ その行を写して effective_from = その月 の行を INSERT。
 * 冪等: もう一度 DRY RUN すると 0 件になる。
 * 前提 SQL: migrations/payroll_salary_settings_paid_leave_unit_price.sql
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const DIR = opt("--extract-dir");
const MONTHS = (opt("--months") ?? "").split(",").filter(Boolean).sort();
if (!DIR || MONTHS.length === 0) { console.error("--extract-dir <dir> --months YYYYMM,... を指定してください"); process.exit(1); }

const env: Record<string, string> = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY がありません"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
type Row = Record<string, unknown>;
async function getAll(p: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${p}${p.includes("?") ? "&" : "?"}order=id&offset=${from}&limit=1000`, { headers: H });
    if (!r.ok) throw new Error(`${p}: ${await r.text()}`);
    const d = (await r.json()) as Row[];
    out.push(...d);
    if (d.length < 1000) break;
  }
  return out;
}
async function write(method: string, p: string, body: unknown): Promise<Row> {
  const r = await fetch(`${SB_URL}/rest/v1/${p}`, { method, headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${p}: ${await r.text()}`);
  const rows = (await r.json()) as Row[];
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error(`${method} ${p}: 1 行のはずが ${Array.isArray(rows) ? rows.length : "?"} 行`);
  return rows[0];
}

const normName = (s: unknown) => String(s ?? "").split("\n")[0].replace(/[\s　]+/g, "").trim();
const normNo = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");
const monthStart = (m: string) => `${m.slice(0, 4)}-${m.slice(4, 6)}-01`;
function leaveDays(r: Row): number {
  const v = r["有給・特休・欠勤"] ?? r["有給"];
  if (typeof v === "number") return v;
  const m = /有\/?有?([\d.]+)/.exec(String(v ?? "")) ?? /^([\d.]+)$/.exec(String(v ?? "").trim());
  return m ? Number(m[1]) : 0;
}

// ── 総括表 ──
type Obs = { m: string; office: string; code: string; name: string; amt: number; days: number; unit: number };
const obs: Obs[] = [];
const skipped: string[] = [];
for (const m of MONTHS) {
  const ex = JSON.parse(readFileSync(path.join(DIR, `soukatsu${m}`, "extract.json"), "utf8")) as { office: string; kind: string; rows: Row[] }[];
  const seen = new Set<string>();
  for (const f of ex) {
    if (f.kind !== "shaseki") continue;
    for (const r of f.rows) {
      // 日数があって手当が空 (0) の月は 単価 0 円 (社員は 前年のパート実績・介護超過が無いと 0 = user 2026-09-18)
      const amt = typeof r["有給休暇手当"] === "number" ? (r["有給休暇手当"] as number) : 0;
      const name = normName(r["氏名"]);
      if (amt < 0 || !name || /^(合計|小計|計)$/.test(name)) continue;
      if (amt === 0 && !(leaveDays(r) > 0)) continue;
      const code = normNo(r._code);
      const key = `${f.office}|${code}`;
      if (seen.has(key)) continue; // 同じ人が同じ月に 2 行 (おゆみ野の重複シート)
      seen.add(key);
      const days = leaveDays(r);
      if (!(days > 0)) { skipped.push(`${m} ${f.office} ${code} ${name}: 手当 ${amt} だが日数が読めない (${JSON.stringify(r["有給・特休・欠勤"] ?? r["有給"])})`); continue; }
      const unit = Math.round(amt / days);
      if (Math.round(unit * days) !== amt) { skipped.push(`${m} ${f.office} ${code} ${name}: ${amt} ÷ ${days}日 が整数の単価にならない`); continue; }
      obs.push({ m, office: f.office, code, name, amt, days, unit });
    }
  }
}

// ── DB ──
const emps = await getAll("payroll_employees?select=id,employee_number,name,salary_type,employment_status,paid_leave_unit_price");
const sal = await getAll("payroll_salary_settings?select=*");
const empOf = (o: Obs) => {
  const hit = emps.filter((e) => normNo(e.employee_number) === o.code && normName(e.name) === o.name);
  if (hit.length <= 1) return hit;
  // 同じ番号・氏名が 2 事業所に登録されている (兼務) ときは 月給の在職者に絞る
  const narrowed = hit.filter((e) => e.salary_type === "月給" && e.employment_status !== "退職者");
  return narrowed.length === 1 ? narrowed : hit;
};

const ops: { label: string; run: () => Promise<unknown> }[] = [];
const notes: string[] = [...skipped];
const byEmp = new Map<string, Obs[]>();
for (const o of obs) {
  const hit = empOf(o);
  if (hit.length !== 1) { notes.push(`${o.m} ${o.office} ${o.code} ${o.name}: 職員が ${hit.length} 人当たる (入れません)`); continue; }
  const id = String(hit[0].id);
  byEmp.set(id, [...(byEmp.get(id) ?? []), o]);
}
for (const [empId, list] of byEmp) {
  const emp = emps.find((e) => e.id === empId)!;
  const rows = sal.filter((r) => r.employee_id === empId);
  for (const o of list.sort((a, b) => a.m.localeCompare(b.m))) {
    const ms = monthStart(o.m);
    const active = rows.filter((r) => String(r.effective_from) <= ms).sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)))[0];
    if (!active) { notes.push(`${o.m} ${o.office} ${o.code} ${o.name}: 給与設定の行が無い (入れません)`); continue; }
    const cur = active.paid_leave_unit_price ?? emp.paid_leave_unit_price ?? 0;
    // 今の単価 × 日数 が 同じ金額に戻るなら変えない (0.5 日は端数で 1205 と 1206 のどちらでも 603 円になる)
    if (Number(cur) === o.unit || (Number(cur) > 0 && Math.round(Number(cur) * o.days) === o.amt)) continue;
    const label = `${o.m} ${o.office} ${o.code} ${o.name}: ${cur} → ${o.unit} 円/日 (${o.amt}円 ÷ ${o.days}日)`;
    if (String(active.effective_from) === ms) {
      active.paid_leave_unit_price = o.unit;
      ops.push({ label: `PATCH ${label}`, run: () => write("PATCH", `payroll_salary_settings?id=eq.${active.id}`, { paid_leave_unit_price: o.unit }) });
    } else {
      const copy: Row = { ...active, effective_from: ms, paid_leave_unit_price: o.unit };
      delete copy.id; delete copy.created_at; delete copy.updated_at;
      rows.push(copy);
      ops.push({ label: `INSERT ${label} (${active.effective_from} の行を写す)`, run: () => write("POST", "payroll_salary_settings", copy) });
    }
  }
}

for (const n of notes) console.log(`  ・${n}`);
for (const op of ops) console.log(op.label);
console.log(`\n総括表の観測 ${obs.length} 件 / 書き込み ${ops.length} 件 / 入れないもの ${notes.length} 件`);
if (!EXECUTE) { console.log("DRY RUN (--execute で書き込み)"); process.exit(0); }
for (const op of ops) await op.run();
console.log(`書き込み ${ops.length} 件 完了`);
