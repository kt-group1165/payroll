// 会社休日 (payroll_company_holidays) migration 適用 + デフォルト seed。
// Run: node apps/payroll-app/scripts/apply_company_holidays.mjs
//
// 1) migrations/payroll_company_holidays.sql を exec_sql RPC で apply
//    (exec_sql RPC が無い場合は SQL Editor で手動実行を促す)
// 2) tenant_id='kt-group' / 当年 (2026) + 翌年 (2027) の
//    お盆 (8/13, 8/14, 8/15) + 年末年始 (12/30, 12/31, 1/2, 1/3) を UPSERT
//    ※ 1/1 は元から国民の祝日のため除外

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// service role key は kaigo-app/.env.local に格納 (4 app 共通の Supabase project)
const envPath = resolve(__dirname, "..", "..", "kaigo-app", ".env.local");
const envText = readFileSync(envPath, "utf8");
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("Missing SUPABASE_URL or SERVICE_ROLE_KEY in kaigo-app/.env.local");
  process.exit(1);
}

const sb = createClient(SB_URL, SB_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ===================================================================
// 1) Migration SQL 適用
// ===================================================================
const sqlPath = resolve(__dirname, "..", "migrations", "payroll_company_holidays.sql");
const sql = readFileSync(sqlPath, "utf8");

console.log("[1/2] migration payroll_company_holidays.sql 適用");
const { error: sqlErr } = await sb.rpc("exec_sql", { sql });
if (sqlErr) {
  // table が既に存在するなら無視して seed に進む
  const msg = sqlErr.message || "";
  if (
    msg.includes("already exists") ||
    msg.includes("relation \"payroll_company_holidays\" already exists")
  ) {
    console.log("  → table 既に存在。seed のみ実行します");
  } else {
    console.error("\n⚠️ exec_sql RPC が無いため、自動適用できません。");
    console.error("Supabase SQL Editor で以下を実行してください:\n");
    console.error("─".repeat(60));
    console.error(sql);
    console.error("─".repeat(60));
    console.error("\n適用後、再度このスクリプトを実行すると seed が走ります。");
    process.exit(1);
  }
} else {
  console.log("  → OK");
}

// ===================================================================
// 2) デフォルト seed (当年 + 翌年)
// ===================================================================
const TENANT_ID = "kt-group";
const now = new Date();
const baseYear = now.getFullYear();
const years = [baseYear, baseYear + 1];

// 各年について:
//   - 8/13, 8/14, 8/15 → name='お盆'
//   - 12/30, 12/31     → name='年末年始'
//   - (1/1 は祝日のため skip)
//   - 1/2, 1/3         → name='年末年始'
function buildSeedRows(year) {
  const rows = [];
  for (const d of [13, 14, 15]) {
    rows.push({
      tenant_id: TENANT_ID,
      holiday_date: `${year}-08-${String(d).padStart(2, "0")}`,
      name: "お盆",
    });
  }
  for (const d of [30, 31]) {
    rows.push({
      tenant_id: TENANT_ID,
      holiday_date: `${year}-12-${String(d).padStart(2, "0")}`,
      name: "年末年始",
    });
  }
  for (const d of [2, 3]) {
    rows.push({
      tenant_id: TENANT_ID,
      holiday_date: `${year}-01-${String(d).padStart(2, "0")}`,
      name: "年末年始",
    });
  }
  return rows;
}

const seedRows = years.flatMap(buildSeedRows);

console.log(`[2/2] デフォルト seed (${TENANT_ID}, ${years.join("/")} 計 ${seedRows.length} 件) UPSERT`);
const { error: upErr } = await sb
  .from("payroll_company_holidays")
  .upsert(seedRows, { onConflict: "tenant_id,holiday_date" });
if (upErr) {
  console.error(`  ✗ upsert 失敗: ${upErr.message}`);
  process.exit(1);
}
for (const r of seedRows) {
  console.log(`  ${r.holiday_date}  ${r.name}`);
}
console.log("\n✅ 会社休日 migration + seed 完了");
