-- migrations/payroll_employees_kyotaku_columns.sql
-- Phase: payroll_employees に居宅介護支援ケアマネ給与列を追加 (集計.py 給与設定 の統合)
-- 作成: 2026-05-13
--
-- 背景: payroll_kyotaku_settings を廃止し、payroll_employees に集約する設計切替の
--       第一歩。既存の payroll_kyotaku_settings table はデータ移行後に DROP 予定。
-- 適用方法: Supabase SQL Editor で 1 ファイル実行 (BEGIN/COMMIT 内)。

BEGIN;
  ALTER TABLE payroll_employees
    ADD COLUMN IF NOT EXISTS kyotaku_base_salary INT,
    ADD COLUMN IF NOT EXISTS kyotaku_kaigo_rate INT,
    ADD COLUMN IF NOT EXISTS kyotaku_shien_rate INT;

  COMMENT ON COLUMN payroll_employees.kyotaku_base_salary IS '居宅介護支援: ケアマネ基本給 (円、NULL=未設定で default 250000 fallback)';
  COMMENT ON COLUMN payroll_employees.kyotaku_kaigo_rate IS '居宅介護支援: 要介護プラン手当単価 (円/件、NULL=0)';
  COMMENT ON COLUMN payroll_employees.kyotaku_shien_rate IS '居宅介護支援: 要支援プラン手当単価 (円/件、NULL=0)';
COMMIT;
