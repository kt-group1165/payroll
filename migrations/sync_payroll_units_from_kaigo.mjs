// migrations/sync_payroll_units_from_kaigo.mjs
//
// kaigo_service_codes (居宅介護支援費) から payroll_kyotaku_service_units に
// 単位数を sync。法改正時の運用フロー:
//   1. kaigo-app 側 master を更新 (CSV 再取込 or SQL UPDATE)
//   2. 本 mjs を実行 → payroll-app 側が自動追随
//
// 範囲: 9 ITEM (要介護１～２ / 要介護３～５ / 加算系 7 種)。
//       要支援１/２ は kaigo master の居宅介護支援系に存在しないため対象外
//       (= 暫定値 514 のまま、別途設定 modal で個別管理)。
//
// ★ 2026-10-06: 単位数は「何月分から」の履歴で持つ (payroll_kyotaku_service_units.effective_from)。
//   以前は 既存の行を UPDATE していたので、改定すると 過去の月まで新しい単位数で計算されていた。
//   今は EFFECTIVE_FROM (改定月の 1 日) の行を足す。kaigo 側も その月に有効な世代 (valid_from / valid_to) を見る。
//
// 使い方:
//   EFFECTIVE_FROM=2026-06-01 DRY_RUN=true  node apps/payroll-app/migrations/sync_payroll_units_from_kaigo.mjs
//   EFFECTIVE_FROM=2026-06-01 DRY_RUN=false node apps/payroll-app/migrations/sync_payroll_units_from_kaigo.mjs

import { createClient } from "@supabase/supabase-js";

const SB_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !KEY) {
  console.error("env SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が必要");
  process.exit(1);
}
const DRY_RUN = process.env.DRY_RUN !== "false";
const EFFECTIVE_FROM = process.env.EFFECTIVE_FROM ?? "";
if (!/^\d{4}-\d{2}-01$/.test(EFFECTIVE_FROM)) {
  console.error("env EFFECTIVE_FROM=YYYY-MM-01 (改定月の 1 日) が必要。この月の給与から新しい単位数になる");
  process.exit(1);
}
console.log(DRY_RUN ? "*** DRY RUN ***" : "*** LIVE ***");

