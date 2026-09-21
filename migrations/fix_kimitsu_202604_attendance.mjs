/**
 * 君津 (1273001626) 2026-04 の出勤簿を「旧版」CSV で入れ直す。
 *
 *   node migrations/fix_kimitsu_202604_attendance.mjs            # DRY RUN
 *   node migrations/fix_kimitsu_202604_attendance.mjs --execute  # 現行分を退避して削除 → その後 import-attendance-csv-folder.mts で旧版を取込
 *
 * 経緯 (2026-09-21):
 *   君津は 4 月の出勤簿 CSV を 2 回出している (Box CSV保存先/2026年04月/)。
 *     旧版/                 4/25 出力。1〜30 日 (25〜30 日は予定値)
 *     2026年4月25日から30日/ 5/8 出力。25〜30 日だけ (1〜24 日は空)
 *   当方は後者だけ取り込んでいたので 1〜24 日が 0 分になっていた (三土手 2,530分 vs 総括 11,405分)。
 *   旧版の合計は総括表と 4/5 名で分単位まで一致する (三土手 11,405 / 土岐 10,480 / 深谷 9,645 / 青木 10,860)。
 *   森田 (事務員) だけは旧版 9,300 / 総括 9,840 で一致しないが、後者 (1,800) よりは近い。
 * 退避: 削除前の行を scratchpad ではなく同じフォルダの _backup_*.json に書く (後で消す)。
 */
import { readFileSync, writeFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const env = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" };
const OFFICE = "1273001626";
const EMPS = ["210913", "210914", "211002", "211102", "221201"];

const q = `payroll_attendance_records?office_number=eq.${OFFICE}&year=eq.2026&month=eq.4&employee_number=in.(${EMPS.join(",")})`;
const res = await fetch(`${SB_URL}/rest/v1/${q}&select=*&order=employee_number,day`, { headers: H });
const rows = await res.json();
if (!Array.isArray(rows)) { console.error("読込失敗:", rows); process.exit(1); }
const hm = (s) => { const m = /^(\d+):(\d+)/.exec(String(s ?? "")); return m ? +m[1] * 60 + +m[2] : 0; };
const byEmp = new Map();
for (const r of rows) byEmp.set(r.employee_number, [...(byEmp.get(r.employee_number) ?? []), r]);
console.log(`=== 君津 2026-04 出勤簿 入れ直し ${EXECUTE ? "【本番】" : "(DRY RUN)"} ===`);
for (const [e, rs] of byEmp) {
  const filled = rs.filter((r) => hm(r.work_hours) > 0).map((r) => r.day);
  console.log(`  ${e} ${rs[0].employee_name}  ${rs.length}行  勤務時間計 ${rs.reduce((s, r) => s + hm(r.work_hours), 0)}分  入力日 ${filled[0] ?? "-"}〜${filled.at(-1) ?? "-"}`);
}
const batchIds = [...new Set(rows.map((r) => r.import_batch_id))];
console.log(`  対象 ${rows.length} 行 / バッチ ${batchIds.length}`);
if (!EXECUTE) { console.log("DRY RUN のため削除しません。--execute で実行"); process.exit(0); }

const bk = `migrations/_backup_kimitsu_202604_attendance_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.json`;
writeFileSync(bk, JSON.stringify(rows, null, 1));
console.log(`  退避: ${bk}`);
const del = await fetch(`${SB_URL}/rest/v1/${q}`, { method: "DELETE", headers: { ...H, Prefer: "return=representation" } });
const deleted = await del.json();
if (!del.ok || !Array.isArray(deleted)) { console.error("削除失敗:", deleted); process.exit(1); }
console.log(`  削除 ${deleted.length} 行`);
if (deleted.length !== rows.length) { console.error(`★ 件数不一致 (期待 ${rows.length})`); process.exit(1); }
const bd = await fetch(`${SB_URL}/rest/v1/payroll_import_batches?id=in.(${batchIds.join(",")})`, { method: "DELETE", headers: { ...H, Prefer: "return=representation" } });
const bdel = await bd.json();
if (!bd.ok) { console.error("バッチ削除失敗:", bdel); process.exit(1); }
console.log(`  バッチ削除 ${bdel.length}`);
console.log("次: npx tsx scripts/import-attendance-csv-folder.mts <旧版CSVフォルダ> --execute");
