/**
 * check:form-empty-values — 事業所書式 (payroll_office_form_records) の「行はあるが値が空」を 項目ごとに数える
 * (2026-09-27 給与C 新設・読み取り専用)。
 *
 *   npm run check:form-empty-values
 *   FORM_SNAPSHOT=<path.json> npm run check:form-empty-values   # DB を読まず 保存済みの行を使う
 *   ... -- --detail=<record_type|item_name>   /   -- --update   (★ 悪化したまま更新しない)
 *
 * 【なぜ】
 * 2026-09-27 朝の restore_form_meeting_counts.mts が ①由来の 会議1件数=1 の 14 行 (さつき 202606) を消し、
 * 書式 CSV の空白 = 値が null の行を入れた。★ 行はあるので「書式に行が無い」を探す検査には掛からず、
 * 会議費 ¥21,000 が黙って 0 になった。★ 行があっても 値が空なら 無いのと同じ、を数える。
 *
 * 【値がどの列か】record_type で違う。★ numeric_value だけ見ると 有給・研修 の全行が「空」に見える (偽陽性)
 *   km        numeric_value           (会議N件数・出張km・通勤km …)
 *   leave     item_date               (有給・半有給 … の日付)
 *   childcare amount                  (保育料)
 *   training  start_time と end_time  (研修・HRD研修・会議(時間)・初任者研修)
 *
 * 【数えるもの (項目ごと)】
 *   行数 (分母) / 空の行 / うち 同じ人月に同じ項目で値のある行も無い (= その人月の値が本当に無い)
 *   / ★ うち 復元 script の控え (migrations/_restored_*.json の inserted_ids) に載っている行 = 復元で入った空の行
 *
 * 【基準値】項目ごとの 空の行 と 復元で入った空の行 が増えたら FAIL。★ 0 件を目指す検査ではない
 *   (書式 CSV の空白セルは 通常の取込でも行になる。通勤km の空 3,331 行はそれ)。
 *   ★ ただし「復元で入った空の行」は 0 になるべきもの。
 *
 * 【★ 不変条件 (常に 0)】会議N件数 が null の行がある人月で ①② のどちらも会議費を払っていないもの。
 *   computeMeetingFee は null を 1 件と数える (numeric_value ?? 1) ので、ここに入ると 会議をしていない人に 1,500 円払う (過払いの向き)。
 *   ★ ?? 1 自体は変えない (① との一致率に効くため・2026-09-27 指示役)。現に過大になっていないかを見張る。SOUKATSU1_DIR 必須
 *
 * ── この検査が見ていないもの ─────────────────────────────────────────────
 *   ・空の行が お金に効くか (当方は 出張km を 手入力 > 書式 > 出勤簿 の順で取るので 書式が空でも払っていることがある)。
 *     ★ 参考として ① (旧システム出力) がその項目を払っている人月を出すが 合否には使わない
 *   ・値が入っているが間違っている行 (件数欄に円 等は check:meeting-3way)
 *   ・書式に行そのものが無い人月 (check:office-form-shrink / check:meeting-3way の D)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { restAll } from "./_rest.mjs";
import { num } from "./_soukatsu-items.mjs";
import { l2Meeting } from "./check-meeting-3way.mjs";

const UPDATE = process.argv.includes("--update");
const DETAIL = process.argv.find((a) => a.startsWith("--detail="))?.split("=")[1];
const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(HERE, "check-form-empty-values-baseline.json");

export type FormRow = {
  id: string; office_number: string; employee_number: string; processing_month: string; record_type: string; item_name: string;
  item_date: string | null; numeric_value: number | null; amount: number | null; start_time: string | null; end_time: string | null; import_batch_id: string | null;
};
export type Stat = { rows: number; empty: number; emptyNoSibling: number; restoredEmpty: number };

export function isEmpty(r: FormRow): boolean {
  if (r.record_type === "km") return r.numeric_value == null;
  if (r.record_type === "leave") return !r.item_date;
  if (r.record_type === "childcare") return r.amount == null;
  if (r.record_type === "training") return !(r.start_time && r.end_time);
  return r.numeric_value == null && r.amount == null && !r.item_date && !r.start_time;
}

const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");
const pm = (r: FormRow) => `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}|${r.item_name}`;

export function tally(rows: FormRow[], restored: Set<string>): Record<string, Stat> {
  const valued = new Set(rows.filter((r) => !isEmpty(r)).map(pm));
  const out: Record<string, Stat> = {};
  for (const r of rows) {
    const s = (out[`${r.record_type}|${r.item_name}`] ??= { rows: 0, empty: 0, emptyNoSibling: 0, restoredEmpty: 0 });
    s.rows++;
    if (!isEmpty(r)) continue;
    s.empty++;
    if (!valued.has(pm(r))) s.emptyNoSibling++;
    if (restored.has(r.id)) s.restoredEmpty++;
  }
  return out;
}

/**
 * ★ 不変条件 (0 であること): 会議N件数 が null の行がある人月のうち ① も ② も会議費を払っていないもの。
 * computeMeetingFee は null を 1 件と数える (numeric_value ?? 1) ので、ここに入る人月は
 * ★ 会議をしていない人に 1,500 円を払っている = 過払いの向き。現在 0 (さつき 202606 の 14 は ①② とも払っている)。
 * ② の会議ぶんは check:meeting-3way と同じ l2Meeting (② は列名で会議費が取れないため) を呼ぶ。
 */
