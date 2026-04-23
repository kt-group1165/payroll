-- 請求データ取り込み用テーブル
-- 介護ソフトから出力される6ファイル（01_金額/02_単位/03_利用日 × 介護/障害）を格納

-- 01_金額: 利用者×月×利用料項目 ごとの金額明細（請求額の真の値）
CREATE TABLE IF NOT EXISTS billing_amount_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  segment           text NOT NULL,            -- '介護' | '障害'
  office_number     text,
  office_name       text,
  client_number     text NOT NULL,
  client_name       text,
  billing_month     text NOT NULL,            -- YYYYMM
  service_item_code text,                     -- 利用料項目コード
  service_item      text,                     -- 利用料項目名（例: 利用者負担額）
  unit_price        numeric,                  -- 単価
  quantity          numeric,                  -- 数量
  amount            integer,                  -- 金額（利用者負担額）
  tax_amount        integer,                  -- 消費税額
  reduction_amount  integer,                  -- 軽減額
  medical_deduction integer,                  -- 医療費控除対象額
  period_start      date,                     -- 集計開始日
  period_end        date,                     -- 集計終了日
  status            text,                     -- 状態（確定 等）
  import_batch_id   uuid,
  raw               jsonb,                    -- 元CSV行（デバッグ用に保持）
  created_at        timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS billing_amount_items_client_month ON billing_amount_items (client_number, billing_month);
CREATE INDEX IF NOT EXISTS billing_amount_items_office_month ON billing_amount_items (office_number, billing_month);

-- 02_単位: サービス種別ごとの単位数明細（請求書の内訳表に使用）
CREATE TABLE IF NOT EXISTS billing_unit_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  segment          text NOT NULL,             -- '介護' | '障害'
  office_number    text,
  client_number    text NOT NULL,
  client_name      text,
  billing_month    text NOT NULL,
  service_name     text,                      -- サービス内容
  service_code     text,                      -- サービスコード
  unit_count       numeric,                   -- 単位数
  unit_type        text,                      -- 単位/点/円
  repetition       numeric,                   -- 回数
  amount           integer,                   -- 金額（該当時）
  import_batch_id  uuid,
  raw              jsonb,
  created_at       timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS billing_unit_items_client_month ON billing_unit_items (client_number, billing_month);

-- 03_利用日: 日付×サービスごとの提供量（カレンダー表示用）
CREATE TABLE IF NOT EXISTS billing_daily_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  segment         text NOT NULL,
  office_number   text,
  client_number   text NOT NULL,
  client_name     text,
  billing_month   text NOT NULL,              -- YYYYMM
  service_name    text,                       -- サービス内容
  service_code    text,
  day             integer NOT NULL,           -- 1〜31
  quantity        numeric,                    -- その日の提供量
  import_batch_id uuid,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS billing_daily_items_client_month ON billing_daily_items (client_number, billing_month);

COMMENT ON TABLE billing_amount_items IS '請求金額明細（01_金額CSV）';
COMMENT ON TABLE billing_unit_items   IS '請求単位数明細（02_単位CSV）';
COMMENT ON TABLE billing_daily_items  IS '請求利用日明細（03_利用日CSV）';
