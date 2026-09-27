/**
 * check:soukatsu-row-only — 総括表 ① と 当方の給与計算で「行ごと片側にしか居ない人月」を 型に分ける (2026-09-27)。読み取りのみ・DB書換なし。
 *
 *   L1_DIR=<① の抽出フォルダ> CALC_SNAPSHOT=<json> L2_SNAPSHOT=<json> npm run check:soukatsu-row-only
 *   npm run check:soukatsu-row-only -- --update        ★ 基準値方式。型ごとの件数だけ更新
 *
 * ★★ 当方の数字は 読んだ給与計算 (payroll_calc_results) の計算日時に基づく (出力の 2 行目・基準値の calc_at に出る)。
 *    基準値: 2026-09-23 の計算で 279/7 → 2026-09-27 に 138 件を再計算して 273/7
 *    (手入力しか無い 3 と 計算より後にマスタ登録 3 が 予想どおり 0 に。他の型は変わらず)。
 *    その後のコード修正 (例: 手入力しか無い時給者を拾う hourly-targets / 入社前の月を外す) は反映されていない。
 *    再計算したら 1 回 --update せずに回し、増減の中身を見てから取り直すこと。
 *
 * ── 数え方 (check:soukatsu-item-gap / -monthly の rowOnlyL1 / rowOnlyOurs と同じ定義) ──
 *   キー = 事業所番号|職員番号 (先頭 0 を落とす)|処理月。月給 = ① 提責_社員 ↔ 当方 monthly / パート = ① パート ↔ 当方 hourly
 *   ① だけ   ① の総支給 > 0 ・同じ事業所月は計算済み ・当方のその配列にその人月が無い
 *   当方だけ  当方の grand_total > 0 ・同じ事業所月の ① がある ・① のそのシートにその人月が無い
 *   月給は 働いた記録が無い月の固定給 (check:fixed-pay-no-work と同じ定義) を 先に除く (-monthly と同じ)
 *   ① の数値は "10,000" のようなカンマ付き文字列もある → num() で読む (給与D と同じ)
 *
 * ── 型 (上から順に 最初に当てはまったもの) ──
 *   ① だけ:
 *     シート違い        当方の もう一方の配列 (hourly ↔ monthly) に同じ人月がある = 給与形態の判定が ① と違うだけ。払い漏れではない
 *     職員マスタに無い   その事業所の payroll_employees に その職員番号が無い → 計算の対象に入りようがない
 *     退職で外した      職員マスタで 退職者 かつ 退職日 < 月初 (page.tsx の .or() で外れる)
 *     休職など          employment_status が 在職者/退職者/空 以外 (月給は page.tsx:1692 で外れる)
 *     計算より後にマスタ登録 その事業所の職員マスタの行が 計算日時より後に作られた (再計算で入る)
 *     入社前で外した     hire_date > 月末 (page.tsx の hiredAfterMonth。9/23 より後の修正なので 計算時点では外れていないはず → 出たら要確認)
 *     形態がマスタと逆    ① 提責_社員 なのに その月の形態が 時給 (月給の計算に入らない) / ① パート なのに 月給 (時給の計算に入らない)
 *     ここまでに当たらなかったものを 当時の入力 (実績・出勤簿・事業所書式・手入力。社保の印は除く) を 1 件ずつ引いて さらに分ける:
 *     ① はベースアップだけ パートで ① の総支給 = ベースアップ加算手当 かつ ② も払っていない (旧システムが 働いていない登録者にも 2 万円を印字する)
 *     手入力しか無い      計算前からあった入力が 手入力 (研修・出張km) だけ。9/23 より後の修正 (hourly-targets.ts) で拾う
 *     どれにも当てはまらない ★ 本命。1 件ずつ ② (支払用) の総支給と並べて出す
 *   当方だけ: シート違い / どれにも当てはまらない (② と並べて出す)
 *
 * ── 2026-09-27 の結果 (① だけ 279 / 当方だけ 7) ──
 *   退職で外した 236・休職 6 は ① の行が 1 件を除き 固定分だけ (本人給・職能給・勤続・ベースアップ)。② も払っていない (林 美咲 を除く)
 *   → 旧システムが 退職処理していない人に 固定分を印字し続けているだけ。★ 例外: 林 美咲 (休職者) は ② が 03〜05 月を払っている
 *     (employment_status は今の状態で 月ごとの履歴が無いため 休職前の月まで外れる)
 *   シート違い 5 は ② も当方と同じ側 (形態は ① だけが違う)
 *
 * ── 負のコントロール ──
 *   ① の 1 行を 当方から消す → ① だけ が 1 増え、型が付くこと。num("10,000") = 10000。
 *
 * ── 見ていないもの ──
 *   両方にあって額が違う人月 (check:soukatsu-item-gap / -monthly が見る) / ① に事業所月ごと無い月 / 当方が未計算の事業所月 /
 *   「どれにも当てはまらない」の原因 (出勤簿・実績・事業所書式のどれが無いか) は 件別に人が見る /
 *   ③ ミロク (実際の支給) との照合
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { restAll } from "./_rest.mjs";

const UPDATE = process.argv.includes("--update");
const BASELINE = new URL("./check-soukatsu-row-only-baseline.json", import.meta.url);
const MONTHS = (process.env.MONTHS || "202603,202604,202605,202606,202607,202608").split(",");
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");
const num = (v: unknown) => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?[\d,]+(\.\d+)?$/.test(v.trim())) return Number(v.replace(/,/g, ""));
  return 0;
};
const yen = (n: number) => `¥${Math.round(n).toLocaleString()}`;
const TOTAL = { shaseki: "総支給額（介社）", part: "総支給額（パート）" } as const;
type Kind = keyof typeof TOTAL;
const ARR: Record<Kind, "monthly" | "hourly"> = { shaseki: "monthly", part: "hourly" };

console.log("=== check:soukatsu-row-only (総括表 ① と 当方で 行ごと片側にしか居ない人月を 型に分ける) ===");

const L1_DIR = process.env.L1_DIR ?? "";
const CALC_SNAPSHOT = process.env.CALC_SNAPSHOT ?? "";
const L2_SNAPSHOT = process.env.L2_SNAPSHOT ?? "";
if (!L1_DIR || !existsSync(L1_DIR)) {
  console.error("★ L1_DIR (① の抽出フォルダ。migrations/extract_soukatsu_from_xlsm.mjs の出力) を指定してください");
  process.exit(1);
}

// ── ① ──
type L1Row = { office_number: string; employee_number: string | number; sheet_kind: Kind; source_file?: string; row_data: Record<string, unknown> };
const l1 = new Map<string, Record<string, unknown>>(); // kind|key
let l1Dup = 0; // ① の同じシートに 同じ人月が 2 行以上 (給与D の検査は行で数えるので その分 多く出る)
for (const f of readdirSync(L1_DIR).filter((x) => /_(\d{6})\.json$/.test(x))) {
  const m = /_(\d{6})\.json$/.exec(f)![1];
  if (!MONTHS.includes(m)) continue;
  for (const r of JSON.parse(readFileSync(`${L1_DIR}/${f}`, "utf8")) as L1Row[]) {
    const k = `${r.sheet_kind}|${r.office_number}|${nn(r.employee_number)}|${m}`;
    // ★ 2026-09-27 実測: 43 人月。全部 同じ中身の写し (過誤_おゆみ野 / コピー中央 / 市原ムツミの入浴ファイル) で 総支給は同じ額 → 1 人月に畳む
    if (l1.has(k)) { l1Dup++; if (num(l1.get(k)![TOTAL[r.sheet_kind]]) !== num(r.row_data[TOTAL[r.sheet_kind]])) console.log(`  ★ ① に同じ人月が複数行で 総支給が違う: ${k} (${r.source_file})`); }
    l1.set(k, r.row_data);
  }
}

// ── 当方 ──
type E = { employee_number: string; employee_name?: string; grand_total?: number; summary?: Record<string, unknown>; [k: string]: unknown };
type CalcRow = { office_number: string; processing_month: string; calculated_at: string; hourly: E[] | null; monthly: E[] | null };
let calc: CalcRow[];
if (CALC_SNAPSHOT && existsSync(CALC_SNAPSHOT)) calc = JSON.parse(readFileSync(CALC_SNAPSHOT, "utf8")) as CalcRow[];
else {
  calc = await restAll<CalcRow>("payroll_calc_results?select=id,office_number,processing_month,calculated_at,hourly:payload->hourly,monthly:payload->monthly");
  if (CALC_SNAPSHOT) writeFileSync(CALC_SNAPSHOT, JSON.stringify(calc));
}
calc = calc.filter((c) => MONTHS.includes(c.processing_month));
const calcAt = calc.map((c) => c.calculated_at).sort();
console.log(`★ 当方の数字は ${calcAt[0]} 〜 ${calcAt.at(-1)} (UTC) の給与計算に基づく`);
const ours = new Map<string, E[]>(); // kind|key
for (const c of calc) for (const kind of ["shaseki", "part"] as Kind[]) for (const e of c[ARR[kind]] ?? []) {
  const k = `${kind}|${c.office_number}|${nn(e.employee_number)}|${c.processing_month}`;
  ours.set(k, [...(ours.get(k) ?? []), e]);
}
const calcMonths = new Set(calc.map((c) => `${c.office_number}|${c.processing_month}`));
const calcAtOf = new Map(calc.map((c) => [`${c.office_number}|${c.processing_month}`, c.calculated_at]));

// ── ② ──
type L2Row = { office_number: string; employee_number: string; employee_name?: string; processing_month: string; sheet_kind: Kind; row_data: Record<string, unknown> };
let l2rows: L2Row[];
if (L2_SNAPSHOT && existsSync(L2_SNAPSHOT)) l2rows = JSON.parse(readFileSync(L2_SNAPSHOT, "utf8")) as L2Row[];
else {
  l2rows = await restAll<L2Row>("payroll_soukatsu_rows?select=id,office_number,employee_number,employee_name,processing_month,sheet_kind,row_data");
  if (L2_SNAPSHOT) writeFileSync(L2_SNAPSHOT, JSON.stringify(l2rows));
}
const l2 = new Map<string, L2Row>(); // key (シート問わず) → 行。同じ人月が両シートにあれば kind 付きでも引く
for (const r of l2rows) {
  l2.set(`${r.sheet_kind}|${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, r);
}
const l2Months = new Set(l2rows.map((r) => `${r.office_number}|${r.processing_month}`));
const l2Of = (key: string) => l2.get(`shaseki|${key}`) ?? l2.get(`part|${key}`) ?? null;
const l2Total = (r: L2Row | null) => (r ? num(r.row_data["総支給額"]) : null);

// ── 職員マスタ (その事業所の番号で引く。職員番号は事業所をまたぐと重複する) ──
type Emp = { id: string; employee_number: string; name: string; office_id: string; salary_type: string | null; employment_status: string | null; resignation_date: string | null; hire_date: string | null; created_at: string };
type Off = { id: string; office_number: string };
type Sal = { employee_id: string; effective_from: string | null; salary_type: string | null };
const offices = await restAll<Off>("payroll_offices?select=id,office_number");
const emps = await restAll<Emp>("payroll_employees?select=id,employee_number,name,office_id,salary_type,employment_status,resignation_date,hire_date,created_at");
const sals = await restAll<Sal>("payroll_salary_settings?select=id,employee_id,effective_from,salary_type");
const offNum = new Map(offices.map((o) => [o.id, o.office_number]));
const empByKey = new Map<string, Emp[]>();
for (const e of emps) {
  const k = `${offNum.get(e.office_id) ?? "?"}|${nn(e.employee_number)}`;
  empByKey.set(k, [...(empByKey.get(k) ?? []), e]);
}
const salByEmp = new Map<string, Sal[]>();
for (const s of sals) salByEmp.set(s.employee_id, [...(salByEmp.get(s.employee_id) ?? []), s]);
/** その月で有効な形態 (その月の末日までに始まった最後の給与設定の行 → 無ければ職員マスタ)。page.tsx は月初時点 (buildActiveSalaryMap) */
const salaryTypeAt = (e: Emp, monthStart: string) => {
  const rows = (salByEmp.get(e.id) ?? []).filter((s) => !s.effective_from || s.effective_from <= monthStart)
    .sort((a, b) => String(a.effective_from ?? "").localeCompare(String(b.effective_from ?? "")));
  return rows.at(-1)?.salary_type || e.salary_type || "";
};

