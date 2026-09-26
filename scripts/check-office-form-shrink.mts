/**
 * check:office-form-shrink — 事業所書式を取り込んだあと、別の script が書式の行を黙って消していないか (2026-09-27)
 *
 *   npx tsx scripts/check-office-form-shrink.mts
 *   npx tsx scripts/check-office-form-shrink.mts --update          # 基準値を今の値にする
 *   SNAPSHOT=<path.json> npx tsx scripts/check-office-form-shrink.mts   # DB 読みを使い回す
 *   FORMS_DIR=<dir> npx tsx scripts/check-office-form-shrink.mts         # 書式 CSV と比べて「何が消えたか」を項目名で出す
 *
 * 【なぜ要るか】
 * 取込バッチ (payroll_import_batches) には 取込時の行数 record_count が残る。今の行数がそれより少なければ、
 * 取込のあとで誰かが消した。2026-09-27 に次が見つかった (どれも落ちずに黙って進んでいた):
 *   ・import_soukatsu_meeting_counts.mjs の DELETE が import_batch_id を見ておらず、書式から入った
 *     会議N件数 まで消していた (31 事業所×月。消えた行数 = 書式CSV の会議N件数行数 で一致)
 *   ・ちはら台 202606 の書式バッチ 27 行が 全部消えていた
 *
 * 【見方】事業所×月ごとに **いちばん新しい書式バッチ** だけを見る。古いバッチが 0 行になっているのは
 *   取り込み直し (置き換え) なので数えない。
 *
 * 【基準値方式】0 を目指す検査ではない。★ 事業所×月ごとの「消えた行数」を固定し、**増えたら落ちる**。
 *   ★ なぜ 0 にできないか: 正当な削除がありうる (書式の誤入力を総括表に合わせて消した・
 *     重複行を消した 等)。どれが正当かは行ごとに人が判断するしかない。
 *   ★ --update は 消えた理由を確かめてからにすること。悪化したまま更新すると穴を焼き付ける。
 *
 * 【負のコントロール】毎回、取得結果の写しから 減っていない事業所×月の行を 1 つ抜き、
 *   「消えた」と検知されることを確かめてから判定する。★ DB は壊さない。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { restAll } from "./_rest.mjs";

const BASELINE = new URL("./check-office-form-shrink-baseline.json", import.meta.url);
const UPDATE = process.argv.includes("--update");
const SNAPSHOT = process.env.SNAPSHOT ?? "";
const FORMS_DIR = process.env.FORMS_DIR ?? "";

type Batch = { id: string; import_type: string; file_names: string[] | null; record_count: number; processing_month: string; office_number: string; created_at: string };
type Row = { import_batch_id: string | null; item_name: string };
type Snap = { batches: Batch[]; rows: Row[] };

console.log("=== check:office-form-shrink  取込後に消えた事業所書式の行 ===\n");

let snap: Snap;
if (SNAPSHOT && existsSync(SNAPSHOT)) {
  snap = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snap;
  console.log(`(SNAPSHOT を使いました: ${SNAPSHOT})`);
} else {
  const [batches, rows] = await Promise.all([
    restAll<Batch>("payroll_import_batches?select=id,import_type,file_names,record_count,processing_month,office_number,created_at&import_type=eq.office_form"),
    restAll<Row>("payroll_office_form_records?select=import_batch_id,item_name&import_batch_id=not.is.null"),
  ]);
  snap = { batches, rows };
  if (SNAPSHOT) { writeFileSync(SNAPSHOT, JSON.stringify(snap)); console.log(`(SNAPSHOT に保存しました: ${SNAPSHOT})`); }
}

/** 事業所×月ごとの いちばん新しいバッチと、その今の行数 */
function measure(s: Snap) {
  const latest = new Map<string, Batch>();
  for (const b of s.batches) {
    const k = `${b.office_number}|${b.processing_month}`;
    const cur = latest.get(k);
    if (!cur || b.created_at > cur.created_at) latest.set(k, b);
  }
  const now = new Map<string, number>();
  const itemsNow = new Map<string, Map<string, number>>();
  for (const r of s.rows) {
    if (!r.import_batch_id) continue;
    now.set(r.import_batch_id, (now.get(r.import_batch_id) ?? 0) + 1);
    const m = itemsNow.get(r.import_batch_id) ?? itemsNow.set(r.import_batch_id, new Map()).get(r.import_batch_id)!;
    m.set(r.item_name, (m.get(r.item_name) ?? 0) + 1);
  }
  const shrink: Record<string, number> = {};
  for (const [k, b] of latest) {
    const d = b.record_count - (now.get(b.id) ?? 0);
    if (d !== 0) shrink[k] = d;
  }
  return { latest, now, itemsNow, shrink };
}

