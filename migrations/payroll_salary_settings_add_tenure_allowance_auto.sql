-- 勤続手当 自動計算 切替フラグ
-- TRUE  → 勤続年数 × 給与形態 × 職種 から auto 計算 (payroll page の computeTenureAllowance)
-- FALSE → 手動入力された tenure_allowance を使用
-- 既存運用維持のため default TRUE。
BEGIN;
ALTER TABLE payroll_salary_settings
  ADD COLUMN IF NOT EXISTS tenure_allowance_auto BOOLEAN NOT NULL DEFAULT true;
COMMENT ON COLUMN payroll_salary_settings.tenure_allowance_auto IS
  '勤続手当を自動計算するか (TRUE=auto / FALSE=手動入力値を使用)';
COMMIT;