// ── 働いた記録が無い月 (check:fixed-pay-no-work と同じ定義) ──
const TOP_KEYS = ["paid_leave_allowance_override", "travel_km", "travel_km_auto", "business_trip_fee", "absence_days", "care_minutes", "office_worker_care_pay"];
const WORK_KEYS = ["recordCount", "workDays", "helperDays", "workHoursMin", "visitMinutes", "paidLeave", "halfLeave", "specialLeave",
  "hrdCount", "hrdMinutes", "meetingCount", "commuteKmTotal", "businessKmTotal", "commuteYenTotal"];
const noWork = (p: E) => WORK_KEYS.every((k) => !Number(p.summary?.[k] ?? 0)) && TOP_KEYS.every((k) => !Number(p[k] ?? 0));

// ── 分類 ──
type Hit = { dir: "①だけ" | "当方だけ"; kind: Kind; key: string; name: string; type: string; mine: number; other: number | null; l2: number | null; l2Kind: string | null; note: string };
function classify(l1m: Map<string, Record<string, unknown>>, oursM: Map<string, E[]>): Hit[] {
  const hits: Hit[] = [];
  // ① に事業所月があるか は シートごとに見る (-monthly は 提責_社員 シートの事業所月だけを母数にしている)
  const l1Months = new Set([...l1m.keys()].map((k) => { const [kd, on, , m] = k.split("|"); return `${kd}|${on}|${m}`; }));
  // 月給の 働いた記録が無い月 は 突合から除く (-monthly と同じ)
  const skipOurs = new Set<string>();
  for (const [k, es] of oursM) if (k.startsWith("shaseki|") && es.every(noWork)) skipOurs.add(k);
  for (const [k, d] of l1m) {
    const [kind, on, en, m] = k.split("|") as [Kind, string, string, string];
    if (!calcMonths.has(`${on}|${m}`) || num(d[TOTAL[kind]]) <= 0) continue;
    if (oursM.has(k)) continue; // skipOurs に入った人月も ① 側は「当方にある」扱い (-monthly の seen と同じ)
    const key = `${on}|${en}|${m}`;
    const otherKind: Kind = kind === "shaseki" ? "part" : "shaseki";
    const other = oursM.get(`${otherKind}|${key}`);
    const r2 = l2Of(key);
    const base = { dir: "①だけ" as const, kind, key, name: String(d["氏名"] ?? d["職員名"] ?? r2?.employee_name ?? ""), mine: num(d[TOTAL[kind]]), l2: l2Total(r2), l2Kind: r2?.sheet_kind ?? null };
    if (other) { hits.push({ ...base, type: "シート違い", other: other.reduce((s, e) => s + Number(e.grand_total ?? 0), 0), note: `当方は ${ARR[otherKind]} で計算` }); continue; }
    const cands = empByKey.get(`${on}|${en}`) ?? [];
    if (cands.length === 0) { hits.push({ ...base, type: "職員マスタに無い", other: null, note: "" }); continue; }
    const e = cands[0];
    const at = calcAtOf.get(`${on}|${m}`) ?? "";
    if (cands.every((c) => c.created_at > at)) {
      hits.push({ ...base, name: base.name || e.name, type: "計算より後にマスタ登録", other: null, note: `職員マスタ作成 ${e.created_at.slice(0, 10)} (計算 ${at.slice(0, 10)})` }); continue;
    }
    const y = Number(m.slice(0, 4)), mo = Number(m.slice(4));
    const monthStart = `${y}-${String(mo).padStart(2, "0")}-01`;
    const monthEnd = `${y}-${String(mo).padStart(2, "0")}-${new Date(y, mo, 0).getDate()}`;
    const nm = { ...base, name: base.name || e.name };
    if (e.employment_status === "退職者" && (!e.resignation_date || e.resignation_date < monthStart)) {
      hits.push({ ...nm, type: "退職で外した", other: null, note: `退職日 ${e.resignation_date ?? "空"}` }); continue;
    }
    if (kind === "shaseki" && e.employment_status && !["在職者", "退職者"].includes(e.employment_status)) {
      hits.push({ ...nm, type: "休職など", other: null, note: `状態 ${e.employment_status}` }); continue;
    }
    if (e.hire_date && e.hire_date > monthEnd) { hits.push({ ...nm, type: "入社前で外した", other: null, note: `入社日 ${e.hire_date}` }); continue; }
    const st = salaryTypeAt(e, monthStart);
    if ((kind === "shaseki" && st === "時給") || (kind === "part" && st === "月給")) {
      hits.push({ ...nm, type: "形態がマスタと逆", other: null, note: `その月の形態 ${st}` }); continue;
    }
    hits.push({ ...nm, type: "どれにも当てはまらない", other: null, note: `形態 ${st || "空"} / 状態 ${e.employment_status ?? "空"}${cands.length > 1 ? ` / マスタに ${cands.length} 行` : ""}` });
  }
  for (const [k, es] of oursM) {
    if (skipOurs.has(k)) continue;
    const [kind, on, en, m] = k.split("|") as [Kind, string, string, string];
    const total = es.reduce((s, e) => s + Number(e.grand_total ?? 0), 0);
    if (!l1Months.has(`${kind}|${on}|${m}`) || total <= 0 || l1m.has(k)) continue;
    const key = `${on}|${en}|${m}`;
    const otherKind: Kind = kind === "shaseki" ? "part" : "shaseki";
    const od = l1m.get(`${otherKind}|${key}`);
    const r2 = l2Of(key);
    const base = { dir: "当方だけ" as const, kind, key, name: String(es[0].employee_name ?? ""), mine: total, l2: l2Total(r2), l2Kind: r2?.sheet_kind ?? null };
    if (od) hits.push({ ...base, type: "シート違い", other: num(od[TOTAL[otherKind]]), note: `① は ${otherKind === "part" ? "パート" : "提責_社員"} シート` });
    else hits.push({ ...base, type: "どれにも当てはまらない", other: null, note: "" });
  }
  return hits;
}

