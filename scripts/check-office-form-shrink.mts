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
/** 事業所書式の行。import_batch_id が空の行 (総括表①・旧システム・手入力補完) も持つ (金額の見積りに使う) */
type Row = { import_batch_id: string | null; item_name: string; office_number: string; processing_month: string; employee_number: string; record_type: string; numeric_value: number | null };
type UnitPrice = { office_id: string; effective_from: string; travel_unit_price: number | null; commute_unit_price: number | null; meeting_unit_price: number | null };
type OfficeRow = { id: string; office_number: string; travel_unit_price: number | null; commute_unit_price: number | null; meeting_unit_price: number | null };
type Snap = { batches: Batch[]; rows: Row[]; unitPrices: UnitPrice[]; offices: OfficeRow[]; settings: { key: string; value: unknown }[] };

console.log("=== check:office-form-shrink  取込後に消えた事業所書式の行 ===\n");

let snap: Snap;
const cached = SNAPSHOT && existsSync(SNAPSHOT) ? JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Partial<Snap> : null;
if (cached?.unitPrices && cached.rows?.[0] && "numeric_value" in cached.rows[0]) {
  snap = cached as Snap;
  console.log(`(SNAPSHOT を使いました: ${SNAPSHOT})`);
} else {
  if (cached) console.log("(SNAPSHOT が古い形なので 読み直します)");
  const [batches, rows, unitPrices, offices, settings] = await Promise.all([
    restAll<Batch>("payroll_import_batches?select=id,import_type,file_names,record_count,processing_month,office_number,created_at&import_type=eq.office_form"),
    restAll<Row>("payroll_office_form_records?select=id,import_batch_id,item_name,office_number,processing_month,employee_number,record_type,numeric_value"),
    restAll<UnitPrice>("payroll_office_unit_prices?select=id,office_id,effective_from,travel_unit_price,commute_unit_price,meeting_unit_price"),
    restAll<OfficeRow>("payroll_offices?select=id,office_number,travel_unit_price,commute_unit_price,meeting_unit_price"),
    restAll<{ key: string; value: unknown }>("payroll_app_settings?select=key,value&key=in.(meeting_unit_prices,meeting_fee_unpaid_offices)", "key"),
  ]);
  snap = { batches, rows, unitPrices, offices, settings };
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
  const broken: Snap = { ...snap, rows: snap.rows.filter((r) => { if (!removed && r.import_batch_id === intact.id) { removed = true; return false; } return true; }) };
  const k = `${intact.office_number}|${intact.processing_month}`;
  negOk = measure(broken).shrink[k] === 1;
}
console.log(`\n負のコントロール (減っていない事業所×月の行を写しから 1 行抜く → 1 行減と出るか): ${negOk ? "OK" : "★ NG"}`);

