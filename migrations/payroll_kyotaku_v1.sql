-- migrations/payroll_kyotaku_v1.sql
-- Phase: payroll-app に居宅介護支援用の給与計算機能を追加 (apps/居宅給与計算/集計.py の TypeScript 移植)
-- 作成: 2026-05-13
--
-- 背景:
--   apps/居宅給与計算/集計.py (1267 行 Python スタンドアロン) を payroll-app に統合。
--   訪問介護向け既存 payroll_* table と並行して、居宅介護支援向け payroll_kyotaku_*
--   table 群を新規追加する。office.office_type で UI/DB を切り替える。
--
-- 5 つの新 table:
--   1. payroll_kyotaku_records          国保連 CSV の row (1 row = 1 明細)
--   2. payroll_kyotaku_settings         ケアマネ別給与設定 (基本給 / 要介護単価 / 要支援単価)
--   3. payroll_kyotaku_service_units    項目別 単位数 master (要介護1〜2 / 加算系)
--   4. payroll_kyotaku_regional_rates   保険者 → 1単位の円 (1 級地 11.40 等)
--   5. payroll_kyotaku_confirmations    支給済み (append-only: reverted_at で解除)
--
-- 仕様: apps/居宅給与計算/SPEC.md (582 行) 参照
-- 適用方法: Supabase SQL Editor で 1 ファイルとして実行 (BEGIN/COMMIT 入り)

BEGIN;

-- ============================================================
-- 1. payroll_kyotaku_records: 国保連 CSV を行単位で保持
-- ============================================================
CREATE TABLE payroll_kyotaku_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  office_number TEXT NOT NULL,         -- 自事業所 (RLS scope key)

  -- 提供月 / 請求月 (YYYY-MM-01 で正規化、delay 区分判定用)
  service_month DATE NOT NULL,         -- 提供年月
  billing_month DATE NOT NULL,         -- 請求年月

  -- 集計の主キー
  staff_name TEXT NOT NULL,            -- 担当ケアマネ氏名 (CSV「担当者氏名」)
  detail_row_no TEXT,                  -- 明細行番号 ("1" が基本サービス行)

  -- 利用者情報
  insured_number TEXT,                 -- 被保険者番号
  insured_name TEXT,                   -- 被保険者名
  client_number TEXT,                  -- 利用者番号
  gender TEXT,
  birth_date DATE,
  care_level TEXT,                     -- 要介護度 (要支援１〜２ / 要介護１〜５)

  -- 保険者 (地域加算判定キー)
  insurer_number TEXT,
  insurer_name TEXT,

  -- サービス情報
  service_code TEXT,                   -- サービスコード
  service_name TEXT,                   -- サービス名 (加算判定: "加算" が含まれるか)
  unit_total INT,                      -- 単位数合計
  unit_price NUMERIC(6,2),             -- 単位数単価
  amount INT,                          -- 請求額 (円)

  -- 認定情報
  cert_start_date DATE,
  cert_end_date DATE,

  -- 担当者・事業所情報
  staff_number TEXT,
  staff_identifier TEXT,
  kyotaku_office_number TEXT,
  kyotaku_office_name TEXT,
  kyotaku_support_number TEXT,
  receiver_number TEXT,

  -- 取込メタ
  import_batch_id UUID,                -- 既存 import_batches FK にしてもよい (任意)
  source_filename TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- 重複 INSERT 防止 (CSV 再取込時の dedup)
  UNIQUE (office_number, service_month, detail_row_no, insured_number, service_code, staff_name)
);

CREATE INDEX idx_kyotaku_records_office_month
  ON payroll_kyotaku_records (office_number, service_month);
CREATE INDEX idx_kyotaku_records_staff
  ON payroll_kyotaku_records (office_number, staff_name);
CREATE INDEX idx_kyotaku_records_client
  ON payroll_kyotaku_records (office_number, client_number);