// ── 負のコントロール ──
{
  let fail = 0;
  if (num("10,000") !== 10000 || num("1:00") !== 0) { console.error("★ 負のコントロール失敗: num()"); fail++; }
  const base = classify(l1, ours);
  const victim = [...ours.keys()].find((k) => l1.has(k) && num(l1.get(k)![TOTAL[k.split("|")[0] as Kind]]) > 0 && !(k.startsWith("shaseki|") && ours.get(k)!.every(noWork)));
  if (!victim) { console.error("★ 負のコントロール失敗: 両方にある人月が見つからない"); fail++; }
  else {
    const broken = new Map(ours); broken.delete(victim);
    const after = classify(l1, broken);
    const n0 = base.filter((h) => h.dir === "①だけ").length, n1 = after.filter((h) => h.dir === "①だけ").length;
    const got = after.find((h) => h.dir === "①だけ" && `${h.kind}|${h.key}` === victim);
    console.log(`負のコントロール: 当方から 1 人月 (${victim}) を消す → ① だけ ${n0} → ${n1} (期待 +1) / 型 ${got?.type ?? "なし"}`);
    if (n1 !== n0 + 1 || !got) fail++;
  }
  if (fail) { console.error("★ 負のコントロールが鳴りません。検査が効いていません"); process.exit(1); }
}

