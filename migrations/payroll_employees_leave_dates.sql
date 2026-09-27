-- ============================================================================================
-- ⚠⚠⚠ この SQL を流す前に 林 美咲 (1270501180|3290) の休職開始日を決めること ⚠⚠⚠
--   ★ 流しただけで 開始日が空のままだと、次の再計算で 202603〜08 の全月に固定給が付く。
--   ★ ② (総括表・支払用) は 06〜08 を払っていない = 過払いになる。
--   ★ SQL を流す ⇔ 開始日を入れる は **同時に** (流したら すぐ /employees で開始日を入れ、その後に再計算)。
--   ★ 138 件の まとめて再計算 の前には流さないこと。
-- ============================================================================================
--
-- payroll_employees に 休職の開始日・終了日を足す (2026-09-27)
--
-- なぜ: employment_status は「今の状態」1 つしか持たず、給与計算 (payroll/page.tsx) は 休職者を
--   ★ 休職に入る前の月まで 月給の計算から外していた。
--   実例: 林 美咲 (1270501180|3290) は ② (総括表) が 202603〜05 に ¥703,824 払っているのに 当方は 0 円。
--   判定は src/lib/payroll/employment-in-month.ts の leaveInMonth。
--
-- 列を足した後の挙動:
--   ・休職者で 開始日が空 → ★ 外さずに計算して 警告を出す (無い情報を理由に外すと 払い漏れを繰り返すため)
--   ・開始日がある → 休職の期間 [開始日, 終了日 (空なら ずっと)] が その月の全日を覆う月だけ 月給から外す
--   ・月の途中で休職に入る/戻る月は 外さずに満額 + 警告 (日割りは未対応)
--   ★ 列が無い間は 以前と同じ (休職者は全部の月で外す)。
--
-- ⚠ 流したあと 林 美咲の休職開始日を /employees で入れるまでは、林さんは 全月 (202606〜08 も) 固定給が付く。
--   ② は 06〜08 を払っていない。★ 開始日を入れる前に 202606〜08 の おゆみ野 (1270501180) を再計算しないこと。
--
-- 実行: Supabase SQL Editor に全体を貼って Run (BEGIN; 〜 COMMIT; の 1 ブロック)。流したら applied_archive/ へ移す。

BEGIN;

ALTER TABLE payroll_employees
  ADD COLUMN IF NOT EXISTS leave_start_date date,
  ADD COLUMN IF NOT EXISTS leave_end_date   date;

COMMENT ON COLUMN payroll_employees.leave_start_date IS '休職の開始日。休職者で空のときは 給与計算は外さずに警告を出す (employment-in-month.ts)';
COMMENT ON COLUMN payroll_employees.leave_end_date   IS '休職の終了日 (復職の前日)。空なら 休職が続いている';

ALTER TABLE payroll_employees
  DROP CONSTRAINT IF EXISTS payroll_employees_leave_range_chk;
ALTER TABLE payroll_employees
  ADD CONSTRAINT payroll_employees_leave_range_chk
  CHECK (leave_end_date IS NULL OR leave_start_date IS NULL OR leave_end_date >= leave_start_date);

COMMIT;

-- ── 検算 (流したあとに 1 つずつ Run) ──
-- 1. 列が 2 本あり nullable であること (期待: 2 行・is_nullable = YES・data_type = date)
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
--  WHERE table_name = 'payroll_employees' AND column_name IN ('leave_start_date', 'leave_end_date');
-- 2. 制約が入っていること (期待: 1 行)
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'payroll_employees_leave_range_chk';
-- 3. 既存の行は全部 空のまま (期待: 0)
-- SELECT count(*) FROM payroll_employees WHERE leave_start_date IS NOT NULL OR leave_end_date IS NOT NULL;
-- 4. 開始日の入力が要る人 (期待: 林 美咲 1 行。在職区分が 休職者 で 開始日が空)
-- SELECT employee_number, name, employment_status, leave_start_date FROM payroll_employees
--  WHERE employment_status NOT IN ('在職者', '退職者') AND leave_start_date IS NULL;
