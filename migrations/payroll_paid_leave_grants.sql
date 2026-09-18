-- 有給の付与ごとの 日当 と 前年度繰越 (2026-09-18)
--
-- 有給休暇手当の 1 日単価は、Box 03_有給/<法人>/<年度>/<事業所>.xlsm の個人シートの「今年度日当」。
-- 付与日から 前年度繰越日数 を使い切るまでは 前年度の日当、使い切ったら 今年度の日当 (user 2026-09-18)。
-- 総括表 2026-04〜07 全事業所で 予想が外れたのは 510 件中 2 件。
-- 例) 花見川 保本眞美子: 2026-04-01 付与 繰越 20 日 → 8 月も前年度の 997 円 (今年度は 624 円)
BEGIN;

CREATE TABLE IF NOT EXISTS payroll_paid_leave_grants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  grant_date   DATE NOT NULL,
  carry_days   NUMERIC NOT NULL DEFAULT 0 CHECK (carry_days >= 0),
  grant_days   NUMERIC NULL,
  prev_rate    NUMERIC NULL CHECK (prev_rate IS NULL OR prev_rate >= 0),
  cur_rate     NUMERIC NULL CHECK (cur_rate IS NULL OR cur_rate >= 0),
  source       TEXT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, grant_date)
);

COMMENT ON TABLE payroll_paid_leave_grants IS
  '有給の付与ごとの日当。付与日から carry_days を使い切るまでは prev_rate、以降は cur_rate';

ALTER TABLE payroll_paid_leave_grants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payroll_paid_leave_grants_authenticated ON payroll_paid_leave_grants;
CREATE POLICY payroll_paid_leave_grants_authenticated ON payroll_paid_leave_grants
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
