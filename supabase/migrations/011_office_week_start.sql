-- 事業所に週起算曜日を追加
-- 0=日曜, 1=月曜, 2=火曜, 3=水曜, 4=木曜, 5=金曜, 6=土曜
-- デフォルトは日曜 (0)
ALTER TABLE offices
  ADD COLUMN IF NOT EXISTS work_week_start INTEGER NOT NULL DEFAULT 0
    CHECK (work_week_start >= 0 AND work_week_start <= 6);
