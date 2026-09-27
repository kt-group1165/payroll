/**
 * check:service-record-duplicates — 実績 (payroll_service_records) に 完全に同じ訪問が 2 行以上ある組を数える (2026-09-27 給与D)。★ 基準値方式
 *
 *   npm run check:service-record-duplicates
 *   npm run check:service-record-duplicates -- --update      ★ 基準値を更新 (中身を見てから)
 *
 * ── 鍵 ───────────────────────────────────────────────────────────────
 *   事業所 / 処理月 / ★ 職員 / 日付 / 算定の開始・終了 / 利用者 (番号、無ければ名前) / サービスコード
 *   ★ 職員が鍵に入っているので 2 人派遣 (職員が違う) は重複にならない。同じ職員が 同じ利用者に 同じ時刻で 2 回、は実際にはありえない。
 *
 * ── 2026-09-27 に分かったこと ────────────────────────────────────────────
 *   284,342 行中 42 組・余分な行 42。全部 同じ取込 (import_batch) の中。
 *     やわた 1272404508 202606 が 40 (利用者はすべて 野村敦子・身体介護(自立) 0:30・職員 6 名)
 *     1270201930 202602 が 1 (白須健一 A22621) / 1270906546 202608 が 1 (上野君江 A21121)
 *   ★ 原本 (ほのぼの MEISAI。kaigo-app/サービス実績データ/やわた/202606) にも 同じ重複が 40 件ある = 取込のバグではない。
 *   ★ ② (総括表 支払用) は 1 回で払っている。当方は 2 回払っている (過払いの向き):
 *     鈴木阿貴子 220901|202606 +1,050 (重複 0.5h × 2,100) / 峰沙織 221009|202606 +1,050 /
 *     石本美幸 221005|202606 +18,906 のうち 15,750 (7.5h × 2,100。残り 3,156 は別原因・未解明) /
 *     鍬本シナラ 1270906546|1227|202608 +1,050 (総合事業 0.75h × 船橋 1,400)。月給 3 名は小計に訪問が入らないので差 0。
 *   対処 (★ user 判断待ち・未実装): 計算の入口で 完全に同じ行を 1 回に数える (a)。取込で除く (b) は採らない —
 *     payroll_import_batches.record_count = payroll_service_records の行数 という「取込で 1 行も落ちていない」検算が壊れるため。
 *   ★ a を入れても この検査の件数は 42 のまま (DB は原本に忠実なまま・計算だけが 1 回になる)。紛らわしいので注意。
 *
 * ── 判定 ─────────────────────────────────────────────────────────────
 *   組の数が基準値より増えたら FAIL (新しい月の取込に重複が入った)。内訳 (事業所 × 月) も基準値と比べて表示する
 * 負のコントロール: 写しの 1 行を複製すると 組が +1 になること
 * 見ていないもの: 時刻が 1 分でも違う 近い重複 / 利用者名の表記ゆれ / 取込前の原本
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { restAll } from "./_rest.mjs";

const UPDATE = process.argv.includes("--update");
const BASELINE = new URL("./check-service-record-duplicates-baseline.json", import.meta.url);
let fail = 0;
const expect = (ok: boolean, msg: string) => { console.log(`  ${ok ? "o" : "★ FAIL"} ${msg}`); if (!ok) fail++; };
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");

type Rec = { id: string; office_number: string; processing_month: string; employee_number: string; service_date: string; calc_start_time: string; calc_end_time: string; client_number: string | null; client_name: string | null; service_code: string; import_batch_id: string | null };
const recs = await restAll<Rec>("payroll_service_records?select=id,office_number,processing_month,employee_number,service_date,calc_start_time,calc_end_time,client_number,client_name,service_code,import_batch_id");

function groups(rs: Rec[]) {
  const g = new Map<string, Rec[]>();
  for (const r of rs) {
    const k = [r.office_number, r.processing_month, nn(r.employee_number), r.service_date, r.calc_start_time, r.calc_end_time, r.client_number || r.client_name, r.service_code].join("|");
    const l = g.get(k);
    if (l) l.push(r); else g.set(k, [r]);
  }
  const dups = [...g.values()].filter((l) => l.length > 1);
  const byOM: Record<string, number> = {};
  for (const l of dups) { const k = `${l[0].office_number} ${l[0].processing_month}`; byOM[k] = (byOM[k] ?? 0) + 1; }
  return { dups, extra: dups.reduce((s, l) => s + l.length - 1, 0), byOM, crossBatch: dups.filter((l) => new Set(l.map((r) => r.import_batch_id)).size > 1).length };
}

console.log("=== check:service-record-duplicates (実績に 完全に同じ訪問が 2 行以上) ===");
const cur = groups(recs);
console.log(`母数: 実績 ${recs.length} 行。★ 重複の組 ${cur.dups.length} / 余分な行 ${cur.extra} / うち 別の取込どうし ${cur.crossBatch}`);
for (const [k, v] of Object.entries(cur.byOM).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v} 組`);
for (const l of cur.dups.slice(0, 5)) console.log(`  例 ${l[0].office_number}|${nn(l[0].employee_number)}|${l[0].processing_month} ${l[0].service_date} ${l[0].calc_start_time} ${l[0].client_name} ${l[0].service_code} × ${l.length}`);

console.log("\n--- 負のコントロール");
{
  const t = recs.find((r) => !cur.dups.some((l) => l.includes(r)));
  const m = groups(t ? [...recs, { ...t, id: "copy" }] : recs);
  expect(!!t && m.dups.length === cur.dups.length + 1, `1 行を複製すると 組が +1 (${cur.dups.length} → ${m.dups.length})`);
}

type Baseline = { _readme: string[]; groups: number; byOM: Record<string, number> };
const baseline: Baseline | null = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline : null;
console.log("\n--- 基準値");
if (UPDATE || !baseline) {
  writeFileSync(BASELINE, JSON.stringify({ _readme: baseline?._readme ?? [], groups: cur.dups.length, byOM: cur.byOM }, null, 2) + "\n", "utf8");
  console.log("  基準値を保存しました");
} else {
  expect(cur.dups.length <= baseline.groups, `重複の組 ${baseline.groups} → ${cur.dups.length}${cur.dups.length > baseline.groups ? "  ★ 新しい重複 (どの事業所月か 上の内訳を見る)" : ""}`);
  const added = Object.keys(cur.byOM).filter((k) => !(k in baseline.byOM));
  if (added.length) console.log(`  (基準値に無い事業所月: ${added.join(", ")})`);
}
console.log("\n見ていないもの: 時刻が少し違う近い重複 / 利用者名の表記ゆれ / 取込前の原本");
console.log(fail ? `\n★ FAIL ${fail} 件` : "\nPASS");
process.exit(fail ? 1 : 0);
