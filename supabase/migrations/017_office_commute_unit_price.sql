-- 事業所マスタに通勤手当単価を追加（円/km）
ALTER TABLE offices
  ADD COLUMN IF NOT EXISTS commute_unit_price NUMERIC(10,2) NOT NULL DEFAULT 0;
