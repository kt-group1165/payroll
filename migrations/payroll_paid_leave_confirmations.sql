-- 有給管理 画面の「管理者・所属長 確認欄」(2026-10-08 user「有給管理画面、任せる」)。
-- Box 03_有給 の個人シートは 使用年月日ごとに 確認欄がある。それを 1 行 = 職員 × 使用日 で持つ。
-- 行がある = 確認済み。外すときは行を消す。
-- Supabase SQL Editor で このまま全部を貼って Run (BEGIN 〜 COMMIT)。

BEGIN;

CREATE TABLE IF NOT EXISTS public.payroll_paid_leave_confirmations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   UUID NOT NULL REFERENCES public.payroll_employees(id) ON DELETE CASCADE,
  use_date      DATE NOT NULL,
  confirmed_by  TEXT NULL,
  confirmed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, use_date)
);

COMMENT ON TABLE public.payroll_paid_leave_confirmations IS
  '有給の使用日ごとの 管理者・所属長の確認。行がある = 確認済み';

ALTER TABLE public.payroll_paid_leave_confirmations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payroll_paid_leave_confirmations_authenticated ON public.payroll_paid_leave_confirmations;
CREATE POLICY payroll_paid_leave_confirmations_authenticated ON public.payroll_paid_leave_confirmations
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
