/**
 * check:commute-monthly — 月給者の通勤費を 当方 / ② / ① で突き合わせ、② の数え方で説明できるものを 式で別掲する
 * (2026-09-27 給与C 新設・読み取り専用)。
 *
 *   SOUKATSU1_DIR=<① の抽出物のある dir> npm run check:commute-monthly
 *   ... SNAPSHOT=<{calc, soukatsu} の json>   # calc・② を DB から読まない (出勤簿は違う人月だけ読む)
 *   ... -- --detail   /   -- --update   (★ 悪化したまま更新しない)
 *
 * 【比べるもの】
 *   当方 = verificationItems の「通勤費」(= commuteFeeAmount)。★ 月給の payload に通勤費の額は入っていない (素材だけ) ので
 *          payload の列を直接読まない (2026-09-27 指示役が commute_fee を 0 と読んで偽の差を作った罠)
 *   ②   = 提責_社員 シートの「通勤費」/ km は「通勤距離」(無ければ「距離(通)」)
 *   ①   = 旧システム出力の「通勤費」/「通勤距離」(事務員は多くが 0)
 *
 * 【型 (通勤費が ② と違う人月)】★ 規則が式で書けるものは 基準値ではなく式で分ける (データが増えても壊れない)
 *   A: ② の数え方   ② の km = 出勤日数 × その人のいつもの 1 日の km (出勤簿の日ごとの通勤 km の最頻値)
 *                   出勤日数 = 出勤簿で勤務がある日 か 切り上げ(② の出勤日数)。★ ②側 (移行後に消える)。当方は直さない
 *                   当方の km = 書式の通勤km = 日ごとの実際の km の合計。① に値がある月は ① = 当方
 *   B: km は同じで額が違う (② の定額・別の単価)
 *   C: 書式の通勤km 欄に円が入っている (事務所の通勤単価が 1 円/km の人。金子百恵)
 *   D: km が違う (上のどれでもない)
 *
 * ── この検査が見ていないもの ─────────────────────────────────────────────
 *   ・時給者の通勤費 (check:soukatsu-item-gap の 通勤)
 *   ・どちらの数え方で払うのが正しいか (実日の km か 出勤日数 × 定額か は運用の判断・user)
 *   ・通勤と出張の二重 (check:km-double)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { restAll } from "./_rest.mjs";
import { num } from "./_soukatsu-items.mjs";
import { attendanceWorkMinutes, type OvertimeSetting, type OfficeAttendanceRecord } from "../src/lib/payroll/payroll-calc.js";
import { verificationItems } from "../src/lib/payroll/verification-items.js";

const UPDATE = process.argv.includes("--update");
const DETAIL = process.argv.includes("--detail");
const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), "check-commute-monthly-baseline.json");
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");

type M = Record<string, unknown> & { employee_number: string; employee_name?: string; role_type?: string; office_commute_unit_price?: number };
type Calc = { office_number: string; processing_month: string; payload: { monthly?: M[]; overtime_settings?: unknown[] } | null };
type R2 = { office_number: string; employee_number: string; processing_month: string; sheet_kind: string; row_data: Record<string, unknown> };
export type Mis = { key: string; name: string; role: string; ours: number; l2: number; l1: number | null; l2km: number; unit: number; onlyCommute: boolean; totDiff: number };
export type Att = { days: number; usualKm: number | null };

/** 出勤簿から 勤務がある日数 と いつもの 1 日の通勤 km (最頻値。同数なら小さい方) */
export function attOf(rows: (OfficeAttendanceRecord & { commute_km?: number | string | null })[]): Att {
  const days = rows.filter((r) => attendanceWorkMinutes(r) > 0).length;
  const freq = new Map<number, number>();
  for (const r of rows) { const v = Number(r.commute_km) || 0; if (v > 0) freq.set(v, (freq.get(v) ?? 0) + 1); }
  const usual = [...freq].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
  return { days, usualKm: usual };
}

export function typeOf(x: Mis, oursKm: number, att: Att | undefined, l2days: number): string {
  if (x.unit === 1 || oursKm >= 1000) return "C:書式の通勤km欄に円";
  // ★ km が当方と同じなら km の数え方では額の差を説明できない (江尻 63km = 21 日 × 3km でも 額は 782 / 670) → B を先に見る
  if (Math.abs(oursKm - x.l2km) < 0.05) return "B:kmは同じで額が違う";
  if (att?.usualKm) {
    const cands = [att.days, Math.ceil(l2days - 1e-9)].filter((d) => d > 0);
    if (cands.some((d) => Math.abs(d * att.usualKm! - x.l2km) < 0.05)) return "A:②は出勤日数×いつものkm";
  }
  return "D:kmが違う";
}

