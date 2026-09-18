-- 月ごと・職員ごとの手入力の値 (2026-09-18)
--
-- 総括表で本社が手入力している数字のうち、実績・出勤簿・事業所書式のどこにも元が無いものを
-- 給与計算システムで持つための表。計算し直しても消えない (取込で消さない)。
-- 最初の項目:
--   bath_visit_count  入浴件数。おゆみ野の総括表は 介護超過の時間 = 訪問時間 … + 訪問件数 × 1.12h − 120h
--                     (3〜7月の式で確認。件数は手入力で元の記録は未確認 = user 保留 2026-09-18)
-- item_key を増やせば 有給休暇手当・調整手当 などにも使える。
BEGIN;

CREATE TABLE IF NOT EXISTS payroll_monthly_inputs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  office_number    TEXT NOT NULL,
  employee_number  TEXT NOT NULL,
  processing_month TEXT NOT NULL CHECK (processing_month ~ '^\d{6}$'),
  item_key         TEXT NOT NULL,
  numeric_value    NUMERIC NULL,
  note             TEXT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (office_number, employee_number, processing_month, item_key)
);

CREATE INDEX IF NOT EXISTS payroll_monthly_inputs_office_month
  ON payroll_monthly_inputs (office_number, processing_month);

ALTER TABLE payroll_monthly_inputs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payroll_monthly_inputs_authenticated ON payroll_monthly_inputs;
CREATE POLICY payroll_monthly_inputs_authenticated ON payroll_monthly_inputs
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMENT ON TABLE payroll_monthly_inputs IS '月ごと・職員ごとの手入力 (入浴件数など)。取込では消さない';

COMMIT;
