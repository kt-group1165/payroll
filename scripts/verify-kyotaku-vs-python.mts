// 居宅ケアマネ給与計算 (kyotaku-calc.ts) を 移植元 Python の実出力と突合する
//
//   npx tsx scripts/verify-kyotaku-vs-python.mts
//   NEGATIVE_CONTROL=1 npx tsx scripts/verify-kyotaku-vs-python.mts   # 負のコントロール
//
// ─────────────────────────────────────────────────────────────────────────
// 何を期待値にしているか (VERIFICATION_RULES 3-2 / 3-5)
//   実装 (kyotaku-calc.ts) の出力は一切期待値にしていない。期待値は 2 系統だけ:
//     (A) apps/居宅給与計算/output/ケアマネ別集計.xlsx  ← Python 版 集計.py の実出力
//         入力 CSV (元データ/袖ヶ浦2503取り込み用.CSV) と設定 sheet も同じ xlsx から読む。
//         xlsx はこの script が zip/XML を直接読む (手写しによる転記ミスを排除)。
//     (B) SPEC.md §3.2/§3.3/§3.5/§3.6 の式から手で導いた fixture (下記 Layer B)
//         実データに 1 件も出てこない経路 (要支援・月遅れ・基本給割れ・確定差異) 用。
//
// この検査が証明していないこと (VERIFICATION_RULES 3-1)
//   ・売上表 / 利用者内訳 / 差異明細 sheet (kyotaku-calc.ts の守備範囲外)
//   ・地域区分 (regional rates) — kyotaku-calc は rates を受け取るが給与計算では使わない
//   ・件数 8 行の内訳 (当月請求 / 翌月請求 の分離)。calcSalary が返す details は
//     両者を合算した normal_kaigo しか持たないので、合計でしか照合できない
//   ・DB からの取り出し (SWR hook) と画面表示。純関数の入出力だけを見ている
//   ・出張距離手当 / 資格手当 / 固定 / 特定処遇改善 (Python 版に無い TS 独自の項目)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

import { parseKokuhoCsv } from "../src/lib/csv/kokuho-parser";
import {
  addMonths,
  calcAdjustments,
  calcPaymentForMonth,
  calcSalary,
  getBaseUnit,
  monthDiff,
  normalizeMonth,
  type CalcConfig,
  type CalcConfigWithConfirmations,
  type Confirmation,
  type EmployeeSetting,
  type KyotakuRecord,
  type ServiceUnit,
} from "../src/lib/payroll/kyotaku-calc";

const HERE = dirname(fileURLToPath(import.meta.url));
const KYOTAKU_DIR = resolve(HERE, "../../居宅給与計算");
const XLSX_PATH = resolve(KYOTAKU_DIR, "output/ケアマネ別集計.xlsx");
const CSV_PATH = resolve(KYOTAKU_DIR, "元データ/袖ヶ浦2503取り込み用.CSV");

/** 期待値を 1 か所だけ壊して、検査が本当に落ちるかを見る (VERIFICATION_RULES 3-9) */
const NEGATIVE_CONTROL = process.env.NEGATIVE_CONTROL === "1";

const BASELINE = join(HERE, "verify-kyotaku-vs-python-baseline.json");
const UPDATE = process.argv.includes("--update");

// =====================================================================
// 0. 最小 xlsx リーダ (zip + sheet XML)
//    期待値を手で写さないため。openpyxl 相当のことを 読み取り専用でやる。
// =====================================================================

type Zip = Map<string, Buffer>;

function readZip(path: string): Zip {
  const buf = readFileSync(path);
  // End of Central Directory を末尾から探す
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`zip の EOCD が見つからない: ${path}`);
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);

  const out: Zip = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error("zip の central directory が壊れている");
    }
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);

    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    out.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));

    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

/** シート名 → { "A3": "値" } の Map */
function readSheets(path: string): Map<string, Map<string, string>> {
  const zip = readZip(path);
  const get = (name: string): string => {
    const b = zip.get(name);
    if (!b) throw new Error(`${path} に ${name} が無い`);
    return b.toString("utf8");
  };

  // 共有文字列
  const shared: string[] = [];
  const ssBuf = zip.get("xl/sharedStrings.xml");
  if (ssBuf) {
    const xml = ssBuf.toString("utf8");
    for (const si of xml.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
      let text = "";
      for (const t of si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []) {
        text += unescapeXml(t.replace(/^<t[^>]*>/, "").replace(/<\/t>$/, ""));
      }
      shared.push(text);
    }
  }

  // rId → part path
  const rels = get("xl/_rels/workbook.xml.rels");
  const relMap = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*\/>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1];
    const target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) {
      relMap.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    }
  }

  // sheet 名 → part path
  const wb = get("xl/workbook.xml");
  const sheets = new Map<string, Map<string, string>>();
  for (const m of wb.matchAll(/<sheet\b[^>]*\/>/g)) {
    const name = /name="([^"]+)"/.exec(m[0])?.[1];
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
    if (!name || !rid) continue;
    const part = relMap.get(rid);
    if (!part) continue;
    const xml = get(part);

    const cells = new Map<string, string>();
    for (const c of xml.matchAll(/<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const body = c[3] ?? "";
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
      if (!ref) continue;
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? "n";
      let value: string | null = null;
      if (type === "inlineStr") {
        const t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body);
        value = t ? unescapeXml(t[1]) : null;
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        if (v) {
          value = type === "s" ? (shared[Number(v[1])] ?? "") : unescapeXml(v[1]);
        }
      }
      if (value !== null && value !== "") cells.set(ref, value);
    }
    sheets.set(unescapeXml(name), cells);
  }
  return sheets;
}

const COL_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const col = (i: number): string => {
  // 1-based。26 列で足りる範囲しか扱わない
  if (i < 1 || i > 26) throw new Error(`列 ${i} は未対応`);
  return COL_LETTERS[i - 1];
};

// =====================================================================
// 1. 突合エンジン
// =====================================================================

type Cmp = {
  name: string;
  want: number | null;
  got: number | null;
  /** Python と TS で意図的に挙動が違うと分かっている項目 (落ちても FAIL にしない) */
  xfail?: string;
};