const hits = classify(l1, ours);
console.log(`① に同じ人月が複数行: ${l1Dup} 人月 (1 人月に畳んだ。給与D の検査は行で数えるので その分 多く出る)`);
console.log(`給与計算 ${calc.length} 事業所月 (計算日時 ${calcAt[0]} 〜 ${calcAt.at(-1)}) / ① ${l1.size} 人月 / ② ${l2rows.length} 行 / 職員マスタ ${emps.length} 名`);

// ★ 本命の人月だけ 計算の入力が当時あったかを引く (件数が少ないので 1 件ずつ・直列。全件は読まない)
//   「計算より後に入った」なら 9/23 の計算では拾いようがない (再計算で入るはず)。「計算前からあった」のに当方に居ないなら 計算が落としている
/** social_insurance (社保の有無の印) は 働いた記録ではないので 数えない */
const NOT_WORK_KEYS = new Set(["social_insurance"]);
async function inputsOf(on: string, en: string, m: string): Promise<{ text: string; work: Set<string> }> {
  const y = Number(m.slice(0, 4)), mo = Number(m.slice(4));
  const q: [string, string][] = [
    ["実績", `payroll_service_records?select=id,employee_number,created_at&office_number=eq.${on}&processing_month=eq.${m}&employee_number=like.*${en}`],
    ["出勤簿", `payroll_attendance_records?select=id,employee_number,created_at&office_number=eq.${on}&year=eq.${y}&month=eq.${mo}&employee_number=like.*${en}`],
    ["事業所書式", `payroll_office_form_records?select=id,employee_number,created_at&office_number=eq.${on}&processing_month=eq.${m}&employee_number=like.*${en}`],
    ["手入力", `payroll_monthly_inputs?select=id,employee_number,item_key,updated_at&office_number=eq.${on}&processing_month=eq.${m}&employee_number=like.*${en}`],
  ];
  const at = calcAtOf.get(`${on}|${m}`) ?? "";
  const parts: string[] = [];
  const work = new Set<string>();
  for (const [label, url] of q) {
    const rows = (await restAll<{ employee_number: string; item_key?: string; created_at?: string; updated_at?: string }>(url))
      .filter((r) => nn(r.employee_number) === en && !NOT_WORK_KEYS.has(r.item_key ?? ""));
    if (!rows.length) continue;
    const after = rows.filter((r) => String(r.created_at ?? r.updated_at ?? "") > at).length;
    parts.push(`${label} ${rows.length}${label === "手入力" ? ` [${[...new Set(rows.map((r) => r.item_key))].join(",")}]` : ""}${after ? ` (うち計算より後 ${after})` : ""}`);
    if (rows.length > after) work.add(label);
  }
  return { text: parts.length ? `入力: ${parts.join(" / ")}` : "入力: 無し (社保の印を除く)", work };
}
// 本命候補を 入力で さらに分ける
//   ① はベースアップだけ   パートで ① の総支給 = ベースアップ加算手当 (旧システムが働いていない登録者にも 2 万円を出す) かつ ② も払っていない
//   手入力しか無い          計算前からあった入力が 手入力 (研修・出張km 等) だけ。9/23 より後の修正 (hourly-targets.ts / check:manual-input-dropped) で拾う
for (const h of hits.filter((x) => x.type === "どれにも当てはまらない" && x.dir === "①だけ")) {
  const [on, en, m] = h.key.split("|");
  const r = await inputsOf(on, en, m);
  h.note += ` / ${r.text}`;
  const d = l1.get(`${h.kind}|${h.key}`)!;
  // ★ 入力があっても (有給日数の手入力だけ 等) ① が ベースアップだけ・② も 0 なら こちら。
  //   ⚠ 再計算すると 当方は hourly-targets の修正で 有給 (paid_leave_days) を拾って払う → ② (0 円) と食い違う側に移る。そのとき中身を見ること
  if (h.kind === "part" && Math.abs(h.mine - num(d["ベースアップ加算手当"])) < 1 && !(h.l2 && h.l2 > 0)) h.type = "① はベースアップだけ";
  else if (r.work.size === 1 && r.work.has("手入力")) h.type = "手入力しか無い";
}

