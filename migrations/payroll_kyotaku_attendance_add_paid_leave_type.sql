-- 有給に「全有給/半有給」の区別を追加
-- 既存 is_paid_leave (boolean) は backward compat 用に残置するが、UI/calc は paid_leave_type で動く。
-- 値: NULL=有給なし, 'full'=全有給(1日), 'half'=半有給(0.5日)

ALTER TABLE payroll_kyotaku_attendance_records
  ADD COLUMN IF NOT EXISTS paid_leave_type TEXT;

-- 既存 is_paid_leave=true の row を 'full' (全有給) として backfill
UPDATE payroll_kyotaku_attendance_records
  SET paid_leave_type = 'full'
  WHERE is_paid_leave = true AND paid_leave_type IS NULL;

-- CHECK constraint (NULL / 'full' / 'half' のみ許容)
ALTER TABLE payroll_kyotaku_attendance_records
  DROP CONSTRAINT IF EXISTS paid_leave_type_check;
ALTER TABLE payroll_kyotaku_attendance_records
  ADD CONSTRAINT paid_leave_type_check
    CHECK (paid_leave_type IS NULL OR paid_leave_type IN ('full', 'half'));

COMMENT ON COLUMN payroll_kyotaku_attendance_records.paid_leave_type IS
  '有給種別: NULL=有給なし, full=全有給(1日), half=半有給(0.5日)。is_paid_leave は backward compat 用 (paid_leave_type IS NOT NULL と同義)';
