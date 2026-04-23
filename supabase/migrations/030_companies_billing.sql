-- 法人に請求書の差出人情報を追加
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS zipcode              text,
  ADD COLUMN IF NOT EXISTS formal_name          text,   -- 請求書記載の正式名称（株式会社○○）
  ADD COLUMN IF NOT EXISTS registration_number  text,   -- インボイス登録番号 T00000000000
  ADD COLUMN IF NOT EXISTS tel                  text,   -- 請求書TEL
  ADD COLUMN IF NOT EXISTS seal_image_url       text,   -- 押印画像URL（利用者側で seal_required=true の場合に表示）
  -- 拝啓〜敬具 等の定型文（法人で1回設定、請求書に挿入）
  ADD COLUMN IF NOT EXISTS invoice_greeting     text,
  -- お問い合わせ先電話番号（請求書下部）
  ADD COLUMN IF NOT EXISTS inquiry_tel          text;

COMMENT ON COLUMN companies.formal_name         IS '請求書記載の正式名称';
COMMENT ON COLUMN companies.registration_number IS 'インボイス登録番号';
