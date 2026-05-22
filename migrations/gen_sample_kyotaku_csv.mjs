/**
 * 動作確認用 国保連 CSV (居宅介護支援) サンプルデータ生成スクリプト。
 *
 * 用途:
 *   - /csv-import の動作確認 (通常請求 / 月遅れ請求 / 過誤再請求 シナリオ)
 *   - プラン手当 半期締め (semi_annual) cycle の累積/支給確認
 *
 * 出力:
 *   apps/payroll-app/sample_kyotaku_R8_5.csv (Shift-JIS、改行 CRLF)
 *
 * 実行:
 *   cd apps/payroll-app && node migrations/gen_sample_kyotaku_csv.mjs
 *
 * シナリオ (5 名のケアマネ × 多様な請求パターン):
 *
 *   1. 坂本 祐香 (通常 + 月遅れ):
 *      - 2026/05 提供 → 2026/05 請求: 利用者 A1〜A8 の 8 件 (通常)
 *      - 2026/03 提供 → 2026/05 請求: 利用者 X1 の 1 件 (月遅れ 2 ヶ月)
 *      - 2026/04 提供 → 2026/05 請求: 利用者 X1 の 1 件 (月遅れ 1 ヶ月)
 *
 *   2. 天野 恵子 (通常多め):
 *      - 2026/05 提供 → 2026/05 請求: 利用者 B1〜B14 の 14 件
 *
 *   3. 本庄 麻子 (通常 + 過誤再請求パターン):
 *      - 2026/05 提供 → 2026/05 請求: 利用者 C1〜C6 の 6 件
 *      - 2026/02 提供 → 2026/05 請求: 利用者 C7 の 1 件 (過誤再請求 = 月遅れ 3 ヶ月)
 *
 *   4. 森田 尚子 (通常):
 *      - 2026/05 提供 → 2026/05 請求: 利用者 D1〜D9 の 9 件
 *
 *   5. 清水 治美 (要支援多め、プラン手当の差額判定確認用):
 *      - 2026/05 提供 → 2026/05 請求: 利用者 E1〜E5 介護 + E6〜E10 予防 計 10 件
 */

import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import Encoding from "encoding-japanese";

const __dirname = dirname(fileURLToPath(import.meta.url));

const HEADERS = [
  "提供年月",
  "請求年月",
  "担当職員名",
  "明細行番号",
  "被保険者番号",
  "利用者番号",
  "氏名",
  "性別",
  "生年月日",
  "要介護度",
  "保険者番号",
  "保険者名",
  "サービスコード",
  "サービス名",
  "単位数合計",
  "単位数単価",
  "請求額",
  "認定期間（開始）",
  "認定期間（終了）",
  "居宅介護支援事業所番号",
  "居宅介護支援事業所名",
];

const OFFICE_NUMBER = "1270501172";
const OFFICE_NAME = "Ｈａｎａ居宅支援センターおゆみ野";
const INSURER_NUMBER = "122192";
const INSURER_NAME = "市原市";

/**
 * 1 行作成。サービス内容を care_level + service_kind で決める。
 *   service_kind: 'kaigo' (要介護) | 'yobou' (要支援)
 */
function makeRow({
  service_month, billing_month, staff_name, detail_no, insured, user_no, name, gender, birth, care_level, service_kind,
}) {
  const isKaigo = service_kind === "kaigo";
  const code = isKaigo ? "AA1100" : "AA2200";
  const svcName = isKaigo ? "居宅介護支援費(Ⅰ)" : "介護予防支援費";
  // 要介護度 → 単位数 ベース (シンプル化)
  const unitsBase = {
    "要介護1": 1086, "要介護2": 1086,
    "要介護3": 1411, "要介護4": 1411, "要介護5": 1411,
    "要支援1": 442, "要支援2": 442,
  };
  const units = unitsBase[care_level] ?? 1086;
  const unitPrice = 10.96; // 介護報酬単価
  const amount = Math.round(units * unitPrice);
  return [
    service_month,
    billing_month,
    staff_name,
    String(detail_no),
    insured,
    user_no,
    name,
    gender,
    birth,
    care_level,
    INSURER_NUMBER,
    INSURER_NAME,
    code,
    svcName,
    String(units),
    String(unitPrice),
    String(amount),
    "2025-04-01",
    "2027-03-31",
    OFFICE_NUMBER,
    OFFICE_NAME,
  ];
}

