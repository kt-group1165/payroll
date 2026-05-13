// apps/payroll-app/migrations/seed_sodegaura_kyotaku_v2.mjs
//
// 袖ヶ浦事業所 (office_number=1273400851, office_id=e1a208ca-fdf3-4a7f-9053-eb813927c63d)
// のケアマネ 8 名に対し、6 列分解の新給与設定を投入する。
//
// 前提 DDL: apps/payroll-app/migrations/payroll_employees_kyotaku_columns_v2.sql
//          (kyotaku_honnin_kyu / shokuno_kyu / kotei_zangyo / shikaku_teate / kotei / tokutei_shogu)
//
// 対象:
//   - 既存 7 名 (employee_number 26051301..26051307) は UPDATE
//   - 清水 治美 (26051309) は新規 INSERT
//   - 内海 典子 (26051308) は user 新 list から外れたため kyotaku_* 8 列を NULL に reset
//     (row 自体は残置: employment_status / 退職 status の判断は別タスク)
//
// 既存 kaigo_rate / shien_rate は維持する (user 新 list に rate 情報なし)。
// 旧 kyotaku_base_salary 列は触らない (DB 残置 rollback 用)。
//
// 坂本 祐香: user 表記「佑香」だが国保連 CSV / records と一致するため「祐」のまま UPDATE。
//
// 実行:
//   DRY:   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... DRY_RUN=true  node apps/payroll-app/migrations/seed_sodegaura_kyotaku_v2.mjs
//   LIVE:  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... DRY_RUN=false node apps/payroll-app/migrations/seed_sodegaura_kyotaku_v2.mjs

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

const OFFICE_ID = "e1a208ca-fdf3-4a7f-9053-eb813927c63d"; // 袖ヶ浦 (payroll_offices.id)
const OFFICE_NUMBER = "1273400851";

// user 提示 list (6 列分解)
// 並び順 = employee_number の順 (= 既存 row の順) を維持
const UPDATES = [
  // 26051301 天野 恵子
  {
    name: "天野 恵子",
    honnin: 100000,
    shokuno: 191000,
    koteiZangyo: 49000,
    shikaku: 15000,
    kotei: 10000,
    tokutei: 5000,
  },
  // 26051302 坂本 祐香 (CSV/records 一致 = 祐の字)
  {
    name: "坂本 祐香",
    honnin: 100000,
    shokuno: 115300,
    koteiZangyo: 34700,
    shikaku: null,
    kotei: 5500,
    tokutei: 5000,
  },
  // 26051303 森田 尚子
  {
    name: "森田 尚子",
    honnin: 100000,
    shokuno: 115300,
    koteiZangyo: 34700,
    shikaku: null,
    kotei: 9500,
    tokutei: 5000,
  },
  // 26051304 髙橋 和子
  {
    name: "髙橋 和子",
    honnin: 100000,
    shokuno: 115300,
    koteiZangyo: 34700,
    shikaku: null,
    kotei: 9500,
    tokutei: 5000,
  },
  // 26051305 本庄 麻子
  {
    name: "本庄 麻子",
    honnin: 100000,
    shokuno: 115300,
    koteiZangyo: 34700,
    shikaku: null,
    kotei: 8500,
    tokutei: 5000,
  },
  // 26051306 長谷川 秀子
  {
    name: "長谷川 秀子",
    honnin: 100000,
    shokuno: 115300,
    koteiZangyo: 34700,
    shikaku: null,
    kotei: 7500,
    tokutei: 5000,
  },
  // 26051307 笠原 道代
  {
    name: "笠原 道代",
    honnin: 100000,
    shokuno: 115300,
    koteiZangyo: 34700,
    shikaku: null,
    kotei: 7000,
    tokutei: 5000,
  },
];

