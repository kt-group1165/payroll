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
// 使い方:
//   DRY_RUN=true  node apps/payroll-app/migrations/sync_payroll_units_from_kaigo.mjs
//   DRY_RUN=false node apps/payroll-app/migrations/sync_payroll_units_from_kaigo.mjs

import { createClient } from "@supabase/supabase-js";

const SB_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !KEY) {
  console.error("env SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が必要");
  process.exit(1);
}
const DRY_RUN = process.env.DRY_RUN !== "false";
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
    .select("service_code, service_name, units")
    .in("service_code", codes)
    .eq("system", "介護")
    .eq("service_category", "43");
  if (kaigoErr) {
    console.error("kaigo fetch error:", kaigoErr.message);
    process.exit(1);
  }
  const kaigoByCode = new Map((kaigoData ?? []).map(r => [r.service_code, r]));

  // 2. payroll の現状 fetch
  const items = Object.keys(ITEM_TO_KAIGO_CODE);
  const { data: payData, error: payErr } = await admin
    .from("payroll_kyotaku_service_units")
    .select("id, item_name, unit_count")
    .in("item_name", items)
    .eq("tenant_id", TENANT);
  if (payErr) {
    console.error("payroll fetch error:", payErr.message);
    process.exit(1);
  }
  const payByItem = new Map((payData ?? []).map(r => [r.item_name, r]));

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
        payrollId: payRow.id,
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
    if (DRY_RUN) console.log("\nDRY_RUN なので UPDATE しません。");
    return;
  }

  // 4. UPDATE
  for (const d of toUpdate) {
    const { error } = await admin
      .from("payroll_kyotaku_service_units")
      .update({ unit_count: d.kaigoUnits, updated_at: new Date().toISOString() })
      .eq("id", d.payrollId);
    if (error) {
      console.error(`update error (${d.item}):`, error.message);
      process.exit(1);
    }
    console.log(`  ✓ ${d.item}: ${d.payrollUnits} → ${d.kaigoUnits}`);
  }
  console.log(`\n✓ ${toUpdate.length} 件 UPDATE 完了`);
}

main().catch(e => { console.error("fatal:", e); process.exit(1); });
