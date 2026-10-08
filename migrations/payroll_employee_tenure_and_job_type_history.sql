-- 職種の履歴 と 勤続月数の 2 本立て (2026-10-08 user「OK」)。
--
-- ① 職種を「何月分から」で持つ: 給与設定の行 (effective_from つき) に job_type を足す。
--    NULL = 職員一覧の職種のまま (給与形態・役職・通信費・社保と同じ扱い)。
--
-- ② 勤続月数を 職員ごとに 画面で見て直せるようにする (これまでは 旧システムの従業員データ
--    payroll_legacy_employee に 出力時点の値があるだけで、画面に出ず 直せなかった)。
--      company_tenure_months  法人での勤続 (月数)
--      group_tenure_months    グループ通算の勤続 (月数。グループ間で移って 引き継いだ人は 通算を入れる)
--      tenure_as_of           上の 2 つが いつ時点の値か ('YYYYMM')。以後は 1 か月ごとに 1 足して数える
--    給与計算の優先: この列 (入っていれば) → 旧システムの従業員データ → 実勤続月数。
--    中身は 旧システムの従業員データから写す (migrations/backfill_employee_tenure_from_legacy.mts)。
--
-- Supabase SQL Editor で このまま全部を貼って Run (BEGIN 〜 COMMIT)。

BEGIN;

ALTER TABLE public.payroll_salary_settings
  ADD COLUMN IF NOT EXISTS job_type text;

COMMENT ON COLUMN public.payroll_salary_settings.job_type IS
  'この適用開始月からの職種 (訪問介護 / 訪問入浴 / 訪問看護 / 居宅介護支援 / 福祉用具貸与 / 薬局 / 本社)。NULL=職員一覧の値';

ALTER TABLE public.payroll_employees
  ADD COLUMN IF NOT EXISTS company_tenure_months integer,
  ADD COLUMN IF NOT EXISTS group_tenure_months integer,
  ADD COLUMN IF NOT EXISTS tenure_as_of text;

ALTER TABLE public.payroll_employees DROP CONSTRAINT IF EXISTS payroll_employees_tenure_chk;
ALTER TABLE public.payroll_employees ADD CONSTRAINT payroll_employees_tenure_chk CHECK (
  (tenure_as_of IS NULL OR tenure_as_of ~ '^[0-9]{4}(0[1-9]|1[0-2])$')
  AND (company_tenure_months IS NULL OR company_tenure_months >= 0)
  AND (group_tenure_months IS NULL OR group_tenure_months >= 0)
);

COMMENT ON COLUMN public.payroll_employees.company_tenure_months IS '法人での勤続 (月数)。tenure_as_of 時点の値';
COMMENT ON COLUMN public.payroll_employees.group_tenure_months IS 'グループ通算の勤続 (月数。グループ間の移動で引き継いだ分を含む)。tenure_as_of 時点の値';
COMMENT ON COLUMN public.payroll_employees.tenure_as_of IS '勤続月数がいつ時点の値か (YYYYMM)。以後 1 か月ごとに 1 足す';

COMMIT;
