// 請求の「発行」と「発行後の訂正」の組み立て (純関数のみ / DB・ブラウザ依存なし)
//
// ⚠ **billing-content.tsx から切り出した。式・条件・順序は 1 文字も変えていない。**
//   component の中にあると import しただけで supabase のブラウザクライアントが
//   起動して Node で落ち、**検証ハーネスから本番のコードを呼べない**。
//   逐語コピーで検査を書くと片方だけ直したときに乖離するので
//   (2026-09-03 に移動支援で「ハーネスが本番と別の表を検証していた」事故があった)、
//   純関数を独立 module に出して **画面とハーネスが同じ関数を使う**。
//
// ── この設計の要点 (kaigo-app には無い) ──────────────────────────────────
//   ① 発行時に **その時点の amount を invoiced_amount に固定**する。
//      あとで amount が変わっても「いくらで請求したか」が残る。
//   ② 発行後の訂正は **元行を書き換えない**。差額を翌月の調整行として作る
//      (billing_status='adjustment' / parent_item_id で元行に紐づく)。
//      = 会計的に正しい「訂正は上書きでなく差額調整」。
//   ③ 発行対象は `billing_status='scheduled'` に限る = **二重発行しない**。
//      一括発行は 100 件ずつの更新でトランザクションではないが、この条件により
//      **再実行すれば残りだけ拾える (冪等)**。

/** 発行対象の 1 行 (画面が取得するのは id と amount だけ) */
export interface IssueTarget {
  id: string;
  amount: number;
}

/** 発行時に書き込む内容 */
export interface IssuePatch {
  billing_status: "invoiced";
  actual_issue_date: string;
  invoiced_amount: number;
}

/**
 * 一括発行で 1 行に書き込む内容を組み立てる。
 *
 * ⚠ `invoiced_amount` に **その時点の amount** を入れるのがこの関数の要点。
 *   ここを外すと「いくらで請求したか」が失われる。
 */
export function buildIssuePatch(target: IssueTarget, today: string): IssuePatch {
  return {
    billing_status: "invoiced",
    actual_issue_date: today,
    invoiced_amount: target.amount,
  };
}

/**
 * 発行対象を絞る条件。**scheduled のみ**。
 * (画面は PostgREST の .eq で絞るが、条件を 1 か所に置いて検証できるようにする)
 */
export const ISSUE_TARGET_STATUS = "scheduled" as const;
export function isIssueTarget(billingStatus: string | null | undefined): boolean {
  return billingStatus === ISSUE_TARGET_STATUS;
}

/**
 * 請求月 "YYYYMM" の翌月。
 * ⚠ 元実装 (billing-content.tsx の nextMonth) と同じく `new Date(y, mm, 1)` を使う。
 *   mm は 1-based なので `new Date(y, mm, 1)` が翌月の 1 日になる (月末繰り上がりなし)。
 */
export function nextBillingMonth(m: string): string {
  const y = parseInt(m.slice(0, 4), 10);
  const mm = parseInt(m.slice(4, 6), 10);
  const d = new Date(y, mm, 1);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** 金額修正のとき、発行前なら上書き / 発行後なら調整行 */
export type AmountEditMode = "overwrite" | "adjustment";

/**
 * 発行前 (scheduled / draft) は amount を直接上書きしてよい。
 * それ以外 (invoiced / paid / overdue …) は元を残して調整行にする。
 */
export function amountEditMode(billingStatus: string | null | undefined): AmountEditMode {
  return billingStatus === "scheduled" || billingStatus === "draft" ? "overwrite" : "adjustment";
}

/** 調整行の元になる情報 */
export interface AdjustmentSource {
  /** 元行 */
  item: { id: string; amount: number; service_month: string | null; service_item: string | null };
  /** 元行が属する請求のヘッダ情報 */
  detail: {
    segment: string | null;
    office_number: string | null;
    client_number: string | null;
    client_name: string | null;
    billing_month: string;
  };
}

export interface AdjustmentRow {
  segment: string | null;
  office_number: string | null;
  client_number: string | null;
  client_name: string | null;
  billing_month: string;
  service_month: string | null;
  service_item: string | null;
  amount: number;
  billing_status: "adjustment";
  parent_item_id: string;
  source: "manual";
  lifecycle_note: string;
}

/**
 * 発行後の金額訂正で作る調整行。**差額が 0 なら null** (作らない)。
 *
 * ⚠ 元行は書き換えない。差額だけを翌月に立てる。
 */
export function buildAdjustmentRow(
  src: AdjustmentSource,
  newAmount: number,
): AdjustmentRow | null {
  const diff = newAmount - src.item.amount;
  if (diff === 0) return null;
  return {
    segment: src.detail.segment,
    office_number: src.detail.office_number,
    client_number: src.detail.client_number,
    client_name: src.detail.client_name,
    billing_month: nextBillingMonth(src.detail.billing_month),
    service_month: src.item.service_month,
    service_item: src.item.service_item,
    amount: diff,
    billing_status: "adjustment",
    parent_item_id: src.item.id,
    source: "manual",
    lifecycle_note: `過誤調整（元請求${src.item.amount}→${newAmount}の差額）`,
  };
}