const admin = createClient(SB_URL, KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TENANT = "kt-group";

// payroll_kyotaku_service_units.item_name → kaigo_service_codes.service_code
const ITEM_TO_KAIGO_CODE = {
  "要介護１～２": "432111",          // 居宅介護支援Ⅰⅰ１
  "要介護３～５": "432211",          // 居宅介護支援Ⅰⅰ２
  "ターミナルケアマネジメント加算": "436100",
  "初回加算":                       "434001",
  "入院時情報連携加算Ⅰ":            "436125",
  "入院時情報連携加算Ⅱ":            "436129",
  "特定事業所加算Ⅱ":                "434003",
  "退院退所加算Ⅰ１":                "436132",
  "通院時情報連携加算":              "436135",
  // 要支援１/２ は kaigo master 不在のため対象外
};

async function main() {
  const codes = Object.values(ITEM_TO_KAIGO_CODE);

  // 1. kaigo から最新単位数を fetch
  const { data: kaigoData, error: kaigoErr } = await admin
    .from("kaigo_service_codes")
    .select("service_code, service_name, units, valid_from, valid_to")
    .in("service_code", codes)
    .eq("system", "介護")
    .eq("service_category", "43");
  if (kaigoErr) {
    console.error("kaigo fetch error:", kaigoErr.message);
    process.exit(1);
  }
  // kaigo のサービスコードは世代管理。改定月に有効な世代を使う (valid_from <= 月初 <= valid_to)
  const kaigoByCode = new Map();
  for (const r of kaigoData ?? []) {
    if (r.valid_from && r.valid_from > EFFECTIVE_FROM) continue;
    if (r.valid_to && r.valid_to < EFFECTIVE_FROM) continue;
    const cur = kaigoByCode.get(r.service_code);
    if (!cur || (r.valid_from ?? "") > (cur.valid_from ?? "")) kaigoByCode.set(r.service_code, r);
  }

  // 2. payroll の現状 fetch
  const items = Object.keys(ITEM_TO_KAIGO_CODE);
  const { data: payData, error: payErr } = await admin
    .from("payroll_kyotaku_service_units")
    .select("*")
    .in("item_name", items)
    .eq("tenant_id", TENANT);
  if (payErr) {
    console.error("payroll fetch error:", payErr.message);
    process.exit(1);
  }
  // 改定月の時点で有効な行 (item_name ごとに effective_from <= 改定月 の最新) と比べる
  const payByItem = new Map();
  for (const r of payData ?? []) {
    if ((r.effective_from ?? "1970-01-01") > EFFECTIVE_FROM) continue;
    const cur = payByItem.get(r.item_name);
    if (!cur || r.effective_from > cur.effective_from) payByItem.set(r.item_name, r);
  }

  // 3. 差分検出
  const diffs = [];
  for (const [item, code] of Object.entries(ITEM_TO_KAIGO_CODE)) {
    const kaigoRow = kaigoByCode.get(code);
    const payRow = payByItem.get(item);
    if (!kaigoRow) {
      diffs.push({ item, status: "kaigo_missing", code });
      continue;
    }
    if (!payRow) {
      diffs.push({ item, status: "payroll_missing", code, kaigoUnits: kaigoRow.units });
      continue;
    }
    if (payRow.unit_count !== kaigoRow.units) {
      diffs.push({
        item, status: "diff", code,
        payrollUnits: payRow.unit_count,
        kaigoUnits: kaigoRow.units,
        payrollRow: payRow,
      });
    } else {
      diffs.push({ item, status: "match", code, units: payRow.unit_count });
    }
  }

  console.log("\n=== sync 結果 ===");
  for (const d of diffs) {
    if (d.status === "match") {
      console.log(`  ✓ ${d.item.padEnd(28)} ${d.code} units=${d.units} (一致)`);
    } else if (d.status === "diff") {
      console.log(`  ⚠ ${d.item.padEnd(28)} ${d.code} ${d.payrollUnits} → ${d.kaigoUnits}`);
    } else if (d.status === "kaigo_missing") {
      console.log(`  ✗ ${d.item.padEnd(28)} ${d.code} (kaigo master 不在)`);
    } else if (d.status === "payroll_missing") {
      console.log(`  ✗ ${d.item.padEnd(28)} ${d.code} (payroll master 不在、要 INSERT)`);
    }
  }

  const toUpdate = diffs.filter(d => d.status === "diff");
  console.log(`\n更新候補: ${toUpdate.length} 件`);

  if (DRY_RUN || toUpdate.length === 0) {
    if (DRY_RUN) console.log(`\nDRY_RUN なので書きません。(書くと ${EFFECTIVE_FROM} からの行を足す。前の月は今までの単位数のまま)`);
    return;
  }

  // 4. 改定月の行を足す (同じ月の行があれば上書き)。前の月の行は触らない
  for (const d of toUpdate) {
    const { id: _id, created_at: _c, ...base } = d.payrollRow;
    void _id; void _c;
    const { error } = await admin
      .from("payroll_kyotaku_service_units")
      .upsert({ ...base, unit_count: d.kaigoUnits, effective_from: EFFECTIVE_FROM, updated_at: new Date().toISOString() },
        { onConflict: "tenant_id,item_name,effective_from" });
    if (error) {
      console.error(`update error (${d.item}):`, error.message);
      process.exit(1);
    }
    console.log(`  ✓ ${d.item}: ${d.payrollUnits} → ${d.kaigoUnits}`);
  }
  console.log(`\n✓ ${toUpdate.length} 件 ${EFFECTIVE_FROM} からの行を足しました`);
}

main().catch(e => { console.error("fatal:", e); process.exit(1); });