// =====================================================================
// シナリオ生成
// =====================================================================

const rows = [];
let lineNo = 1;

// ── 1. 坂本 祐香: 通常 8 件 + 月遅れ 2 件 = 10 件 ─────────────
const sakamotoNormal = [
  { user_no: "A001", name: "青木 一郎", insured: "0001000001", gender: "男", birth: "1940-01-15", care_level: "要介護2" },
  { user_no: "A002", name: "石井 花子", insured: "0001000002", gender: "女", birth: "1938-03-22", care_level: "要介護1" },
  { user_no: "A003", name: "上田 三郎", insured: "0001000003", gender: "男", birth: "1942-07-08", care_level: "要介護3" },
  { user_no: "A004", name: "江口 静子", insured: "0001000004", gender: "女", birth: "1935-11-30", care_level: "要介護4" },
  { user_no: "A005", name: "大野 五郎", insured: "0001000005", gender: "男", birth: "1939-05-19", care_level: "要介護2" },
  { user_no: "A006", name: "加藤 千代", insured: "0001000006", gender: "女", birth: "1937-09-25", care_level: "要介護5" },
  { user_no: "A007", name: "木下 七郎", insured: "0001000007", gender: "男", birth: "1941-12-03", care_level: "要介護1" },
  { user_no: "A008", name: "久保 八重", insured: "0001000008", gender: "女", birth: "1933-02-14", care_level: "要介護3" },
];
sakamotoNormal.forEach((u) => {
  rows.push(makeRow({
    service_month: "2026-05-01", billing_month: "2026-05-01",
    staff_name: "坂本 祐香", detail_no: lineNo++,
    ...u, service_kind: "kaigo",
  }));
});
// 月遅れ (X1 利用者の 3 月分 と 4 月分 を 5 月にまとめて請求)
rows.push(makeRow({
  service_month: "2026-03-01", billing_month: "2026-05-01",
  staff_name: "坂本 祐香", detail_no: lineNo++,
  user_no: "X001", name: "佐藤 月遅", insured: "0001999001", gender: "男", birth: "1944-06-10", care_level: "要介護2",
  service_kind: "kaigo",
}));
rows.push(makeRow({
  service_month: "2026-04-01", billing_month: "2026-05-01",
  staff_name: "坂本 祐香", detail_no: lineNo++,
  user_no: "X001", name: "佐藤 月遅", insured: "0001999001", gender: "男", birth: "1944-06-10", care_level: "要介護2",
  service_kind: "kaigo",
}));

// ── 2. 天野 恵子: 通常 14 件 ────────────────────────────────
const amanoNormal = [
  { user_no: "B001", name: "鈴木 京子", insured: "0002000001", gender: "女", birth: "1936-04-12", care_level: "要介護3" },
  { user_no: "B002", name: "高橋 健一", insured: "0002000002", gender: "男", birth: "1942-08-23", care_level: "要介護2" },
  { user_no: "B003", name: "田中 道子", insured: "0002000003", gender: "女", birth: "1940-11-05", care_level: "要介護1" },
  { user_no: "B004", name: "中村 隆", insured: "0002000004", gender: "男", birth: "1934-01-18", care_level: "要介護4" },
  { user_no: "B005", name: "西田 さくら", insured: "0002000005", gender: "女", birth: "1938-10-09", care_level: "要介護2" },
  { user_no: "B006", name: "野口 茂", insured: "0002000006", gender: "男", birth: "1941-03-27", care_level: "要介護1" },
  { user_no: "B007", name: "橋本 美智子", insured: "0002000007", gender: "女", birth: "1937-07-14", care_level: "要介護3" },
  { user_no: "B008", name: "藤田 義雄", insured: "0002000008", gender: "男", birth: "1933-12-01", care_level: "要介護5" },
  { user_no: "B009", name: "前田 緑", insured: "0002000009", gender: "女", birth: "1939-05-31", care_level: "要介護2" },
  { user_no: "B010", name: "松本 太郎", insured: "0002000010", gender: "男", birth: "1942-09-16", care_level: "要介護1" },
  { user_no: "B011", name: "宮本 涼子", insured: "0002000011", gender: "女", birth: "1935-02-22", care_level: "要介護3" },
  { user_no: "B012", name: "森 健二", insured: "0002000012", gender: "男", birth: "1940-06-04", care_level: "要介護2" },
  { user_no: "B013", name: "山本 久美子", insured: "0002000013", gender: "女", birth: "1938-08-17", care_level: "要介護4" },
  { user_no: "B014", name: "吉田 武", insured: "0002000014", gender: "男", birth: "1936-10-29", care_level: "要介護2" },
];
amanoNormal.forEach((u) => {
  rows.push(makeRow({
    service_month: "2026-05-01", billing_month: "2026-05-01",
    staff_name: "天野 恵子", detail_no: lineNo++,
    ...u, service_kind: "kaigo",
  }));
});

