-- 事業所に会議1単価を追加
ALTER TABLE offices ADD COLUMN IF NOT EXISTS meeting_unit_price NUMERIC(10,2) NOT NULL DEFAULT 0;
