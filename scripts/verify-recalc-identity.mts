/**
 * 「まとめて再計算」と「画面の給与計算ボタン」が同じ結果を出すことを確かめる (2026-09-27)。読み取りのみ・DB書換なし。
 *
 *   npx tsx scripts/verify-recalc-identity.mts snapshot 1272603851 202607   # ① ボタンで計算した直後に控える
 *   npx tsx scripts/verify-recalc-identity.mts compare  1272603851 202607   # ② まとめて再計算で同じ 1 件を計算した後に突き合わせる
 *   npx tsx scripts/verify-recalc-identity.mts self-test                    # 負のコントロール (わざと 1 か所壊して検知できるか)
 *
 * ★ 何を確かめるか:
 *   calculate (ボタン) → calculateFor に分けた変更は「本体 1,580 行が無変更」を git diff で示せる (af67892)。
 *   ★ diff で示せないのは まとめて再計算の側だけにある違い:
 *     ・月次ステータスの渡し方 (画面は state、まとめては payroll_monthly_status を読んで渡す)
 *     ・旧システムの職員表の読み込みを使い回す fetch (lib/supabase/batch-cache-fetch.ts。まとめての間だけ ON)
 *   → ボタンで 1 件 と まとめて再計算で同じ 1 件 を 新しいプログラム同士で比べれば、この 2 つを実際に確かめられる。
 * ★ payroll_calc_results の payload を丸ごと比べる。除くのは calculated_at だけ。それ以外は 1 か所でも違えば exit 1。
 *   違ったときは どのキーがどう違うかを出す。
 * ⚠ 控えは給与の個人データを含むので リポジトリには置かず OS の一時フォルダに置く (比べ終わったら消してよい)。
 * ⚠ ①と②の間に 入力が変わると 違って当然。② は その間に変わった入力も数えて出す (calc-freshness の定義を使う)。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restAll } from "./_rest.mjs";
import { CALC_INPUT_SOURCES } from "../src/lib/payroll/calc-freshness.js";

const DIR = join(tmpdir(), "payroll-recalc-identity");
const IGNORE_KEYS = new Set(["calculated_at"]);
type Row = { calculated_at: string; payload: unknown };

/** a と b を再帰で比べ、違うところを path 付きで返す (calculated_at は どの深さでも除く) */
export function diffJson(a: unknown, b: unknown, path = "", out: string[] = []): string[] {
  if (out.length >= 200) return out;
  if (a === b) return out;
  const ta = Array.isArray(a) ? "array" : a === null ? "null" : typeof a;
  const tb = Array.isArray(b) ? "array" : b === null ? "null" : typeof b;
  if (ta !== tb) { out.push(`${path || "(root)"}: 型が違う ${ta} → ${tb} (${short(a)} → ${short(b)})`); return out; }
  if (ta === "array") {
    const aa = a as unknown[], bb = b as unknown[];
    if (aa.length !== bb.length) out.push(`${path}: 件数が違う ${aa.length} → ${bb.length}`);
    for (let i = 0; i < Math.min(aa.length, bb.length); i++) diffJson(aa[i], bb[i], `${path}[${i}]${label(aa[i])}`, out);
    return out;
  }
  if (ta === "object") {
    const oa = a as Record<string, unknown>, ob = b as Record<string, unknown>;
    for (const k of new Set([...Object.keys(oa), ...Object.keys(ob)])) {
      if (IGNORE_KEYS.has(k)) continue;
      if (!(k in oa)) { out.push(`${path}.${k}: 後だけにある (${short(ob[k])})`); continue; }
      if (!(k in ob)) { out.push(`${path}.${k}: 前だけにある (${short(oa[k])})`); continue; }
      diffJson(oa[k], ob[k], `${path}.${k}`, out);
    }
    return out;
  }
  out.push(`${path}: ${short(a)} → ${short(b)}`);
  return out;
}
const short = (v: unknown) => { const s = JSON.stringify(v); return s === undefined ? "undefined" : s.length > 80 ? s.slice(0, 80) + "…" : s; };
/** 配列の要素が職員なら 職員番号・氏名を付けて どの人の違いか分かるようにする */
const label = (v: unknown) => {
  if (v && typeof v === "object" && "employee_number" in (v as object)) {
    const o = v as { employee_number?: unknown; employee_name?: unknown };
    return `{#${String(o.employee_number)} ${String(o.employee_name ?? "")}}`;
  }
  return "";
};

