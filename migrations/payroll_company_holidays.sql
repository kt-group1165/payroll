BEGIN;

-- 会社休日 (祝日以外の独自休業日)
-- 用途: 居宅介護支援事業所のお盆 (8/13-15) / 年末年始 (12/30-1/3 から 1/1 を除く)
--       祝日と並んで「所定労働日でない日」として出勤簿の自動休日判定に用いる。
-- tenant_id 単位で管理。日付ユニーク。
CREATE TABLE payroll_company_holidays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  holiday_date DATE NOT NULL,        -- 休業日 YYYY-MM-DD
  name TEXT NOT NULL,                 -- 例: 'お盆', '年末年始'
  note TEXT,                          -- 備考 (任意)

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, holiday_date)
);

CREATE INDEX idx_payroll_company_holidays_tenant_date
  ON payroll_company_holidays (tenant_id, holiday_date);

ALTER TABLE payroll_company_holidays ENABLE ROW LEVEL SECURITY;

CREATE POLICY payroll_company_holidays_authenticated
  ON payroll_company_holidays
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMIT;
