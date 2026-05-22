/**
 * 動作確認用 国保連 CSV (居宅介護支援) サンプルデータ生成スクリプト
 * 6 ヶ月分の取込タイムライン (2026-02 〜 2026-07) を生成する。
 *
 * 介護保険請求の流れ:
 *   - 1 月にサービス提供 → 2 月に国保連へ伝送 (= 2 月分 CSV)
 *   - だから "2026-02 月の CSV" = "提供年月 2026-01 + 月遅れ分" になる
 *
 * 出力 6 ファイル:
 *   apps/payroll-app/sample_kyotaku_2026_02.csv  (= 2026/01 提供分 メイン)
 *   apps/payroll-app/sample_kyotaku_2026_03.csv  (= 2026/02 提供分 メイン)
 *   apps/payroll-app/sample_kyotaku_2026_04.csv  (= 2026/03 提供分 メイン)
 *   apps/payroll-app/sample_kyotaku_2026_05.csv  (= 2026/04 提供分 メイン)
 *   apps/payroll-app/sample_kyotaku_2026_06.csv  (= 2026/05 提供分 メイン)
 *   apps/payroll-app/sample_kyotaku_2026_07.csv  (= 2026/06 提供分 メイン)
 *
 * シナリオ:
 *   - 5 ケアマネ × 各々の固定利用者 (約 8-14 名)
 *   - 月遅れ請求: 坂本担当の佐藤月遅 (X001) を別月で複数回月遅れ請求
 *   - 過誤再請求: 本庄担当の瀬戸過誤 (C007) を返戻 → 再請求
 *   - 利用開始: 坂本に A009 が 2026/03 〜、本庄に C008 が 2026/06 〜
 *   - 利用終了: 天野の B014 が 2026/04 で終了 (2026/05 以降は含まれず)
 *
 * 半期締め (semi_annual) 動作確認:
 *   - 2026-02 〜 2026-07 を順に取込 + 各月「確定」を押すと
 *     1-6月分 が accumulator に蓄積 → 9月 で 一括支給される動作になる
 *
 * 実行:
 *   cd apps/payroll-app && node migrations/gen_sample_kyotaku_csv.mjs
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

// =====================================================================
// 利用者マスタ (5 ケアマネ × 各 N 名)
// =====================================================================

/**
 * 各利用者: { user_no, name, insured, gender, birth, care_level, service_kind, started, ended }
 *   service_kind: 'kaigo' (要介護) | 'yobou' (要支援)
 *   started: 利用開始月 'YYYY-MM' (省略時は古くから利用)
 *   ended: 利用終了月 'YYYY-MM' (省略時は継続)
 */
