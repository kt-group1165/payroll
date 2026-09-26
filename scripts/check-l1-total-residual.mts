/**
 * 総括表 ① の「総支給額 ≠ 項目の合計」(説明のつかない残差) を 型に分ける (2026-09-27 給与C)。★ 基準値方式。
 *
 *   SOUKATSU1_DIR=<① 抽出物のdir> npm run check:l1-total-residual
 *   SOUKATSU1_DIR=<dir> npm run check:l1-total-residual -- --update
 *   SOUKATSU1_DIR=<dir> npm run check:l1-total-residual -- --detail=深夜の二重
 *   SNAPSHOT=<path.json>   ② を DB から読まず 保存済みの取得結果を使う (check:soukatsu-cause と同じ形式・soukatsu キー)
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 * 給与D の check:soukatsu-item-gap(-monthly) は ① の総支給を 項目の和の式で再現している:
 *   月給 1,502 / 1,578 一致 (残差 76) / パート 3,011 / 3,143 一致 (残差 15。会議費の 575 円刻みを除いた数)。
 * 残差は「① の中で辻褄が合わない」もので 当方の誤りではないが、① の **項目の値** を突合の正に使う範囲を決めるのに要る。
 * ★ 本命は「総支給にあるのに 項目 (列) が無い」= 当方に実装が要る候補。
 *
 * ── 型 (上から順に判定。1 人月は 1 つの型) ─────────────────────────────────
 *   数値でない     式の項目か総支給に 数値として読めない値がある (#VALUE! 等。カンマ付きは読めるので含めない)
 *   総支給0        総支給が 0 なのに 項目の和が 0 でない (① の行が壊れている)
 *   桁違い         残差の絶対値が 100,000 円以上 (例: 1271502518|210934|202604 +1,256,547)
 *   深夜の二重     残差 = 深夜訪介の時間 × 500 (深夜_3 と同額)。★ ① の総支給に 深夜手当が 2 回入っている
 *   深夜の上乗せ   残差 = 深夜訪介の時間 × 500 だが 深夜_3 とは額が違う (深夜_3 が空など)
 *   夜朝の上乗せ   残差 = 夜朝訪介の時間 × 200。総支給に 夜朝が 列とは別に入っている
 *   入れない:<列>  残差 = −(式の項目 1 つ)。① がその項目を表示するのに 総支給に入れていない (例: 介護超過 / 通信手当 / 育児手当)
 *   列あり:<列>    残差 = +(式に無い金額の列 1 つ)。総支給に入っているのに 式に無い列 (★ 式の見落とし候補)
 *   欠勤の月       欠勤控除 / 欠勤取得日数 がある月。① の総支給は 欠勤控除の列とは違う額を引いている
 *   遅刻早退の月   遅刻早退の列に値がある月
 *   列なし+        残差 > 0 で 対応する列が 1 つも見つからない = ★ 総支給にあるのに項目が無い (本命)
 *   列なし−        残差 < 0 で 対応する列が 1 つも見つからない
 *
 * ── ★ 何と何を比べているか ───────────────────────────────────────────────
 *   ① の中だけ (総支給 vs 項目の和)。当方は比べない。
 *   ② (支払用 payroll_soukatsu_rows) は 参考として「② の総支給は ① の総支給側か 式側か」を型ごとに出す。
 *   数値の読み方は 給与D の num() と同じ (カンマ付き文字列を数値に直す。それ以外の文字列は 0)。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { restAll } from "./_rest.mjs";
import { classifyCell } from "./check-nonnumeric-cells.mjs";

const UPDATE = process.argv.includes("--update");
const DETAIL = process.argv.find((a) => a.startsWith("--detail="))?.split("=")[1];
const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), "check-l1-total-residual-baseline.json");

/** 給与D の check:soukatsu-item-gap(-monthly) と同じ読み方 */
export const num = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?[\d,]+(\.\d+)?$/.test(v.trim())) return Number(v.replace(/,/g, ""));
  return 0;
};
/** "7:30" / "7:30:00" / Excel の日数 (数値) を 時間に */
const hours = (v: unknown): number => {
  if (typeof v === "number") return v * 24;
  const m = /^(-?\d+):(\d+)/.exec(String(v ?? ""));
  return m ? Number(m[1]) + Number(m[2]) / 60 : 0;
};

