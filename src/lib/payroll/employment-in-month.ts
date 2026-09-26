/**
 * その月に 在籍していたか・休職していたか を決める (2026-09-27)。
 *
 * 【なぜ純関数にしたか】
 * payroll_employees.employment_status は「今の状態」1 つしか持たない。
 * 給与計算 (payroll/page.tsx) はそれで過去の月まで判定していて、
 * ★ 休職者は 休職に入る前の月まで 月給の計算から外れていた
 *   (林 美咲 1270501180|3290: ② が 202603〜05 に ¥703,824 払っているのに 当方は 0 円)。
 * 判定を 1 か所に集めて 月ごとに引けるようにする。検査: scripts/check-employment-in-month.mts
 *
 * 【規則】
 * 退職 (読み込みの段階。時給・月給とも)
 *   在職区分が 退職者 以外 → 在籍 / 退職者 でも 退職日 >= 月初 → その月は在籍
 *   ★ 在職区分が NULL の行も 外れる。以前の DB 側の条件
 *     .or(employment_status.neq.退職者, resignation_date.gte.<月初>) が NULL を「退職者でない」とみなさなかったのと同じ
 *     (SQL の NULL <> '退職者' は真にならない)。実データに NULL は 0 件 (2026-09-27)
 * 休職 (月給だけ。時給は 働いた記録で決まるので外さない)
 *   在職区分が 空・在職者・退職者 以外 (= 休職者 など) のとき:
 *   ・leave_start_date の列がまだ無い (undefined) → 全部の月で外す (列を足す前と同じ挙動)
 *   ・列はあるが 開始日が空 (null)             → ★ 外さない + 警告。
 *       無い情報を理由に外すと 今回の払い漏れを繰り返す。人が開始日を入れれば正しくなる
 *   ・開始日がある → 休職の期間 [開始日, 終了日 (空なら ずっと)] が その月の全日を覆う月だけ 外す。
 *       月の途中で休職に入る/戻る月は 外さない + 警告 (日割りは未対応)
 */

export type EmploymentFields = {
  employment_status?: string | null;
  resignation_date?: string | null;
  /** 列を足す前は undefined。足した後は string | null */
  leave_start_date?: string | null;
  leave_end_date?: string | null;
};

/** "YYYYMM" → 月初・月末 ("YYYY-MM-DD") */
export function monthBounds(ym: string): { start: string; end: string } {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(4, 6));
  const mm = String(m).padStart(2, "0");
  return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}` };
}

/** 退職の判定: その月に在籍していたか (時給・月給とも、読み込みの段階で使う) */
export function isEmployedInMonth(emp: EmploymentFields, ym: string): boolean {
  const { start } = monthBounds(ym);
  const st = emp.employment_status;
  if (st != null && st !== "退職者") return true;
  return !!emp.resignation_date && emp.resignation_date >= start;
}

/** 休職扱いの在職区分か (空・在職者・退職者 以外) */
const isLeaveStatus = (st: string | null | undefined) => !!st && st !== "在職者" && st !== "退職者";

export type LeaveJudgement = { onLeave: boolean; warning: string | null };

/** 休職の判定: その月は 月給の計算から外すか。warning は 画面に出す文 (外さないが 人が見るべきとき) */
export function leaveInMonth(emp: EmploymentFields, ym: string): LeaveJudgement {
  if (!isLeaveStatus(emp.employment_status)) return { onLeave: false, warning: null };
  // 列がまだ無い: 今までと同じく 全部の月で外す
  if (emp.leave_start_date === undefined) return { onLeave: true, warning: null };
  if (!emp.leave_start_date) {
    return { onLeave: false, warning: `在職区分が ${emp.employment_status} ですが 休職開始日が空です。外さずに計算しました (職員マスタに開始日を入れてください)` };
  }
  const { start, end } = monthBounds(ym);
  const ls = emp.leave_start_date, le = emp.leave_end_date ?? null;
  if (ls <= start && (le === null || le >= end)) return { onLeave: true, warning: null };
  const overlaps = ls <= end && (le === null || le >= start);
  if (overlaps) {
    return { onLeave: false, warning: `月の途中で休職の出入りがあります (休職 ${ls}〜${le ?? ""})。外さずに満額で計算しました (日割りは未対応)` };
  }
  return { onLeave: false, warning: null };
}
