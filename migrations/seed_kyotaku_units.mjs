// apps/payroll-app/migrations/seed_kyotaku_units.mjs
//
// payroll_kyotaku_service_units master seed
// 集計.py の DEFAULT_UNIT_COUNTS + DEFAULT_ITEMS を INSERT する。
// これがないと給与計算ロジック (要介護単価 × 件数 等) が動かない。
//
// 注意:
//   - 要支援１/２ の unit_count = 514 は SPEC.md に書かれてなかった暫定値
//     (後で user 要確認)
//   - 「～」は全角チルダ U+FF5E
//   - is_addition = 名前に「加算」を含むか
//   - is_office_addition = 「特定事業所加算」を含むか (個人手当から除外する印)
//
// 既存 row は item_name で skip (重複防止)。tenant_id = 'kt-group' 固定。
//
// 実行:
//   DRY:   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... DRY_RUN=true  node apps/payroll-app/migrations/seed_kyotaku_units.mjs
//   LIVE:  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... DRY_RUN=false node apps/payroll-app/migrations/seed_kyotaku_units.mjs

import { createClient } from "@supabase/supabase-js";

const SB_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !KEY) {
  console.error("env required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const DRY_RUN = process.env.DRY_RUN !== "false";
console.log(DRY_RUN ? "*** DRY RUN ***" : "*** LIVE ***");

const admin = createClient(SB_URL, KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TENANT = "kt-group";

const ROWS = [
  { item_name: "要支援１",                      unit_count:  514, display_order:  1, is_addition: false, is_office_addition: false },
  { item_name: "要支援２",                      unit_count:  514, display_order:  2, is_addition: false, is_office_addition: false },
  { item_name: "要介護１～２",                  unit_count: 1086, display_order:  3, is_addition: false, is_office_addition: false },
  { item_name: "要介護３～５",                  unit_count: 1411, display_order:  4, is_addition: false, is_office_addition: false },
  { item_name: "ターミナルケアマネジメント加算", unit_count:  400, display_order:  5, is_addition: true,  is_office_addition: false },
  { item_name: "入院時情報連携加算Ⅰ",           unit_count:  250, display_order:  6, is_addition: true,  is_office_addition: false },
  { item_name: "入院時情報連携加算Ⅱ",           unit_count:  200, display_order:  7, is_addition: true,  is_office_addition: false },
  { item_name: "初回加算",                      unit_count:  300, display_order:  8, is_addition: true,  is_office_addition: false },
  { item_name: "特定事業所加算Ⅱ",               unit_count:  421, display_order:  9, is_addition: true,  is_office_addition: true  },
  { item_name: "退院退所加算Ⅰ１",               unit_count:  450, display_order: 10, is_addition: true,  is_office_addition: false },
  { item_name: "通院時情報連携加算",             unit_count:   50, display_order: 11, is_addition: true,  is_office_addition: false },
];

async function main() {
  // 既存チェック (item_name で skip)
  const { data: existing, error: selErr } = await admin
    .from("payroll_kyotaku_service_units")
    .select("item_name")
    .eq("tenant_id", TENANT);
  if (selErr) {
    console.error("SELECT failed:", selErr.message);
    process.exit(1);
  }
  const existSet = new Set((existing ?? []).map((r) => r.item_name));
  const toInsert = ROWS
    .filter((r) => !existSet.has(r.item_name))
    .map((r) => ({ tenant_id: TENANT, ...r }));

  console.log(`既存 ${existing?.length ?? 0} 件、INSERT 候補 ${toInsert.length} 件`);

  if (DRY_RUN) {
    console.log("INSERT 候補 (先頭 3 件):");
    console.log(JSON.stringify(toInsert.slice(0, 3), null, 2));
    if (toInsert.length > 3) {
      console.log(`... and ${toInsert.length - 3} more`);
    }
    return;
  }

  if (toInsert.length === 0) {
    console.log("変更なし (全て既存)");
    return;
  }

  const { error } = await admin
    .from("payroll_kyotaku_service_units")
    .insert(toInsert);
  if (error) {
    console.error("INSERT failed:", error.message);
    process.exit(1);
  }
  console.log(`OK INSERT 完了: ${toInsert.length} 件`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