export function findMis(calc: Calc[], l2rows: R2[], l1: Map<string, Record<string, unknown>>) {
  const l2 = new Map<string, Record<string, unknown>>();
  for (const r of l2rows) if (r.sheet_kind !== "part") l2.set(`${r.office_number}|${nn(r.employee_number)}|${r.processing_month}`, r.row_data);
  let pairs = 0, l2Has = 0, oursHas = 0;
  const mis: (Mis & { oursKm: number; l2days: number })[] = [];
  for (const c of calc) {
    const ot = new Map(((c.payload?.overtime_settings ?? []) as OvertimeSetting[]).map((r) => [r.job_type, r]));
    for (const p of c.payload?.monthly ?? []) {
      const key = `${c.office_number}|${nn(p.employee_number)}|${c.processing_month}`;
      const d2 = l2.get(key);
      if (!d2) continue;
      pairs++;
      const v = verificationItems(p, "shaseki", ot, d2);
      const it = v.items.find((x) => x.item === "通勤費");
      if (!it) continue;
      if (it.soukatsu > 0) l2Has++;
      if (it.ours > 0) oursHas++;
      if (Math.abs(it.ours - it.soukatsu) <= 1) continue;
      const others = v.items.filter((x) => !["通勤費", "総支給額", "調整手当(内訳計)"].includes(x.item) && Math.abs(x.ours - x.soukatsu) > 1);
      const tot = v.items.find((x) => x.item === "総支給額");
      const d1 = l1.get(key);
      const summary = (p.summary ?? {}) as { commuteKmTotal?: number };
      mis.push({
        key, name: String(p.employee_name ?? "").replace(/\s+/g, " "), role: String(p.role_type ?? ""), ours: it.ours, l2: it.soukatsu,
        l1: d1 ? num(d1["通勤費"]) : null, l2km: num(d2["通勤距離"] ?? d2["距離(通)"]), unit: Number(p.office_commute_unit_price ?? 0),
        onlyCommute: others.length === 0, totDiff: tot ? tot.ours - tot.soukatsu : 0, oursKm: Number(summary.commuteKmTotal ?? 0), l2days: num(d2["出勤日数"]),
      });
    }
  }
  return { pairs, l2Has, oursHas, mis };
}

