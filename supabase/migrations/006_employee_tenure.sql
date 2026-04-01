-- 職員マスタに在職区分・入退社日・実勤続月数を追加

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS employment_status TEXT NOT NULL DEFAULT '在職者'
    CHECK (employment_status IN ('在職者', '休職者', '退職者')),
  ADD COLUMN IF NOT EXISTS hire_date DATE,
  ADD COLUMN IF NOT EXISTS resignation_date DATE,
  -- 実勤続月数（休職中の労働日ゼロ月はカウントしない）
  -- 初期値はCSVから取込。以降、出勤実績がある月に +1 する運用。
  ADD COLUMN IF NOT EXISTS effective_service_months INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN employees.effective_service_months IS
  '実勤続月数。休職中で労働日ゼロの月は加算しない。出勤簿確定時に月次更新する。';
