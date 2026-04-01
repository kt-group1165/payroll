-- 事業所書式 取込テーブル
-- record_type: 'leave'=有給/半有給/特休, 'training'=HRD研修, 'km'=km情報, 'childcare'=保育料
CREATE TABLE IF NOT EXISTS office_form_records (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  import_batch_id UUID REFERENCES import_batches(id) ON DELETE CASCADE,
  office_number TEXT NOT NULL,
  employee_number TEXT NOT NULL,
  processing_month TEXT NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('leave', 'training', 'km', 'childcare')),
  item_name TEXT NOT NULL,
  item_date TEXT,          -- 日付 (M/D 形式: leave/training)
  start_time TEXT,         -- training 開始時間
  end_time TEXT,           -- training 終了時間
  break_time TEXT,         -- training 休憩時間
  numeric_value NUMERIC,   -- km 数値
  year_month TEXT,         -- childcare 年月
  child_name TEXT,         -- childcare お子さん名
  amount INTEGER,          -- childcare 金額
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_office_form_records_month
  ON office_form_records(processing_month);

CREATE INDEX IF NOT EXISTS idx_office_form_records_emp
  ON office_form_records(employee_number, processing_month);

-- import_batches.import_type に office_form を追加
ALTER TABLE import_batches DROP CONSTRAINT IF EXISTS import_batches_import_type_check;
ALTER TABLE import_batches ADD CONSTRAINT import_batches_import_type_check
  CHECK (import_type IN ('meisai', 'attendance', 'office_form'));