const counts: Record<string, number> = {};
for (const h of hits) { const c = `${h.dir}|${h.kind === "shaseki" ? "月給" : "パート"}|${h.type}`; counts[c] = (counts[c] ?? 0) + 1; }
console.log("\n--- 型ごとの件数 (人月) と 金額 ---");
for (const dir of ["①だけ", "当方だけ"]) for (const kind of ["shaseki", "part"] as Kind[]) {
  const hs = hits.filter((h) => h.dir === dir && h.kind === kind);
  console.log(`${dir} ${kind === "shaseki" ? "月給 (提責_社員)" : "パート"}: ${hs.length} 人月`);
  const byType = new Map<string, Hit[]>();
  for (const h of hs) byType.set(h.type, [...(byType.get(h.type) ?? []), h]);
  for (const [t, list] of byType) {
    const l2eq0 = list.filter((h) => h.l2 === 0).length;
    const l2noMonth = list.filter((h) => h.l2 === null && !l2Months.has(h.key.split("|")[0] + "|" + h.key.split("|")[2])).length;
    const l2none = list.filter((h) => h.l2 === null).length - l2noMonth;
    const l2pay = list.length - l2eq0 - l2none - l2noMonth;
    console.log(`  ${t.padEnd(12, "　")} ${String(list.length).padStart(4)} 人月  ${dir === "①だけ" ? "①" : "当方"} ${yen(list.reduce((s, h) => s + h.mine, 0))}`
      + `  (② が払っている ${l2pay} / ② が 0 ${l2eq0} / ② にその人の行なし ${l2none} / ② に事業所月ごと無い ${l2noMonth})`);
  }
}