// ── 書式 CSV があれば「何が消えたか」と「金額に効いたか」を出す ──
// CSV は バッチに記録されたファイル名で引く (ファイル名の日付は出力日で 稼働月ではないため)。
// 見つからなければ <FORMS_DIR>/<タグ>/<YYYYMM>.csv の形 (中の事業所番号で照合) も探す。
type CsvRec = { office_number: string; employee_number: string; record_type: string; item_name: string; numeric_value?: number | null };
const csvByKey = new Map<string, { recs: CsvRec[]; rawKm: number; file: string }>();
const nn = (s: unknown) => String(s ?? "").trim().replace(/^0+/, "");
if (FORMS_DIR) {
  const { parseOfficeFormFile } = await import("../src/lib/csv/office-form-parser");
  const { readCsvFile } = await import("../src/lib/csv/decoder");
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : /\.csv$/i.test(e.name) ? [join(d, e.name)] : []);
  const files = walk(FORMS_DIR);
  const baseOf = (f: string) => f.split(/[\\/]/).pop()!;
  const load = async (f: string) => {
    const name = f.split(/[\\/]/).pop()!;
    const parsed = await parseOfficeFormFile(new File([readFileSync(f)], name));
    // 重複 km 行 (パーサが先頭だけ残す行) を数えるため 生の行も読む
    const raw: string[][] = await readCsvFile(new File([readFileSync(f)], name));
    let rawKm = 0;
    for (const r of raw.slice(1)) for (let n = 1; n <= 20; n++) {
      const ni = raw[0].indexOf(`数値項目名${n}`), vi = raw[0].indexOf(`数値${n}`);
      if (ni >= 0 && vi >= 0 && (r[ni] === "通勤km" || r[ni] === "出張km") && Number(String(r[vi] ?? "").replace(/,/g, "")) > 0) rawKm++;
    }
    return { recs: parsed.data as CsvRec[], rawKm, file: name };
  };
  for (const [k, b] of latest) {
    if (!((shrink[k] ?? 0) > 0)) continue;
    // ⚠ "202606.csv" のような名前は事業所をまたいで重複する。同名の候補を全部読み、中の事業所番号で照合する
    const cands = [
      ...files.filter((x) => b.file_names?.[0] && baseOf(x) === b.file_names[0]),
      ...files.filter((x) => baseOf(x) === `${b.processing_month}.csv`),
    ];
    for (const x of [...new Set(cands)]) {
      const c = await load(x);
      if (c.recs[0]?.office_number === b.office_number) { csvByKey.set(k, c); break; }
    }
  }
  console.log(`(FORMS_DIR の書式 CSV と照らせた 事業所×月 ${csvByKey.size} / 減った ${Object.values(shrink).filter((v) => v > 0).length})`);
}

// 単価 (事業所×月の月末までに有効な行。項目ごとに 空でない最新の値。無ければ payroll_offices)
const officeByNum = new Map(snap.offices.map((o) => [o.office_number, o]));
const priceOf = (office: string, month: string, field: "travel_unit_price" | "commute_unit_price" | "meeting_unit_price"): number => {
  const o = officeByNum.get(office);
  const end = `${month.slice(0, 4)}-${month.slice(4, 6)}-31`;
  const rows = snap.unitPrices.filter((u) => u.office_id === o?.id && u.effective_from <= end && u[field] != null)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  return Number(rows[0]?.[field] ?? o?.[field] ?? 0);
};
const meetingPrices = ((snap.settings.find((s) => s.key === "meeting_unit_prices")?.value as { prices?: Record<string, Record<string, number>> } | undefined)?.prices) ?? {};
const unpaid = new Set(((snap.settings.find((s) => s.key === "meeting_fee_unpaid_offices")?.value as { offices?: string[] } | undefined)?.offices) ?? []);
const { computeMeetingFee } = await import("../src/lib/payroll/payroll-calc");
const rowsByOfficeMonth = new Map<string, Row[]>();
for (const r of snap.rows) { const k = `${r.office_number}|${r.processing_month}`; (rowsByOfficeMonth.get(k) ?? rowsByOfficeMonth.set(k, []).get(k)!).push(r); }
const isMeet = (item: string) => /^会議[123]件数$/.test(item);
const isKm = (item: string) => item === "通勤km" || item === "出張km";

