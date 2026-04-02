-- 事業所に移動手当単価（円/時）を追加
ALTER TABLE offices ADD COLUMN IF NOT EXISTS travel_allowance_rate NUMERIC(10,2) NOT NULL DEFAULT 0;
