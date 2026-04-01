-- 職員マスタに介護資格フラグを追加
-- TRUE: 介護福祉士または実務者研修修了
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS has_care_qualification BOOLEAN NOT NULL DEFAULT FALSE;
