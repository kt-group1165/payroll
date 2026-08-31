// ============================================================================
// 割増賃金の算定基礎に、施行規則21条で除外できない手当を入れる。
//
//   node migrations/apply_overtime_base_rule21.mjs              DRY RUN
//   node migrations/apply_overtime_base_rule21.mjs --execute    実行
//
// `fix_overtime_base_rule21.sql` と同じ内容を REST から流すもの。
// SQL Editor を開かなくても、dry-run → 差分確認 → 実行 → 検証 まで通せる。
//
// ── 根拠 ────────────────────────────────────────────────────────────────
//   労働基準法37条5項 + 施行規則21条。算定基礎から**除外できる**のは
//     ① 家族手当 ② 通勤手当 ③ 別居手当 ④ 子女教育手当 ⑤ 住宅手当
//     ⑥ 臨時に支払われた賃金 ⑦ 1か月を超える期間ごとに支払われる賃金
//   の 7 つだけ (限定列挙)。役職・資格・勤続・処遇改善は除外できない。
//
// ── 何を true にするか ──────────────────────────────────────────────────
//   役職 / 資格 / 勤続 / 処遇改善 / 特定処遇 / 処遇補助  → true
//   固定残業代  → false のまま (割増賃金そのもの。入れると二重)
//   特別賞与    → false のまま (臨時の賃金 = ⑥で除外できる)
//
// ── 安全装置 ────────────────────────────────────────────────────────────
//   1. 家族/通勤/住宅/別居/子女 に相当する列が現れたら **中止する**。
//      それらは除外すべき手当なので、機械的に true にしてはいけない。
//   2. 変更前の全行を `_backup_payroll_overtime_settings_<日付>.json` に残す。
//   3. 実行後に読み直して、意図どおりか検証する。
//
// ── 影響 (2026-09-01 実測) ──────────────────────────────────────────────
//   733 レコード中 154 で算定基礎が増える (兼務の重複を含む)。
//     訪問介護 153  +4,680円  = 時給 +27.9円/h
//     訪問入浴   1  +120,000円 = 時給 +750円/h  (1,475 → 2,225円/h)
//
//   ⚠ `payroll_overtime_settings` に effective_from が無いので
//     **過去月の再計算値も変わる**。適用月から、という切り分けはできない。
// ============================================================================
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const EXECUTE = process.argv.includes("--execute");

function loadEnv() {
  // payroll-app に .env.local が無ければ kaigo-app のものを使う (同じ DB)
  for (const p of [path.join(ROOT, ".env.local"),
                   path.join(ROOT, "../kaigo-app/.env.local")]) {
    if (!existsSync(p)) continue;
    const e = {};
    for (const l of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
      if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    if (e.NEXT_PUBLIC_SUPABASE_URL && e.SUPABASE_SERVICE_ROLE_KEY) return e;
  }
  return {};
}
const env = loadEnv();
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("✗ .env.local に URL / SERVICE_ROLE_KEY が無い");
  process.exit(1);
}
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

/** true にする 6 つ */
const TURN_ON = [
  "include_position_allowance",
  "include_qualification_allowance",
  "include_tenure_allowance",
  "include_treatment_improvement",
  "include_specific_treatment",
  "include_treatment_subsidy",
];
/** false のままにする 2 つ */
const KEEP_OFF = ["include_fixed_overtime_pay", "include_special_bonus"];
/** ⚠ 現れたら中止する = 施行規則21条で除外すべき手当 */
const MUST_NOT_INCLUDE = /family|commut|hous|separat|education|kazoku|tsukin|jutaku/i;

const LABEL = {
  include_position_allowance: "役職",
  include_qualification_allowance: "資格",
  include_tenure_allowance: "勤続",
  include_treatment_improvement: "処遇改善",
  include_specific_treatment: "特定処遇",
  include_treatment_subsidy: "処遇補助",
  include_fixed_overtime_pay: "固定残業",
  include_special_bonus: "特別賞与",
};

