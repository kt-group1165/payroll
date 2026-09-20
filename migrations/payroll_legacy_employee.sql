BEGIN;

-- 旧システム (給与管理システム) の「従業員データ」。1行 = 1職員 × 1所属。
-- ⚠ 社員No は事業所をまたぐと重複するので (所属名, 社員No) が一意キー。
-- ⚠ 勤続年数の 3 列は **月数** で、CSV に月の指定が無い (出力時点の値)。
--    2026-09-21 に出したものは 2026-08 時点だった。それを tenure_as_of に明示して持つ。
CREATE TABLE IF NOT EXISTS payroll_legacy_employee (
  id                     BIGSERIAL PRIMARY KEY,
  office_name            TEXT NOT NULL,
  employee_number        TEXT NOT NULL,
  employee_name          TEXT,
  employment_status      TEXT,
  pay_type               TEXT,
  job_type               TEXT,
  hire_date              DATE,
  quit_date              DATE,
  leave_reason           TEXT,
  office_tenure_months   INTEGER,
  company_tenure_months  INTEGER,
  group_tenure_months    INTEGER,
  tenure_as_of           TEXT NOT NULL,
  source_file            TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS payroll_legacy_employee_key
  ON payroll_legacy_employee (office_name, employee_number);
CREATE INDEX IF NOT EXISTS payroll_legacy_employee_num
  ON payroll_legacy_employee (employee_number);

ALTER TABLE payroll_legacy_employee ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payroll_legacy_employee_select ON payroll_legacy_employee;
CREATE POLICY payroll_legacy_employee_select ON payroll_legacy_employee
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE  payroll_legacy_employee IS '旧システムの従業員データ (入社日・勤続月数)。勤続月数は tenure_as_of 時点の値';
COMMENT ON COLUMN payroll_legacy_employee.group_tenure_months IS 'グループ勤続月数。総括表2026-03〜07のパート575人月で97.9%一致 (会社97.7/事業所96.9/入社日からの暦月86.6)';

COMMIT;