/** 給与D の式 (check:soukatsu-item-gap / -monthly の L1_TOTAL_TERMS と同じ) */
export const TERMS: Record<"part" | "shaseki", string[]> = {
  part: ["集計項目小計（土日祝含む）", "勤続手当（パート）", "処遇改善", "移動手当", "育児手当", "その他手当計", "通信手当", "残業手当総額_パート", "通勤費", "出張費", "ベースアップ加算手当"],
  shaseki: ["本人給", "職能給", "役職手当", "資格手当", "勤続手当", "固定残業手当", "処遇改善", "特定処遇改善", "ベースアップ加算手当", "出張費", "通勤費", "育児手当", "介護超過", "夜朝", "深夜_3"],
};
export const TOTAL: Record<"part" | "shaseki", string> = { part: "総支給額（パート）", shaseki: "総支給額（介社）" };
/** 金額でない列 (日数・時間・距離・件数・単価・コード) と 総支給系 は「列あり」の候補にしない */
const NOT_MONEY = /日数|件数|距離|時間|_時$|回数|単価|コード|№|氏名|総支給|税法上|差引|控除計|再集計|合計$|出勤|訪介|介護$|重度|夜朝介護|深夜介護|深夜所定|残業\(|残業$|%/;

export type L1Row = { office_number: string; employee_number: string; employee_name?: string; processing_month?: string; sheet_kind: string; row_data: Record<string, unknown> };
const w1 = (x: number) => Math.abs(x) < 1.5;

/** 1 行の残差と型。残差が無ければ null (パートの 会議費 575 円刻みも 給与D と同じく残差に数えない) */
export function classifyRow(r: L1Row): { diff: number; type: string } | null {
  const k = r.sheet_kind === "part" ? "part" : "shaseki";
  const d = r.row_data;
  const sum = TERMS[k].reduce((s, t) => s + num(d[t]), 0);
  const total = num(d[TOTAL[k]]);
  const diff = total - sum;
  if (w1(diff)) return null;
  if (k === "part" && Math.round(diff) % 575 === 0 && diff < 0 && -diff <= num(d["その他手当計"])) return null;
  const unreadable = [...TERMS[k], TOTAL[k]].some((c) => { const t = classifyCell(d[c]); return t != null && t !== "カンマ付き"; });
  if (unreadable) return { diff, type: "数値でない" };
  if (total === 0 && sum !== 0) return { diff, type: "総支給0" };
  if (Math.abs(diff) >= 100000) return { diff, type: "桁違い" };
  const shinya = hours(d["深夜訪介"]) * 500, yocho = hours(d["夜朝訪介"]) * 200;
  if (shinya > 0 && w1(diff - shinya)) return { diff, type: w1(num(d["深夜_3"]) - shinya) ? "深夜の二重" : "深夜の上乗せ" };
  if (yocho > 0 && w1(diff - yocho)) return { diff, type: "夜朝の上乗せ" };
  for (const t of TERMS[k]) if (num(d[t]) !== 0 && w1(diff + num(d[t]))) return { diff, type: `入れない:${t}` };
  for (const [c, v] of Object.entries(d)) {
    if (TERMS[k].includes(c) || NOT_MONEY.test(c)) continue;
    if (num(v) !== 0 && w1(diff - num(v))) return { diff, type: `列あり:${c}` };
  }
  if (num(d["欠勤控除"]) !== 0 || num(d["欠勤取得日数"]) !== 0) return { diff, type: "欠勤の月" };
  if (num(d["遅刻早退"]) !== 0) return { diff, type: "遅刻早退の月" };
  return { diff, type: diff > 0 ? "列なし+" : "列なし−" };
}

/** ② の総支給は ① の総支給側か 式側か */
function l2Side(l2total: number | null, total: number, sum: number): string {
  if (l2total == null) return "②無し";
  if (w1(l2total - total)) return "②=①総支給";
  if (w1(l2total - sum)) return "②=①式";
  return "②は別の額";
}

type Hit = { kind: string; key: string; name: string; diff: number; type: string; side: string };
export function scan(rows: (L1Row & { month: string })[], l2: Map<string, Record<string, unknown>>): Hit[] {
  const hits: Hit[] = [];
  for (const r of rows) {
    const c = classifyRow(r);
    if (!c) continue;
    const k = r.sheet_kind === "part" ? "part" : "shaseki";
    const key = `${r.office_number}|${String(r.employee_number).replace(/^0+/, "")}|${r.month}`;
    const d = r.row_data;
    const t2 = l2.get(`${key}|${k}`);
    hits.push({ kind: k, key, name: String(r.employee_name ?? "").replace(/\s+/g, " "), diff: c.diff, type: c.type,
      side: l2Side(t2 ? num(t2["総支給額"]) : null, num(d[TOTAL[k]]), TERMS[k].reduce((s, t) => s + num(d[t]), 0)) });
  }
  return hits;
}
const countOf = (hits: Hit[]) => { const c: Record<string, number> = {}; for (const h of hits) c[`${h.kind}|${h.type}`] = (c[`${h.kind}|${h.type}`] ?? 0) + 1; return c; };

/** 当方に その項目があるか (目で確かめた対応。payroll-calc の関数名) */
const OURS: Record<string, string> = {
  深夜の二重: "有 (yochoAllowance が 深夜の時間 × 500 を足す。当方は 1 回だけ)",
  深夜の上乗せ: "有 (yochoAllowance が 深夜の時間 × 500)",
  夜朝の上乗せ: "有 (yochoAllowance が 夜朝の時間 × 単価)",
  "入れない:介護超過": "有 (careOvertimePay)", "入れない:通信手当": "有 (communication_fee)", "入れない:育児手当": "有 (childcare_allowance)",
  "入れない:移動手当": "有 (travel_allowance)",
  欠勤の月: "有 (absenceDeduction)", 遅刻早退の月: "★ 無し (給与D が 2026-09-27 に指摘済み)",
};

function negativeControl(rows: (L1Row & { month: string })[]) {
  const lines: string[] = [];
  const base = rows.find((r) => r.sheet_kind === "shaseki" && classifyRow(r) === null && num(r.row_data[TOTAL.shaseki]) > 0 && num(r.row_data["介護超過"]) > 0);
  const baseP = rows.find((r) => r.sheet_kind === "part" && classifyRow(r) === null && num(r.row_data[TOTAL.part]) > 0 && num(r.row_data["通信手当"]) > 0);
  if (!base || !baseP) return { ok: false, lines: ["壊す元の行が見つからない"] };
  const T = TOTAL.shaseki, tot = num(base.row_data[T]);
  const cases: [string, L1Row, string][] = [
    ["数値でない", { ...base, row_data: { ...base.row_data, 本人給: "#VALUE!" } }, "数値でない"],
    ["総支給0", { ...base, row_data: { ...base.row_data, [T]: 0 } }, "総支給0"],
    ["桁違い", { ...base, row_data: { ...base.row_data, [T]: tot + 500000 } }, "桁違い"],
    ["深夜の二重", { ...base, row_data: { ...base.row_data, 深夜訪介: "2:00", 夜朝訪介: "0:00", 深夜_3: 1000, [T]: tot - num(base.row_data["深夜_3"]) + 2000 } }, "深夜の二重"],
    ["深夜の上乗せ", { ...base, row_data: { ...base.row_data, 深夜訪介: "2:00", 夜朝訪介: "0:00", 深夜_3: 0, [T]: tot - num(base.row_data["深夜_3"]) + 1000 } }, "深夜の上乗せ"],
    ["夜朝の上乗せ", { ...base, row_data: { ...base.row_data, 深夜訪介: "0:00", 夜朝訪介: "3:00", [T]: tot + 600 } }, "夜朝の上乗せ"],
    ["入れない", { ...base, row_data: { ...base.row_data, [T]: tot - num(base.row_data["介護超過"]) } }, "入れない:介護超過"],
    ["列あり", { ...base, row_data: { ...base.row_data, 負のコントロール手当: 777, [T]: tot + 777 } }, "列あり:負のコントロール手当"],
    ["カンマ付きは読める", { ...base, row_data: { ...base.row_data, 本人給: num(base.row_data["本人給"]).toLocaleString("en-US") } }, "(残差なし)"],
    ["欠勤の月", { ...base, row_data: { ...base.row_data, 欠勤取得日数: 1, 深夜訪介: "0:00", 夜朝訪介: "0:00", [T]: tot - 12345 } }, "欠勤の月"],
    ["列なし+", { ...base, row_data: { ...base.row_data, 深夜訪介: "0:00", 夜朝訪介: "0:00", [T]: tot + 4321 } }, "列なし+"],
    ["パート 入れない", { ...baseP, row_data: { ...baseP.row_data, [TOTAL.part]: num(baseP.row_data[TOTAL.part]) - num(baseP.row_data["通信手当"]) } }, "入れない:通信手当"],
  ];
  let ok = true;
  for (const [label, row, want] of cases) {
    const got = classifyRow(row)?.type ?? "(残差なし)";
    const hit = got === want;
    if (!hit) ok = false;
    lines.push(`${label.padEnd(10)} → ${got}${hit ? "  OK" : `  ★ NG (期待 ${want})`}`);
  }
  // 基準値比較が悪化を出すか
  const extra = { ...base, row_data: { ...base.row_data, [T]: tot + 4321, 深夜訪介: "0:00", 夜朝訪介: "0:00" } };
  const worse = Object.entries(countOf(scan([...rows, extra], new Map()))).some(([k, v]) => v > (countOf(scan(rows, new Map()))[k] ?? 0));
  if (!worse) ok = false;
  lines.push(`1 行足すと 型の件数が増える: ${worse ? "OK" : "★ NG"}`);
  return { ok, lines };
}

function loadL1(): { rows: (L1Row & { month: string })[]; files: string[] } {
  const dir = process.env.SOUKATSU1_DIR;
  if (!dir) throw new Error("★ SOUKATSU1_DIR=<① の抽出物 soukatsu_extract_YYYYMM.json のある dir> を渡してください (xlsm は再抽出しない)");
  const files = readdirSync(dir).filter((f) => /^soukatsu_extract_\d{6}\.json$/.test(f)).sort();
  // ★ 走査ファイル 0 本で「0 件」と出さない
  if (!files.length) throw new Error(`★ ${dir} に soukatsu_extract_YYYYMM.json が 1 本もありません`);
  const rows: (L1Row & { month: string })[] = [];
  for (const f of files) {
    const m = /_(\d{6})\.json$/.exec(f)![1];
    for (const r of JSON.parse(readFileSync(join(dir, f), "utf8")) as L1Row[]) rows.push({ ...r, month: m });
  }
  return { rows, files };
}

async function loadL2(): Promise<Map<string, Record<string, unknown>>> {
  type R2 = { office_number: string; employee_number: string; processing_month: string; sheet_kind: string; row_data: Record<string, unknown> };
  let rows: R2[];
  const path = process.env.SNAPSHOT;
  if (path && existsSync(path)) rows = JSON.parse(readFileSync(path, "utf8")).soukatsu;
  else rows = await restAll<R2>("payroll_soukatsu_rows?select=id,office_number,employee_number,processing_month,sheet_kind,row_data");
  return new Map(rows.map((r) => [`${r.office_number}|${String(r.employee_number).replace(/^0+/, "")}|${r.processing_month}|${r.sheet_kind}`, r.row_data]));
}

async function main() {
  console.log("=== 総括表 ① の「総支給 ≠ 項目の合計」の型 2026-09-27 新設・読み取り専用 ===");
  console.log("★ check:all には入れていない (意図的)。① の中の辻褄の話で 当方の金額は比べていない。診断系");
  console.log("★ 比べているもの: ① の中だけ (総支給 vs 給与D の式の項目の和)。② は「② の総支給が ① のどちら側か」を参考に出すだけ");
  console.log("★ この検査が見ていないもの:");
  console.log("  ・当方の金額 (→ check:soukatsu-item-gap / -monthly)");
  console.log("  ・残差の無い人月の中身 (総支給と項目の和が一致していても 項目どうしが相殺している可能性はある)");
  console.log("  ・2 つ以上の項目が絡む残差。列なし± に落ちる (組み合わせは 偶然一致が多いので探さない)");
  console.log("  ・パートの 会議費 (残差が −575 の倍数でその他手当計以内) は 給与D と同じく 既知として数えない");
  console.log("  ・① の抽出物が古ければ その時点の値 (xlsm は再抽出しない)");
  console.log("");
  const { rows, files } = loadL1();
  const l2 = await loadL2();
  console.log(`① 抽出物 ${files.length} 本 (${files[0]}〜${files.at(-1)}) / ${rows.length} 行 (月給 ${rows.filter((r) => r.sheet_kind !== "part").length} / パート ${rows.filter((r) => r.sheet_kind === "part").length})`);

  const neg = negativeControl(rows);
  console.log("\n負のコントロール (① の写しの 1 行を壊す。ファイルも DB も触らない):");
  for (const l of neg.lines) console.log("  " + l);

  const hits = scan(rows, l2);
  const counts = countOf(hits);
  for (const kind of ["shaseki", "part"] as const) {
    const hs = hits.filter((h) => h.kind === kind);
    const n = rows.filter((r) => (r.sheet_kind === "part" ? "part" : "shaseki") === kind).length;
    console.log(`\n--- ${kind === "part" ? "パート" : "月給 (提責_社員)"}: 残差 ${hs.length} / ${n} 行 ---`);
    const types = [...new Set(hs.map((h) => h.type))].sort((a, b) => hs.filter((h) => h.type === b).length - hs.filter((h) => h.type === a).length);
    for (const t of types) {
      const th = hs.filter((h) => h.type === t);
      const sides: Record<string, number> = {};
      for (const h of th) sides[h.side] = (sides[h.side] ?? 0) + 1;
      const offs = new Set(th.map((h) => h.key.split("|")[0]));
      console.log(`  ${t.padEnd(16)} ${String(th.length).padStart(4)}  残差計 ${Math.round(th.reduce((s, h) => s + h.diff, 0)).toLocaleString()}円  事業所${offs.size}  ② ${JSON.stringify(sides)}  当方: ${OURS[t] ?? "—"}`);
    }
  }
  if (DETAIL) {
    console.log(`\n--- 型 ${DETAIL} ---`);
    for (const h of hits.filter((h) => h.type === DETAIL)) console.log(`  ${h.kind} ${h.key} ${h.name} 残差 ${Math.round(h.diff)} ${h.side}`);
  }

  let failed = false;
  if (existsSync(BASELINE_PATH) && !UPDATE) {
    const base = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    console.log("\n--- 基準値との比較 ---");
    if (base.rows !== rows.length) console.log(`  データが変わった (① ${base.rows}→${rows.length} 行)。FAIL にしない。中身を見てから --update`);
    else {
      const worse = Object.keys({ ...base.counts, ...counts }).filter((k) => (counts[k] ?? 0) > (base.counts[k] ?? 0));
      const better = Object.keys({ ...base.counts, ...counts }).filter((k) => (counts[k] ?? 0) < (base.counts[k] ?? 0));
      console.log(`  ★ 悪化 ${worse.length} / 改善 ${better.length}`);
      for (const k of worse) console.log(`  ★ 悪化 ${k} ${base.counts[k] ?? 0}→${counts[k]}`);
      for (const k of better) console.log(`  改善   ${k} ${base.counts[k]}→${counts[k] ?? 0}`);
      failed = worse.length > 0;
    }
  } else if (!UPDATE) console.log("\n基準値ファイルがありません。--update で作成してください");
  if (UPDATE) {
    const prev = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
    writeFileSync(BASELINE_PATH, JSON.stringify({ _readme: prev._readme ?? "(新規)", updated_at: new Date().toISOString(), files, rows: rows.length, counts }, null, 2) + "\n");
    console.log(`\n基準値を更新しました: ${BASELINE_PATH}`);
  }
  if (!neg.ok) { console.log("★ 負のコントロールが通らないので PASS を出しません"); process.exit(1); }
  if (failed) { console.log("★ FAIL: ① の行数が同じなのに ある型の件数が増えました。--detail=<型> で見てください"); process.exit(1); }
  console.log("PASS (★ 0 件 PASS ではない。基準値の件数を許容したうえでの PASS)");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e); process.exit(1); });
