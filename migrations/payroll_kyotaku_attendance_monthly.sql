-- ============================================================
-- payroll_kyotaku_attendance_monthly + _kasan
-- 居宅介護支援 出勤簿 月単位データ (件数 + 加算)
-- ============================================================
-- 設計:
--   出勤簿は日次 (payroll_kyotaku_attendance_records) と
--   月次 (本ファイル: payroll_kyotaku_attendance_monthly) の 2 つに分かれる。
--
--   _monthly:        1 ケアマネ × 1 月 = 1 row。介護件数 / 予防件数 を保持
--   _monthly_kasan:  1 ケアマネ × 1 月 = N row。各 row は
--                    (kasan_unit + kasan_count) の規定加算、または
--                    (free_label + free_amount) の自由記述加算 のどちらか
--
--   PRIMARY KEY:
--     _monthly: (employee_id, month_start) UNIQUE
--     _monthly_kasan: id (autogen) — multi-row OK
--
--   month_start = その月の 1 日 (DATE)、例 2026-05-01。
-- ============================================================

BEGIN;

-- ─── 月次本体 ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payroll_kyotaku_attendance_monthly (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL,
  office_id     UUID NOT NULL REFERENCES payroll_offices(id) ON DELETE CASCADE,
  employee_id   UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  month_start   DATE NOT NULL,            -- YYYY-MM-01
  kaigo_count   INT  NOT NULL DEFAULT 0,  -- 介護件数
  yobou_count   INT  NOT NULL DEFAULT 0,  -- 予防件数
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, month_start)
);

CREATE INDEX IF NOT EXISTS idx_kyotaku_attmonth_office_month
  ON payroll_kyotaku_attendance_monthly (office_id, month_start);
CREATE INDEX IF NOT EXISTS idx_kyotaku_attmonth_emp_month
  ON payroll_kyotaku_attendance_monthly (employee_id, month_start);

ALTER TABLE payroll_kyotaku_attendance_monthly ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kyotaku_attmonth_authenticated ON payroll_kyotaku_attendance_monthly;
CREATE POLICY kyotaku_attmonth_authenticated
  ON payroll_kyotaku_attendance_monthly
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMENT ON TABLE payroll_kyotaku_attendance_monthly IS
  '居宅介護支援 出勤簿 月単位 (件数集計、1 ケアマネ × 1 月 = 1 row)';

-- ─── 月次加算 (multi-row per month) ──────────────────────
CREATE TABLE IF NOT EXISTS payroll_kyotaku_attendance_monthly_kasan (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL,
  office_id     UUID NOT NULL REFERENCES payroll_offices(id) ON DELETE CASCADE,
  employee_id   UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  month_start   DATE NOT NULL,
  sort_order    INT NOT NULL DEFAULT 0,   -- 表示順 (画面で上から追加された行順)
  -- 規定加算: プルダウン (200/300/400/450/600/750/900) を選んで count を入れる
  kasan_unit    INT,                       -- NULL = 自由記述行
  kasan_count   INT,                       -- 件数 (kasan_unit が non-null のとき必須)
  -- 自由記述: ラベル + 金額 を直接入れる
  free_label    TEXT,
  free_amount   INT,                       -- 円 (free_label が non-null のとき必須)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    -- 「規定加算行」xor「自由記述行」: どちらか必ず一方
    (kasan_unit IS NOT NULL AND free_label IS NULL AND free_amount IS NULL)
    OR (kasan_unit IS NULL AND kasan_count IS NULL AND free_label IS NOT NULL)
  ),
  CHECK (kasan_unit IS NULL OR kasan_unit IN (200, 300, 400, 450, 600, 750, 900))
);

CREATE INDEX IF NOT EXISTS idx_kyotaku_kasan_emp_month
  ON payroll_kyotaku_attendance_monthly_kasan (employee_id, month_start);
CREATE INDEX IF NOT EXISTS idx_kyotaku_kasan_office_month
  ON payroll_kyotaku_attendance_monthly_kasan (office_id, month_start);

ALTER TABLE payroll_kyotaku_attendance_monthly_kasan ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kyotaku_kasan_authenticated ON payroll_kyotaku_attendance_monthly_kasan;
CREATE POLICY kyotaku_kasan_authenticated
  ON payroll_kyotaku_attendance_monthly_kasan
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMENT ON TABLE payroll_kyotaku_attendance_monthly_kasan IS
  '居宅介護支援 出勤簿 月単位 加算明細 (規定 200-900 単位 or 自由記述)';

COMMIT;