const results: Cmp[] = [];
let checkedCells = 0;

function eq(name: string, got: number | null, want: number | null): void {
  checkedCells++;
  results.push({ name, want, got });
}

function eqXfail(name: string, got: number | null, want: number | null, why: string): void {
  checkedCells++;
  results.push({ name, want, got, xfail: why });
}

const near = (a: number | null, b: number | null): boolean => {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < 0.5;
};

// =====================================================================
// 2. 入力 (すべて xlsx / CSV から。実装の出力は使わない)
// =====================================================================

const sheets = readSheets(XLSX_PATH);
const need = (n: string): Map<string, string> => {
  const s = sheets.get(n);
  if (!s) throw new Error(`xlsx に sheet「${n}」が無い: ${XLSX_PATH}`);
  return s;
};

// ── 給与設定 sheet → EmployeeSetting[] ──────────────────────────────────
//  Python の base は 1 列 (基本給)。TS は honnin+shokuno+kotei_zangyo の 3 列合成なので
//  honnin_kyu に基本給を入れ、残り 2 列は NULL にして base を一致させる。
//  shikaku / kotei / tokutei / 出張距離手当 は Python 版に無い項目なので 0 に固定する。
const settingsSheet = need("給与設定");
const settings: EmployeeSetting[] = [];
for (let r = 2; r <= 200; r++) {
  const name = settingsSheet.get(`A${r}`);
  if (!name) continue;
  settings.push({
    staff_name: name,
    honnin_kyu: Number(settingsSheet.get(`B${r}`) ?? 0),
    shokuno_kyu: null,
    kotei_zangyo: null,
    shikaku_teate: null,
    kotei: null,
    tokutei_shogu: null,
    kaigo_rate: Number(settingsSheet.get(`C${r}`) ?? 0),
    shien_rate: Number(settingsSheet.get(`D${r}`) ?? 0),
  });
}

// ── 単位数 sheet → 2 通りの ServiceUnit[] ───────────────────────────────
//  Python の加算手当は「フォーマット sheet の ITEMS」でも絞られる。ITEMS が無い今回は
//  DEFAULT_ITEMS (SPEC §2.1) が効くので、単位数 sheet に居ても ITEMS に無い項目
//  (退院退所加算Ⅰ２ 等) は Python の加算手当に入らない。
//  TS 側の相当物は payroll_kyotaku_service_units master の中身なので、
//    variantMaster    = seed_kyotaku_units.mjs が投入する 11 行 (= 本番で使われる姿)
//    variantUnitSheet = 単位数 sheet 全 14 行 (= master に ITEMS 外を足したらどうなるか)
//  の 2 通りで回して、差が出るなら「master の中身が ITEMS ゲートを兼ねている」ことを示す。
const unitSheet = need("単位数");
const unitSheetRows: { item: string; count: number }[] = [];
for (let r = 2; r <= 200; r++) {
  const item = unitSheet.get(`A${r}`);
  const cnt = unitSheet.get(`B${r}`);
  if (!item || cnt === undefined) continue;
  unitSheetRows.push({ item, count: Number(cnt) });
}
const toUnit = (item: string, count: number): ServiceUnit => ({
  item_name: item,
  unit_count: count,
  is_addition: item.includes("加算"),
  is_office_addition: item.includes("特定事業所加算"),
});
const variantUnitSheet: ServiceUnit[] = unitSheetRows.map((u) => toUnit(u.item, u.count));

// SPEC §2.1 DEFAULT_ITEMS (フォーマット sheet が無いときに Python が使う項目リスト)
const DEFAULT_ITEMS = [
  "要支援１",
  "要支援２",
  "要介護１",
  "要介護２",
  "要介護３",
  "要介護４",
  "要介護５",
  "ターミナルケアマネジメント加算",
  "入院時情報連携加算Ⅰ",
  "入院時情報連携加算Ⅱ",
  "初回加算",
  "特定事業所加算Ⅱ",
  "退院退所加算Ⅰ１",
  "通院時情報連携加算",
];
const variantMaster: ServiceUnit[] = variantUnitSheet.filter(
  (u) => DEFAULT_ITEMS.includes(u.item_name) || !u.is_addition,
);

// ── 支給済み sheet → Confirmation[] ────────────────────────────────────
//  SPEC §2.5: B 列のヘッダは「提供年月」だが中身は支払い月。
const paidSheet = need("支給済み");
const confirmations: Confirmation[] = [];
for (let r = 2; r <= 500; r++) {
  const staff = paidSheet.get(`A${r}`);
  const pm = paidSheet.get(`B${r}`);
  const amt = paidSheet.get(`C${r}`);
  if (!staff || !pm || amt === undefined) continue;
  const norm = normalizeMonth(pm);
  if (!norm) throw new Error(`支給済み 行${r}: 支払い月が読めない "${pm}"`);
  confirmations.push({ staff_name: staff, pay_month: norm, amount: Number(amt) });
}

// ── 元データ CSV → KyotakuRecord[] (本番と同じ parseKokuhoCsv を通す) ───
const csvBuf = readFileSync(CSV_PATH);
const parsed = await parseKokuhoCsv(
  csvBuf.buffer.slice(csvBuf.byteOffset, csvBuf.byteOffset + csvBuf.byteLength) as ArrayBuffer,
);
const records: KyotakuRecord[] = parsed.rows.map((r) => ({
  service_month: r.service_month,
  billing_month: r.billing_month,
  staff_name: r.staff_name,
  detail_row_no: r.detail_row_no,
  insurer_name: r.insurer_name,
  service_name: r.service_name,
  unit_total: r.unit_total,
  care_level: r.care_level,
}));

// ── 給与計算 sheet → 期待値 ────────────────────────────────────────────
type Expected = {
  months: string[];
  staff: string[];
  // [staff][month][label] = 数値 (空欄は null)
  cell: Map<string, Map<string, Map<string, number | null>>>;
};