// ── 3. 本庄 麻子: 通常 6 件 + 過誤再請求 1 件 ─────────────────
const honjoNormal = [
  { user_no: "C001", name: "斎藤 文子", insured: "0003000001", gender: "女", birth: "1937-01-25", care_level: "要介護2" },
  { user_no: "C002", name: "酒井 治男", insured: "0003000002", gender: "男", birth: "1942-04-11", care_level: "要介護3" },
  { user_no: "C003", name: "坂田 みつ", insured: "0003000003", gender: "女", birth: "1939-07-28", care_level: "要介護1" },
  { user_no: "C004", name: "佐々木 進", insured: "0003000004", gender: "男", birth: "1934-09-14", care_level: "要介護4" },
  { user_no: "C005", name: "篠原 智子", insured: "0003000005", gender: "女", birth: "1941-11-06", care_level: "要介護2" },
  { user_no: "C006", name: "杉山 浩二", insured: "0003000006", gender: "男", birth: "1938-12-19", care_level: "要介護3" },
];
honjoNormal.forEach((u) => {
  rows.push(makeRow({
    service_month: "2026-05-01", billing_month: "2026-05-01",
    staff_name: "本庄 麻子", detail_no: lineNo++,
    ...u, service_kind: "kaigo",
  }));
});
// 過誤再請求 (2 月分 を 5 月に再請求 = 3 ヶ月遅れ)
rows.push(makeRow({
  service_month: "2026-02-01", billing_month: "2026-05-01",
  staff_name: "本庄 麻子", detail_no: lineNo++,
  user_no: "C007", name: "瀬戸 過誤", insured: "0003999001", gender: "女", birth: "1936-05-22", care_level: "要介護2",
  service_kind: "kaigo",
}));

// ── 4. 森田 尚子: 通常 9 件 ─────────────────────────────────
const moritaNormal = [
  { user_no: "D001", name: "高木 春雄", insured: "0004000001", gender: "男", birth: "1941-02-08", care_level: "要介護1" },
  { user_no: "D002", name: "高山 房子", insured: "0004000002", gender: "女", birth: "1937-05-20", care_level: "要介護3" },
  { user_no: "D003", name: "竹内 正夫", insured: "0004000003", gender: "男", birth: "1939-08-13", care_level: "要介護2" },
  { user_no: "D004", name: "立花 のぶ", insured: "0004000004", gender: "女", birth: "1933-10-26", care_level: "要介護4" },
  { user_no: "D005", name: "谷口 利夫", insured: "0004000005", gender: "男", birth: "1940-01-05", care_level: "要介護2" },
  { user_no: "D006", name: "塚本 トキ", insured: "0004000006", gender: "女", birth: "1936-03-18", care_level: "要介護5" },
  { user_no: "D007", name: "土屋 義男", insured: "0004000007", gender: "男", birth: "1942-06-30", care_level: "要介護1" },
  { user_no: "D008", name: "寺田 静江", insured: "0004000008", gender: "女", birth: "1938-09-12", care_level: "要介護3" },
  { user_no: "D009", name: "戸田 五郎", insured: "0004000009", gender: "男", birth: "1934-11-24", care_level: "要介護2" },
];
moritaNormal.forEach((u) => {
  rows.push(makeRow({
    service_month: "2026-05-01", billing_month: "2026-05-01",
    staff_name: "森田 尚子", detail_no: lineNo++,
    ...u, service_kind: "kaigo",
  }));
});

