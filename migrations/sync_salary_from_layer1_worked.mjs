/**
 * ① (総括表データ_提責_社員) にだけ載っていて ② (支払用 = payroll_soukatsu_rows) に居ない月給者のうち、
 * ① に「出勤・訪問の記録がある」人月だけ、給与設定 (payroll_salary_settings) の固定給を ① の値に合わせる (2026-09-26 給与D)。
 *
 *   node migrations/sync_salary_from_layer1_worked.mjs                 # DRY RUN (既定。何も書かない)
 *   node migrations/sync_salary_from_layer1_worked.mjs --execute       # 書き込む
 *   EXTRACT=<dir> node migrations/sync_salary_from_layer1_worked.mjs   # ① の抽出結果 (extract_soukatsu_from_xlsm.mjs --execute の出力先)
 *   MONTHS=202603,...                                                   # 対象月 (既定 202603〜202608)
 *
 * 【なぜ】
 * scripts/sync-master-from-soukatsu.mts は ② から作った extract.json しか読まないので、
 * ② に載っていない人は 一度も同期されない。2026-09-26 実測 (① のある 23 事業所 × 202603〜08):
 *   ① で総支給>0 かつ ② に居ない   44 名 / 223 人月
 *   うち ① に出勤・訪問の記録がある   13 人月 (船木治美 6 / 酒井絹恵 6 / 渡邉美吹 1)
 *   ★ 残り 210 人月は ① に出勤も訪問も無い。旧システムは 職員マスタに居る人の固定給を
 *     働いていなくても計算して ① に出す (例: 2025-02 退職の 堀内則子 が 2026 年も ¥195,500)。
 *     ② (支払用) はそういう人を載せない = 実際には払っていないと読むのが自然。
 * よって ★「① にだけ居る人を全部足す」は誤り (働いていない人に固定給を付けてしまう)。
 *   対象は「② に居ない」かつ「① に出勤・訪問の記録がある」人月に限る。
 *
 * 【① と ② の列の対応】 (① と ② の両方に居る 提責_社員 1,310 人月で一致率を測って決めた)
 *   本人給→本人給 97% / 職能給→職能給 91% / 役職手当 99% / 資格手当 99% / 勤続手当 84% /
 *   固定残業手当→固定残業代 98% / 処遇改善→処遇改善手当 95% / 特定処遇改善→特別処遇改善手当 88% /
 *   ベースアップ加算手当→処遇改善補助金手当 99% / 特別報奨金 99%
 *   (不一致は ② の手入力。① を正とする)
 *
 * 【触らないもの】
 *   ② に居る人月 (② の手入力を踏み潰さないため。そちらは sync-master-from-soukatsu の担当)
 *   ① に出勤・訪問の記録が無い人月
 *   職員マスタで 月給・在職者 でない人
 *   対象月より後に始まる給与設定の行
 *   勤続手当が自動計算 (tenure_allowance_auto=true) の人の 勤続手当 (自動のまま残す)
 *
 * マーカー: 書いた行の note の末尾に「[layer1-sync 2026-09-26]」
 * 冪等: もう一度 DRY RUN すると 0 件になる。
 */