// シート違いの 金額が同じか (形態の判定だけの違いなら 総支給は近いはず)
const sheet = hits.filter((h) => h.type === "シート違い");
if (sheet.length) {
  const same = sheet.filter((h) => h.other !== null && Math.abs(h.other - h.mine) <= 1).length;
  console.log(`\n参考: シート違い ${sheet.length} 人月のうち 総支給が 1 円以内で一致 ${same}`);
}

/** ① の行に 働いた量で決まる項目があるか (無ければ 旧システムが固定分だけを印字した行) */
const L1_WORK_COLS: Record<Kind, string[]> = {
  shaseki: ["出張費", "通勤費", "介護超過", "夜朝", "深夜_3", "特日", "残業手当総額"],
  part: ["集計項目小計", "土日祝", "移動手当", "その他手当計", "通勤費", "出張費", "残業手当総額_パート", "初任者研修費"],
};
const l1HasWork = (h: Hit) => { const d = l1.get(`${h.kind}|${h.key}`); return !!d && L1_WORK_COLS[h.kind].some((c) => num(d[c]) !== 0); };
{
  const rt = hits.filter((x) => x.type === "退職で外した" || x.type === "休職など");
  const w = rt.filter(l1HasWork);
  console.log(`\n参考: 退職で外した / 休職など ${rt.length} 人月のうち ① に働いた量で決まる項目がある ${w.length} 人月 (残りは ① が固定分だけを印字した行)`);
  for (const h of w) console.log(`  ★ ${h.type} ${h.key} ${h.name} ① ${yen(h.mine)} / ② ${h.l2 === null ? "行なし" : yen(h.l2)} ${h.note}`);
}

