-- ============================================================
-- 居宅介護支援 プラン手当 半期締め支給機能
-- ============================================================
-- 目的:
--   プラン手当 = (要介護件数 × 要介護単価 + 要支援件数 × 要支援単価) − 固定給
--   を「毎月支給 (monthly)」or「半期締め支給 (semi_annual)」で切り替える。
--
--   semi_annual:
--     - 1〜6 月分の差額を 9 月に一括支給
--     - 7〜12 月分の差額を 翌 3 月に一括支給
--     - その他の月は ¥0 出力、内部的に積立額に加算
--
-- 履歴対応:
--   - cycle 設定は payroll_kyotaku_salary (effective_from 履歴 table) に乗せる
--
-- 積立額:
--   - 新規 table payroll_kyotaku_plan_accumulator で職員 × 半期ごとに保持
--   - user が直接編集可 (CSV 差額や月遅れ訂正をまとめて反映)
-- ============================================================

BEGIN;

-- ─── 1) cycle 列を salary 履歴 table に追加 ──────────────────────
ALTER TABLE payroll_kyotaku_salary
  ADD COLUMN IF NOT EXISTS plan_payment_cycle TEXT NOT NULL DEFAULT 'monthly';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payroll_kyotaku_salary_plan_payment_cycle_check'
  ) THEN
    ALTER TABLE payroll_kyotaku_salary
      ADD CONSTRAINT payroll_kyotaku_salary_plan_payment_cycle_check
      CHECK (plan_payment_cycle IN ('monthly', 'semi_annual'));
  END IF;
END $$;

COMMENT ON COLUMN payroll_kyotaku_salary.plan_payment_cycle IS
  'プラン手当の支給サイクル。monthly = 毎月支給 (既存挙動)、'
  ' semi_annual = 1-6月分を9月、7-12月分を3月にまとめて支給。';

-- ─── 2) 積立額 table ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payroll_kyotaku_plan_accumulator (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           TEXT NOT NULL DEFAULT 'kt-group',
  employee_id         UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  period_start        VARCHAR(7) NOT NULL,  -- 'YYYY-MM' (e.g., '2026-01' or '2026-07')
  period_end          VARCHAR(7) NOT NULL,  -- 'YYYY-MM' (e.g., '2026-06' or '2026-12')
  payout_month        VARCHAR(7) NOT NULL,  -- 'YYYY-MM' (e.g., '2026-09' or '2027-03')
  accumulated_amount  INTEGER NOT NULL DEFAULT 0,
  paid_at             TIMESTAMPTZ,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_kyotaku_plan_accumulator_tenant
  ON payroll_kyotaku_plan_accumulator(tenant_id);
CREATE INDEX IF NOT EXISTS idx_kyotaku_plan_accumulator_payout
  ON payroll_kyotaku_plan_accumulator(payout_month);

ALTER TABLE payroll_kyotaku_plan_accumulator ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payroll_kyotaku_plan_accumulator_authenticated
  ON payroll_kyotaku_plan_accumulator;
CREATE POLICY payroll_kyotaku_plan_accumulator_authenticated
  ON payroll_kyotaku_plan_accumulator FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMENT ON TABLE payroll_kyotaku_plan_accumulator IS
  '居宅介護支援ケアマネ プラン手当 半期締め支給用の積立額。'
  ' period_start/period_end は半期 (1-6 or 7-12)、payout_month は 9 月 or 翌 3 月。'
  ' accumulated_amount は user が直接編集可。';

COMMIT;
