-- 事業所マスタに出張手当単価を追加（円/km）
ALTER TABLE offices
  ADD COLUMN IF NOT EXISTS travel_unit_price INTEGER NOT NULL DEFAULT 0;