const { latest, now, itemsNow, shrink } = measure(snap);
const totalShrink = Object.values(shrink).filter((v) => v > 0).reduce((a, b) => a + b, 0);
console.log(`分母: 書式バッチ ${snap.batches.length} 本 / 事業所×月 ${latest.size} (それぞれ いちばん新しいバッチだけを見る)`);
console.log(`  取込後に行が減った 事業所×月 ${Object.values(shrink).filter((v) => v > 0).length} / 消えた行 合計 ${totalShrink}`);
const grown = Object.entries(shrink).filter(([, v]) => v < 0);
if (grown.length) console.log(`  (取込時より増えた 事業所×月 ${grown.length} — 同じバッチ id で後から足した行。この検査の対象外)`);

// ── 負のコントロール: 減っていない事業所×月から 1 行抜いた写しで 検知できるか ──
let negOk = false;
const intact = [...latest.values()].find((b) => (now.get(b.id) ?? 0) > 0 && b.record_count === now.get(b.id));
if (intact) {
  let removed = false;
  const broken: Snap = { batches: snap.batches, rows: snap.rows.filter((r) => { if (!removed && r.import_batch_id === intact.id) { removed = true; return false; } return true; }) };
  const k = `${intact.office_number}|${intact.processing_month}`;
  negOk = measure(broken).shrink[k] === 1;
}
console.log(`\n負のコントロール (減っていない事業所×月の行を写しから 1 行抜く → 1 行減と出るか): ${negOk ? "OK" : "★ NG"}`);

// ── 書式 CSV があれば「何が消えたか」を項目名で出す ──
const csvItems = new Map<string, Map<string, number>>(); // office|month -> item -> 行数
if (FORMS_DIR) {
  const { parseOfficeFormFile } = await import("../src/lib/csv/office-form-parser");
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : /\.csv$/i.test(e.name) ? [join(d, e.name)] : []);
  for (const f of walk(FORMS_DIR)) {
    const m = /(\d{6})\.csv$/i.exec(f); if (!m) continue;
    const parsed = await parseOfficeFormFile(new File([readFileSync(f)], f.split(/[\\/]/).pop()!));
    const offices = [...new Set(parsed.data.map((r) => r.office_number))];
    if (offices.length !== 1) continue;
    const map = new Map<string, number>();
    for (const r of parsed.data) map.set(r.item_name, (map.get(r.item_name) ?? 0) + 1);
    csvItems.set(`${offices[0]}|${m[1]}`, map);
  }
  console.log(`(FORMS_DIR の書式 CSV ${csvItems.size} 事業所×月 と照らして、消えた項目を出します)`);
}