async function read(office: string, month: string): Promise<Row> {
  const rows = await restAll<Row>(`payroll_calc_results?select=calculated_at,payload&office_number=eq.${office}&processing_month=eq.${month}`, "calculated_at");
  if (rows.length !== 1) throw new Error(`★ 計算結果が ${rows.length} 件 (期待 1): ${office} ${month}`);
  return rows[0];
}

async function main() {
  const [mode, office, month] = process.argv.slice(2);
  if (mode === "self-test") {
    const a = { calculated_at: "x", hourly: [{ employee_number: "1", employee_name: "テスト", grand_total: 100, summary: { workDays: 3 } }], monthly: [] };
    const same = diffJson(a, { ...a, calculated_at: "y" });
    const broken = diffJson(a, { ...a, hourly: [{ ...a.hourly[0], summary: { workDays: 4 } }] });
    console.log(`calculated_at だけ違う → 差 ${same.length} 件 (期待 0): ${same.length === 0 ? "OK" : "NG"}`);
    console.log(`summary.workDays を 1 つ変える → 差 ${broken.length} 件 (期待 1): ${broken.length === 1 ? "OK" : "NG"}  ${broken.join(" / ")}`);
    if (same.length !== 0 || broken.length !== 1) process.exit(1);
    return;
  }
  if (!office || !month || !["snapshot", "compare"].includes(mode)) {
    console.error("使い方: snapshot|compare <office_number> <YYYYMM> / self-test"); process.exit(1);
  }
  mkdirSync(DIR, { recursive: true });
  const file = join(DIR, `${office}_${month}_before.json`);
  const now = await read(office, month);
  if (mode === "snapshot") {
    writeFileSync(file, JSON.stringify(now));
    console.log(`控えました: ${office} ${month} 計算日時 ${now.calculated_at}\n  → ${file}`);
    console.log("次: 画面の「まとめて再計算」で 同じ 1 件だけを選んで再計算 → compare を回す");
    return;
  }
  if (!existsSync(file)) { console.error(`★ 控えがありません。先に snapshot を回してください: ${file}`); process.exit(1); }
  const before = JSON.parse(readFileSync(file, "utf8")) as Row;
  console.log(`前 (ボタン)       計算日時 ${before.calculated_at}`);
  console.log(`後 (まとめて再計算) 計算日時 ${now.calculated_at}`);
  if (now.calculated_at <= before.calculated_at) { console.error("★ 後の計算がまだです (計算日時が新しくなっていない)。まとめて再計算で この 1 件を計算してから回してください"); process.exit(1); }
  // ①と②の間に変わった入力 (あれば 違って当然)
  let changed = 0;
  const t1 = encodeURIComponent(before.calculated_at), t2 = encodeURIComponent(now.calculated_at);
  for (const src of CALC_INPUT_SOURCES) {
    const scope = src.select.includes("office_number") ? `&office_number=eq.${office}` : "";
    const rows = await restAll<Record<string, unknown>>(`${src.table}?select=${src.select}&${src.tsCol}=gt.${t1}&${src.tsCol}=lte.${t2}${scope}`, src.select.split(",")[0]);
    if (rows.length) { changed += rows.length; console.log(`  ⚠ 間に変わった入力: ${src.table} ${rows.length} 行`); }
  }
  const diffs = diffJson(before.payload, now.payload);
  if (diffs.length === 0) {
    console.log(`\n✓ 一致: calculated_at を除いて payload は完全に同じです (間に変わった入力 ${changed} 行)`);
    return;
  }
  console.log(`\n✗ 不一致: ${diffs.length}${diffs.length >= 200 ? "+" : ""} か所 (間に変わった入力 ${changed} 行${changed ? " ← これが原因の可能性" : ""})`);
  for (const d of diffs.slice(0, 50)) console.log(`  ${d}`);
  if (diffs.length > 50) console.log(`  …他 ${diffs.length - 50} か所`);
  process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
