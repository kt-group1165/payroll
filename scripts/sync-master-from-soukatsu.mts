/**
 * 総括表 (旧Excel給与) の抽出結果から、事業所の給与マスタを総括表に合わせる。
 *
 *   npx tsx scripts/sync-master-from-soukatsu.mts --office 1270201930 --folder 02_花見川 --months 202603,202604,202605,202606,202607 --extract-dir <dir>            # DRY RUN
 *   npx tsx scripts/sync-master-from-soukatsu.mts ... --execute
 *
 * <dir>/soukatsu<YYYYMM>/extract.json = [{ office, kind: "part"|"shaseki", rows: [{ _code, 氏名, … 総括表の列 }] }]
 *   (総括表 xlsm を作業フォルダにコピーして抽出したもの。Box の元ファイルには触らない)
 *
 * さつきが丘・高品 (2026-09-17) で総括表と 1 円まで突き合わせて確かめた決まりだけを入れる:
 *   月給 (提責_社員シート)
 *     - 役割: 「提責・事務」列 3・1 = 提責 / 2 = 事務員 / 空 = 社員
 *     - 固定給 (本人給・職能給・役職・資格・勤続・処遇改善・特別処遇改善・補助金・固定残業代) を月ごとの履歴 (effective_from) で持つ。
 *       勤続手当は手入力 (tenure_allowance_auto=false)
 *     - 社員は 介護超過 120h × 2,500円 / 夜朝 200円、提責・事務員は 0
 *     - 社員の有給単価 (円/日) = 有給休暇手当 ÷ 有給・特休・欠勤 の日数 (月をまたいで同じ値のときだけ)
 *   時給 (パート_総括表データより)
 *     - 社保 (= 処遇改善補助金の対象) は 最新月に 処遇改善補助金手当 が出ているか で決める。
 *       総括表の「社会保険」列は補助金と一致しない (さつき 滝下: 列は空で補助金あり / 高品 菊池: 列は1で補助金なし)
 *     - 有給単価 = 最新月の値 / 勤続手当単価がある → 資格「不明（要件は満たす）」
 *     - 最新月が月給の人には時給側の設定を当てない
 *   --skip-part: パートを扱わない (いわね: パートは やわた の職員と同じ一覧で、やわたで稼働 = user 判断)
 *   在籍
 *     - 総括表に居て DB に居ない → 登録 (番号・氏名・時給/月給・在職者)
 *     - DB の在職/休職者で、総括表 (指定月) と MEISAI 実績 (全月) のどちらにも居ない → 退職者
 *     - 退職者が総括表の月に載っている → 退職日 = 最後に載っている月の末日 (退職日が無いか、それより前のとき)
 *
 * 触らないもの (人の確認が要る): 通信費タイプ・事務時給・兼務者・単価マスタ・サービスコード対応。候補として表示だけする。
 * 冪等: もう一度 DRY RUN すると 0 件になる。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const OFFICE = opt("--office");
const FOLDER = opt("--folder");
const MONTHS = (opt("--months") ?? "").split(",").filter(Boolean).sort();
const DIR = opt("--extract-dir");
const SKIP_PART = args.includes("--skip-part");
if (!OFFICE || !FOLDER || MONTHS.length === 0 || !DIR) {
  console.error("--office <事業所番号> --folder <総括表の事業所フォルダ名> --months YYYYMM,... --extract-dir <dir> を指定してください");
  process.exit(1);
}

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

const num = (v: unknown) => (typeof v === "number" ? v : 0);
const cleanName = (s: unknown) => String(s ?? "").split("\n")[0].replace(/[\s　]+/g, " ").trim();
const monthStart = (m: string) => `${m.slice(0, 4)}-${m.slice(4, 6)}-01`;
const monthEnd = (m: string) => { const y = Number(m.slice(0, 4)), mo = Number(m.slice(4, 6)); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };

// ── 総括表 ────────────────────────────────────────────────────
type SRow = Record<string, unknown> & { _code: string };
const byMonth = new Map<string, { part: SRow[]; shaseki: SRow[] }>();
for (const m of MONTHS) {
  const ex = JSON.parse(readFileSync(path.join(DIR, `soukatsu${m}`, "extract.json"), "utf8")) as { office: string; kind: string; rows: SRow[] }[];
  const mine = ex.filter((f) => f.office === FOLDER);
  if (mine.length === 0) { console.error(`★ ${m} の extract.json に ${FOLDER} がありません`); process.exit(2); }
  const valid = (r: SRow) => { const nm = String(r["氏名"] ?? "").trim(); return nm !== "" && !nm.includes("_") && !/^(合計|小計|計)$/.test(nm); };
  byMonth.set(m, {
    part: mine.filter((f) => f.kind === "part").flatMap((f) => f.rows).filter(valid),
    shaseki: mine.filter((f) => f.kind === "shaseki").flatMap((f) => f.rows).filter(valid),
  });
}
const latest = MONTHS[MONTHS.length - 1];

// ── DB ────────────────────────────────────────────────────────
const [office] = await getAll(`payroll_offices?select=id,office_number&office_number=eq.${OFFICE}`);
if (!office) { console.error(`payroll_offices に ${OFFICE} がありません`); process.exit(2); }
const emps = await getAll(`payroll_employees?select=id,employee_number,name,salary_type,role_type,employment_status,resignation_date,social_insurance,paid_leave_unit_price,has_care_qualification,care_qualification_kind,communication_fee_type,is_office_worker&office_id=eq.${office.id}`);
const byNo = new Map(emps.map((e) => [String(e.employee_number), e]));
const meisaiNos = new Set((await getAll(`payroll_service_records?select=id,employee_number&office_number=eq.${OFFICE}`)).map((r) => String(r.employee_number).replace(/^0+/, "")));

type Op = { label: string; run: () => Promise<unknown> };
const ops: Op[] = [];
const notes: string[] = [];

// ── 在籍 ──────────────────────────────────────────────────────
const lastSeen = new Map<string, { month: string; kind: "part" | "shaseki"; row: SRow }>();
for (const m of MONTHS) {
  const s = byMonth.get(m)!;
  // 総支給が 0 / 空 の行は「居ない」とみなす (user 2026-09-17: 総括表に空行だけの人は居ない)。ただし兼務者の行は在籍として扱う
  for (const r of s.part) if (!SKIP_PART && (num(r["総支給額"]) !== 0 || r["兼務者"])) lastSeen.set(r._code, { month: m, kind: "part", row: r });
  for (const r of s.shaseki) if (num(r["総支給額"]) !== 0) lastSeen.set(r._code, { month: m, kind: "shaseki", row: r });
}
const pendingCreate = new Set<string>();
for (const [code, seen] of lastSeen) {
  const e = byNo.get(code);
  if (!e) {
    const body = {
      employee_number: code, name: cleanName(seen.row["氏名"]), office_id: office.id,
      salary_type: seen.kind === "part" ? "時給" : "月給", role_type: seen.kind === "part" ? "パート" : "社員",
      employment_status: seen.month === latest ? "在職者" : "退職者", resignation_date: seen.month === latest ? null : monthEnd(seen.month),
      job_type: "訪問介護", social_insurance: seen.kind === "shaseki" || num(seen.row["処遇改善補助金手当"]) > 0, communication_fee_type: "none",
    };
    pendingCreate.add(code);
    ops.push({ label: `登録 ${code} ${body.name} ${body.salary_type}/${body.employment_status}${body.resignation_date ? ` 退職日${body.resignation_date}` : ""} (総括表 ${seen.month})`, run: async () => { const c = await write("POST", "payroll_employees", body); byNo.set(code, c); } });
    continue;
  }
  if (e.employment_status === "退職者") {
    const want = seen.month === latest ? null : monthEnd(seen.month);
    if (want === null) ops.push({ label: `在職者に戻す ${code} ${e.name} (総括表 ${latest} に在籍)`, run: () => write("PATCH", `payroll_employees?id=eq.${e.id}`, { employment_status: "在職者", resignation_date: null }) });
    else if (!e.resignation_date || String(e.resignation_date) < want) ops.push({ label: `退職日 ${code} ${e.name} ${e.resignation_date ?? "なし"} → ${want}`, run: () => write("PATCH", `payroll_employees?id=eq.${e.id}`, { resignation_date: want }) });
  } else if (e.employment_status === "休職者" && seen.month === latest) {
    ops.push({ label: `在職者に ${code} ${e.name} (休職者、総括表 ${latest} に在籍)`, run: () => write("PATCH", `payroll_employees?id=eq.${e.id}`, { employment_status: "在職者" }) });
  }
  const wantType = seen.kind === "part" ? "時給" : "月給";
  if (e.salary_type !== wantType) ops.push({ label: `給与形態 ${code} ${e.name} ${e.salary_type} → ${wantType} (総括表 ${seen.month})`, run: () => write("PATCH", `payroll_employees?id=eq.${e.id}`, { salary_type: wantType }) });
}
for (const e of emps) {
  const code = String(e.employee_number);
  if (e.employment_status === "退職者" || lastSeen.has(code) || meisaiNos.has(code.replace(/^0+/, ""))) continue;
  ops.push({ label: `退職者に ${code} ${e.name} (${e.employment_status}。総括表 ${MONTHS[0]}〜${latest} にも MEISAI にも居ない)`, run: () => write("PATCH", `payroll_employees?id=eq.${e.id}`, { employment_status: "退職者" }) });
}

// ── 月給 ──────────────────────────────────────────────────────
const FIXED: [string, string][] = [
  ["本人給", "base_personal_salary"], ["職能給", "skill_salary"], ["役職手当", "position_allowance"], ["資格手当", "qualification_allowance"],
  ["勤続手当", "tenure_allowance"], ["処遇改善手当", "treatment_improvement"], ["特別処遇改善手当", "specific_treatment_improvement"],
  ["処遇改善補助金手当", "treatment_subsidy"], ["固定残業代", "fixed_overtime_pay"],
];
const shaCodes = new Set(MONTHS.flatMap((m) => byMonth.get(m)!.shaseki.map((r) => r._code)));
for (const code of shaCodes) {
  if (lastSeen.get(code)?.kind === "part") {
    const ms = MONTHS.filter((m) => byMonth.get(m)!.shaseki.some((x) => x._code === code));
    notes.push(`${code}: ${ms.join(",")} は月給、最新月は時給 (給与形態の月次履歴が無いので、月給だった月は計算が合わない)`);
    continue;
  }
  const monthsRows = MONTHS.map((m) => ({ m, r: byMonth.get(m)!.shaseki.find((x) => x._code === code) })).filter((x) => x.r) as { m: string; r: SRow }[];
  const last = monthsRows[monthsRows.length - 1].r;
  const kubun = last["提責・事務"];
  const role = kubun === 3 || kubun === 1 ? "提責" : kubun === 2 ? "事務員" : "社員";
  const e = byNo.get(code);
  const name = cleanName(last["氏名"]);
  if (e && e.role_type !== role) ops.push({ label: `役割 ${code} ${name} ${e.role_type} → ${role} (提責・事務=${kubun ?? "空"})`, run: () => write("PATCH", `payroll_employees?id=eq.${byNo.get(code)!.id}`, { role_type: role }) });
  if (!e && !pendingCreate.has(code)) continue;
  if (!e) ops.push({ label: `役割 ${code} ${name} → ${role}`, run: () => write("PATCH", `payroll_employees?id=eq.${byNo.get(code)!.id}`, { role_type: role }) });

  // 固定給の区間 (値が同じ月をまとめる)
  const care = role === "社員" ? { care_overtime_threshold_hours: 120, care_overtime_unit_price: 2500, yocho_unit_price: 200 } : { care_overtime_threshold_hours: 0, care_overtime_unit_price: 0, yocho_unit_price: 0 };
  const target = (r: SRow) => ({ ...Object.fromEntries(FIXED.map(([k, c]) => [c, num(r[k])])), ...care, tenure_allowance_auto: false });
  const segs: { start: string; values: Record<string, unknown> }[] = [];
  for (const { m, r } of monthsRows) {
    const v = target(r);
    const prev = segs[segs.length - 1];
    if (!prev || JSON.stringify(prev.values) !== JSON.stringify(v)) segs.push({ start: m, values: v });
  }
  const settings = e ? await getAll(`payroll_salary_settings?select=*&employee_id=eq.${e.id}`) : [];
  settings.sort((a, b) => String(a.effective_from).localeCompare(String(b.effective_from)));
  segs.forEach((seg, i) => {
    const eff = i === 0 ? (settings.find((s) => String(s.effective_from) <= monthStart(seg.start)) ? String([...settings].reverse().find((s) => String(s.effective_from) <= monthStart(seg.start))!.effective_from) : "1970-01-01") : monthStart(seg.start);
    const row = settings.find((s) => String(s.effective_from) === eff);
    const diff = row ? Object.entries(seg.values).filter(([k, v]) => row[k] !== v).map(([k, v]) => `${k} ${row[k]}→${v}`) : [];
    if (row && diff.length) ops.push({ label: `給与設定 ${code} ${name} ${eff}〜: ${diff.join(", ")}`, run: () => write("PATCH", `payroll_salary_settings?id=eq.${row.id}`, seg.values) });
    if (!row) {
      const base = [...settings].reverse().find((s) => String(s.effective_from) < eff);
      const copy: Row = base ? Object.fromEntries(Object.entries(base).filter(([k]) => !["id", "created_at", "updated_at", "employee_id", "effective_from"].includes(k))) : {};
      ops.push({ label: `給与設定を作る ${code} ${name} ${eff}〜 ${FIXED.map(([k, c]) => `${k.slice(0, 2)}${seg.values[c]}`).join(" ")}${role === "社員" ? " 介護超過120h×2500/夜朝200" : ""}`, run: () => write("POST", "payroll_salary_settings", { ...copy, ...seg.values, employee_id: byNo.get(code)!.id, effective_from: eff }) });
    }
  });
  // 範囲の月より後に始まる、総括表と食い違う行は触らず知らせる
  for (const s of settings) {
    if (String(s.effective_from) > monthStart(latest)) notes.push(`${code} ${name}: ${s.effective_from} 開始の給与設定があります (${latest} より後。触っていません)`);
  }

  if (role === "社員") {
    const units = monthsRows.map(({ m, r }) => ({ m, days: num(r["有給・特休・欠勤"]), amt: num(r["有給休暇手当"]) })).filter((x) => x.days > 0 && x.amt > 0).map((x) => ({ ...x, unit: Math.round(x.amt / x.days) }));
    const set = new Set(units.map((u) => u.unit));
    if (set.size === 1) {
      const unit = [...set][0];
      if (!e || e.paid_leave_unit_price !== unit) ops.push({ label: `社員の有給単価 ${code} ${name} ${e?.paid_leave_unit_price ?? 0} → ${unit} (${units.map((u) => `${u.m} ${u.amt}/${u.days}日`).join(", ")})`, run: () => write("PATCH", `payroll_employees?id=eq.${byNo.get(code)!.id}`, { paid_leave_unit_price: unit }) });
    } else if (set.size > 1) notes.push(`${code} ${name}: 社員の有給単価が月で違う ${units.map((u) => `${u.m} ${u.amt}/${u.days}日=${u.unit}`).join(", ")} (設定していません)`);
  }
}

// ── 時給 ──────────────────────────────────────────────────────
const partCodes = new Set(SKIP_PART ? [] : MONTHS.flatMap((m) => byMonth.get(m)!.part.map((r) => r._code)));
for (const code of partCodes) {
  if (lastSeen.get(code)?.kind !== "part") continue;   // 最新月が月給 (または居ない) 人には時給側の設定を当てない
  const rows = MONTHS.map((m) => ({ m, r: byMonth.get(m)!.part.find((x) => x._code === code) })).filter((x) => x.r) as { m: string; r: SRow }[];
  const last = rows[rows.length - 1].r;
  const name = cleanName(last["氏名"]);
  if (last["兼務者"] && num(last["総支給額"]) === 0) { notes.push(`${code} ${name}: 兼務者 (${last["兼務者"]})。触っていません`); continue; }
  const e = byNo.get(code);
  if (!e && !pendingCreate.has(code)) continue;
  const id = () => byNo.get(code)!.id;
  const si = num(last["処遇改善補助金手当"]) > 0;
  if (!e || Boolean(e.social_insurance) !== si) ops.push({ label: `社保(補助金の対象) ${code} ${name} ${e?.social_insurance ?? "-"} → ${si} (${rows[rows.length - 1].m} 補助金 ${last["処遇改善補助金手当"] ?? "なし"})`, run: () => write("PATCH", `payroll_employees?id=eq.${id()}`, { social_insurance: si }) });
  const unitRow = [...rows].reverse().find((x) => num(x.r["有給単価"]) > 0);
  if (unitRow) {
    const unit = num(unitRow.r["有給単価"]);
    if (!e || e.paid_leave_unit_price !== unit) ops.push({ label: `有給単価 ${code} ${name} ${e?.paid_leave_unit_price ?? 0} → ${unit} (${unitRow.m})`, run: () => write("PATCH", `payroll_employees?id=eq.${id()}`, { paid_leave_unit_price: unit }) });
    const others = new Set(rows.map((x) => num(x.r["有給単価"])).filter((u) => u > 0));
    if (others.size > 1) notes.push(`${code} ${name}: 有給単価が月で違う ${rows.filter((x) => num(x.r["有給単価"]) > 0).map((x) => `${x.m}=${x.r["有給単価"]}`).join(", ")} (最新月の値を入れる)`);
  }
  if (rows.some((x) => num(x.r["勤続手当単価"]) > 0) && (!e || !e.has_care_qualification)) ops.push({ label: `資格 ${code} ${name} → 不明（要件は満たす） (勤続手当単価 ${rows.map((x) => x.r["勤続手当単価"]).filter(Boolean).join("/")})`, run: () => write("PATCH", `payroll_employees?id=eq.${id()}`, { has_care_qualification: true, care_qualification_kind: "不明（要件は満たす）" }) });
  if (num(last["通信手当"]) < 0) notes.push(`${code} ${name}: 通信手当 ${last["通信手当"]} (貸与負担なら 通信費タイプ lend_fee。現在 ${e?.communication_fee_type ?? "-"})`);
  if (last["事務時給"]) notes.push(`${code} ${name}: 事務時給 ${last["事務時給"]} (事務員。現在 is_office_worker=${e?.is_office_worker ?? "-"})`);
}

console.log(`=== 総括表 → 給与マスタ ${FOLDER} (${OFFICE}) ${MONTHS.join(",")} ${EXECUTE ? "【本番】" : "(DRY RUN)"} ${ops.length} 件 ===`);
for (const o of ops) console.log(`  ${o.label}`);
if (notes.length) { console.log("--- 要確認 (変更しない)"); for (const n of notes) console.log(`  ${n}`); }
if (!EXECUTE) { console.log("\nDRY RUN。--execute で書き込みます"); process.exit(0); }
let done = 0;
for (const o of ops) { await o.run(); done++; }
console.log(`\n完了 ${done} / ${ops.length}`);