console.log("\n--- 退職で外した / 休職など の人ごと (★ ② が払っているものは 職員マスタの退職・休職の記録が誤っている疑い) ---");
{
  const g = new Map<string, Hit[]>();
  for (const h of hits.filter((x) => x.type === "退職で外した" || x.type === "休職など")) {
    const [on, en] = h.key.split("|");
    const k = `${h.type}|${h.kind}|${on}|${en}`;
    g.set(k, [...(g.get(k) ?? []), h]);
  }
  for (const [k, list] of [...g].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [t, kind, on, en] = k.split("|");
    const paid = list.filter((h) => (h.l2 ?? 0) > 0);
    console.log(`  ${t} ${kind === "shaseki" ? "月給" : "パート"} ${on}|${en} ${list[0].name} ${list[0].note} / ① ${list.map((h) => h.key.split("|")[2].slice(4)).join(",")}月 ${yen(list.reduce((s, h) => s + h.mine, 0))}`
      + (paid.length ? ` / ★ ② が払っている ${paid.length} か月 ${yen(paid.reduce((s, h) => s + (h.l2 ?? 0), 0))}` : ""));
  }
}

console.log("\n--- 1 件ずつ (★ 型の付いていない行が本命。[ ] は型。② は支払用の総支給額) ---");
// 件数の多い 3 型 (退職 / 休職 / ベースアップだけ) は上で人ごとに出したので除く。残りは件数が少ないので 1 件ずつ出す
const BULK = new Set(["退職で外した", "休職など", "① はベースアップだけ"]);
const rest = hits.filter((h) => !BULK.has(h.type))
  .sort((a, b) => a.dir.localeCompare(b.dir) || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
for (const h of rest) {
  const side = h.l2 === null ? "② 行なし" : h.l2 === 0 ? "② 0円" : Math.abs(h.l2 - h.mine) <= 1 ? `② ${yen(h.l2)} = ${h.dir === "①だけ" ? "①" : "当方"}` : `② ${yen(h.l2)}`;
  console.log(`  ${h.dir} ${h.kind === "shaseki" ? "月給" : "パート"} ${h.key} ${h.name} ${h.dir === "①だけ" ? "①" : "当方"} ${yen(h.mine)} / ${side}${h.l2Kind && h.l2Kind !== h.kind ? ` (② は ${h.l2Kind})` : ""} ${h.type !== "どれにも当てはまらない" ? `[${h.type}] ` : ""}${h.note}`);
}

// ── 基準値 ──
const total = { "①だけ": hits.filter((h) => h.dir === "①だけ").length, "当方だけ": hits.filter((h) => h.dir === "当方だけ").length };
console.log(`\n合計: ① だけ ${total["①だけ"]} 人月 / 当方だけ ${total["当方だけ"]} 人月`);
const cur = { calc_at: `${calcAt[0]} 〜 ${calcAt.at(-1)}`, counts, total };
if (UPDATE || !existsSync(BASELINE)) {
  writeFileSync(BASELINE, JSON.stringify({
    _readme: "型ごとの人月数。★ 増えたら FAIL。「どれにも当てはまらない」は 本命 (払い漏れ候補) なので 増えたら中身を見ること。"
      + " ★ 当方の数字は calc_at の計算に基づく。再計算したら --update せずに 1 回回して差を見る。"
      + " 経緯: 2026-09-23 の計算で ① だけ 279 / 当方だけ 7 → 2026-09-27 の再計算で 273 / 7 (手入力しか無い 3・計算より後にマスタ登録 3 が 0 に)。"
      + " ★ 悪化したまま --update しない (穴を焼き付ける)",
    ...cur,
  }, null, 2) + "\n");
  console.log(`基準値を${UPDATE ? "更新" : "作成"}しました`);
} else {
  const b = JSON.parse(readFileSync(BASELINE, "utf8")) as typeof cur;
  let fail = 0;
  for (const k of new Set([...Object.keys(b.counts), ...Object.keys(counts)])) {
    const was = b.counts[k] ?? 0, now = counts[k] ?? 0;
    if (now > was) { console.log(`  ★ FAIL ${k}: ${was} → ${now}`); fail++; }
    else if (now < was) console.log(`  o ${k}: ${was} → ${now} (減った。中身を見てから --update)`);
  }
  console.log(fail ? `★ 基準値より悪化 ${fail} 型` : "o 基準値から悪化なし");
  if (fail) process.exitCode = 1;
}
console.log("\n見ていないもの: 両方にあって額が違う人月 (check:soukatsu-item-gap / -monthly) / ① に事業所月ごと無い月 / 当方が未計算の事業所月 /"
  + " 「どれにも当てはまらない」の原因 (出勤簿・実績・事業所書式のどれが無いか) / ③ ミロクとの照合");
console.log("★ check:all には入れていない (① の抽出物 L1_DIR が要るため)");
