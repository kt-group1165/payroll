-- 訪問介護の給与計算結果を DB に保存 (2026-09-17)
-- これまで結果はブラウザの localStorage にしか無く、別 PC から見えず、総括表 (Excel) との突合もできなかった。
-- 事業所 × 処理月 で最新の計算結果を 1 行持つ (再計算で上書き)。確定機能はまだ無い。
BEGIN;

CREATE TABLE IF NOT EXISTS payroll_calc_results (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id        UUID NOT NULL REFERENCES payroll_offices(id) ON DELETE CASCADE,
  office_number    TEXT NOT NULL,
  processing_month TEXT NOT NULL CHECK (processing_month ~ '^[0-9]{6}$'),  -- YYYYMM
  calculated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  calculated_by    UUID DEFAULT auth.uid(),
  payload          JSONB NOT NULL,  -- { hourly: [...], monthly: [...], overtime_settings: [...] } 各行に grand_total を含む
  UNIQUE (office_number, processing_month)
);

COMMENT ON TABLE payroll_calc_results IS
  '訪問介護の給与計算結果 (給与計算画面で計算するたびに上書き)。総括表画面と突合に使う';

ALTER TABLE payroll_calc_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payroll_calc_results_authenticated_all ON payroll_calc_results;
CREATE POLICY payroll_calc_results_authenticated_all ON payroll_calc_results
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
