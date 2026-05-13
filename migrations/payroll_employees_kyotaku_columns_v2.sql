-- migrations/payroll_employees_kyotaku_columns_v2.sql
-- Phase: payroll_employees に居宅介護支援ケアマネ給与の 6 列分解列を追加
-- 作成: 2026-05-13
--
-- 背景:
--   payroll_employees.kyotaku_base_salary (1 列の基本給) を 6 列に分解する。
--   旧 kyotaku_base_salary は当面残置 (rollback 用) し、コード参照のみ新列に切替える。
--
--   設計:
--     base (= プラン手当との比較に使う集計.py DEFAULT_BASE_SALARY 相当)
--       = honnin_kyu + shokuno_kyu + kotei_zangyo
--     total に加算される独立手当
--       = shikaku_teate + kotei + tokutei_shogu
--
-- 適用方法: Supabase SQL Editor で 1 ファイル実行 (BEGIN/COMMIT 内)。

BEGIN;
  ALTER TABLE payroll_employees
    ADD COLUMN IF NOT EXISTS kyotaku_honnin_kyu INT,        -- 本人給 (base 構成要素)
    ADD COLUMN IF NOT EXISTS kyotaku_shokuno_kyu INT,       -- 職能給 (base 構成要素)
    ADD COLUMN IF NOT EXISTS kyotaku_kotei_zangyo INT,      -- 固定残業手当 (base 構成要素)
    ADD COLUMN IF NOT EXISTS kyotaku_shikaku_teate INT,     -- 資格手当 (total に加算)
    ADD COLUMN IF NOT EXISTS kyotaku_kotei INT,             -- 固定 (total に加算、用途暫定)
    ADD COLUMN IF NOT EXISTS kyotaku_tokutei_shogu INT;     -- 特定処遇改善 (total に加算)

  COMMENT ON COLUMN payroll_employees.kyotaku_honnin_kyu IS '居宅介護支援: 本人給 (円、NULL=未設定)。base = honnin+shokuno+kotei_zangyo';
  COMMENT ON COLUMN payroll_employees.kyotaku_shokuno_kyu IS '居宅介護支援: 職能給 (円、NULL=未設定)。base 構成要素';
  COMMENT ON COLUMN payroll_employees.kyotaku_kotei_zangyo IS '居宅介護支援: 固定残業手当 (円、NULL=未設定)。base 構成要素';
  COMMENT ON COLUMN payroll_employees.kyotaku_shikaku_teate IS '居宅介護支援: 資格手当 (円、NULL=未設定)。total に独立加算';
  COMMENT ON COLUMN payroll_employees.kyotaku_kotei IS '居宅介護支援: 固定 (円、NULL=未設定)。total に独立加算 (用途暫定)';
  COMMENT ON COLUMN payroll_employees.kyotaku_tokutei_shogu IS '居宅介護支援: 特定処遇改善 (円、NULL=未設定)。total に独立加算';
COMMIT;
