/**
 * 居宅の給与設定で 勤続手当の型が空 (null) なのに 件数単価が入っている行を 型 2 (固定 + 件数分) にする (2026-10-19)。
 *
 *   npx tsx migrations/fix_kyotaku_kinzoku_type_null.mts            # DRY RUN
 *   npx tsx migrations/fix_kyotaku_kinzoku_type_null.mts --execute
 *
 * 総括表 (ケアマネ) の 姉崎ムツミ 2026-01〜08 と 花見川 2026-09 のブックには「勤続手当対象」の欄が無く、
 * 取り込み (import_caremane_settings_from_soukatsu.mts) が 型を空にしていた。総括表では 件数分 (単価 × (介護件数 + 予防件数 ÷ 2)) が
 * 払われている (東郷 弘子 190 × 23 = 4,370 / 野口 小百合 330 × 7.5 = 2,475 / 清水 玲 2026-09 330 × 10 = 3,300)。
 * 取り込みの決まりは 同じ commit で直した (欄が空でも 勤続_変動 > 0 なら 型 2)。
 * 対象は 2026-10-19 時点で 6 行 (この 3 人)。それ以外の人の行が出てきたら 止める (確かめていないため)。
 */
import { readFileSync } from "node:fs";
import { restAll } from "../scripts/_rest.mjs";

const EXECUTE = process.argv.includes("--execute");
const CHECKED = new Set(["東郷 弘子", "野口 小百合", "清水 玲"]);
const rows = await restAll<{ id: string; employee_id: string; effective_from: string; kinzoku_type: number | null; kinzoku_unit: number | null }>(
  "payroll_kyotaku_salary?select=id,employee_id,effective_from,kinzoku_type,kinzoku_unit&kinzoku_unit=gt.0&kinzoku_type=is.null");
const names = new Map((await restAll<{ id: string; name: string }>("payroll_employees?select=id,name")).map((e) => [e.id, e.name]));
console.log(`型が空で 件数単価がある行 ${rows.length}`);
for (const r of rows) console.log(`  ${names.get(r.employee_id)} ${r.effective_from}〜 件数単価 ${r.kinzoku_unit} → 型 2`);
const unchecked = rows.filter((r) => !CHECKED.has(String(names.get(r.employee_id) ?? "").replace(/\s+/g, " ")));
if (unchecked.length) { console.error(`✗ 総括表で確かめていない人の行 ${unchecked.length}。止めます`); process.exit(2); }
if (!EXECUTE) { console.log("\nDRY RUN。書き込むときは --execute"); process.exit(0); }

const env: Record<string, string> = {};
for (const f of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" };
for (const r of rows) {
  const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/payroll_kyotaku_salary?id=eq.${r.id}&kinzoku_type=is.null`, { method: "PATCH", headers: H, body: JSON.stringify({ kinzoku_type: 2 }) });
  if (!res.ok) { console.error(`✗ ${r.id}: ${res.status} ${await res.text()}`); process.exit(1); }
  const out = (await res.json()) as unknown[];
  if (out.length !== 1) { console.error(`✗ ${r.id}: 更新 ${out.length} 行 (1 のはず)`); process.exit(1); }
}
const left = await restAll<{ id: string }>("payroll_kyotaku_salary?select=id&kinzoku_unit=gt.0&kinzoku_type=is.null");
console.log(`✓ ${rows.length} 行 更新 / 残り ${left.length}`);
if (left.length) process.exit(1);