const STAFF_CLIENTS = {
  "坂本 祐香": [
    { user_no: "A001", name: "青木 一郎", insured: "0001000001", gender: "男", birth: "1940-01-15", care_level: "要介護2", service_kind: "kaigo" },
    { user_no: "A002", name: "石井 花子", insured: "0001000002", gender: "女", birth: "1938-03-22", care_level: "要介護1", service_kind: "kaigo" },
    { user_no: "A003", name: "上田 三郎", insured: "0001000003", gender: "男", birth: "1942-07-08", care_level: "要介護3", service_kind: "kaigo" },
    { user_no: "A004", name: "江口 静子", insured: "0001000004", gender: "女", birth: "1935-11-30", care_level: "要介護4", service_kind: "kaigo" },
    { user_no: "A005", name: "大野 五郎", insured: "0001000005", gender: "男", birth: "1939-05-19", care_level: "要介護2", service_kind: "kaigo" },
    { user_no: "A006", name: "加藤 千代", insured: "0001000006", gender: "女", birth: "1937-09-25", care_level: "要介護5", service_kind: "kaigo" },
    { user_no: "A007", name: "木下 七郎", insured: "0001000007", gender: "男", birth: "1941-12-03", care_level: "要介護1", service_kind: "kaigo" },
    { user_no: "A008", name: "久保 八重", insured: "0001000008", gender: "女", birth: "1933-02-14", care_level: "要介護3", service_kind: "kaigo" },
    { user_no: "A009", name: "小林 信吾", insured: "0001000009", gender: "男", birth: "1945-08-07", care_level: "要介護1", service_kind: "kaigo", started: "2026-03" },
    { user_no: "X001", name: "佐藤 月遅", insured: "0001999001", gender: "男", birth: "1944-06-10", care_level: "要介護2", service_kind: "kaigo" },
  ],
  "天野 恵子": [
    { user_no: "B001", name: "鈴木 京子", insured: "0002000001", gender: "女", birth: "1936-04-12", care_level: "要介護3", service_kind: "kaigo" },
    { user_no: "B002", name: "高橋 健一", insured: "0002000002", gender: "男", birth: "1942-08-23", care_level: "要介護2", service_kind: "kaigo" },
    { user_no: "B003", name: "田中 道子", insured: "0002000003", gender: "女", birth: "1940-11-05", care_level: "要介護1", service_kind: "kaigo" },
    { user_no: "B004", name: "中村 隆", insured: "0002000004", gender: "男", birth: "1934-01-18", care_level: "要介護4", service_kind: "kaigo" },
    { user_no: "B005", name: "西田 さくら", insured: "0002000005", gender: "女", birth: "1938-10-09", care_level: "要介護2", service_kind: "kaigo" },
    { user_no: "B006", name: "野口 茂", insured: "0002000006", gender: "男", birth: "1941-03-27", care_level: "要介護1", service_kind: "kaigo" },
    { user_no: "B007", name: "橋本 美智子", insured: "0002000007", gender: "女", birth: "1937-07-14", care_level: "要介護3", service_kind: "kaigo" },
    { user_no: "B008", name: "藤田 義雄", insured: "0002000008", gender: "男", birth: "1933-12-01", care_level: "要介護5", service_kind: "kaigo" },
    { user_no: "B009", name: "前田 緑", insured: "0002000009", gender: "女", birth: "1939-05-31", care_level: "要介護2", service_kind: "kaigo" },
    { user_no: "B010", name: "松本 太郎", insured: "0002000010", gender: "男", birth: "1942-09-16", care_level: "要介護1", service_kind: "kaigo" },
    { user_no: "B011", name: "宮本 涼子", insured: "0002000011", gender: "女", birth: "1935-02-22", care_level: "要介護3", service_kind: "kaigo" },
    { user_no: "B012", name: "森 健二", insured: "0002000012", gender: "男", birth: "1940-06-04", care_level: "要介護2", service_kind: "kaigo" },
    { user_no: "B013", name: "山本 久美子", insured: "0002000013", gender: "女", birth: "1938-08-17", care_level: "要介護4", service_kind: "kaigo" },
    { user_no: "B014", name: "吉田 武", insured: "0002000014", gender: "男", birth: "1936-10-29", care_level: "要介護2", service_kind: "kaigo", ended: "2026-04" },
  ],
  "本庄 麻子": [
    { user_no: "C001", name: "斎藤 文子", insured: "0003000001", gender: "女", birth: "1937-01-25", care_level: "要介護2", service_kind: "kaigo" },
    { user_no: "C002", name: "酒井 治男", insured: "0003000002", gender: "男", birth: "1942-04-11", care_level: "要介護3", service_kind: "kaigo" },
    { user_no: "C003", name: "坂田 みつ", insured: "0003000003", gender: "女", birth: "1939-07-28", care_level: "要介護1", service_kind: "kaigo" },
    { user_no: "C004", name: "佐々木 進", insured: "0003000004", gender: "男", birth: "1934-09-14", care_level: "要介護4", service_kind: "kaigo" },
    { user_no: "C005", name: "篠原 智子", insured: "0003000005", gender: "女", birth: "1941-11-06", care_level: "要介護2", service_kind: "kaigo" },
    { user_no: "C006", name: "杉山 浩二", insured: "0003000006", gender: "男", birth: "1938-12-19", care_level: "要介護3", service_kind: "kaigo" },
    { user_no: "C007", name: "瀬戸 過誤", insured: "0003999001", gender: "女", birth: "1936-05-22", care_level: "要介護2", service_kind: "kaigo" },
    { user_no: "C008", name: "曽根 一夫", insured: "0003000007", gender: "男", birth: "1946-02-14", care_level: "要介護1", service_kind: "kaigo", started: "2026-06" },
  ],
  "森田 尚子": [
    { user_no: "D001", name: "高木 春雄", insured: "0004000001", gender: "男", birth: "1941-02-08", care_level: "要介護1", service_kind: "kaigo" },
    { user_no: "D002", name: "高山 房子", insured: "0004000002", gender: "女", birth: "1937-05-20", care_level: "要介護3", service_kind: "kaigo" },
    { user_no: "D003", name: "竹内 正夫", insured: "0004000003", gender: "男", birth: "1939-08-13", care_level: "要介護2", service_kind: "kaigo" },
    { user_no: "D004", name: "立花 のぶ", insured: "0004000004", gender: "女", birth: "1933-10-26", care_level: "要介護4", service_kind: "kaigo" },
    { user_no: "D005", name: "谷口 利夫", insured: "0004000005", gender: "男", birth: "1940-01-05", care_level: "要介護2", service_kind: "kaigo" },
    { user_no: "D006", name: "塚本 トキ", insured: "0004000006", gender: "女", birth: "1936-03-18", care_level: "要介護5", service_kind: "kaigo" },
    { user_no: "D007", name: "土屋 義男", insured: "0004000007", gender: "男", birth: "1942-06-30", care_level: "要介護1", service_kind: "kaigo" },
    { user_no: "D008", name: "寺田 静江", insured: "0004000008", gender: "女", birth: "1938-09-12", care_level: "要介護3", service_kind: "kaigo" },
    { user_no: "D009", name: "戸田 五郎", insured: "0004000009", gender: "男", birth: "1934-11-24", care_level: "要介護2", service_kind: "kaigo" },
  ],
  "清水 治美": [
    { user_no: "E001", name: "永井 雄一", insured: "0005000001", gender: "男", birth: "1941-04-22", care_level: "要介護2", service_kind: "kaigo" },
    { user_no: "E002", name: "中島 順子", insured: "0005000002", gender: "女", birth: "1937-06-15", care_level: "要介護3", service_kind: "kaigo" },
    { user_no: "E003", name: "長島 茂", insured: "0005000003", gender: "男", birth: "1939-08-08", care_level: "要介護1", service_kind: "kaigo" },
    { user_no: "E004", name: "西山 千恵", insured: "0005000004", gender: "女", birth: "1934-10-30", care_level: "要介護4", service_kind: "kaigo" },
    { user_no: "E005", name: "野田 健太", insured: "0005000005", gender: "男", birth: "1942-12-12", care_level: "要介護2", service_kind: "kaigo" },
    { user_no: "E006", name: "畑中 あや", insured: "0005000006", gender: "女", birth: "1943-02-03", care_level: "要支援1", service_kind: "yobou" },
    { user_no: "E007", name: "原 信夫", insured: "0005000007", gender: "男", birth: "1944-05-16", care_level: "要支援2", service_kind: "yobou" },
    { user_no: "E008", name: "東 さなえ", insured: "0005000008", gender: "女", birth: "1945-07-28", care_level: "要支援1", service_kind: "yobou" },
    { user_no: "E009", name: "平岡 進", insured: "0005000009", gender: "男", birth: "1942-09-09", care_level: "要支援2", service_kind: "yobou" },
    { user_no: "E010", name: "福島 紀子", insured: "0005000010", gender: "女", birth: "1943-11-21", care_level: "要支援1", service_kind: "yobou" },
  ],
};