-- ============================================================
-- 2. payroll_kyotaku_settings: ケアマネ別給与設定
-- ============================================================
CREATE TABLE payroll_kyotaku_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  office_number TEXT NOT NULL,
  staff_name TEXT NOT NULL,

  base_salary INT NOT NULL DEFAULT 250000,    -- 基本給 (集計.py: DEFAULT_BASE_SALARY)
  kaigo_rate INT NOT NULL DEFAULT 0,          -- 要介護単価 (円/件)
  shien_rate INT NOT NULL DEFAULT 0,          -- 要支援単価 (円/件)

  -- 適用期間 (将来の昇給対応用、現状は NULL 許容)
  effective_from DATE,
  effective_to DATE,

  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (office_number, staff_name)           -- 1 ケアマネ = 1 設定 (現行仕様)
);

-- ============================================================
-- 3. payroll_kyotaku_service_units: 項目別 単位数 master
-- ============================================================
CREATE TABLE payroll_kyotaku_service_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,

  item_name TEXT NOT NULL,                     -- "要支援１" / "要介護１～２" / "初回加算" 等
  unit_count INT NOT NULL,                     -- 単位数 (例: 1086 / 250 / 300)

  display_order INT,                           -- 売上表での行順
  is_addition BOOLEAN NOT NULL DEFAULT false,  -- "加算" 系か (給与計算で加算手当対象)
  is_office_addition BOOLEAN NOT NULL DEFAULT false,  -- "特定事業所加算" 系 (個人手当から除外)

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, item_name)
);

-- 初期データ (集計.py DEFAULT_UNIT_COUNTS / DEFAULT_ITEMS 由来) は別 seed mjs で投入する想定

-- ============================================================
-- 4. payroll_kyotaku_regional_rates: 地域区分 (保険者 → 円/単位)
-- ============================================================
CREATE TABLE payroll_kyotaku_regional_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,

  insurer_name TEXT NOT NULL,                  -- "千葉市" / "市原市" 等 (CSV「保険者」と一致)
  rate NUMERIC(6,2) NOT NULL DEFAULT 10.0,     -- 1 単位あたりの円 (1 級地 11.40 等)

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, insurer_name)
);

-- ============================================================
-- 5. payroll_kyotaku_confirmations: 支給済み (append-only)
-- ============================================================
-- append-only 設計: 解除しても row は残し、reverted_at で無効化を表現
-- (集計.py の「支給済み sheet」相当だが、監査ログ強化)
CREATE TABLE payroll_kyotaku_confirmations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  office_number TEXT NOT NULL,
  staff_name TEXT NOT NULL,

  pay_month DATE NOT NULL,                     -- 支払い月 (YYYY-MM-01)
  amount INT NOT NULL,                         -- 支給済み合計額

  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_by TEXT,

  -- 解除時にここに時刻 + 操作者 (row は削除しない)
  reverted_at TIMESTAMPTZ,
  reverted_by TEXT,

  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 有効な確定 (reverted_at IS NULL) は 1 件のみ
CREATE UNIQUE INDEX idx_kyotaku_confirmations_unique_active
  ON payroll_kyotaku_confirmations (office_number, staff_name, pay_month)
  WHERE reverted_at IS NULL;

CREATE INDEX idx_kyotaku_confirmations_office_pay
  ON payroll_kyotaku_confirmations (office_number, pay_month);

-- ============================================================
-- RLS (office_number scoped、既存 payroll_* と同パターン)
-- ============================================================
ALTER TABLE payroll_kyotaku_records         ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_kyotaku_settings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_kyotaku_service_units   ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_kyotaku_regional_rates  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_kyotaku_confirmations   ENABLE ROW LEVEL SECURITY;

-- authenticated user は全 row 操作可。office_number scope は app 側で filter する。
-- (既存 payroll_* table と同一 policy pattern。後続 phase で multi-tenant scope を強化したい場合は別 migration)
CREATE POLICY kyotaku_records_authenticated      ON payroll_kyotaku_records
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY kyotaku_settings_authenticated     ON payroll_kyotaku_settings
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY kyotaku_units_authenticated        ON payroll_kyotaku_service_units
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY kyotaku_rates_authenticated        ON payroll_kyotaku_regional_rates
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY kyotaku_confirmations_authenticated ON payroll_kyotaku_confirmations
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
