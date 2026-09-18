-- 給与形態 (時給/月給) と 役職 の月次履歴 (2026-09-18)
--
-- これまで給与形態は payroll_employees.salary_type の「今の値」1 つだけで、
-- 月の途中で切り替わった人の過去月を計算し直すと 今の形態で計算されていた。
--   例) 東郷 仁見初江 2026-03 月給 → 2026-04〜 時給 / さつき 米倉靖子 2026-03 時給 → 2026-04〜 月給
-- 給与設定の履歴 (effective_from) に 給与形態と役職を持たせ、計算する月で有効な行から決める。
-- NULL の行は 職員マスタ (payroll_employees) の値を使う = 今までと同じ動き。
--
-- ⚠ 画面 (給与設定の保存) がこの列を送るので、push より先に適用すること
BEGIN;

ALTER TABLE payroll_salary_settings
  ADD COLUMN IF NOT EXISTS salary_type TEXT NULL,
  ADD COLUMN IF NOT EXISTS role_type   TEXT NULL;

ALTER TABLE payroll_salary_settings
  DROP CONSTRAINT IF EXISTS payroll_salary_settings_salary_type_check;
ALTER TABLE payroll_salary_settings
  ADD CONSTRAINT payroll_salary_settings_salary_type_check
  CHECK (salary_type IS NULL OR salary_type IN ('時給', '月給'));

COMMENT ON COLUMN payroll_salary_settings.salary_type IS
  'この適用開始月からの給与形態 (時給/月給)。NULL = 職員マスタの値を使う';
COMMENT ON COLUMN payroll_salary_settings.role_type IS
  'この適用開始月からの役職 (パート/社員/提責/事務員/管理者)。NULL = 職員マスタの値を使う';

COMMIT;