function readKyuyoSheet(): Expected {
  const ws = need("給与計算");
  const months: string[] = [];
  for (let c = 3; c <= 26; c++) {
    const v = ws.get(`${col(c)}2`);
    if (!v) break;
    const m = normalizeMonth(v);
    if (!m) throw new Error(`給与計算 sheet の月ヘッダが読めない: "${v}"`);
    months.push(m);
  }
  const staff: string[] = [];
  const cell = new Map<string, Map<string, Map<string, number | null>>>();
  let current: string | null = null;
  for (let r = 3; r <= 2000; r++) {
    const a = ws.get(`A${r}`);
    const b = ws.get(`B${r}`);
    if (a) {
      current = a;
      staff.push(a);
      cell.set(a, new Map(months.map((m) => [m, new Map()])));
    }
    if (!current || !b) continue;
    months.forEach((m, i) => {
      const raw = ws.get(`${col(3 + i)}${r}`);
      cell.get(current!)!.get(m)!.set(b, raw === undefined ? null : Number(raw));
    });
  }
  return { months, staff, cell };
}

const expected = readKyuyoSheet();

// ── 支払いサマリー sheet → 期待値 ──────────────────────────────────────
function readPaySummary(): {
  payMonths: string[];
  perStaff: Map<string, Map<string, number | null>>;
  officeTotal: Map<string, number | null>;
} {
  const ws = need("支払いサマリー");
  const payMonths: string[] = [];
  for (let c = 3; c <= 26; c++) {
    const v = ws.get(`${col(c)}2`);
    if (!v) break;
    const m = normalizeMonth(v);
    if (!m) throw new Error(`支払いサマリー の月ヘッダが読めない: "${v}"`);
    payMonths.push(m);
  }
  const perStaff = new Map<string, Map<string, number | null>>();
  const officeTotal = new Map<string, number | null>();
  let current: string | null = null;
  for (let r = 3; r <= 2000; r++) {
    const a = ws.get(`A${r}`);
    const b = ws.get(`B${r}`);
    if (a && a.startsWith("事業所合計")) {
      payMonths.forEach((m, i) => {
        const raw = ws.get(`${col(3 + i)}${r}`);
        officeTotal.set(m, raw === undefined ? null : Number(raw));
      });
      continue;
    }
    if (a) {
      current = a;
      perStaff.set(a, new Map());
    }
    if (!current || b !== "計算額") continue;
    payMonths.forEach((m, i) => {
      const raw = ws.get(`${col(3 + i)}${r}`);
      perStaff.get(current!)!.set(m, raw === undefined ? null : Number(raw));
    });
  }
  return { payMonths, perStaff, officeTotal };
}

const paySummary = readPaySummary();

// =====================================================================
// 3. 分母チェック (VERIFICATION_RULES 1-1 / 1-2 / 1-3)
//    0 件で「合格」を出さない。式の差が出る行が何行あるかまで数える。
// =====================================================================
const denominators: string[] = [];
const fatal: string[] = [];

const push = (label: string, n: number, min: number) => {
  denominators.push(`${label}: ${n}`);
  if (n < min) fatal.push(`${label} が ${n} 件 (最低 ${min} 必要) — 検査が成立しない`);
};

push("CSV 解析行", records.length, 1000);
push("CSV 解析エラー行(参考)", parsed.errors.length, 0);
push("給与設定 staff", settings.length, 5);
push("単位数 (sheet)", variantUnitSheet.length, 10);
push("単位数 (master 相当)", variantMaster.length, 8);
push("支給済み (確定)", confirmations.length, 5);
push("給与計算 sheet の staff", expected.staff.length, 5);
push("給与計算 sheet の月", expected.months.length, 3);
push("支払いサマリーの支払い月", paySummary.payMonths.length, 3);

// 「値のある行」が何行あるか — 0 埋めの表を検算しても何も証明しない (rule 1-3)
let nonZeroPlan = 0;
let nonZeroKazan = 0;
let zeroPlan = 0;
for (const s of expected.staff) {
  for (const m of expected.months) {
    const v = expected.cell.get(s)!.get(m)!;
    if ((v.get("プラン手当") ?? 0) > 0) nonZeroPlan++;
    else zeroPlan++;
    if ((v.get("加算手当") ?? 0) > 0) nonZeroKazan++;
  }
}
push("プラン手当 > 0 のセル", nonZeroPlan, 5);
push("プラン手当 = 0 のセル (基本給で吸収された側)", zeroPlan, 3);
push("加算手当 > 0 のセル", nonZeroKazan, 5);

if (fatal.length > 0) {
  console.log("★ 前提が成立しないので検査を中止する:");
  for (const f of fatal) console.log("   " + f);
  console.log("\n分母:\n   " + denominators.join("\n   "));
  process.exit(1);
}

// =====================================================================
// 4. Layer A — 実データ replay (期待値 = Python の実出力 xlsx)
// =====================================================================

const baseConfig = (units: ServiceUnit[]): CalcConfig => ({
  settings,
  units,
  rates: [], // 給与計算では地域単価を使わない (SPEC §8.5 固定 10 円) ことの確認も兼ねる
});
const confConfig = (units: ServiceUnit[]): CalcConfigWithConfirmations => ({
  ...baseConfig(units),
  confirmations,
});

const cfg = baseConfig(variantMaster);
const cfgC = confConfig(variantMaster);

