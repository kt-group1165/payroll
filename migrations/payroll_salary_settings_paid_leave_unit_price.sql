-- 有給休暇手当の 1 日あたりの単価を 給与設定の履歴 (effective_from) に持たせる (2026-09-18)
--
-- これまで単価は payroll_employees.paid_leave_unit_price の「今の値」1 つだけだった。
-- 総括表 (2026-03〜07) では 社員の単価が 2026-03 → 04 で多くの人が変わる (年度で決め直している)。
--   例) おゆみ野 進藤育代 03: 1,445円/日 → 04〜: 2,303円/日 / Hana中央 池谷美佐子 2,040 → 1,993
-- user 見立て: 前年の介護超過手当 ÷ 前年の稼働 で決めている可能性。自動算出は後日、まずは単価を手で持つ。
-- NULL の行は 職員マスタ (payroll_employees.paid_leave_unit_price) の値を使う = 今までと同じ動き。
--
-- ⚠ 画面 (給与設定の保存) がこの列を送るので、push より先に適用すること
BEGIN;

ALTER TABLE payroll_salary_settings
  ADD COLUMN IF NOT EXISTS paid_leave_unit_price NUMERIC NULL;

ALTER TABLE payroll_salary_settings
  DROP CONSTRAINT IF EXISTS payroll_salary_settings_paid_leave_unit_price_check;
ALTER TABLE payroll_salary_settings
  ADD CONSTRAINT payroll_salary_settings_paid_leave_unit_price_check
  CHECK (paid_leave_unit_price IS NULL OR paid_leave_unit_price >= 0);

COMMENT ON COLUMN payroll_salary_settings.paid_leave_unit_price IS
  'この適用開始月からの有給休暇手当の単価 (円/日)。有給日数 (半休 0.5) × 単価。NULL = 職員マスタの値';

COMMIT;