console.log("\n--- 取込後に行が減った 事業所×月 ---");
for (const [k, d] of Object.entries(shrink).filter(([, v]) => v > 0).sort()) {
  const b = latest.get(k)!;
  let detail = "";
  const csv = csvItems.get(k);
  if (csv) {
    const cur = itemsNow.get(b.id) ?? new Map<string, number>();
    const lost = [...csv].map(([item, n]) => [item, n - (cur.get(item) ?? 0)] as const).filter(([, n]) => n > 0);
    const sumLost = lost.reduce((a, [, n]) => a + n, 0);
    detail = `  消えた項目: ${lost.map(([i, n]) => `${i}×${n}`).join(" ") || "(CSV と今の行で項目の差が出ない)"}${sumLost !== d ? `  ⚠ CSV から数えた差 ${sumLost} ≠ 減った行 ${d} (CSV が取り込んだものと違う版かもしれない)` : ""}`;
  }
  console.log(`  ${k}  取込時 ${b.record_count} → 今 ${now.get(b.id) ?? 0}  (${d} 行減)  ${String(b.created_at).slice(0, 10)} ${b.file_names?.[0] ?? ""}${detail ? "\n  " + detail : ""}`);
}

console.log("\n⚠ この検査が見ていないもの:");
console.log("   ・取込バッチを通らずに入った行 (import_batch_id が空。総括表から作った行など) — 消えても分からない");
console.log("   ・値だけ書き換えられた行 (UPDATE) — 行数が変わらないので見えない");
console.log("   ・取り込む前に落ちた行 (パーサが読まなかった列) — record_count 自体に入っていない");
console.log("   ・古いバッチ — 取り込み直しで置き換わったものとみなして数えない");
console.log("   ・消えた行が正当かどうか — 数を見るだけ。理由は人が確かめる");

// ── 基準値 ──
type Baseline = { _readme: string[]; total_shrink_rows: number; by_office_month: Record<string, number> };
const current: Baseline = {
  _readme: [
    "check:office-form-shrink の基準値。事業所×月ごとに、いちばん新しい書式バッチの 取込時行数 − 今の行数。",
    "★ 0 を目指す検査ではない。正当な削除 (書式の誤入力を消した・重複を消した 等) がありうるので 0 にできない。",
    "★ 2026-09-27 時点で入っている主な中身:",
    "   ・import_soukatsu_meeting_counts.mjs が書式の 会議N件数 を消していたぶん (31 事業所×月)。",
    "     script は同日に直した (DELETE を import_batch_id=is.null に限定)。消えた件数を書式 CSV から戻すかは user 判断。",
    "     戻したら この数は減る (減るぶんには落ちない) ので、そのとき --update する。",
    "   ・ちはら台 202606 の 27 行 (出張km) 全消え / 五井 の説明の付かない減り — 理由は未確定。",
    "★ 増えた = 取込のあとに また誰かが書式の行を消した。どの script かを先に確かめてから --update すること。",
  ],
  total_shrink_rows: totalShrink,
  by_office_month: Object.fromEntries(Object.entries(shrink).filter(([, v]) => v > 0).sort()),
};

if (UPDATE) {
  if (!negOk) { console.log("\n★ 負のコントロールが通らないので 基準値を更新しません"); process.exit(1); }
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + "\n");
  console.log(`\n基準値を更新しました: ${totalShrink} 行`);
  process.exit(0);
}

let base: Baseline;
try { base = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline; }
catch { console.log("\n⚠ 基準値のファイルがありません。--update で作ってください"); process.exit(1); }

const worse: string[] = [];
for (const [k, n] of Object.entries(current.by_office_month)) {
  const b = base.by_office_month[k] ?? 0;
  if (n > b) worse.push(`${k} が ${b} → ${n} 行減に増えました`);
}
const better = Object.entries(base.by_office_month).filter(([k, n]) => (current.by_office_month[k] ?? 0) < n);
console.log(`\n基準値 ${base.total_shrink_rows} 行 / 今回 ${totalShrink} 行  (改善 ${better.length} 事業所×月)`);
if (!negOk) { console.log("\n★ 負のコントロールが通らないので PASS を出しません"); process.exit(1); }
if (worse.length) {
  console.log("\nFAIL — 取込後に消えた行が増えています");
  for (const w of worse) console.log("  " + w);
  process.exit(1);
}
console.log("\nPASS — 基準値より増えていません");
