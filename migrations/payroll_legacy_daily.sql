BEGIN;

-- 旧システム (給与管理システム) の「従業員日別データ出力」。1行 = 1職員 × 1日。
-- 出し方: 集計データ出力 → 従業員日別データ出力 → 会社だけ選ぶ (事業所は空で会社全体) / 指定月 YYYY/MM
-- ⚠ 時間列は分に直して入れる (CSV は "HH:MM")。km はカンマが小数点 ('33,600' = 33.6km)
CREATE TABLE IF NOT EXISTS payroll_legacy_daily (
  id                  BIGSERIAL PRIMARY KEY,
  work_date           DATE NOT NULL,
  processing_month    TEXT NOT NULL,
  company_name        TEXT,
  office_number       TEXT NOT NULL,
  office_name         TEXT,
  employee_number     TEXT NOT NULL,
  employee_name       TEXT,
  employment_status   TEXT,
  tenure_months       INTEGER,
  job_type            TEXT,
  pay_type            TEXT,
  visit_min           INTEGER,
  actual_min          INTEGER,
  accompany_min       INTEGER,
  evening_min         INTEGER,
  midnight_min        INTEGER,
  travel_min          INTEGER,
  travel_paid_min     INTEGER,
  work_min            INTEGER,
  overtime_min        INTEGER,
  midnight_ot_min     INTEGER,
  holiday_ot_min      INTEGER,
  legal_within_ot_min INTEGER,
  break_min           INTEGER,
  late_early_min      INTEGER,
  visit_count         INTEGER,
  business_km         NUMERIC(10,2),
  commute_km          NUMERIC(10,2),
  work_note           TEXT,
  source_file         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS payroll_legacy_daily_key
  ON payroll_legacy_daily (work_date, office_number, employee_number);
CREATE INDEX IF NOT EXISTS payroll_legacy_daily_month
  ON payroll_legacy_daily (processing_month, office_number);

ALTER TABLE payroll_legacy_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payroll_legacy_daily_select ON payroll_legacy_daily;
CREATE POLICY payroll_legacy_daily_select ON payroll_legacy_daily
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE payroll_legacy_daily IS '旧システムの従業員日別データ。時間列は分。出勤簿が当方に無い人の出勤時間・残業・出張km・通勤km の確定値';

COMMIT;