// ── 5. 清水 治美: 介護 5 件 + 予防 5 件 = 10 件 ──────────────
const shimizuKaigo = [
  { user_no: "E001", name: "永井 雄一", insured: "0005000001", gender: "男", birth: "1941-04-22", care_level: "要介護2" },
  { user_no: "E002", name: "中島 順子", insured: "0005000002", gender: "女", birth: "1937-06-15", care_level: "要介護3" },
  { user_no: "E003", name: "長島 茂", insured: "0005000003", gender: "男", birth: "1939-08-08", care_level: "要介護1" },
  { user_no: "E004", name: "西山 千恵", insured: "0005000004", gender: "女", birth: "1934-10-30", care_level: "要介護4" },
  { user_no: "E005", name: "野田 健太", insured: "0005000005", gender: "男", birth: "1942-12-12", care_level: "要介護2" },
];
const shimizuYobou = [
  { user_no: "E006", name: "畑中 あや", insured: "0005000006", gender: "女", birth: "1943-02-03", care_level: "要支援1" },
  { user_no: "E007", name: "原 信夫", insured: "0005000007", gender: "男", birth: "1944-05-16", care_level: "要支援2" },
  { user_no: "E008", name: "東 さなえ", insured: "0005000008", gender: "女", birth: "1945-07-28", care_level: "要支援1" },
  { user_no: "E009", name: "平岡 進", insured: "0005000009", gender: "男", birth: "1942-09-09", care_level: "要支援2" },
  { user_no: "E010", name: "福島 紀子", insured: "0005000010", gender: "女", birth: "1943-11-21", care_level: "要支援1" },
];
shimizuKaigo.forEach((u) => {
  rows.push(makeRow({
    service_month: "2026-05-01", billing_month: "2026-05-01",
    staff_name: "清水 治美", detail_no: lineNo++,
    ...u, service_kind: "kaigo",
  }));
});
shimizuYobou.forEach((u) => {
  rows.push(makeRow({
    service_month: "2026-05-01", billing_month: "2026-05-01",
    staff_name: "清水 治美", detail_no: lineNo++,
    ...u, service_kind: "yobou",
  }));
});

// =====================================================================
// CSV 出力 (Shift-JIS, CRLF)
// =====================================================================

function csvEscape(v) {
  const s = String(v ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const lines = [HEADERS.map(csvEscape).join(",")];
for (const r of rows) {
  lines.push(r.map(csvEscape).join(","));
}
const utf8Csv = lines.join("\r\n") + "\r\n";

// Shift-JIS エンコード
const sjisBytes = Encoding.convert(Encoding.stringToCode(utf8Csv), {
  to: "SJIS",
  from: "UNICODE",
});
const sjisBuf = Buffer.from(sjisBytes);

const outPath = join(__dirname, "..", "sample_kyotaku_R8_5.csv");
writeFileSync(outPath, sjisBuf);

console.log(`✅ 生成完了: ${outPath}`);
console.log(`   行数: ${rows.length} (+ header)`);
console.log(`   サイズ: ${sjisBuf.length} bytes (Shift-JIS)`);
console.log(`\n📋 シナリオ内訳:`);
console.log(`   坂本 祐香 通常 8 件 + 月遅れ 2 件 (3月分+4月分) = 10 件`);
console.log(`   天野 恵子 通常 14 件`);
console.log(`   本庄 麻子 通常 6 件 + 過誤再請求 1 件 (2月分) = 7 件`);
console.log(`   森田 尚子 通常 9 件`);
console.log(`   清水 治美 介護 5 件 + 予防 5 件 = 10 件`);
console.log(`\n👉 /csv-import で取込テスト可能`);
