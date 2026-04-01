-- 夜朝手当の単価設定カラムを salary_settings に追加
-- yocho_unit_price: 夜朝時間に対する単価（円/時間）
-- 夜朝手当 = 夜朝時間（月次手動入力） × yocho_unit_price
-- ※ 夜朝時間の自動計算方法は未確定。現在は給与計算画面で月次手動入力。

ALTER TABLE salary_settings
  ADD COLUMN IF NOT EXISTS yocho_unit_price INTEGER NOT NULL DEFAULT 0;
