/**
 * 請求の発行・調整行ロジックの検証 (READ ONLY / DB は読むだけ)
 *
 *   npx tsx scripts/billing-issue-check.mts
 *
 * ⚠ 画面 (billing-content.tsx) が使うのと **同じ関数** を呼ぶ。
 *   逐語コピーで書くと片方だけ直したときに乖離するため。
 *
 * 切り出し (lib/billing/billing-issue.ts) で挙動が変わっていないことを確かめる:
 *   ① 発行対象の抽出条件が変わらない (scheduled のみ)
 *   ② 発行済 155 行の invoiced_amount が amount と一致したまま
 *   ③ 調整行の payload が **切り出し前と同じ**もの (fixture で逐語比較)
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  buildIssuePatch, isIssueTarget, ISSUE_TARGET_STATUS,
  amountEditMode, buildAdjustmentRow, nextBillingMonth,
} from "@/lib/billing/billing-issue";

const env: Record<string, string> = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log("⚠ SUPABASE_SERVICE_ROLE_KEY が無いのでスキップ (anon だと RLS で 0 行になり誤判定する)");
  process.exit(0);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let ng = 0, n = 0;
const eq = (label: string, a: unknown, b: unknown) => {
  n++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) ng++;
  console.log(`  ${ok ? "OK " : "NG "} ${label.padEnd(46)} ${ok ? "" : `実際=${JSON.stringify(a)} 期待=${JSON.stringify(b)}`}`);
};

// ══ ③ 調整行の payload — 切り出し前の式を fixture として逐語で持つ ══════
console.log("══ ③ 調整行の payload が切り出し前と同じか (fixture 比較) ══");
{
  const item = { id: "ITEM-1", amount: 10000, service_month: "202603", service_item: "利用者負担額" };
  const detail = { segment: "介護", office_number: "1270203191", client_number: "248",
    client_name: "見本 太郎", billing_month: "202603" };
  const newAmt = 12500;

  // ── 切り出し **前** の実装をそのまま書いたもの (billing-content.tsx の旧コード) ──
  const diff = newAmt - item.amount;
  const nextMonthOld = (m: string) => {
    const y = parseInt(m.slice(0, 4), 10);
    const mm = parseInt(m.slice(4, 6), 10);
    const d = new Date(y, mm, 1);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
  };
  const before = {
    segment: detail.segment,
    office_number: detail.office_number,
    client_number: detail.client_number,
    client_name: detail.client_name,
    billing_month: nextMonthOld(detail.billing_month),
    service_month: item.service_month,
    service_item: item.service_item,
    amount: diff,
    billing_status: "adjustment",
    parent_item_id: item.id,
    source: "manual",
    lifecycle_note: `過誤調整（元請求${item.amount}→${newAmt}の差額）`,
  };
  const after = buildAdjustmentRow({ item, detail }, newAmt);
  eq("★ 調整行の payload が完全に一致", after, before);
  console.log(`     ${JSON.stringify(after)}`);

  eq("差額 0 なら調整行を作らない", buildAdjustmentRow({ item, detail }, item.amount), null);
  eq("★ 減額 (マイナスの調整行) も作る", buildAdjustmentRow({ item, detail }, 8000)?.amount, -2000);
  eq("減額の note", buildAdjustmentRow({ item, detail }, 8000)?.lifecycle_note, "過誤調整（元請求10000→8000の差額）");
}

console.log("\n══ 翌月の計算 (年またぎ) ══");
eq("202603 → 202604", nextBillingMonth("202603"), "202604");
eq("★ 202612 → 202701 (年またぎ)", nextBillingMonth("202612"), "202701");
eq("202601 → 202602", nextBillingMonth("202601"), "202602");
eq("202611 → 202612", nextBillingMonth("202611"), "202612");

console.log("\n══ 発行前/後の分岐 ══");
eq("scheduled → 上書き", amountEditMode("scheduled"), "overwrite");
eq("draft → 上書き", amountEditMode("draft"), "overwrite");
eq("★ invoiced → 調整行", amountEditMode("invoiced"), "adjustment");
eq("★ paid → 調整行", amountEditMode("paid"), "adjustment");
eq("★ overdue → 調整行", amountEditMode("overdue"), "adjustment");
eq("null → 調整行 (安全側)", amountEditMode(null), "adjustment");

console.log("\n══ 発行 payload ══");
eq("★ invoiced_amount に その時点の amount が入る",
  buildIssuePatch({ id: "X", amount: 11351 }, "2026-04-23"),
  { billing_status: "invoiced", actual_issue_date: "2026-04-23", invoiced_amount: 11351 });

// ══ ①② 実データ ═══════════════════════════════════════════════════════
console.log("\n══ ①② 実データ (READ ONLY) ══");
const { data: R, error } = await sb.from("payroll_billing_amount_items")
  .select("id, amount, invoiced_amount, paid_amount, billing_status");
if (error) throw new Error(error.message);
const rows = R ?? [];
console.log(`  【分母】payroll_billing_amount_items ${rows.length} 行`);
const targets = rows.filter((r) => isIssueTarget(r.billing_status));
const byStatus: Record<string, number> = {};
for (const r of rows) byStatus[String(r.billing_status)] = (byStatus[String(r.billing_status)] ?? 0) + 1;
console.log(`  billing_status: ${JSON.stringify(byStatus)}`);
eq(`① 発行対象 (${ISSUE_TARGET_STATUS}) の件数`, targets.length, byStatus["scheduled"] ?? 0);
eq("① 発行対象に invoiced/paid が混ざらない",
  targets.filter((r) => r.billing_status !== "scheduled").length, 0);

const issued = rows.filter((r) => r.invoiced_amount != null);
console.log(`  【分母】発行済 (invoiced_amount あり) ${issued.length} 行`);
if (issued.length === 0) { console.log("  ⚠ 分母 0 — ② は検証できない"); }
else {
  eq("② amount ≠ invoiced_amount の行", issued.filter((r) => Number(r.invoiced_amount) !== Number(r.amount)).length, 0);
  eq("② 発行済に scheduled が混ざらない", issued.filter((r) => r.billing_status === "scheduled").length, 0);
  // 発行 payload を再現したら同じ invoiced_amount になるか
  const mismatch = issued.filter((r) => buildIssuePatch({ id: String(r.id), amount: Number(r.amount) }, "2026-04-23").invoiced_amount !== Number(r.invoiced_amount));
  eq("★ ② 実データを buildIssuePatch に通しても同じ金額", mismatch.length, 0);
}
console.log(`\n══ 検査 ${n} 件 / NG ${ng} 件 ══`);
// ⚠ 2026-09-05 是正: ng を数えるだけで exit code に反映していなかった。
//   NG が出ても常に exit 0 = check:all 等のゲートで検知できない (silent pass)。
process.exitCode = ng > 0 ? 1 : 0;
