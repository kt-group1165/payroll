-- migrations/payroll_kyotaku_yobou_records.sql
-- Phase: 居宅介護支援の「介護予防支援 (要支援1/2) 件数管理」用 table 追加
-- 作成: 2026-05-13
--
-- 背景:
--   payroll_kyotaku_records は国保連 CSV (居宅介護支援 = 介護給付) ベースで、
--   care_level に要介護1〜5 / 要支援1〜2 が入る前提だが、
--   袖ヶ浦の CSV は介護給付のみで要支援件数が空欄。
--   介護予防支援は別事業で国保連 CSV のフォーマットも違うため、
--   独自フォーマットの集約形式 (1 row = 1 staff × 1 提供月 × 1 請求月) で別 table 化する。
--
--   - source='csv'    : 独自フォーマット CSV からの取込 (parseYobouCsv)
--   - source='manual' : 手入力 UI からの登録
--
--   月遅れ請求も区別: UNIQUE (office_number, service_month, billing_month, staff_name)
--   (= 同一提供月でも請求月が異なれば別 row)
--
-- 関連:
--   - apps/payroll-app/migrations/payroll_kyotaku_v1.sql (介護給付側の records / settings)
--   - apps/payroll-app/src/lib/csv/yobou-parser.ts        (この table への INSERT 用 CSV パーサ)
--
-- 適用方法: Supabase SQL Editor で 1 ファイルとして実行 (BEGIN/COMMIT 入り)

BEGIN;

CREATE TABLE payroll_kyotaku_yobou_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  office_number TEXT NOT NULL,                 -- 自事業所 (RLS scope key)

  service_month DATE NOT NULL,                 -- 提供年月 (YYYY-MM-01)
  billing_month DATE NOT NULL,                 -- 請求年月 (月遅れ判定用、YYYY-MM-01)

  staff_name TEXT NOT NULL,                    -- 担当ケアマネ氏名 (payroll_employees.name と一致)

  yobou1_count INT NOT NULL DEFAULT 0,         -- 要支援1 件数
  yobou2_count INT NOT NULL DEFAULT 0,         -- 要支援2 件数

  source TEXT NOT NULL CHECK (source IN ('csv', 'manual')),
  source_filename TEXT,                        -- source='csv' のみセット (manual の場合は NULL)
  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- 月遅れも区別: 同 staff × 提供月 × 請求月 で UNIQUE (= 月遅れ請求は別 row)
  UNIQUE (office_number, service_month, billing_month, staff_name)
);

CREATE INDEX idx_kyotaku_yobou_office_month
  ON payroll_kyotaku_yobou_records (office_number, service_month);
CREATE INDEX idx_kyotaku_yobou_staff
  ON payroll_kyotaku_yobou_records (office_number, staff_name);

-- ============================================================
-- RLS (既存 payroll_kyotaku_* と同 policy pattern)
-- ============================================================
ALTER TABLE payroll_kyotaku_yobou_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY kyotaku_yobou_authenticated ON payroll_kyotaku_yobou_records
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
