-- ============================================================
-- 事業所書式入力 (Web UI) 用テーブル
-- ============================================================
-- 目的:
--   既存「【中央】事業所書式完成（最新）.xlsm」で各事業所が入力していた内容を
--   payroll-app の Web 画面 (= /office-input) で直接入力できるようにする。
--
--   将来 給与計算ロジックがこのテーブルを参照する想定。
--
-- 設計:
--   - 1 行 = 1 入力エントリ (= スタッフ × 月 × カテゴリ × 項目 × 値)
--   - category は 5 種類: 数値項目 / 時間項目 / 日付項目 / 日時項目 / 育児手当
--   - 値の格納列は category ごとに使い分け:
--       数値項目 → numeric_value
--       時間項目 → time_minutes
--       日付項目 → date_value
--       日時項目 → start_time / end_time / break_minutes (+ date_value で日付)
--       育児手当 → numeric_value (= 金額) + child_name + reference_month
--
-- RLS:
--   - 他 payroll table と同じパターン (authenticated 全許可、tenant_id 一致のみ)
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS payroll_office_input_entries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL DEFAULT 'kt-group',
  employee_id       UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  billing_month     TEXT NOT NULL,  -- 'YYYY-MM' 例: '2026-05'
  category          TEXT NOT NULL CHECK (category IN (
                      '数値項目',
                      '時間項目',
                      '日付項目',
                      '日時項目',
                      '育児手当'
                    )),
  item_name         TEXT NOT NULL,

  -- 数値項目・育児手当 (金額) 用
  numeric_value     NUMERIC,

  -- 時間項目用 (合計分)
  time_minutes      INTEGER,

  -- 日付項目用 / 日時項目の日付部分
  date_value        DATE,

  -- 日時項目用
  start_time        TIME,
  end_time          TIME,
  break_minutes     INTEGER,

  -- 育児手当用
  child_name        TEXT,
  reference_month   TEXT,  -- 'YYYY-MM' 参照月 (例: 領収月)

  notes             TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payroll_office_input_emp_month
  ON payroll_office_input_entries(employee_id, billing_month);

CREATE INDEX IF NOT EXISTS idx_payroll_office_input_tenant
  ON payroll_office_input_entries(tenant_id);

-- updated_at 自動更新 trigger (= 既存 update_updated_at() function を使う)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at'
  ) THEN
    DROP TRIGGER IF EXISTS payroll_office_input_entries_updated_at
      ON payroll_office_input_entries;
    CREATE TRIGGER payroll_office_input_entries_updated_at
      BEFORE UPDATE ON payroll_office_input_entries
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;

-- RLS
ALTER TABLE payroll_office_input_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payroll_office_input_entries_authenticated
  ON payroll_office_input_entries;
CREATE POLICY payroll_office_input_entries_authenticated
  ON payroll_office_input_entries FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMENT ON TABLE payroll_office_input_entries IS
  '事業所書式入力 (Web UI) のエントリ。'
  ' 1 行 = スタッフ × 月 × カテゴリ × 項目 × 値。'
  ' 既存 xlsm 書式の置換。給与計算が参照する想定。';

COMMIT;