import { readFileSync, existsSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const EXTRACT = process.env.EXTRACT || "C:/Users/domen-PC/AppData/Local/Temp/claude/C--Users-domen-PC-Downloads---------/2891151f-c7b0-42ed-ad03-f7911938da20/scratchpad/soukatsu_extract";
const MONTHS = (process.env.MONTHS || "202603,202604,202605,202606,202607,202608").split(",");
const MARKER = "[layer1-sync 2026-09-26]";

const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL + "/rest/v1/";
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
/** PostgREST の 1000 行上限を越えて全件読む。order 無しのページングは行が抜けるので id で並べる */
async function all(q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB}${q}&order=id&offset=${from}&limit=1000`, { headers: H });
    const j = await r.json();
    if (!Array.isArray(j)) { console.error("★ 読み込み失敗:", q.slice(0, 80), JSON.stringify(j).slice(0, 300)); process.exit(1); }
    out.push(...j); if (j.length < 1000) break;
  }
  return out;
}
const nn = (s) => String(s ?? "").trim().replace(/^0+/, "");
const num = (v) => { if (v == null || v === "") return 0; const n = Number(String(v).replace(/,/g, "")); return Number.isFinite(n) ? n : 0; };
const tmin = (v) => { if (v == null || v === "") return 0; if (typeof v === "number") return v; const m = /^(-?\d+):(\d{2})/.exec(String(v)); return m ? Number(m[1]) * 60 + Number(m[2]) : num(v); };
const monthStart = (m) => `${m.slice(0, 4)}-${m.slice(4)}-01`;

/** ① の列 → payroll_salary_settings の列 */
const L1_TO_SETTING = [
  ["本人給", "base_personal_salary"], ["職能給", "skill_salary"], ["役職手当", "position_allowance"], ["資格手当", "qualification_allowance"],
  ["勤続手当", "tenure_allowance"], ["固定残業手当", "fixed_overtime_pay"], ["処遇改善", "treatment_improvement"],
  ["特定処遇改善", "specific_treatment_improvement"], ["ベースアップ加算手当", "treatment_subsidy"], ["特別報奨金", "special_bonus"],
];
const LOSER_FILE = /^(過誤|訂正|再|コピー)/;
/** ① の行に 出勤・訪問の記録があるか */
const worked = (d) => num(d["出勤日数"]) > 0 || tmin(d["出勤"]) > 0 || tmin(d["訪問時間"]) > 0 || tmin(d["訪介実績時間"]) > 0;

// ── ① を読む ──
const l1 = new Map(); // office|emp|month -> row_data
for (const m of MONTHS) {
  const p = `${EXTRACT}/soukatsu_extract_${m}.json`;
  if (!existsSync(p)) { console.error(`★ ① の抽出結果が無い: ${p}  (先に extract_soukatsu_from_xlsm.mjs --execute を回す)`); process.exit(1); }
  for (const r of JSON.parse(readFileSync(p, "utf8"))) {
    if (r.sheet_kind !== "shaseki" || LOSER_FILE.test(r.source_file ?? "")) continue;
    l1.set(`${r.office_number}|${nn(r.employee_number)}|${m}`, { ...r.row_data, _file: r.source_file, _name: r.employee_name });
  }
}

// ── DB を読む (1 回ずつ) ──
const offices = await all("payroll_offices?select=id,office_number");
const offById = new Map(offices.map((o) => [o.id, o.office_number]));
const emps = await all("payroll_employees?select=id,employee_number,name,office_id,salary_type,employment_status");
const empBy = new Map(emps.map((e) => [`${offById.get(e.office_id)}|${nn(e.employee_number)}`, e]));
const l2 = new Set((await all(`payroll_soukatsu_rows?select=id,office_number,employee_number,processing_month&sheet_kind=eq.shaseki&processing_month=in.(${MONTHS.join(",")})`))
  .map((r) => `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`));

// ── 対象を決める ──
const stats = { l1Paid: 0, notInL2: 0, notWorked: 0, notMonthlyActive: 0, noEmp: 0, target: 0 };
const targetMonths = new Map(); // office|emp -> [{m, d}]
for (const [k, d] of l1) {
  if (num(d["総支給額（介社）"]) <= 0) continue;
  stats.l1Paid++;
  if (l2.has(k)) continue;
  stats.notInL2++;
  if (!worked(d)) { stats.notWorked++; continue; }
  const [on, en, m] = k.split("|");
  const e = empBy.get(`${on}|${en}`);
  if (!e) { stats.noEmp++; continue; }
  if (e.salary_type !== "月給" || e.employment_status !== "在職者") { stats.notMonthlyActive++; continue; }
  stats.target++;
  const pk = `${on}|${en}`;
  if (!targetMonths.has(pk)) targetMonths.set(pk, []);
  targetMonths.get(pk).push({ m, d });
}

console.log(`=== ①にだけ居る月給者 (出勤あり) の固定給を ① に合わせる ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
console.log(`★ 比較: ① = 総括表データ_提責_社員 (${EXTRACT}) / ② = payroll_soukatsu_rows sheet_kind=shaseki / 月 ${MONTHS[0]}〜${MONTHS[MONTHS.length - 1]}`);
console.log(`  ① で総支給>0 の人月 ${stats.l1Paid}`);
console.log(`    うち ② に居ない ${stats.notInL2}`);
console.log(`      ① に出勤・訪問の記録が無い → 対象外 ${stats.notWorked}`);
console.log(`      職員マスタに居ない → 対象外 ${stats.noEmp} / 月給・在職者でない → 対象外 ${stats.notMonthlyActive}`);
console.log(`      ★ 対象 ${stats.target} 人月 (${targetMonths.size} 名)`);

// ── 給与設定と比べて 書く内容を作る ──
const ops = [];
const skippedBad = [];
for (const [pk, list] of targetMonths) {
  const e = empBy.get(pk);
  list.sort((a, b) => a.m.localeCompare(b.m));
  const settings = (await all(`payroll_salary_settings?select=*&employee_id=eq.${e.id}`)).sort((a, b) => String(a.effective_from).localeCompare(String(b.effective_from)));
  // ★ 勤続手当が自動計算 (tenure_allowance_auto=true) の人は 勤続手当に触らない。
  //   固定値を書いて auto=false にすると 自動計算から手入力に黙って切り替わる (2026-09-26: 船木・酒井 とも auto=true だった)
  const autoTenure = settings.length > 0 && settings[settings.length - 1].tenure_allowance_auto === true;
  const cols = L1_TO_SETTING.filter(([, col]) => !(autoTenure && col === "tenure_allowance"));
  // 値が同じ月をまとめる (区間)
  // ★ 未設定と 0 を混ぜない (COALESCE(列,0) と同じ型の事故を防ぐ):
  //   ・① のシートに その列 (見出し) が無い → その項目は比べない・書かない (0 で上書きしない)
  //   ・① のセルが エラー値 (#VALUE! 等) や数字でない文字 → その人月ごと対象外にして名前を出す
  //   ・① のセルが空欄 → 0 とみなす (① は旧システムの出力で、空欄は 支給なし = 総支給にも入っていない)
  const segs = [];
  for (const { m, d } of list) {
    const bad = cols.filter(([c1]) => c1 in d && d[c1] != null && d[c1] !== "" && !Number.isFinite(Number(String(d[c1]).replace(/,/g, ""))));
    if (bad.length) { skippedBad.push(`${pk} ${e.name} ${m}: ${bad.map(([c1]) => `${c1}=${JSON.stringify(d[c1])}`).join(", ")}`); continue; }
    const values = Object.fromEntries(cols.filter(([c1]) => c1 in d).map(([c1, col]) => [col, num(d[c1])]));
    const prev = segs[segs.length - 1];
    if (!prev || JSON.stringify(prev.values) !== JSON.stringify(values)) segs.push({ start: m, values, file: d._file });
  }
  for (const seg of segs) {
    const ms = monthStart(seg.start);
    // その月に効いている行 (effective_from <= 月初 のうち最新)
    const active = [...settings].reverse().find((s) => String(s.effective_from) <= ms);
    // 給与設定の NULL (未設定) は 0 と別に扱う: ① が 0 で 設定が NULL なら 書かない (未設定のまま残す)
    const diff = active ? Object.entries(seg.values).filter(([k, v]) => (active[k] == null ? v !== 0 : Number(active[k]) !== v)) : Object.entries(seg.values);
    if (diff.length === 0) continue;
    const label = `${pk} ${e.name} ${seg.start}〜: ${diff.map(([k, v]) => `${k} ${!active ? "(行なし)" : active[k] == null ? "未設定" : Number(active[k])}→${v}`).join(", ")}  (${seg.file})`;
    if (active && String(active.effective_from) === ms) {
      ops.push({ label: `PATCH ${label}`, method: "PATCH", path: `payroll_salary_settings?id=eq.${active.id}`,
        body: { ...seg.values, ...(autoTenure ? {} : { tenure_allowance_auto: false }), note: `${active.note ?? ""} ${MARKER}`.trim() } });
    } else {
      // ★ 既存の行 (1970-01-01 の初期値など) は書き換えず、その月から始まる行を足す (それより前の月の値を変えない)
      const copy = active ? Object.fromEntries(Object.entries(active).filter(([k]) => !["id", "created_at", "updated_at", "employee_id", "effective_from", "note"].includes(k))) : {};
      ops.push({ label: `POST  ${label}`, method: "POST", path: "payroll_salary_settings",
        body: { ...copy, ...seg.values, ...(autoTenure ? {} : { tenure_allowance_auto: false }), employee_id: e.id, effective_from: ms, note: MARKER } });
    }
  }
}

if (skippedBad.length) {
  console.log(`\n--- ① のセルが数字でないので対象外 ${skippedBad.length} 人月 (0 とみなして書かない)`);
  for (const x of skippedBad) console.log("  " + x);
}
console.log(`\n--- 書く内容 ${ops.length} 件`);
for (const o of ops) console.log("  " + o.label);
const confirmSql = `SELECT e.employee_number, e.name, s.effective_from, s.base_personal_salary, s.skill_salary, s.position_allowance,
       s.qualification_allowance, s.tenure_allowance, s.fixed_overtime_pay, s.treatment_improvement,
       s.specific_treatment_improvement, s.treatment_subsidy, s.note
  FROM payroll_salary_settings s JOIN payroll_employees e ON e.id = s.employee_id
 WHERE s.note LIKE '%${MARKER}%' ORDER BY e.employee_number, s.effective_from;`;
if (!EXECUTE) {
  console.log(`\nDRY RUN。--execute で書き込みます。書いた後の確認 SQL:\n${confirmSql}`);
  process.exit(0);
}
let done = 0;
for (const o of ops) {
  const r = await fetch(`${SB}${o.path}`, { method: o.method, headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(o.body) });
  const b = await r.json();
  if (!r.ok || !Array.isArray(b) || b.length !== 1) { console.error(`★ 書き込み失敗: ${o.label}\n  ${JSON.stringify(b).slice(0, 400)}`); process.exit(1); }
  done++;
}
console.log(`\n反映 ${done} 件。確認 SQL:\n${confirmSql}`);