for (const staff of expected.staff) {
  for (const month of expected.months) {
    const want = expected.cell.get(staff)!.get(month)!;
    const num = (label: string): number => want.get(label) ?? 0;

    const br = calcSalary(records, staff, month, cfg);
    const adj = calcAdjustments(records, staff, month, cfgC);
    const tag = `${staff} ${month.slice(0, 7)}`;

    // 件数 — sheet は 当月/翌月 が別行、calcSalary の details は合算値しか持たない
    eq(
      `${tag} 要介護件数(当月+翌月)`,
      br.details.normal_kaigo,
      num("要介護件数（当月請求）") + num("要介護件数（翌月請求）"),
    );
    eq(
      `${tag} 要支援件数(当月+翌月)`,
      br.details.normal_shien,
      num("要支援件数（当月請求）") + num("要支援件数（翌月請求）"),
    );
    eq(`${tag} 月遅れ要介護(翌々月)`, br.details.late1_kaigo, num("月遅れ要介護（翌々月請求）"));
    eq(`${tag} 月遅れ要支援(翌々月)`, br.details.late1_shien, num("月遅れ要支援（翌々月請求）"));
    eq(`${tag} 月遅れ要介護(3か月後)`, br.details.late2_kaigo, num("月遅れ要介護（3か月後請求）"));
    eq(`${tag} 月遅れ要支援(3か月後)`, br.details.late2_shien, num("月遅れ要支援（3か月後請求）"));

    // 給与
    eq(`${tag} 基本給`, br.base, num("基本給"));
    eq(`${tag} プラン手当`, br.plan, num("プラン手当"));
    eq(`${tag} 加算手当`, br.kazan, num("加算手当"));
    eq(`${tag} 調整手当`, adj.late_adj + adj.sayi_adj, num("調整手当"));
    // 合計額 = base + plan + kazan + 調整手当 (+ TS 独自の独立加算)。
    // 当月の chosei1/chosei2 は T+2 / T+3 払いなので当月の合計には入らない
    // (集計.py 728 行 `total = base + plan + kazan + chosei`、
    //  dashboard kyotaku-payroll-dashboard.tsx:1801 も同じ式)。
    // calcSalary().total は chosei1/2 を含むので引いてから比べる。
    eq(
      `${tag} 合計額`,
      br.total - br.chosei1 - br.chosei2 + adj.late_adj + adj.sayi_adj,
      num("合計額"),
    );

    // 支給済み (= 入力) と 差異 (= 表示側の派生値) の整合。
    // kyotaku-calc は 差異 を計算しないので、ここは「xlsx の中で閉じた恒等式」の確認。
    const paid = confirmations.find(
      (c) => c.staff_name === staff && c.pay_month === addMonths(month, 1),
    );
    eq(`${tag} 支給済み(入力の突合)`, paid?.amount ?? null, want.get("支給済み") ?? null);
    if ((paid?.amount ?? 0) > 0) {
      const total =
        br.total - br.chosei1 - br.chosei2 + adj.late_adj + adj.sayi_adj;
      eq(`${tag} 差異 = 合計額 - 支給済み`, total - (paid?.amount ?? 0), want.get("差異") ?? 0);
    }
  }
}

// 支払いサマリー: 計算額 (T+1/T+2/T+3 の分配)
for (const [staff, byMonth] of paySummary.perStaff) {
  for (const pm of paySummary.payMonths) {
    const got = calcPaymentForMonth(records, staff, pm, cfg);
    eq(`支払いサマリー ${staff} ${pm.slice(0, 7)} 計算額`, got, byMonth.get(pm) ?? 0);
  }
}
for (const pm of paySummary.payMonths) {
  let sum = 0;
  for (const staff of paySummary.perStaff.keys()) {
    sum += calcPaymentForMonth(records, staff, pm, cfg);
  }
  eq(`支払いサマリー 事業所合計 ${pm.slice(0, 7)}`, sum, paySummary.officeTotal.get(pm) ?? 0);
}

// ── 診断: 単位数 sheet 全 14 行を master に入れたらどうなるか ───────────
//  (Python の ITEMS ゲートを master の中身が肩代わりしている、という仮説の検証)
const cfgAll = baseConfig(variantUnitSheet);
const unitVariantDiff: string[] = [];
for (const staff of expected.staff) {
  for (const month of expected.months) {
    const want = expected.cell.get(staff)!.get(month)!.get("加算手当") ?? 0;
    const got = calcSalary(records, staff, month, cfgAll).kazan;
    if (!near(got, want)) {
      unitVariantDiff.push(`   ${staff} ${month.slice(0, 7)}  Python ${want} → TS ${got} (差 ${got - want})`);
    }
  }
}

// =====================================================================
// 5. Layer B — fixture (SPEC の式から手で導いた期待値)
//    実データに 1 件も出てこない経路を通す。
// =====================================================================

const FX_UNITS: ServiceUnit[] = [
  { item_name: "要介護１～２", unit_count: 1086, is_addition: false, is_office_addition: false },
  { item_name: "要介護３～５", unit_count: 1411, is_addition: false, is_office_addition: false },
  { item_name: "要支援１", unit_count: 514, is_addition: false, is_office_addition: false },
  { item_name: "要支援２", unit_count: 514, is_addition: false, is_office_addition: false },
  { item_name: "初回加算", unit_count: 300, is_addition: true, is_office_addition: false },
  { item_name: "特定事業所加算Ⅱ", unit_count: 421, is_addition: true, is_office_addition: true },
  { item_name: "通院時情報連携加算", unit_count: 50, is_addition: true, is_office_addition: false },
];

const FX_SETTINGS: EmployeeSetting[] = [
  {
    staff_name: "検証 太郎",
    honnin_kyu: 250000,
    shokuno_kyu: null,
    kotei_zangyo: null,
    shikaku_teate: null,
    kotei: null,
    tokutei_shogu: null,
    kaigo_rate: 9000,
    shien_rate: 3000,
  },
];

const rec = (o: Partial<KyotakuRecord>): KyotakuRecord => ({
  service_month: "2025-06-01",
  billing_month: "2025-07-01",
  staff_name: "検証 太郎",
  detail_row_no: "1",
  insurer_name: "袖ヶ浦市",
  service_name: "居宅介護支援Ⅰⅰ１",
  unit_total: 1086,
  care_level: "要介護１",
  ...o,
});

const many = (n: number, o: Partial<KyotakuRecord>): KyotakuRecord[] =>
  Array.from({ length: n }, () => rec(o));

const fxCfg = (over: Partial<CalcConfig> = {}): CalcConfig => ({
  settings: FX_SETTINGS,
  units: FX_UNITS,
  rates: [{ insurer_name: "袖ヶ浦市", rate: 11.4 }],
  ...over,
});