type Impact = { rows: number; yen: number; lines: string[] };
/** 1 事業所×月ぶん: 書式 CSV どおりの金額と 今 (どの経路の行も含む) の金額の差を 職員ごとに出す */
function impactOf(k: string, c: { recs: CsvRec[] }, b: Batch): { meet: Impact; km: Impact; lostMeet: number; lostKm: number } {
  const [office, month] = k.split("|");
  const nowRows = rowsByOfficeMonth.get(k) ?? [];
  const emps = new Set([...c.recs.map((r) => nn(r.employee_number)), ...nowRows.map((r) => nn(r.employee_number))]);
  const meet: Impact = { rows: 0, yen: 0, lines: [] }, km: Impact = { rows: 0, yen: 0, lines: [] };
  let lostMeet = 0, lostKm = 0;
  for (const e of emps) {
    const csvE = c.recs.filter((r) => nn(r.employee_number) === e);
    const nowE = nowRows.filter((r) => nn(r.employee_number) === e);
    const batchE = nowE.filter((r) => r.import_batch_id === b.id);
    // 会議件数
    const lm = csvE.filter((r) => isMeet(r.item_name) && Number(r.numeric_value) > 0).length - batchE.filter((r) => isMeet(r.item_name)).length;
    if (lm > 0) {
      lostMeet += lm;
      const toRec = (r: { record_type: string; item_name: string; numeric_value?: number | null }) => ({ record_type: r.record_type, item_name: r.item_name, numeric_value: r.numeric_value ?? null } as never);
      const unit = priceOf(office, month, "meeting_unit_price");
      const fCsv = unpaid.has(office) ? 0 : computeMeetingFee(csvE.filter((r) => isMeet(r.item_name)).map(toRec), unit, meetingPrices[office]);
      const fNow = unpaid.has(office) ? 0 : computeMeetingFee(nowE.filter((r) => isMeet(r.item_name)).map(toRec), unit, meetingPrices[office]);
      if (fCsv !== fNow) { meet.rows += lm; meet.yen += fNow - fCsv; meet.lines.push(`職員${e} 会議費 書式どおり¥${fCsv} / 今¥${fNow}`); }
    }
    // km (重複行を除いたあと。今は どの経路の行でも 1 行目を使う前提で 合計を比べる)
    for (const item of ["出張km", "通勤km"] as const) {
      const csvV = csvE.filter((r) => r.item_name === item && Number(r.numeric_value) > 0);
      const lk = csvV.length - batchE.filter((r) => r.item_name === item && Number(r.numeric_value) > 0).length;
      if (lk <= 0) continue;
      lostKm += lk;
      // 書式バッチの行がまだ残っているなら 値の差は「書き換え」(UPDATE) であって 削除の影響ではない。数えない
      //   実例: 五井 西川裕美子 202604 の 通勤km 825.3 → 0 は fix_nishikawa_commute_to_trip.mjs (2026-09-24 user 了承)
      if (batchE.some((r) => r.item_name === item)) continue;
      const a = csvV.reduce((s, r) => s + Number(r.numeric_value), 0);
      const nowV = nowE.filter((r) => r.item_name === item && Number(r.numeric_value) > 0);
      const n = nowV.length ? Number(nowV[0].numeric_value) : 0;   // 今 1 行目 (パーサ・給与計算と同じ「先頭だけ」)
      if (Math.abs(a - n) > 1e-9) {
        const price = priceOf(office, month, item === "出張km" ? "travel_unit_price" : "commute_unit_price");
        const y = Math.round((n - a) * price);
        km.rows += lk; km.yen += y; km.lines.push(`職員${e} ${item} 書式${a} / 今${n} (×${price}円 ≈ ¥${y})`);
      }
    }
  }
  return { meet, km, lostMeet, lostKm };
}