async function get(q) {
  const r = await fetch(`${SB_URL}/rest/v1/${q}`, { headers: H });
  if (!r.ok) throw new Error(`${q} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function main() {
  console.log(`=== 割増賃金の算定基礎を施行規則21条に合わせる ${EXECUTE ? "【実行】" : "【DRY RUN】"} ===\n`);

  const rows = await get("payroll_overtime_settings?select=*&order=job_type");
  if (!rows.length) { console.error("✗ payroll_overtime_settings が空"); process.exit(1); }

  // ── 安全装置 1: 除外すべき手当の列が無いか ──
  const cols = Object.keys(rows[0]);
  const bad = cols.filter((c) => MUST_NOT_INCLUDE.test(c));
  if (bad.length) {
    console.error(`✗ 中止: 施行規則21条で**除外すべき**手当の列がある → ${bad.join(", ")}`);
    console.error("  これらは算定基礎に入れてはいけないので、対象列を見直すこと。");
    process.exit(1);
  }
  console.log("✓ 家族/通勤/住宅/別居/子女 に相当する列は無い (除外すべき手当は混ざらない)\n");

  // ── 変更前 ──
  console.log("── 現状 ──");
  const willChange = [];
  for (const r of rows) {
    const off = TURN_ON.filter((k) => !r[k]);
    const on = KEEP_OFF.filter((k) => r[k]);
    console.log(`  ${String(r.job_type).padEnd(14, "　")}${String(r.scheduled_hours_per_month).padStart(4)}h  `
      + `未算入: ${off.length ? off.map((k) => LABEL[k]).join("・") : "なし"}`
      + (on.length ? `  🔴 入れてはいけないのに算入: ${on.map((k) => LABEL[k]).join("・")}` : ""));
    if (off.length || on.length) willChange.push({ r, off, on });
  }

  if (!willChange.length) {
    console.log("\n✓ すでに施行規則21条どおり。変更するものは無い (冪等)");
    return;
  }
  console.log(`\n  変更対象 ${willChange.length} / ${rows.length} 職種`);

  if (!EXECUTE) {
    console.log("\n※ DRY RUN。実行するには --execute を付ける。");
    console.log("  ⚠ effective_from が無いテーブルなので、**過去月の再計算値も変わる**。");
    return;
  }

  // ── 安全装置 2: バックアップ ──
  // ⚠ ファイル名の日付に toISOString() を使わない。JST の 0〜9 時に前日になる。
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`;
  const bak = path.join(ROOT, "migrations", `_backup_payroll_overtime_settings_${stamp}.json`);
  writeFileSync(bak, JSON.stringify(rows, null, 2), "utf8");
  console.log(`\n✓ バックアップ: ${path.basename(bak)} (${rows.length} 行)`);

  // ── 更新 ──
  const patch = Object.fromEntries([
    ...TURN_ON.map((k) => [k, true]),
    ...KEEP_OFF.map((k) => [k, false]),
    ["updated_at", new Date().toISOString()],
  ]);
  let n = 0;
  for (const { r } of willChange) {
    const res = await fetch(`${SB_URL}/rest/v1/payroll_overtime_settings?id=eq.${r.id}`, {
      method: "PATCH",
      headers: { ...H, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(patch),
    });
    const body = await res.text();
    // ⚠ error を握りつぶさない。200 でも [] なら 0 行更新なので失敗扱いにする
    if (!res.ok || body.trim() === "[]") {
      console.error(`✗ ${r.job_type}: ${res.status} ${body.slice(0, 200)}`);
      console.error(`  戻すには ${path.basename(bak)} の値で PATCH し直す。`);
      process.exit(1);
    }
    n++;
  }
  console.log(`✓ ${n} 職種を更新`);

  // ── 安全装置 3: 読み直して検証 ──
  const after = await get("payroll_overtime_settings?select=*&order=job_type");
  const ng1 = after.filter((r) => TURN_ON.some((k) => !r[k]));
  const ng2 = after.filter((r) => KEEP_OFF.some((k) => r[k]));
  if (ng1.length) { console.error(`✗ 検証失敗: 未更新 ${ng1.length} 職種`); process.exit(1); }
  if (ng2.length) {
    console.error(`✗ 検証失敗: 固定残業代/特別賞与 が算入されている ${ng2.length} 職種`);
    process.exit(1);
  }
  console.log("\n── 適用後 ──");
  for (const r of after) {
    console.log(`  ${String(r.job_type).padEnd(14, "　")}${String(r.scheduled_hours_per_month).padStart(4)}h  `
      + `算入: 本人給・職能給・${TURN_ON.map((k) => LABEL[k]).join("・")}  |  除外: ${KEEP_OFF.map((k) => LABEL[k]).join("・")}`);
  }
  console.log("\n✓ 全職種で施行規則21条どおりの算定基礎になった");
  console.log("⚠ 過去月の給与画面を開くと再計算されて金額が変わる。過去分を精算するかは業務判断。");
}

main().catch((e) => { console.error("✗", e.message); process.exit(1); });
