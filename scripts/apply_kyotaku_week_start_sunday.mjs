// 居宅介護支援事業所の payroll_offices.work_week_start を 0 (日曜起算) に統一する。
// 法定休日 auto-detect (労基§35) と週次残業の週境界を一律 日曜起算 にするための data fix。
// Run: node scripts/apply_kyotaku_week_start_sunday.mjs

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

const supabase = createClient(SB_URL, SB_KEY);

// 1) 現状確認
const { data: before, error: e1 } = await supabase
  .from("payroll_offices")
  .select("id, office_number, short_name, office_type, work_week_start")
  .eq("office_type", "居宅介護支援")
  .order("office_number");
if (e1) {
  console.error("select failed:", e1.message);
  process.exit(1);
}
console.log(`[before] 居宅介護支援 ${before.length} 件:`);
for (const o of before) {
  console.log(`  ${o.office_number} ${o.short_name ?? "(no name)"} work_week_start=${o.work_week_start}`);
}

const needsUpdate = before.filter((o) => o.work_week_start !== 0);
if (needsUpdate.length === 0) {
  console.log("\n→ 全件すでに 0 (日曜起算)。何もしません。");
  process.exit(0);
}

console.log(`\n→ ${needsUpdate.length} 件を 0 (日曜起算) に更新します...`);

// 2) UPDATE
const { error: e2, count } = await supabase
  .from("payroll_offices")
  .update({ work_week_start: 0 }, { count: "exact" })
  .eq("office_type", "居宅介護支援")
  .neq("work_week_start", 0);
if (e2) {
  console.error("update failed:", e2.message);
  process.exit(1);
}
console.log(`✓ 更新完了 (${count} 件)`);

// 3) 確認
const { data: after, error: e3 } = await supabase
  .from("payroll_offices")
  .select("office_number, short_name, work_week_start")
  .eq("office_type", "居宅介護支援")
  .order("office_number");
if (e3) {
  console.error("verify failed:", e3.message);
  process.exit(1);
}
console.log(`\n[after] 居宅介護支援 ${after.length} 件:`);
for (const o of after) {
  const mark = o.work_week_start === 0 ? "✓" : "✗";
  console.log(`  ${mark} ${o.office_number} ${o.short_name ?? "(no name)"} work_week_start=${o.work_week_start}`);
}
const stillNonZero = after.filter((o) => o.work_week_start !== 0);
if (stillNonZero.length > 0) {
  console.error(`\n⚠ 未更新の row が ${stillNonZero.length} 件残っています`);
  process.exit(1);
}
console.log("\n✓ 全件 日曜起算 (0) に統一完了");
