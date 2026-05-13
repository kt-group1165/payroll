BEGIN;

CREATE TABLE payroll_kyotaku_attendance_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  office_id UUID NOT NULL REFERENCES payroll_offices(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,

  work_date DATE NOT NULL,                  -- 出勤日 YYYY-MM-DD
  start_time TIME,                          -- 出勤時刻 (NULL = 未入力)
  end_time TIME,                            -- 退勤時刻 (NULL = 未入力)
  break_minutes INT NOT NULL DEFAULT 0,     -- 休憩 (分単位)
  is_legal_holiday BOOLEAN NOT NULL DEFAULT false,  -- 法定休日労働
  is_paid_leave BOOLEAN NOT NULL DEFAULT false,     -- 有給休暇
  note TEXT,                                -- 備考

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (employee_id, work_date)
);

CREATE INDEX idx_kyotaku_attendance_office_date
  ON payroll_kyotaku_attendance_records (office_id, work_date);
CREATE INDEX idx_kyotaku_attendance_employee_date
  ON payroll_kyotaku_attendance_records (employee_id, work_date);

ALTER TABLE payroll_kyotaku_attendance_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY kyotaku_attendance_authenticated
  ON payroll_kyotaku_attendance_records
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMIT;
