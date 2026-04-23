-- 入金記録テーブル
-- 請求額は service_records を月次集計して都度算出。入金履歴のみこちらで管理。
CREATE TABLE IF NOT EXISTS payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid REFERENCES companies(id) ON DELETE CASCADE,
  client_number   text NOT NULL,
  billing_month   text NOT NULL,           -- 対象月 YYYYMM
  amount          integer NOT NULL,        -- 入金額（円）
  paid_at         date NOT NULL,           -- 入金日
  method          text DEFAULT 'withdrawal', -- withdrawal/transfer/cash/other
  note            text,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payments_company_month_client
  ON payments (company_id, billing_month, client_number);

COMMENT ON TABLE  payments IS '利用者からの入金記録。請求額は service_records から都度集計する';