console.log("\n--- 取込後に行が減った 事業所×月 ---");
let effRows = 0, effYen = 0, legitDup = 0, knownRows = 0, unknownRows = 0;
const noCsv: string[] = [];
for (const [k, d] of Object.entries(shrink).filter(([, v]) => v > 0).sort()) {
  const b = latest.get(k)!;
  let detail = "";
  const c = csvByKey.get(k);
  if (c) {
    const cur = itemsNow.get(b.id) ?? new Map<string, number>();
    const csvCount = new Map<string, number>(); for (const r of c.recs) csvCount.set(r.item_name, (csvCount.get(r.item_name) ?? 0) + 1);
    const lost = [...csvCount].map(([item, n]) => [item, n - (cur.get(item) ?? 0)] as const).filter(([, n]) => n > 0);
    const dedupKm = c.recs.filter((r) => isKm(r.item_name) && Number(r.numeric_value) > 0).length;
    const dup = c.rawKm - dedupKm;                       // パーサが落とす重複 km 行 (取込時は数えられていた)
    const sumLost = lost.reduce((a, [, n]) => a + n, 0) + dup;
    const im = impactOf(k, c, b);
    legitDup += dup; knownRows += sumLost === d ? d : 0; if (sumLost !== d) unknownRows += d;
    effRows += im.meet.rows + im.km.rows; effYen += im.meet.yen + im.km.yen;
    detail = `  消えた項目: ${[...lost.map(([i, n]) => `${i}×${n}`), ...(dup ? [`重複km×${dup} (正当)`] : [])].join(" ") || "(差が出ない)"}`
      + (sumLost !== d ? `  ⚠ CSV から数えた ${sumLost} ≠ 減った行 ${d}` : "  ✓")
      + `\n      金額に効いた: ${im.meet.rows + im.km.rows} 行 / 今と書式どおりの差 ¥${(im.meet.yen + im.km.yen).toLocaleString()}`
      + [...im.meet.lines, ...im.km.lines].slice(0, 6).map((s) => `\n        ${s}`).join("");
  } else if (FORMS_DIR) { noCsv.push(`${k} ${b.file_names?.[0] ?? ""}`); unknownRows += d; }
  console.log(`  ${k}  取込時 ${b.record_count} → 今 ${now.get(b.id) ?? 0}  (${d} 行減)  ${String(b.created_at).slice(0, 10)} ${b.file_names?.[0] ?? ""}${detail ? "\n  " + detail : ""}`);
}
if (FORMS_DIR) {
  console.log(`\n★ 消えた ${totalShrink} 行の内訳: 書式 CSV で説明できた ${knownRows} 行 (うち重複 km ${legitDup} 行は正当) / 説明できない・CSV 無し ${unknownRows} 行`);
  console.log(`★ このうち金額に効いたのは ${effRows} 行 / 今の値 − 書式どおりの値 = ¥${effYen.toLocaleString()} (マイナス = 書式どおりより当方が少ない)`);
  console.log("   ⚠ 金額は 会議費 (computeMeetingFee) と km × 事業所単価 の見積り。給与計算を回した結果ではない");
  if (noCsv.length) console.log(`   CSV が手元に無い: ${noCsv.join(" / ")}`);
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
    "   ・ちはら台 202606 の 27 行 (出張km) — import_legacy_office_form.mjs が 旧システムの事業所入力 55 行に丸ごと置き換えた",
    "     (書式が 30 行未満だったので 書式が無い月と判定された)。script は 2026-09-27 に直した。",
    "   ・五井 202604〜07 の 3/3/2/3 行 — ★ 正当な削除。書式の 重複 km 行 (同じ職員の 通勤km/出張km が 2 行) を",
    "     dedupe_office_form_km_rows.mts (6783620, 2026-09-18) が 先頭だけ残して消した。総括表も先頭の行だけを使っている。",
    "     生 CSV の km 行 − 先頭だけ残した km 行 + 会議N件数 = 減った行 が 4 か月とも一致 (3+0 / 3+7 / 2+9 / 3+1)。",
    "★ 内訳と金額影響は FORMS_DIR=<書式 CSV の置き場> を付けて回すと出る。2026-09-27 時点:",
    "   400 行中 399 行を書式 CSV で説明できた (残り 1 行 = 木更津 202603 kisarazu_202603.csv が手元に無い。CSV があれば出せる)。",
    "   ★ 金額に効いたのは 30 行 / 今 − 書式どおり = ¥-48,150 (当方が少ない側)。",
    "     会議件数 29 行 ¥-41,800 (①に件数が無い・少ない人) / ちはら台 202606 出張km 1 行 ¥-6,350 (旧システムの 281.8km。",
    "     書式の 781.8km が総括表の距離と一致)。残り 370 行は ①・旧システムに同じ値があって 金額は変わっていない。",
    "   ⚠ 書式バッチの行が残っていて 値だけ違うもの (UPDATE) は 削除の影響として数えない (五井 西川 通勤km 825.3→0 は user 了承の是正)。",
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
