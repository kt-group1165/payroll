// _rest.mts が 1000 行上限を越えられることを実データで確かめる (2026-09-26)
import { restAll, restCount, restPage, restOne, empKey, normEmpNo } from "./_rest.mts";
let ng = 0;
const ok = (b: boolean, msg: string) => { if (!b) ng++; console.log(`  ${b ? "PASS" : "★FAIL"}  ${msg}`); };
console.log("=== restAll が 1000 行を越えるか (今日 3 回踏んだ罠) ===");
for (const [t, q] of [
  ["payroll_soukatsu_rows", "payroll_soukatsu_rows?select=id"],
  ["payroll_legacy_employee", "payroll_legacy_employee?select=id"],
  ["payroll_employees", "payroll_employees?select=id"],
] as const) {
  const n = await restCount(q);
  const rows = await restAll<{ id: string }>(q);
  ok(rows.length === n, `${t}: restAll ${rows.length} 行 = restCount ${n} 行`);
  ok(new Set(rows.map((r) => r.id)).size === rows.length, `${t}: 重複なし (order 付きページングで行が抜けたり重なったりしない)`);
}
console.log("\n=== restPage は切れていたら警告を出す ===");
const p = await restPage<{ id: string }>("payroll_soukatsu_rows?select=id&order=id&limit=1000");
ok(p.length === 1000, `restPage で 1000 行 → 上に ⚠ が出ていれば正しい (got ${p.length})`);
console.log("\n=== restOne ===");
ok((await restOne("payroll_offices?select=id&office_number=eq.1270501180")) !== null, "1 行引ける");
ok((await restOne("payroll_offices?select=id&office_number=eq.0000000000")) === null, "0 行なら null");
let threw = false;
try { await restOne("payroll_offices?select=id"); } catch { threw = true; }
ok(threw, "★ 2 行以上なら例外 (絞り不足を黙って通さない)");
console.log("\n=== 職員番号の扱い ===");
ok(empKey("1272401967", "0674") === "1272401967|674", "empKey が 事業所と対にする + 先頭 0 を落とす");
ok(normEmpNo("00231204") === "231204", "normEmpNo");
console.log(ng === 0 ? "\n✓ 全部 PASS" : `\n★ ${ng} 件 FAIL`);
process.exit(ng === 0 ? 0 : 1);