// B-1. 要支援単価の経路 (実データに 要支援 が 1 件も無い)
//   SPEC §3.2: inc0 = n_k*ki + n_s*si → 30*9000 + 10*3000 = 300,000
//   plan = max(0, 300,000 - 250,000) = 50,000
{
  const rs = [
    ...many(30, { care_level: "要介護１" }),
    ...many(10, { care_level: "要支援２", service_name: "介護予防支援" }),
  ];
  const b = calcSalary(rs, "検証 太郎", "2025-06-01", fxCfg());
  eq("B-1 要支援を含む inc0", b.details.inc0, 300000);
  eq("B-1 プラン手当 = inc0-base", b.plan, 50000);
  eq("B-1 要支援件数", b.details.normal_shien, 10);
}

// B-2. 基本給割れ (inc0 < base) → プラン手当 0
//   20*9000 = 180,000 < 250,000
{
  const b = calcSalary(many(20, {}), "検証 太郎", "2025-06-01", fxCfg());
  eq("B-2 inc0 < base はプラン手当 0", b.plan, 0);
  eq("B-2 合計額 = 基本給のみ", b.total, 250000);
}

// B-3. inc0 < base < inc1 の段差 (SPEC §3.2 の「段階差」)
//   当月 20 件 (180,000) + 翌々月請求 10 件 (90,000) → inc1 = 270,000
//   plan = 0 / chosei1 = max(0,270000-250000) - 0 = 20,000
{
  const rs = [
    ...many(20, {}),
    ...many(10, { billing_month: "2025-08-01" }), // delay 2
  ];
  const b = calcSalary(rs, "検証 太郎", "2025-06-01", fxCfg());
  eq("B-3 late1 件数", b.details.late1_kaigo, 10);
  eq("B-3 プラン手当 0", b.plan, 0);
  eq("B-3 調整手当① = inc1-base", b.chosei1, 20000);
  eq("B-3 調整手当② 0", b.chosei2, 0);
}

// B-4. inc0 が既に base 超え → chosei1 は件数ぶん丸ごと
//   当月 30 件 (270,000) / 翌々月 5 件 (45,000) / 3 か月後 4 件 (36,000)
{
  const rs = [
    ...many(30, {}),
    ...many(5, { billing_month: "2025-08-01" }), // delay 2
    ...many(4, { billing_month: "2025-09-01" }), // delay 3
  ];
  const b = calcSalary(rs, "検証 太郎", "2025-06-01", fxCfg());
  eq("B-4 プラン手当", b.plan, 20000);
  eq("B-4 調整手当①", b.chosei1, 45000);
  eq("B-4 調整手当②", b.chosei2, 36000);
  eq("B-4 late2 件数", b.details.late2_kaigo, 4);
  // delay 4 以上も late2 に入る (Python の else 節)
  const b2 = calcSalary(
    [...many(30, {}), ...many(2, { billing_month: "2025-12-01" })],
    "検証 太郎",
    "2025-06-01",
    fxCfg(),
  );
  eq("B-4 delay 6 も late2", b2.details.late2_kaigo, 2);
}

// B-5. 加算手当 (SPEC §3.3): 単位 × 10 円 固定。特定事業所加算は除外。
//   初回加算 2 件 → 300*10*2 = 6,000 / 通院時情報連携 1 件 → 50*10 = 500
//   特定事業所加算Ⅱ 3 件 → 0 円
//   地域単価 11.4 を渡しても加算手当は変わらない (= 固定 10 円)
{
  const rs = [
    ...many(20, {}),
    ...many(2, { detail_row_no: "2", service_name: "居宅支援初回加算" }),
    ...many(1, { detail_row_no: "99", service_name: "居宅支援通院時情報連携加算" }),
    ...many(3, { detail_row_no: "99", service_name: "居宅支援特定事業所加算Ⅱ" }),
  ];
  const b = calcSalary(rs, "検証 太郎", "2025-06-01", fxCfg());
  eq("B-5 加算手当 = 単位×10 (特定事業所加算は除外)", b.kazan, 6500);
  eq("B-5 加算行は件数に入らない", b.details.normal_kaigo, 20);
}

// B-6. 設定行が無い staff は DEFAULT_BASE_SALARY 250,000 / 単価 0 (SPEC §2.2)
{
  const rs = many(30, { staff_name: "設定なし 花子" });
  const b = calcSalary(rs, "設定なし 花子", "2025-06-01", fxCfg());
  eq("B-6 設定無しの基本給", b.base, 250000);
  eq("B-6 設定無しの単価 0 → プラン手当 0", b.plan, 0);
}

// B-7. calcPaymentForMonth の T+1 / T+2 / T+3 分配 (SPEC §3.5)
{
  const rs = [
    ...many(30, {}),
    ...many(5, { billing_month: "2025-08-01" }),
    ...many(4, { billing_month: "2025-09-01" }),
    ...many(2, { detail_row_no: "2", service_name: "居宅支援初回加算" }),
  ];
  const c = fxCfg();
  eq("B-7 T+1 = base+plan+kazan", calcPaymentForMonth(rs, "検証 太郎", "2025-07-01", c), 276000);
  eq("B-7 T+2 = 調整手当①", calcPaymentForMonth(rs, "検証 太郎", "2025-08-01", c), 45000);
  eq("B-7 T+3 = 調整手当②", calcPaymentForMonth(rs, "検証 太郎", "2025-09-01", c), 36000);
  eq("B-7 T+4 は 0", calcPaymentForMonth(rs, "検証 太郎", "2025-10-01", c), 0);
}

