-- Stage 1: billing_amount_items に請求ライフサイクル管理カラムを追加
--
-- 狙い: 「サービス提供月」「請求予定月」「発行日」「引落日」を分離して、
-- 翌月繰越・過誤調整・未入金の状態遷移を正しく扱えるようにする。
--
-- 既存のカラム:
--   billing_month   → 実際の請求月（従来の意味のまま）
--   amount          → CSVから来た金額 (=expected_amount として扱う)
--   status          → CSVの「状態」(確定 等) を格納していた既存カラム。触らない。
--
-- 新規カラム:
--   service_month          → サービス提供月 (YYYYMM、不変)
--   billing_status         → ライフサイクル状態
--   parent_item_id         → 過誤調整行の元請求 ID
--   actual_issue_date      → 請求書発行日
--   actual_withdrawal_date → 引落実行日
--   invoiced_amount        → 請求書記載額（発行時に確定）
--   paid_amount            → 実入金額
--   source                 → データ出所 csv/manual/api
--   lifecycle_note         → 調整理由・運用メモ

ALTER TABLE billing_amount_items ADD COLUMN IF NOT EXISTS service_month          text;
ALTER TABLE billing_amount_items ADD COLUMN IF NOT EXISTS billing_status         text DEFAULT 'scheduled';
ALTER TABLE billing_amount_items ADD COLUMN IF NOT EXISTS parent_item_id         uuid REFERENCES billing_amount_items(id) ON DELETE SET NULL;
ALTER TABLE billing_amount_items ADD COLUMN IF NOT EXISTS actual_issue_date      date;
ALTER TABLE billing_amount_items ADD COLUMN IF NOT EXISTS actual_withdrawal_date date;
ALTER TABLE billing_amount_items ADD COLUMN IF NOT EXISTS invoiced_amount        integer;
ALTER TABLE billing_amount_items ADD COLUMN IF NOT EXISTS paid_amount            integer;
ALTER TABLE billing_amount_items ADD COLUMN IF NOT EXISTS source                 text DEFAULT 'csv';
ALTER TABLE billing_amount_items ADD COLUMN IF NOT EXISTS lifecycle_note         text;

-- 既存データ初期化: service_month を billing_month で埋める
UPDATE billing_amount_items
   SET service_month = billing_month
 WHERE service_month IS NULL;

UPDATE billing_amount_items
   SET billing_status = 'scheduled'
 WHERE billing_status IS NULL;

UPDATE billing_amount_items
   SET source = 'csv'
 WHERE source IS NULL;

-- 制約追加
ALTER TABLE billing_amount_items ALTER COLUMN service_month SET NOT NULL;

ALTER TABLE billing_amount_items
  DROP CONSTRAINT IF EXISTS billing_amount_items_billing_status_check;
ALTER TABLE billing_amount_items
  ADD  CONSTRAINT billing_amount_items_billing_status_check
  CHECK (billing_status IN ('draft', 'scheduled', 'invoiced', 'paid', 'deferred', 'cancelled', 'overdue', 'adjustment'));

ALTER TABLE billing_amount_items
  DROP CONSTRAINT IF EXISTS billing_amount_items_source_check;
ALTER TABLE billing_amount_items
  ADD  CONSTRAINT billing_amount_items_source_check
  CHECK (source IN ('csv', 'manual', 'api'));

-- インデックス
CREATE INDEX IF NOT EXISTS billing_amount_items_service_month_idx ON billing_amount_items (service_month);
CREATE INDEX IF NOT EXISTS billing_amount_items_billing_status_idx ON billing_amount_items (billing_status);
CREATE INDEX IF NOT EXISTS billing_amount_items_parent_idx ON billing_amount_items (parent_item_id);

-- INSERT 時 service_month 未指定なら billing_month をコピー（既存の取り込みコードを変更せずに済ますため）
CREATE OR REPLACE FUNCTION billing_amount_items_set_service_month()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.service_month IS NULL THEN
    NEW.service_month := NEW.billing_month;
  END IF;
  IF NEW.billing_status IS NULL THEN
    NEW.billing_status := 'scheduled';
  END IF;
  IF NEW.source IS NULL THEN
    NEW.source := 'csv';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS billing_amount_items_set_service_month_trg ON billing_amount_items;
CREATE TRIGGER billing_amount_items_set_service_month_trg
  BEFORE INSERT ON billing_amount_items
  FOR EACH ROW
  EXECUTE FUNCTION billing_amount_items_set_service_month();

-- ── コメント ──
COMMENT ON COLUMN billing_amount_items.service_month IS 'サービス提供月 YYYYMM (不変)';
COMMENT ON COLUMN billing_amount_items.billing_status IS 'ライフサイクル: draft/scheduled/invoiced/paid/deferred/cancelled/overdue/adjustment';
COMMENT ON COLUMN billing_amount_items.parent_item_id IS '過誤調整行の元請求 ID';
COMMENT ON COLUMN billing_amount_items.actual_issue_date IS '請求書発行日 (invoiced時に記録)';
COMMENT ON COLUMN billing_amount_items.actual_withdrawal_date IS '実引落日 (paid時に記録)';
COMMENT ON COLUMN billing_amount_items.invoiced_amount IS '請求書記載額 (発行時の確定値)';
COMMENT ON COLUMN billing_amount_items.paid_amount IS '実入金額';
COMMENT ON COLUMN billing_amount_items.source IS 'データ出所: csv/manual/api';
COMMENT ON COLUMN billing_amount_items.lifecycle_note IS 'ライフサイクル系メモ（調整理由など）';