export function nullMeetingUnpaid(rows: FormRow[], l1: Map<string, Record<string, unknown>>, l2: Map<string, Record<string, unknown>>): string[] {
  const keys = new Set(rows.filter((r) => r.record_type === "km" && /^会議[123]件数$/.test(r.item_name) && r.numeric_value == null)
    .map((r) => `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`));
  return [...keys].filter((k) => {
    const d1 = l1.get(k), d2 = l2.get(k);
    return !(num(d1?.["会議費"]) > 0) && !((d2 ? l2Meeting(d2, d1) : 0) > 0);
  });
}

function negativeControl(rows: FormRow[], restored: Set<string>, base: Record<string, Stat>) {
  const lines: string[] = [];
  let ok = true;
  const pick = (f: (r: FormRow) => boolean) => rows.find(f);
  const check = (label: string, rs: FormRow[], rest: Set<string>, item: string, field: keyof Stat, delta: number) => {
    const got = (tally(rs, rest)[item]?.[field] ?? 0) - (base[item]?.[field] ?? 0);
    const p = got === delta;
    if (!p) ok = false;
    lines.push(`${label} → ${item} ${field} ${delta >= 0 ? "+" : ""}${got}${p ? "  OK" : `  ★ NG (期待 ${delta})`}`);
  };
  const km = pick((r) => r.record_type === "km" && r.item_name === "会議1件数" && !isEmpty(r));
  const lv = pick((r) => r.record_type === "leave" && !isEmpty(r));
  const tr = pick((r) => r.record_type === "training" && !isEmpty(r));
  if (!km || !lv || !tr) return { ok: false, lines: ["値のある 会議1件数 / 休暇 / 研修 の行が無く 作れない  ★ NG"] };
  const set = (t: FormRow, patch: Partial<FormRow>) => rows.map((r) => (r === t ? { ...r, ...patch } : r));
  check("会議1件数 の値を null にする", set(km, { numeric_value: null }), restored, "km|会議1件数", "empty", 1);
  check("その行を 復元の控えに載せる", set(km, { numeric_value: null }), new Set([...restored, km.id]), "km|会議1件数", "restoredEmpty", 1);
  check(`${lv.item_name} の日付を空にする (★ numeric_value ではなく item_date を見ているか)`, set(lv, { item_date: null }), restored, `leave|${lv.item_name}`, "empty", 1);
  check(`${tr.item_name} の終了時刻を空にする`, set(tr, { end_time: null }), restored, `training|${tr.item_name}`, "empty", 1);
  check("値のある行を足す (空は増えない)", [...rows, { ...km, id: "neg" }], restored, "km|会議1件数", "empty", 0);
  return { ok, lines };
}

