-- 職員マスタに住所カラムを追加
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS address TEXT NOT NULL DEFAULT '';
