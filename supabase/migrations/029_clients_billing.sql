-- 利用者に請求・引落情報を追加
ALTER TABLE clients
  -- 支払方法: 'withdrawal'(口座引落) | 'transfer'(振込) | 'cash'(集金) | 'other'
  ADD COLUMN IF NOT EXISTS payment_method       text DEFAULT 'withdrawal',
  -- 振替/入金予定日（1〜31）
  ADD COLUMN IF NOT EXISTS withdrawal_day       integer,
  -- 口座情報（口座引落時に使用）
  ADD COLUMN IF NOT EXISTS bank_name            text,
  ADD COLUMN IF NOT EXISTS bank_branch          text,
  ADD COLUMN IF NOT EXISTS bank_account_type    text,   -- '普通' | '当座'
  ADD COLUMN IF NOT EXISTS bank_account_number  text,
  ADD COLUMN IF NOT EXISTS bank_account_holder  text,   -- 口座名義人（カナ）
  -- 請求書に押印画像を載せるか（既定: false=押印省略）
  ADD COLUMN IF NOT EXISTS seal_required        boolean DEFAULT false,
  -- 居宅介護支援事業者名（請求書に表記）
  ADD COLUMN IF NOT EXISTS care_plan_provider   text;

COMMENT ON COLUMN clients.payment_method       IS '支払方法: withdrawal/transfer/cash/other';
COMMENT ON COLUMN clients.withdrawal_day       IS '振替・支払予定日（1〜31）';
COMMENT ON COLUMN clients.seal_required        IS '請求書に押印画像を載せるか。falseなら「押印省略」表記';
