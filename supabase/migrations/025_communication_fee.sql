-- 従業員に通信費タイプを追加（none / fixed / variable）
ALTER TABLE employees ADD COLUMN IF NOT EXISTS communication_fee_type VARCHAR(10) NOT NULL DEFAULT 'none';

-- 事業所に固定通信費額を追加
ALTER TABLE offices ADD COLUMN IF NOT EXISTS communication_fee_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