// =====================================================================
// 月別 シナリオ (= 取込月ごとの月遅れ/過誤 イベント)
// 通常分は次の月の関数で自動生成。ここでは「特別な」行のみ列挙。
// =====================================================================

/**
 * 取込月 (= billing_month) ごとの追加イベント。
 *   { staff_name, user_no, service_month, note }
 *   note は コメント用 (CSV には出力されない)
 */
const EXTRA_EVENTS = {
  "2026-02": [
    // 初月、追加イベントなし
  ],
  "2026-03": [
    // 月遅れ: 坂本 担当 X001 の 2025-12 分 (3 ヶ月遅れ)
    { staff_name: "坂本 祐香", user_no: "X001", service_month: "2025-12", note: "X001 月遅れ 3ヶ月" },
  ],
  "2026-04": [
    // 過誤再請求: 本庄 担当 C007 の 2026-01 分が返戻 → 再請求 (3 ヶ月遅れ)
    { staff_name: "本庄 麻子", user_no: "C007", service_month: "2026-01", note: "C007 過誤再請求 (1月分)" },
  ],
  "2026-05": [
    // 月遅れ: 坂本 担当 X001 の 2026-02 分 (3 ヶ月遅れ)
    { staff_name: "坂本 祐香", user_no: "X001", service_month: "2026-02", note: "X001 月遅れ 3ヶ月" },
  ],
  "2026-06": [
    // 過誤再請求: 本庄 担当 C007 の 2026-04 分が返戻 → 再請求
    { staff_name: "本庄 麻子", user_no: "C007", service_month: "2026-04", note: "C007 過誤再請求 (4月分)" },
  ],
  "2026-07": [
    // 月遅れ: 坂本 担当 X001 の 2026-05 分 (2 ヶ月遅れ)
    { staff_name: "坂本 祐香", user_no: "X001", service_month: "2026-05", note: "X001 月遅れ 2ヶ月" },
  ],
};

// =====================================================================
// ヘルパー
// =====================================================================

