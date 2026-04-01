-- 出張手当単価を小数点2位対応に変更
ALTER TABLE offices
  ALTER COLUMN travel_unit_price TYPE NUMERIC(10,2) USING travel_unit_price::NUMERIC(10,2);
