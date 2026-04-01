-- 給与計算ソフト 初期スキーマ
-- Supabase SQL Editor で実行する

-- 事業所マスタ
CREATE TABLE offices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  office_number TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  office_type TEXT NOT NULL DEFAULT '訪問介護'
    CHECK (office_type IN ('訪問介護', '訪問看護', '訪問入浴', '居宅介護支援', '福祉用具貸与', '薬局', '本社')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 職員マスタ
CREATE TABLE employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_number TEXT NOT NULL,
  name TEXT NOT NULL,
  office_id UUID NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  role_type TEXT NOT NULL DEFAULT 'パートヘルパー'
    CHECK (role_type IN ('管理者', 'サービス提供責任者', '社員ヘルパー', 'パートヘルパー', '事務員')),
  salary_type TEXT NOT NULL DEFAULT '時給'
    CHECK (salary_type IN ('固定給', '時給')),
  base_salary INTEGER,
  fixed_overtime_hours NUMERIC(5,2),
  fixed_overtime_pay INTEGER,
  hourly_rate_physical INTEGER,  -- 身体介護時給
  hourly_rate_living INTEGER,    -- 生活援助時給
  hourly_rate_visit INTEGER,     -- 訪問型時給
  transport_type TEXT NOT NULL DEFAULT '車',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(employee_number, office_id)
);

-- 利用者マスタ
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_number TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  office_id UUID NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(client_number, office_id)
);

-- 取込バッチ管理
CREATE TABLE import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_type TEXT NOT NULL CHECK (import_type IN ('meisai', 'attendance')),
  file_names TEXT[] NOT NULL DEFAULT '{}',
  record_count INTEGER NOT NULL DEFAULT 0,
  processing_month TEXT NOT NULL DEFAULT '',
  office_number TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'error')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- サービス実績（介護ソフトCSVから取込）
CREATE TABLE service_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id UUID NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  office_number TEXT NOT NULL,
  office_name TEXT NOT NULL DEFAULT '',
  processing_month TEXT NOT NULL,
  employee_number TEXT NOT NULL,
  employee_name TEXT NOT NULL DEFAULT '',
  period_start TEXT NOT NULL DEFAULT '',
  period_end TEXT NOT NULL DEFAULT '',
  service_date TEXT NOT NULL,
  dispatch_start_time TEXT NOT NULL DEFAULT '',
  dispatch_end_time TEXT NOT NULL DEFAULT '',
  client_name TEXT NOT NULL DEFAULT '',
  service_type TEXT NOT NULL DEFAULT '',
  actual_start_time TEXT NOT NULL DEFAULT '',
  actual_end_time TEXT NOT NULL DEFAULT '',
  actual_duration TEXT NOT NULL DEFAULT '',
  calc_start_time TEXT NOT NULL DEFAULT '',
  calc_end_time TEXT NOT NULL DEFAULT '',
  calc_duration TEXT NOT NULL DEFAULT '',
  holiday_type TEXT NOT NULL DEFAULT '',
  time_period TEXT NOT NULL DEFAULT '',
  service_category TEXT NOT NULL DEFAULT '',
  amount INTEGER,
  transport_fee INTEGER,
  phone_fee INTEGER,
  adjustment_fee INTEGER,
  meeting_fee INTEGER,
  training_fee INTEGER,
  other_allowance INTEGER,
  total INTEGER,
  accompanied_visit TEXT NOT NULL DEFAULT '',
  client_number TEXT NOT NULL DEFAULT '',
  service_code TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_service_records_month ON service_records(processing_month);
CREATE INDEX idx_service_records_employee ON service_records(employee_number, processing_month);
CREATE INDEX idx_service_records_batch ON service_records(import_batch_id);

-- 出勤簿データ
CREATE TABLE attendance_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id UUID NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  office_number TEXT NOT NULL DEFAULT '',
  employee_number TEXT NOT NULL,
  employee_name TEXT NOT NULL DEFAULT '',
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,
  day_of_week TEXT NOT NULL DEFAULT '',
  substitute_date TEXT NOT NULL DEFAULT '',
  work_note_1 TEXT NOT NULL DEFAULT '',
  work_note_2 TEXT NOT NULL DEFAULT '',
  work_note_3 TEXT NOT NULL DEFAULT '',
  work_note_4 TEXT NOT NULL DEFAULT '',
  work_note_5 TEXT NOT NULL DEFAULT '',
  start_time_1 TEXT NOT NULL DEFAULT '',
  end_time_1 TEXT NOT NULL DEFAULT '',
  start_time_2 TEXT NOT NULL DEFAULT '',
  end_time_2 TEXT NOT NULL DEFAULT '',
  start_time_3 TEXT NOT NULL DEFAULT '',
  end_time_3 TEXT NOT NULL DEFAULT '',
  start_time_4 TEXT NOT NULL DEFAULT '',
  end_time_4 TEXT NOT NULL DEFAULT '',
  start_time_5 TEXT NOT NULL DEFAULT '',
  end_time_5 TEXT NOT NULL DEFAULT '',
  break_time TEXT NOT NULL DEFAULT '',
  work_hours TEXT NOT NULL DEFAULT '',
  commute_km NUMERIC(8,2),
  business_km NUMERIC(8,2),
  overtime_weekly TEXT NOT NULL DEFAULT '',
  overtime_daily TEXT NOT NULL DEFAULT '',
  holiday_work TEXT NOT NULL DEFAULT '',
  legal_overtime TEXT NOT NULL DEFAULT '',
  deduction TEXT NOT NULL DEFAULT '',
  remarks TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_attendance_employee_month ON attendance_records(employee_number, year, month);
CREATE INDEX idx_attendance_batch ON attendance_records(import_batch_id);

-- updated_at 自動更新トリガー
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER offices_updated_at BEFORE UPDATE ON offices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER employees_updated_at BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER clients_updated_at BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS (認証ユーザーはフルアクセス)
ALTER TABLE offices ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated" ON offices FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for authenticated" ON employees FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for authenticated" ON clients FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for authenticated" ON import_batches FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for authenticated" ON service_records FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for authenticated" ON attendance_records FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 開発時はanon keyでもアクセスできるようにする（本番では削除）
CREATE POLICY "Allow all for anon (dev)" ON offices FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon (dev)" ON employees FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon (dev)" ON clients FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon (dev)" ON import_batches FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon (dev)" ON service_records FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon (dev)" ON attendance_records FOR ALL TO anon USING (true) WITH CHECK (true);