// B-8. 確定差異は「最新未確定月」にだけ乗る (SPEC §3.6 / §8.4)
//   05 月分: 30 件 → 270,000 を計算したが 支給済み 265,000 → 差 +5,000
//   06 月分: 未確定 → ここに 5,000 が乗る
{
  const rs = [
    ...many(30, { service_month: "2025-05-01", billing_month: "2025-06-01" }),
    ...many(30, { service_month: "2025-06-01", billing_month: "2025-07-01" }),
  ];
  const c: CalcConfigWithConfirmations = {
    ...fxCfg(),
    confirmations: [{ staff_name: "検証 太郎", pay_month: "2025-06-01", amount: 265000 }],
  };
  const may = calcAdjustments(rs, "検証 太郎", "2025-05-01", c);
  const jun = calcAdjustments(rs, "検証 太郎", "2025-06-01", c);
  eq("B-8 確定済み月には確定差異を乗せない", may.sayi_adj, 0);
  eq("B-8 最新未確定月に確定差異 +5,000", jun.sayi_adj, 5000);
  eq("B-8 過払い側も符号付きで乗る",
    calcAdjustments(rs, "検証 太郎", "2025-06-01", {
      ...fxCfg(),
      confirmations: [{ staff_name: "検証 太郎", pay_month: "2025-06-01", amount: 280000 }],
    }).sayi_adj,
    -10000);
  // 全月確定済みなら latest_unconfirmed は無い → 0
  eq(
    "B-8 全月確定済みなら確定差異 0",
    calcAdjustments(rs, "検証 太郎", "2025-06-01", {
      ...fxCfg(),
      confirmations: [
        { staff_name: "検証 太郎", pay_month: "2025-06-01", amount: 265000 },
        { staff_name: "検証 太郎", pay_month: "2025-07-01", amount: 270000 },
      ],
    }).sayi_adj,
    0,
  );
}

// B-9. late_adj は過去月の chosei が T+1 に流れ込む分 (SPEC §3.6-1)
//   04 月提供の 3 か月後請求 4 件 (36,000) は 07 月払い = 06 月提供分の T+1 と同じ月
{
  const rs = [
    ...many(30, { service_month: "2025-04-01", billing_month: "2025-05-01" }),
    ...many(4, { service_month: "2025-04-01", billing_month: "2025-07-01" }), // delay 3
    ...many(30, { service_month: "2025-06-01", billing_month: "2025-07-01" }),
  ];
  const c: CalcConfigWithConfirmations = { ...fxCfg(), confirmations: [] };
  eq("B-9 late_adj に 04 月の調整手当② が乗る",
    calcAdjustments(rs, "検証 太郎", "2025-06-01", c).late_adj, 36000);
}

// B-10. getBaseUnit (SPEC §6)
{
  eq("B-10 要介護１ → 1086", getBaseUnit("要介護１", FX_UNITS), 1086);
  eq("B-10 要介護２ → 1086", getBaseUnit("要介護２", FX_UNITS), 1086);
  eq("B-10 要介護３ → 1411", getBaseUnit("要介護３", FX_UNITS), 1411);
  eq("B-10 要介護５ → 1411", getBaseUnit("要介護５", FX_UNITS), 1411);
  eq("B-10 要支援１ → 514", getBaseUnit("要支援１", FX_UNITS), 514);
  eq("B-10 未知の介護度 → 0", getBaseUnit("経過的要介護", FX_UNITS), 0);
  // SPEC §8.11: master が U+301C (〜) で登録されていても引けること
  const wave: ServiceUnit[] = [
    { item_name: "要介護１〜２", unit_count: 1086, is_addition: false, is_office_addition: false },
  ];
  eq("B-10 U+301C の master でも引ける", getBaseUnit("要介護１", wave), 1086);
}

// B-11. 月ユーティリティ (SPEC §6)
{
  eq("B-11 normalizeMonth(2025年1月1日)", normalizeMonth("2025年1月1日") === "2025-01-01" ? 1 : 0, 1);
  eq("B-11 normalizeMonth(2025/2)", normalizeMonth("2025/2") === "2025-02-01" ? 1 : 0, 1);
  eq("B-11 addMonths 年跨ぎ", addMonths("2025-11-01", 3) === "2026-02-01" ? 1 : 0, 1);
  eq("B-11 addMonths 負値", addMonths("2025-01-01", -1) === "2024-12-01" ? 1 : 0, 1);
  eq("B-11 monthDiff", monthDiff("2025-01-01", "2025-03-01"), 2);
}

// B-13. ★ 実データで落ちた件の最小再現: 「その月に 1 件も実績が無いケアマネ」
//   Python: calc_payment_for_month は **all_months (全職員共通の月リスト)** を走査するので、
//           実績 0 件の月も calc_salary が base=250,000 を返し T+1 に支払われる。
//           → 調整手当 0 / 合計額 250,000
//   TS   : calcPaymentForMonth は **その staff の records から作った月 set** を走査するので、
//           実績 0 件の月は集合に入らず 0 円。late_adj = 0 - 250,000 = -250,000 になる。
//   05 月に 30 件 / 06 月は 0 件 / 07 月に 30 件 のケアマネで再現する。
//   ⚠ Python の all_months は **全職員の和** なので、06 月が月リストに載るためには
//     他の職員が 06 月の実績を持っている必要がある。実データの 森田 尚子 2025-02 が
//     まさにその形 (本人 0 件 / 他 6 名は実績あり) なので、fixture でも同僚を 1 名置く。
{
  const rs = [
    ...many(30, { service_month: "2025-05-01", billing_month: "2025-06-01" }),
    ...many(30, { service_month: "2025-07-01", billing_month: "2025-08-01" }),
    ...many(10, {
      staff_name: "同僚 花子",
      service_month: "2025-06-01",
      billing_month: "2025-07-01",
    }),
  ];
  const c: CalcConfigWithConfirmations = { ...fxCfg(), confirmations: [] };
  const b = calcSalary(rs, "検証 太郎", "2025-06-01", fxCfg());
  const a = calcAdjustments(rs, "検証 太郎", "2025-06-01", c);
  eq("B-13 実績0件の月でも基本給は出る", b.base, 250000);
  eq(
    "B-13 実績0件の月の T+1 支払額 = 基本給",
    calcPaymentForMonth(rs, "検証 太郎", "2025-07-01", fxCfg()),
    250000,
  );
  eq("B-13 実績0件の月の 調整手当 は 0", a.late_adj + a.sayi_adj, 0);
  eq(
    "B-13 実績0件の月の 合計額 = 基本給",
    b.total - b.chosei1 - b.chosei2 + a.late_adj + a.sayi_adj,
    250000,
  );
}