function makeRow({
  service_month, billing_month, staff_name, detail_no, client,
}) {
  const isKaigo = client.service_kind === "kaigo";
  const code = isKaigo ? "AA1100" : "AA2200";
  const svcName = isKaigo ? "居宅介護支援費(Ⅰ)" : "介護予防支援費";
  const unitsBase = {
    "要介護1": 1086, "要介護2": 1086,
    "要介護3": 1411, "要介護4": 1411, "要介護5": 1411,
    "要支援1": 442, "要支援2": 442,
  };
  const units = unitsBase[client.care_level] ?? 1086;
  const unitPrice = 10.96;
  const amount = Math.round(units * unitPrice);
  return [
    `${service_month}-01`,
    `${billing_month}-01`,
    staff_name,
    String(detail_no),
    client.insured,
    client.user_no,
    client.name,
    client.gender,
    client.birth,
    client.care_level,
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

/** YYYY-MM の前月 */
function prevMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** client が service_month 時点で利用中か */
function isActive(client, service_month) {
  if (client.started && service_month < client.started) return false;
  if (client.ended && service_month >= client.ended) return false;
  return true;
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// =====================================================================
// 取込月 ごとに CSV 生成
// =====================================================================

const IMPORT_MONTHS = ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];

const summary = [];

for (const billing_month of IMPORT_MONTHS) {
  const default_service_month = prevMonth(billing_month);
  const rows = [];
  let lineNo = 1;
  let normalCount = 0;
  let extraCount = 0;

  // 1. 通常請求: 各ケアマネの担当利用者全員 (default_service_month で active なもの)
  for (const [staff_name, clients] of Object.entries(STAFF_CLIENTS)) {
    for (const client of clients) {
      if (!isActive(client, default_service_month)) continue;
      rows.push(makeRow({
        service_month: default_service_month,
        billing_month,
        staff_name,
        detail_no: lineNo++,
        client,
      }));
      normalCount++;
    }
  }

  // 2. 追加イベント (月遅れ / 過誤再請求)
  const extras = EXTRA_EVENTS[billing_month] ?? [];
  for (const ev of extras) {
    const clients = STAFF_CLIENTS[ev.staff_name] ?? [];
    const client = clients.find((c) => c.user_no === ev.user_no);
    if (!client) {
      console.warn(`⚠️  ${billing_month}: ${ev.staff_name} / ${ev.user_no} が見つかりません`);
      continue;
    }
    rows.push(makeRow({
      service_month: ev.service_month,
      billing_month,
      staff_name: ev.staff_name,
      detail_no: lineNo++,
      client,
    }));
    extraCount++;
  }

  // CSV 出力 (Shift-JIS, CRLF)
  const lines = [HEADERS.map(csvEscape).join(",")];
  for (const r of rows) lines.push(r.map(csvEscape).join(","));
  const utf8 = lines.join("\r\n") + "\r\n";
  const sjisBytes = Encoding.convert(Encoding.stringToCode(utf8), { to: "SJIS", from: "UNICODE" });
  const sjisBuf = Buffer.from(sjisBytes);

  const fileName = `sample_kyotaku_${billing_month.replace("-", "_")}.csv`;
  const outPath = join(__dirname, "..", fileName);
  writeFileSync(outPath, sjisBuf);

  summary.push({
    file: fileName,
    billing: billing_month,
    service: default_service_month,
    normal: normalCount,
    extra: extraCount,
    total: rows.length,
    extras_notes: extras.map((e) => e.note),
  });
}

// =====================================================================
// サマリ出力
// =====================================================================

console.log(`\n✅ 6 ヶ月分の CSV を出力しました:\n`);
console.log(
  `  取込月    | 提供月メイン | 通常 | 月遅れ等 | 合計 | ファイル`,
);
console.log(`  ${"".padEnd(75, "─")}`);
for (const s of summary) {
  console.log(
    `  ${s.billing} | ${s.service}    |  ${String(s.normal).padStart(3)} |    ${String(s.extra).padStart(3)}   |  ${String(s.total).padStart(3)} | ${s.file}`,
  );
}

console.log(`\n📋 月別 特殊イベント:`);
for (const s of summary) {
  if (s.extras_notes.length > 0) {
    console.log(`  ${s.billing}: ${s.extras_notes.join(" / ")}`);
  }
}

console.log(`\n👤 利用者の変動:`);
console.log(`  2026-03〜 坂本 担当 A009 (小林 信吾) 利用開始`);
console.log(`  2026-04   天野 担当 B014 (吉田 武) 利用終了 → 2026-05 以降は含まれず`);
console.log(`  2026-06〜 本庄 担当 C008 (曽根 一夫) 利用開始`);
console.log(`\n📥 推奨 取込順: 2026-02 → 03 → 04 → 05 → 06 → 07`);
console.log(`   各月取込 → 確定 → 翌月へ進む流れで semi_annual cycle テスト可能`);