// 新規 INSERT 1 名 (清水 治美)
const INSERTS = [
  {
    employee_number: "26051309",
    name: "清水 治美",
    role_type: "社員",
    salary_type: "月給",
    job_type: "居宅介護支援",
    employment_status: "在職者",
    honnin: 100000,
    shokuno: 115300,
    koteiZangyo: 34700,
    shikaku: null,
    kotei: 7000,
    tokutei: 5000,
    // 既存袖ヶ浦標準値
    kaigo_rate: 9000,
    shien_rate: 3000,
  },
];

// reset 対象 (user 新 list 不在 → 8 列 NULL 化)
const RESETS = [{ name: "内海 典子" }];

async function main() {
  // 既存 employees 取得 (UPDATE/RESET 対象の id 解決用)
  const { data: existing, error: selErr } = await admin
    .from("payroll_employees")
    .select(
      "id, employee_number, name, kyotaku_honnin_kyu, kyotaku_shokuno_kyu, kyotaku_kotei_zangyo, kyotaku_shikaku_teate, kyotaku_kotei, kyotaku_tokutei_shogu, kyotaku_kaigo_rate, kyotaku_shien_rate",
    )
    .eq("office_id", OFFICE_ID)
    .order("employee_number");
  if (selErr) {
    console.error("SELECT failed:", selErr.message);
    process.exit(1);
  }

  const byName = new Map((existing ?? []).map((r) => [r.name, r]));

  console.log(`\n袖ヶ浦 既存 employees: ${existing?.length ?? 0} 件`);
  for (const e of existing ?? []) {
    console.log(`  ${e.employee_number} | ${e.name}`);
  }

  // === Plan ===
  console.log(`\n=== UPDATE 対象 (${UPDATES.length} 件) ===`);
  const updatePlan = [];
  for (const u of UPDATES) {
    const row = byName.get(u.name);
    if (!row) {
      console.log(`  [SKIP] ${u.name}: 既存 row が見つからない`);
      continue;
    }
    const patch = {
      kyotaku_honnin_kyu: u.honnin,
      kyotaku_shokuno_kyu: u.shokuno,
      kyotaku_kotei_zangyo: u.koteiZangyo,
      kyotaku_shikaku_teate: u.shikaku,
      kyotaku_kotei: u.kotei,
      kyotaku_tokutei_shogu: u.tokutei,
      // kaigo_rate / shien_rate は触らない
    };
    updatePlan.push({ id: row.id, name: u.name, patch });
    console.log(
      `  ${row.employee_number} | ${u.name} | 本人=${u.honnin} 職能=${u.shokuno} 残業=${u.koteiZangyo} 資格=${u.shikaku ?? "NULL"} 固定=${u.kotei} 処遇=${u.tokutei}`,
    );
  }

  console.log(`\n=== INSERT 対象 (${INSERTS.length} 件) ===`);
  const insertPlan = [];
  for (const ins of INSERTS) {
    if (byName.has(ins.name)) {
      console.log(`  [SKIP] ${ins.name}: 既に existing に存在`);
      continue;
    }
    const payload = {
      office_id: OFFICE_ID,
      employee_number: ins.employee_number,
      name: ins.name,
      role_type: ins.role_type,
      salary_type: ins.salary_type,
      job_type: ins.job_type,
      employment_status: ins.employment_status,
      kyotaku_honnin_kyu: ins.honnin,
      kyotaku_shokuno_kyu: ins.shokuno,
      kyotaku_kotei_zangyo: ins.koteiZangyo,
      kyotaku_shikaku_teate: ins.shikaku,
      kyotaku_kotei: ins.kotei,
      kyotaku_tokutei_shogu: ins.tokutei,
      kyotaku_kaigo_rate: ins.kaigo_rate,
      kyotaku_shien_rate: ins.shien_rate,
    };
    insertPlan.push(payload);
    console.log(
      `  ${ins.employee_number} | ${ins.name} | (新規 INSERT) 本人=${ins.honnin} 職能=${ins.shokuno} 残業=${ins.koteiZangyo} 固定=${ins.kotei} 処遇=${ins.tokutei} kaigo_rate=${ins.kaigo_rate} shien_rate=${ins.shien_rate}`,
    );
  }

  console.log(`\n=== RESET 対象 (${RESETS.length} 件、8 列 NULL 化) ===`);
  const resetPlan = [];
  for (const r of RESETS) {
    const row = byName.get(r.name);
    if (!row) {
      console.log(`  [SKIP] ${r.name}: 既存 row が見つからない (既に削除済?)`);
      continue;
    }
    resetPlan.push({ id: row.id, name: r.name });
    console.log(`  ${row.employee_number} | ${r.name} → 8 列 NULL`);
  }

  if (DRY_RUN) {
    console.log(
      `\n*** DRY RUN 終了 *** (UPDATE=${updatePlan.length}, INSERT=${insertPlan.length}, RESET=${resetPlan.length})`,
    );
    return;
  }

  // === Apply ===
  let ok = 0;
  let fail = 0;

  console.log("\n=== UPDATE 実行 ===");
  for (const u of updatePlan) {
    const { error } = await admin
      .from("payroll_employees")
      .update(u.patch)
      .eq("id", u.id);
    if (error) {
      console.log(`  [FAIL] ${u.name}: ${error.message.slice(0, 200)}`);
      fail += 1;
    } else {
      console.log(`  [OK]   ${u.name}`);
      ok += 1;
    }
  }

  console.log("\n=== INSERT 実行 ===");
  for (const ins of insertPlan) {
    const { error } = await admin.from("payroll_employees").insert(ins);
    if (error) {
      console.log(`  [FAIL] ${ins.name}: ${error.message.slice(0, 200)}`);
      fail += 1;
    } else {
      console.log(`  [OK]   ${ins.name} (${ins.employee_number})`);
      ok += 1;
    }
  }

  console.log("\n=== RESET 実行 (8 列 NULL 化) ===");
  for (const r of resetPlan) {
    const { error } = await admin
      .from("payroll_employees")
      .update({
        kyotaku_honnin_kyu: null,
        kyotaku_shokuno_kyu: null,
        kyotaku_kotei_zangyo: null,
        kyotaku_shikaku_teate: null,
        kyotaku_kotei: null,
        kyotaku_tokutei_shogu: null,
        kyotaku_kaigo_rate: null,
        kyotaku_shien_rate: null,
      })
      .eq("id", r.id);
    if (error) {
      console.log(`  [FAIL] ${r.name}: ${error.message.slice(0, 200)}`);
      fail += 1;
    } else {
      console.log(`  [OK]   ${r.name}`);
      ok += 1;
    }
  }

  console.log(`\n=== サマリー ===`);
  console.log(`  OK:   ${ok}`);
  console.log(`  FAIL: ${fail}`);
  console.log(`  office_number=${OFFICE_NUMBER} office_id=${OFFICE_ID}`);

  // After 確認
  console.log("\n=== After 確認 ===");
  const { data: after, error: afterErr } = await admin
    .from("payroll_employees")
    .select(
      "employee_number, name, kyotaku_honnin_kyu, kyotaku_shokuno_kyu, kyotaku_kotei_zangyo, kyotaku_shikaku_teate, kyotaku_kotei, kyotaku_tokutei_shogu, kyotaku_kaigo_rate, kyotaku_shien_rate",
    )
    .eq("office_id", OFFICE_ID)
    .order("employee_number");
  if (afterErr) {
    console.error("After SELECT failed:", afterErr.message);
  } else {
    for (const a of after ?? []) {
      console.log(
        `  ${a.employee_number} | ${a.name} | honnin=${a.kyotaku_honnin_kyu} shokuno=${a.kyotaku_shokuno_kyu} koteiZ=${a.kyotaku_kotei_zangyo} shikaku=${a.kyotaku_shikaku_teate} kotei=${a.kyotaku_kotei} tokutei=${a.kyotaku_tokutei_shogu} kaigo_rate=${a.kyotaku_kaigo_rate} shien_rate=${a.kyotaku_shien_rate}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