// B-14. ★ B-13 と同じ原因の 2 つ目の症状: 確定差異 (sayi_adj) の行き先が消える
//   Python の「最新未確定月」探索も all_months (全職員共通) を走査する。
//   本人の実績が 0 件の月でも、そこが未確定なら **その月に確定差異が集約される**。
//   TS は本人の実績月しか見ないので、実績のある月が全部確定済みだと
//   latestUnconfirmed = null になり、確定差異が **どこにも乗らずに消える**。
//
//   05 月 30 件 (計算 270,000 / 支給済 265,000 = 差 +5,000) → 支払 06 月 確定済み
//   06 月 本人 0 件 (同僚は実績あり)                       → 支払 07 月 未確定
//   07 月 30 件                                            → 支払 08 月 確定済み
//   Python: 最新未確定月 = 06 月 → sayi_adj(06) = +5,000
//   TS    : 本人の月 = 05/07 で両方確定済み → latestUnconfirmed 無し → 0
{
  const rs = [
    ...many(30, { service_month: "2025-05-01", billing_month: "2025-06-01" }),
    ...many(30, { service_month: "2025-07-01", billing_month: "2025-08-01" }),
    ...many(10, {
      staff_name: "同僚 花子",
      service_month: "2025-06-01",
      billing_month: "2025-07-01",
    }),
  ];
  const c: CalcConfigWithConfirmations = {
    ...fxCfg(),
    confirmations: [
      { staff_name: "検証 太郎", pay_month: "2025-06-01", amount: 265000 },
      { staff_name: "検証 太郎", pay_month: "2025-08-01", amount: 270000 },
    ],
  };
  eq(
    "B-14 実績0件の未確定月に確定差異が集約される",
    calcAdjustments(rs, "検証 太郎", "2025-06-01", c).sayi_adj,
    5000,
  );
}

// B-15. ★ normalizeMonth の Date fallback が SPEC §6 の書式を黙って壊す
//   Python の normalize_month は %y-%b / %b-%y / %Y-%b … の英語月名も解釈し、
//   未マッチなら **そのまま返す** (SPEC §6「未マッチはそのまま返却」)。
//   kyotaku-calc の normalizeMonth は最後に new Date() へ落ちるので、
//   解釈できない文字列が **もっともらしい別の月** に化ける。
//   ⚠ ただし本 function は app 内から呼ばれていない (取込は kokuho-parser 側の
//     同名別実装を使う)。今は実害が無いので XFAIL 扱いにして事実だけ残す。
{
  const s2n = (v: string | null, want: string) => (v === want ? 1 : 0);
  eqXfail(
    `B-15 "25-Feb" → 2025-02-01 (実際 ${normalizeMonth("25-Feb")})`,
    s2n(normalizeMonth("25-Feb"), "2025-02-01"),
    1,
    "Date fallback が 2001-02-01 にする (24 年ずれる)。app 内で未使用",
  );
  eqXfail(
    `B-15 "2025-Feb" → 2025-02-01 (実際 ${normalizeMonth("2025-Feb")})`,
    s2n(normalizeMonth("2025-Feb"), "2025-02-01"),
    1,
    "Date fallback が 2025-01-01 にする (月が 1 月に化ける)。app 内で未使用",
  );
  const ymm = normalizeMonth("202502");
  eqXfail(
    `B-15 "202502" は壊れた値を返さない (実際 ${ymm})`,
    ymm === null || ymm === "2025-02-01" ? 1 : 0,
    1,
    "Date fallback が 202501-12-01 を返す。kokuho-parser 側は 2025-02-01。app 内で未使用",
  );
}

// B-12. ★ 既知の意図的差異: 請求月が提供月より前 (delay < 0)
//   Python (集計.py 342-351): if 0 / elif 1 / elif 2 / else → 負値は **else = late2**
//   TS   (kyotaku-calc.ts 354): delay <= 0 を same に倒す (コメントで明示)
//   → 支払い月が T+3 か T+1 かで変わる。実データには 1 件も無い。
{
  const rs = [...many(30, {}), ...many(1, { billing_month: "2025-05-01" })]; // delay -1
  const b = calcSalary(rs, "検証 太郎", "2025-06-01", fxCfg());
  eqXfail(
    "B-12 delay<0 は Python では late2 になる",
    b.details.late2_kaigo,
    1,
    "TS は delay<=0 を same に倒す (kyotaku-calc.ts:354 で意図的と明記)",
  );
  eqXfail(
    "B-12 delay<0 は Python では当月件数に入らない",
    b.details.normal_kaigo,
    30,
    "同上",
  );
}

// =====================================================================
// 6. 負のコントロール (VERIFICATION_RULES 3-9)
//    期待値を 1 か所だけ壊して、検査が落ちることを見る。
// =====================================================================
if (NEGATIVE_CONTROL) {
  const target = results.find((r) => r.name.endsWith("合計額") && r.want !== null);
  if (!target) throw new Error("負のコントロールの対象が見つからない");
  target.want = (target.want ?? 0) + 1;
  const fx = results.find((r) => r.name.startsWith("B-5 加算手当"));
  if (!fx) throw new Error("負のコントロールの fixture 対象が見つからない");
  fx.want = (fx.want ?? 0) + 1;
  console.log(`*** NEGATIVE CONTROL: 「${target.name}」と「${fx.name}」の期待値を +1 して壊した ***\n`);
}

// =====================================================================
// 7. 結果
// =====================================================================
const failures = results.filter((r) => !r.xfail && !near(r.got, r.want));
const xfailUnexpectedPass = results.filter((r) => r.xfail && near(r.got, r.want));
const xfailAsExpected = results.filter((r) => r.xfail && !near(r.got, r.want));

console.log("=== 分母 ===");
for (const d of denominators) console.log("   " + d);

console.log(`\n=== 突合 ${checkedCells} 項目 ===`);
console.log(`   一致        ${results.length - failures.length - xfailAsExpected.length}`);
console.log(`   不一致      ${failures.length}`);
console.log(`   既知の差異  ${xfailAsExpected.length} (XFAIL)`);

