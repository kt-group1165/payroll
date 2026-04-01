-- 介護超過手当の設定カラムを salary_settings に追加
-- care_overtime_threshold_hours: 超過判定の閾値（時間）。0 = 無効
-- care_overtime_unit_price: 超過時間に対する単価（円/時間）

ALTER TABLE salary_settings
  ADD COLUMN IF NOT EXISTS care_overtime_threshold_hours INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS care_overtime_unit_price       INTEGER NOT NULL DEFAULT 0;