async function main() {
  console.log("=== check:form-empty-values (書式の 行はあるが値が空) 2026-09-27 新設・読み取り専用 ===");
  console.log("★ check:all には入れていない (意図的)。空の行がお金に効くかは この検査だけでは決まらない診断系");
  console.log("★ この検査が見ていないもの: お金への影響 (①は参考表示のみ) / 値の誤り / 行そのものが無い人月");
  const snapPath = process.env.FORM_SNAPSHOT;
  const rows: FormRow[] = snapPath && existsSync(snapPath)
    ? JSON.parse(readFileSync(snapPath, "utf8"))
    : await restAll<FormRow>("payroll_office_form_records?select=id,office_number,employee_number,processing_month,record_type,item_name,item_date,numeric_value,amount,start_time,end_time,import_batch_id");
  if (!rows.length) { console.log("★ 書式の行が 0 件。条件・列名を疑う (0 件と出さない)"); process.exit(1); }
  const migDir = join(HERE, "..", "migrations");
  const restoreFiles = readdirSync(migDir).filter((f) => /^_restored_.*\.json$/.test(f));
  const restored = new Set<string>();
  for (const f of restoreFiles) for (const id of (JSON.parse(readFileSync(join(migDir, f), "utf8")).inserted_ids ?? []) as string[]) restored.add(id);
  const stats = tally(rows, restored);
  // ★ 控えが無いと「復元で入った空」が黙って 0 になり 改善に見える。基準値に復元の空があるのに控えが無ければ止める
  if (!restored.size && existsSync(BASELINE_PATH)) {
    const was = Object.values(JSON.parse(readFileSync(BASELINE_PATH, "utf8")).counts as Record<string, { restoredEmpty?: number }>).reduce((s, c) => s + (c.restoredEmpty ?? 0), 0);
    if (was > 0) { console.log(`★ 復元の控え (migrations/_restored_*.json) が 1 本も無い。基準値の 復元で入った空 ${was} を確かめられない (0 と出さない)`); process.exit(1); }
  }

  const neg = negativeControl(rows, restored, stats);
  let negOk = true;
  console.log("\n負のコントロール (読み込んだ写しを壊す。DB もファイルも触らない):");
  for (const l of neg.lines) console.log("  " + l);

  console.log(`\n母数: 書式の行 ${rows.length} / 復元の控え ${restoreFiles.join(", ") || "(無し)"} の inserted_ids ${restored.size}`);
  console.log("  項目                     行数   空   空で同じ人月に値も無い   ★復元で入った空");
  for (const [k, s] of Object.entries(stats).sort()) {
    console.log(`  ${k.padEnd(22)} ${String(s.rows).padStart(5)} ${String(s.empty).padStart(5)} ${String(s.emptyNoSibling).padStart(8)} ${String(s.restoredEmpty).padStart(14)}${s.restoredEmpty ? "  ★" : ""}`);
  }

  // ① (必須: 過払いの不変条件に使う) と ② (パート)
  const dir = process.env.SOUKATSU1_DIR;
  if (!dir || !existsSync(dir)) { console.log("★ SOUKATSU1_DIR=<① の抽出物のある dir> が要る (会議件数 null の過払いの不変条件に使う。無しで PASS を出さない)"); process.exit(1); }
  const l1 = new Map<string, Record<string, unknown>>();      // パートだけ (会議費はパートのシートにしか無い)
  const l1All = new Map<string, Record<string, unknown>>();   // 全シート (参考の出張・通勤は月給者が大半)
  for (const f of readdirSync(dir).filter((f) => /^soukatsu_extract_\d{6}\.json$/.test(f))) {
    const ym = /_(\d{6})\.json$/.exec(f)![1];
    for (const r of JSON.parse(readFileSync(join(dir, f), "utf8")) as { office_number: string; employee_number: string; sheet_kind: string; row_data: Record<string, unknown> }[]) {
      const k = `${r.office_number}|${nn(r.employee_number)}|${ym}`;
      if (!l1All.has(k)) l1All.set(k, r.row_data);
      if (r.sheet_kind === "part" && !l1.has(k)) l1.set(k, r.row_data);
    }
  }
  if (!l1.size) { console.log(`★ ${dir} に ① のパートの行が 0 件 (0 件と出さない)`); process.exit(1); }
  const snap2 = process.env.SNAPSHOT;
  type R2 = { office_number: string; employee_number: string; processing_month: string; sheet_kind: string; row_data: Record<string, unknown> };
  const l2rows: R2[] = snap2 && existsSync(snap2) ? JSON.parse(readFileSync(snap2, "utf8")).soukatsu
    : await restAll<R2>("payroll_soukatsu_rows?select=id,office_number,employee_number,processing_month,sheet_kind,row_data&sheet_kind=eq.part");
  const l2 = new Map<string, Record<string, unknown>>();
  for (const r of l2rows) if (r.sheet_kind === "part") l2.set(`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, r.row_data);

  const over = nullMeetingUnpaid(rows, l1, l2);
  const nullPm = new Set(rows.filter((r) => r.record_type === "km" && /^会議[123]件数$/.test(r.item_name) && r.numeric_value == null).map((r) => `${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`)).size;
  console.log(`\n★ 不変条件 (0 であること): 会議N件数 が null の行がある人月 ${nullPm} のうち ①② のどちらも会議費を払っていない ${over.length}`);
  console.log("  (当方は null を 1 件と数えて 1,500 円払う。ここに入る人月は 会議をしていない人への過払い)");
  for (const k of over) console.log(`  ★ ${k}`);
  {
    // 負のコントロール: 値のある会議1件数の行を null にし、その人月の ①② の会議費を 0 にすると +1
    const t = rows.find((r) => r.record_type === "km" && r.item_name === "会議1件数" && r.numeric_value != null);
    const tk = t ? `${t.office_number}|${nn(t.employee_number)}|${t.processing_month}` : "";
    const z = (m: Map<string, Record<string, unknown>>) => new Map([...m].map(([k, d]) => [k, k === tk ? { ...d, 会議費: 0, 研修: 0 } : d]));
    const got = t ? nullMeetingUnpaid(rows.map((r) => (r === t ? { ...r, numeric_value: null } : r)), z(l1), z(l2)).length - over.length : -1;
    const got2 = t ? nullMeetingUnpaid(rows.map((r) => (r === t ? { ...r, numeric_value: null } : r)), l1, l2).length - over.length : -1;
    const p = got === 1 && got2 === 0;
    if (!p) negOk = false;
    console.log(`  負のコントロール: 1 行を null にして ①② を 0 に → +${got} (期待 +1) / null にするだけ (①② は払う) → +${got2} (期待 +0)${p ? "  OK" : "  ★ NG"}`);
  }

  // 参考: ① がその項目を払っている人月 (合否に使わない)
  {
    const col: Record<string, string> = { "km|出張km": "出張費", "km|通勤km": "通勤費", "training|HRD研修": "HRD研修費", "training|研修": "研修費", "childcare|保育料": "育児手当", "km|会議1件数": "会議費" };
    const valued = new Set(rows.filter((r) => !isEmpty(r)).map(pm));
    console.log("\n(参考・合否に使わない) 空で同じ人月に値も無い行のうち ① がその項目を払っている人月:");
    for (const [item, c] of Object.entries(col)) {
      const hits = rows.filter((r) => `${r.record_type}|${r.item_name}` === item && isEmpty(r) && !valued.has(pm(r)))
        .map((r) => ({ r, v: num(l1All.get(`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`)?.[c]) })).filter((x) => x.v > 0);
      console.log(`  ${item.padEnd(20)} ${String(hits.length).padStart(4)} 人月  ① ${c} 計 ¥${hits.reduce((s, x) => s + x.v, 0).toLocaleString()}`);
    }
    console.log("  ★ 当方が払っていないとは限らない (出張は 手入力 > 書式 > 出勤簿 の順で取る)。お金に効くかは 計算結果で確かめる");
  }

  if (DETAIL) {
    console.log(`\n--- ${DETAIL} の空の行 ---`);
    for (const r of rows.filter((r) => `${r.record_type}|${r.item_name}` === DETAIL && isEmpty(r)).slice(0, 200))
      console.log(`  ${r.processing_month} ${r.office_number} ${r.employee_number}${restored.has(r.id) ? "  ★復元" : ""}`);
  }

  let failed = over.length > 0;   // ★ 会議件数 null の過払いは 基準値ではなく常に 0 で判定
  if (failed) console.log("\n★ FAIL: 会議N件数 が null で ①② のどちらも払っていない人月がある (当方は 1,500 円払っている = 過払い)");
  const counts = Object.fromEntries(Object.entries(stats).map(([k, s]) => [k, { empty: s.empty, restoredEmpty: s.restoredEmpty }]));
  if (existsSync(BASELINE_PATH) && !UPDATE) {
    const b = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    console.log("\n--- 基準値との比較 ---");
    const worse: string[] = [], better: string[] = [];
    for (const k of new Set([...Object.keys(b.counts), ...Object.keys(counts)])) for (const f of ["empty", "restoredEmpty"] as const) {
      const was = b.counts[k]?.[f] ?? 0, now = counts[k]?.[f] ?? 0;
      if (now > was) worse.push(`${k} ${f} ${was}→${now}`); else if (now < was) better.push(`${k} ${f} ${was}→${now}`);
    }
    console.log(`  ★ 悪化 ${worse.length} / 改善 ${better.length}`);
    for (const w of worse) console.log(`  ★ 悪化 ${w}`);
    for (const w of better) console.log(`  改善   ${w}`);
    failed = worse.length > 0;
  } else if (!UPDATE) console.log("\n基準値ファイルがありません。--update で作成してください");
  if (UPDATE) {
    const prev = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
    writeFileSync(BASELINE_PATH, JSON.stringify({ _readme: prev._readme ?? "(新規)", updated_at: new Date().toISOString(), rows: rows.length, counts }, null, 2) + "\n");
    console.log(`\n基準値を更新しました: ${BASELINE_PATH}`);
  }
  if (!neg.ok || !negOk) { console.log("★ 負のコントロールが通らないので PASS を出しません"); process.exit(1); }
  if (failed) { console.log("★ FAIL: 空の行が増えました。--detail=<record_type|item_name> で見てください"); process.exit(1); }
  console.log("PASS (★ 0 件 PASS ではない。基準値の件数を許容したうえでの PASS)");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e); process.exit(1); });