if (failures.length > 0) {
  console.log("\n★ 不一致:");
  for (const f of failures) {
    console.log(`   ${f.name}\n      Python(期待) ${f.want}\n      TS  (実際)  ${f.got}`);
  }
}
if (xfailAsExpected.length > 0) {
  console.log("\n△ 既知の意図的差異 (FAIL にはしない):");
  for (const f of xfailAsExpected) {
    console.log(`   ${f.name}\n      Python ${f.want} / TS ${f.got}\n      理由: ${f.xfail}`);
  }
}
if (xfailUnexpectedPass.length > 0) {
  console.log("\n★ XFAIL のはずが一致した (検査か実装が変わっている。要確認):");
  for (const f of xfailUnexpectedPass) console.log(`   ${f.name}`);
}

console.log("\n=== 診断: 単位数 master に ITEMS 外の加算を入れた場合 ===");
if (unitVariantDiff.length === 0) {
  console.log("   差なし (単位数 sheet 全 14 行を master にしても加算手当は変わらない)");
} else {
  console.log(`   加算手当が変わるセル ${unitVariantDiff.length} 件:`);
  for (const d of unitVariantDiff) console.log(d);
  console.log("   → Python は フォーマット/DEFAULT_ITEMS で加算対象を絞る。TS は master の");
  console.log("     is_addition だけで決めるので、master に ITEMS 外の加算を足すと金額が動く。");
}

console.log("\n⚠ この検査が証明していないこと:");
console.log("   ・件数 8 行の内訳 (当月請求/翌月請求 の分離)。details が合算値しか持たない");
console.log("   ・売上表 / 利用者内訳 / 差異明細 sheet と 地域区分 (kyotaku-calc の範囲外)");
console.log("   ・出張距離手当 / 資格手当 / 固定 / 特定処遇改善 (Python 版に無い TS 独自項目)");
console.log("   ・DB 取得層 (SWR hook) と画面表示");

// =====================================================================
// 8. 基準値方式 (2026-09-05 / B-2y・B-2x)
//    ★ 「常に赤い検査」は見なくなるので最悪だが、外すと見えなくなる。
//    現状の不一致件数を基準値として焼き付け、増えたら FAIL・減ったら --update を促す。
//    (check:ceiling / check:service-code-gap と同じ形。0件を目指さない)
// =====================================================================
type Baseline = {
  _readme: string[];
  fingerprint: string;
  asOf: string;
  failureCount: number;
};

const fingerprint = createHash("sha256")
  .update(readFileSync(XLSX_PATH))
  .update(readFileSync(CSV_PATH))
  .digest("hex")
  .slice(0, 16);
const today = new Date().toISOString().slice(0, 10);

// ★ xfailUnexpectedPass (意図的差異のはずが一致した) は基準値化しない。
//   「検査か実装がいつのまにか変わっている」という別種の異常信号なので、
//   件数の多寡によらず常に人に見せる (VERIFICATION_RULES: 0件を無害と決めつけない)。
if (xfailUnexpectedPass.length > 0) {
  console.log("\n★★ XFAIL のはずが一致した項目がある — 基準値の対象外。常に FAIL とする。");
  process.exit(1);
}

let baseline: Baseline | null = null;
if (existsSync(BASELINE)) baseline = JSON.parse(readFileSync(BASELINE, "utf8"));

if (UPDATE || !baseline) {
  const out: Baseline = {
    _readme: [
      "npm run verify:kyotaku-python の基準値。",
      "",
      "■ なぜ 9 件なのか (2026-09-05 実測。B-2y 参照)",
      "  全部 1 つの原因: 実績0件の月に基本給を払うか。",
      "  Python版は払う / TS(kyotaku-calc.ts)は払わない。",
      "  森田尚子 2025-02 で ¥250,000 (合計額 Python=250000 / TS=0)。",
      "  user 判断待ち (DECISIONS_PENDING.md B-2y)。直ったら 9→0 になるはずなので、",
      "  そのとき基準値を 0 に更新すること。",
      "",
      "■ kyotaku-calc.ts 本体は触らないこと",
      "  別セッションの作業対象として予約中。このファイル (基準値) と",
      "  verify-kyotaku-vs-python.mts (ハーネス) 側だけを更新する。",
      "",
      "■ 指紋 (xlsx + CSV の内容ハッシュ)",
      "  期待値の元データ (Python実出力 xlsx / 入力CSV) が変わっていないか。",
      "  指紋が変わっているのに件数が同じなら、たまたま偶然一致した可能性がある",
      "  ので中身を読んでから --update すること。",
      "",
      "■ 0件を目指さない",
      "  kyotaku-calc.ts の是正 (B-2y の user 判断) が入るまでは 9 件のまま。",
      "  減ったら「改善した」と出す。増えたら新しい乖離として FAIL する。",
    ],
    fingerprint,
    asOf: today,
    failureCount: failures.length,
  };
  writeFileSync(BASELINE, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`\n--update: 基準値を書きました (${BASELINE})`);
  process.exit(0);
}

const fingerprintMatch = baseline.fingerprint === fingerprint;
console.log(`\n指紋 (xlsx+CSV): ${fingerprintMatch ? "一致" : "★ 不一致"}`);
console.log(`基準値 (${baseline.asOf} 時点): 不一致 ${baseline.failureCount} 件`);

if (failures.length > baseline.failureCount) {
  console.log(`\n★ FAIL — 不一致が基準値 (${baseline.failureCount}件) より増えた (現在 ${failures.length}件)。`);
  console.log("  新しい乖離が出た可能性が高い。中身を確認すること。");
  process.exit(1);
}
if (failures.length < baseline.failureCount) {
  console.log(`\n✓ PASS — 不一致が基準値 (${baseline.failureCount}件) より減った (現在 ${failures.length}件)。`);
  console.log("  改善している。中身を確認したうえで --update で基準値を下げてよい。");
  process.exit(0);
}
console.log(`\n✓ PASS — 基準値どおり ${failures.length} 件 (既知・DECISIONS_PENDING.md B-2y で user 判断待ち)。`);
if (!fingerprintMatch) {
  console.log("  ⚠ 指紋は不一致だが件数は変わっていない。元データが変わった場合は中身を確認のうえ --update すること。");
}
