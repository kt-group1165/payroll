/**
 * 旧システムの「移動手当・残業時間計算結果ダウンロード（業務者）/ 日計」CSV を取り込む (2026-09-20)。
 *
 *   node migrations/import_legacy_travel_daily.mjs            # DRY RUN
 *   node migrations/import_legacy_travel_daily.mjs --execute
 *   SRC=<dir> node migrations/import_legacy_travel_daily.mjs  # 置き場を変えるとき
 *
 * なぜ: 移動手当・移動時間を Google Distance Matrix の推定で出していたため、総括表との残差の
 *   最大要因になっていた (3〜7月で約1,000件)。旧システムは 1職員×1日 の確定値を CSV で出せる。
 * 出し方: 旧システム → データ出力 → 「移動手当・残業時間計算結果ダウンロード（業務者）」
 *   → 会社を選ぶ / 出力年月 YYYY/MM / 出力タイプ = 日計 → ダウンロード
 *   対象法人は ケイ・ティ・サービス / サービスワン / 儀八 / 至誠堂 の 4 社
 *   (ムツミ商事は薬局のみで対象外。2026-09-20 user 確認)
 * 置き場: Box\10F内共有\ほのぼのから出力\<YYYYMM>_<法人名>(残業時間・移動手当日計).csv (Shift-JIS)
 *
 * 行の種類: 日付が YYYY/MM/DD の日次行だけを取り込む。「小計」「合計」行は事業所コードが空なので落とす。
 * 冪等: (work_date, office_number, employee_number) の UNIQUE で upsert。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const EXECUTE = process.argv.includes("--execute");
const SRC = process.env.SRC || join(process.env.USERPROFILE || "", "Box", "10F内共有", "ほのぼのから出力");

const env = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL + "/rest/v1/";
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };

if (!existsSync(SRC)) { console.error(`✗ 置き場が無い: ${SRC}`); process.exit(1); }

const dec = new TextDecoder("shift_jis");
const hm = (s) => { const [a, b] = String(s ?? "0:0").split(":").map(Number); return (a || 0) * 60 + (b || 0); };
const nn = (s) => String(s ?? "").trim().replace(/^0+/, "");

const COL = {
  service_min: "サービス", travel_paid_min: "移動",
  ot_service_min: "残業(サービス)", ot_travel_min: "残業(移動)",
  night_service_min: "深夜勤務(サービス)", night_travel_min: "深夜勤務(移動)",
  night_ot_service_min: "深夜残業(サービス)", night_ot_travel_min: "深夜残業(移動)",
  hol_ot_service_min: "法定休日残業(サービス)", hol_ot_travel_min: "法定休日残業(移動)",
  night_hol_ot_service_min: "深夜法定休日残業(サービス)", night_hol_ot_travel_min: "深夜法定休日残業(移動)",
  service_total_min: "サービス合計", doukou_min: "同行",
  travel_pay_total_min: "移動手当時間合計", total_min: "総合計", travel_full_min: "移動時間",
};

const files = readdirSync(SRC).filter((f) => /^\d{6}_.*残業時間・移動手当日計.*\.csv$/i.test(f) && !f.includes("ムツミ商事"));
if (files.length === 0) { console.error(`✗ 対象 CSV が 1 本も無い: ${SRC}`); process.exit(1); }

const rows = [];
const skipped = { total: 0, subtotal: 0, noOffice: 0 };
const perFile = [];
for (const f of files.sort()) {
  const ym = /^(\d{6})_/.exec(f)[1];
  const corp = /^\d{6}_(.+?)\(/.exec(f)[1].trim();
  const lines = dec.decode(readFileSync(join(SRC, f))).split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(",").map((x) => x.replace(/^"|"$/g, ""));
  const I = Object.fromEntries(head.map((h, i) => [h, i]));
  for (const key of ["日付", "従業員コード", "氏名", "給与形態", "移動手当", "事業所コード", ...Object.values(COL)]) {
    if (I[key] === undefined) { console.error(`✗ ${f}: 列「${key}」が無い (出力設定が違う可能性)`); process.exit(1); }
  }
  let n = 0;
  for (const l of lines.slice(1)) {
    const c = l.split('","').map((x) => x.replace(/^"|"$/g, ""));
    const d = c[I["日付"]];
    if (d === "合計") { skipped.total++; continue; }
    if (d === "小計") { skipped.subtotal++; continue; }
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(d)) { skipped.subtotal++; continue; }
    const office = c[I["事業所コード"]];
    if (!office) { skipped.noOffice++; continue; }
    const r = {
      work_date: d.replace(/\//g, "-"),
      processing_month: ym,
      office_number: office,
      employee_number: nn(c[I["従業員コード"]]),
      employee_name: c[I["氏名"]] || null,
      pay_type: c[I["給与形態"]] || null,
      travel_allowance: Number(c[I["移動手当"]] || 0),
      source_corp: corp,
    };
    for (const [k, jp] of Object.entries(COL)) r[k] = hm(c[I[jp]]);
    rows.push(r);
    n++;
  }
  perFile.push(`  ${f}  ${n} 行`);
}

// 同じ (日, 事業所, 職員) が 2 本の CSV に出る。1 人が 2 法人に在籍していると 両方の CSV に同じ行が載るため。
//   2026-03〜07 の実測では 5,488 行が重複し、★ 全件 1 バイトも違わなかった ので先勝ちで潰す。
//   内容が違うものが出たら 止める (どちらが正か決められないため)。
const byKey = new Map();
let dup = 0;
const conflicts = [];
for (const r of rows) {
  const k = `${r.work_date}|${r.office_number}|${r.employee_number}`;
  const prev = byKey.get(k);
  if (prev) {
    dup++;
    const same = Object.keys(r).every((x) => x === "source_corp" || String(prev[x]) === String(r[x]));
    if (!same) conflicts.push(`${k}  ${prev.source_corp} と ${r.source_corp} で内容が違う`);
    continue;
  }
  byKey.set(k, r);
}
if (conflicts.length) {
  console.error(`✗ 同じキーで内容の違う行が ${conflicts.length} 件ある。どちらが正か決められないので止める`);
  for (const c of conflicts.slice(0, 10)) console.error("  ", c);
  process.exit(2);
}
const uniq = [...byKey.values()];

console.log(perFile.join("\n"));
console.log(`\n取込対象 ${uniq.length} 行 (重複 ${dup} / 合計行 ${skipped.total} / 小計行 ${skipped.subtotal} / 事業所コード空 ${skipped.noOffice})`);
const months = [...new Set(uniq.map((r) => r.processing_month))].sort();
const offices = new Set(uniq.map((r) => r.office_number));
const emps = new Set(uniq.map((r) => `${r.office_number}|${r.employee_number}`));
console.log(`  月 ${months.join(",")} / 事業所 ${offices.size} / 職員(事業所別) ${emps.size}`);
console.log(`  移動手当 計 ¥${uniq.reduce((s, r) => s + r.travel_allowance, 0).toLocaleString()}`);
// 移動手当は 時給者だけ。旧システムの CSV は 一律 20円/分 で出る (職員ごとの単価は反映されない)
const bad = uniq.filter((r) => r.pay_type === "時給" && r.travel_paid_min * 20 !== r.travel_allowance);
if (bad.length) console.log(`  ⚠ 時給者で 移動手当 ≠ 移動分×20 が ${bad.length} 行 (例 ${bad.slice(0, 3).map((r) => `${r.work_date} ${r.employee_name} ${r.travel_paid_min}分/¥${r.travel_allowance}`).join(" / ")})`);
const paid = uniq.filter((r) => r.pay_type === "月給" && r.travel_allowance > 0);
if (paid.length) console.log(`  ⚠ 月給者に移動手当が付いている行が ${paid.length}`);

if (!EXECUTE) { console.log("\nDRY RUN (--execute で書き込み)"); process.exit(0); }

for (let i = 0; i < uniq.length; i += 500) {
  const chunk = uniq.slice(i, i + 500);
  const res = await fetch(`${SB}payroll_legacy_travel_daily?on_conflict=work_date,office_number,employee_number`, {
    method: "POST",
    headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(chunk),
  });
  if (!res.ok) { console.error(`✗ 書き込み失敗 (${i}行目〜): ${await res.text()}`); process.exit(1); }
  process.stdout.write(`\r  ${Math.min(i + 500, uniq.length)} / ${uniq.length}`);
}
console.log(`\n完了 ${uniq.length} 行`);