async function main() {
  console.log("=== check:commute-monthly (月給者の通勤費 当方 / ② / ①) 2026-09-27 新設・読み取り専用 ===");
  console.log("★ check:all には入れていない (意図的)。② の数え方の違いを見える化する診断系");
  console.log("★ この検査が見ていないもの: 時給者 / どちらの数え方で払うのが正しいか (user) / 通勤と出張の二重 (check:km-double)");
  const dir = process.env.SOUKATSU1_DIR;
  if (!dir) { console.log("★ SOUKATSU1_DIR=<① の抽出物のある dir> が要る"); process.exit(1); }
  const files = readdirSync(dir).filter((f) => /^soukatsu_extract_\d{6}\.json$/.test(f)).sort();
  if (!files.length) { console.log(`★ ${dir} に抽出物が 1 本もない (0 件と出さない)`); process.exit(1); }
  const l1 = new Map<string, Record<string, unknown>>();
  for (const f of files) {
    const ym = /_(\d{6})\.json$/.exec(f)![1];
    for (const r of JSON.parse(readFileSync(join(dir, f), "utf8")) as R2[]) {
      if (r.sheet_kind === "part") continue;
      const k = `${r.office_number}|${nn(r.employee_number)}|${ym}`;
      if (!l1.has(k)) l1.set(k, r.row_data);
    }
  }
  const path = process.env.SNAPSHOT;
  const snap = path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  const calc: Calc[] = snap ? snap.calc : await restAll<Calc>("payroll_calc_results?select=id,office_number,processing_month,payload");
  const l2rows: R2[] = snap ? snap.soukatsu : await restAll<R2>("payroll_soukatsu_rows?select=id,office_number,employee_number,processing_month,sheet_kind,row_data");
  const { pairs, l2Has, oursHas, mis } = findMis(calc, l2rows, l1);
  if (!pairs) { console.log("★ 月給者の対が 0 件 (0 件と出さない)"); process.exit(1); }

  // 違う人月だけ 出勤簿を読む
  const att = new Map<string, Att>();
  for (const x of mis) {
    const [o, e, m] = x.key.split("|");
    const rows = (await restAll<OfficeAttendanceRecord & { employee_number: string; commute_km?: number }>(
      `payroll_attendance_records?select=*&office_number=eq.${o}&year=eq.${Number(m.slice(0, 4))}&month=eq.${Number(m.slice(4))}`)).filter((r) => nn(r.employee_number) === e);
    att.set(x.key, attOf(rows));
  }
  const typed = mis.map((x) => ({ ...x, type: typeOf(x, x.oursKm, att.get(x.key), x.l2days), att: att.get(x.key) }));

  // 負のコントロール
  let negOk = true;
  const negLines: string[] = [];
  const a = typed.find((x) => x.type.startsWith("A:"));
  if (!a || !a.att?.usualKm) { negOk = false; negLines.push("型A の人月が無く 作れない  ★ NG"); }
  else {
    const t1 = typeOf(a, a.oursKm, { days: a.att.days, usualKm: a.att.usualKm + 1 }, a.l2days);
    const t2 = typeOf({ ...a, l2km: a.l2km + a.att.usualKm }, a.oursKm, { days: a.att.days + 1, usualKm: a.att.usualKm }, a.l2days + 1);
    const t3 = typeOf({ ...a, l2km: a.l2km + a.att.usualKm }, a.oursKm, a.att, a.l2days);
    const t4 = typeOf({ ...a, unit: 1 }, a.oursKm, a.att, a.l2days);
    const checks: [string, string, boolean][] = [
      [`いつもの km を +1 (${a.key})`, t1, !t1.startsWith("A:")],
      ["② の km を 1 日分増やし 出勤日数も +1 (まだ式どおり)", t2, t2.startsWith("A:")],
      ["② の km だけ 1 日分増やす (日数と合わない)", t3, !t3.startsWith("A:")],
      ["単価を 1 にする (欄に円)", t4, t4.startsWith("C:")],
    ];
    for (const [label, got, p] of checks) { if (!p) negOk = false; negLines.push(`${label} → ${got}${p ? "  OK" : "  ★ NG"}`); }
  }
  console.log("\n負のコントロール (読み込んだ写しを壊す。DB もファイルも触らない):");
  for (const l of negLines) console.log("  " + l);

  const only = typed.filter((x) => x.onlyCommute);
  console.log("\n母数 (★ 定義ごとに出す):");
  console.log(`  月給の対 ${pairs} / ② に通勤費がある ${l2Has} / 当方に通勤費がある ${oursHas} / 通勤費が違う ${typed.length} / うち通勤費だけが違う ${only.length}`);
  const types = [...new Set(typed.map((x) => x.type))].sort();
  const counts: Record<string, { all: number; only: number; onlyYen: number }> = {};
  for (const t of types) {
    const all = typed.filter((x) => x.type === t), o = all.filter((x) => x.onlyCommute);
    counts[t] = { all: all.length, only: o.length, onlyYen: o.reduce((s, x) => s + x.totDiff, 0) };
    console.log(`  ${t.padEnd(22)} 違う ${String(all.length).padStart(3)} / 通勤費だけ ${String(o.length).padStart(3)}  総支給の差 (当方 − ②・通勤費だけの分) ¥${counts[t].onlyYen.toLocaleString()}`);
  }
  if (DETAIL) {
    console.log("\n--- 通勤費が違う人月");
    for (const x of typed) console.log(`  ${x.onlyCommute ? "T " : "  "}${x.type.padEnd(20)} ${x.key} ${x.name} ${x.role} 当方 ${x.ours} / ② ${x.l2} / ① ${x.l1 ?? "-"} | km 当方 ${x.oursKm} / ② ${x.l2km} | 出勤簿 勤務日 ${x.att?.days} いつもの ${x.att?.usualKm ?? "-"} / ② 出勤日数 ${x.l2days}${x.onlyCommute ? "" : ""}`);
  }

  let failed = false;
  if (existsSync(BASELINE_PATH) && !UPDATE) {
    const b = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    console.log("\n--- 基準値との比較");
    const worse: string[] = [];
    for (const k of new Set([...Object.keys(b.counts), ...Object.keys(counts)])) {
      if (k.startsWith("A:")) continue;   // ★ 型A は ②側の数え方 (式で決まる)。増えても当方の穴ではない
      if ((counts[k]?.all ?? 0) > (b.counts[k]?.all ?? 0)) worse.push(`${k} ${b.counts[k]?.all ?? 0}→${counts[k]?.all}`);
    }
    console.log(`  ★ 悪化 ${worse.length}`);
    for (const w of worse) console.log(`  ★ 悪化 ${w}`);
    failed = worse.length > 0;
  } else if (!UPDATE) console.log("\n基準値ファイルがありません。--update で作成してください");
  if (UPDATE) {
    const prev = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
    writeFileSync(BASELINE_PATH, JSON.stringify({ _readme: prev._readme ?? "(新規)", updated_at: new Date().toISOString(), counts }, null, 2) + "\n");
    console.log(`\n基準値を更新しました: ${BASELINE_PATH}`);
  }
  if (!negOk) { console.log("★ 負のコントロールが通らないので PASS を出しません"); process.exit(1); }
  if (failed) { console.log("★ FAIL: 型A 以外の件数が増えました。--detail で見てください"); process.exit(1); }
  console.log("PASS (★ 0 件 PASS ではない。型A は式で別掲・それ以外は基準値の件数を許容したうえでの PASS)");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e); process.exit(1); });
