-- billing_unit_items / billing_daily_items にも service_month を追加
--
-- 取り込みスコープを「提供年月」ベースに統一するため、全テーブルで
-- サービス提供月カラムを持たせる。
--
-- 既存データは service_month = billing_month で初期化。INSERT 時は
-- トリガで未指定ならコピーする。

ALTER TABLE billing_unit_items  ADD COLUMN IF NOT EXISTS service_month text;
ALTER TABLE billing_daily_items ADD COLUMN IF NOT EXISTS service_month text;

UPDATE billing_unit_items  SET service_month = billing_month WHERE service_month IS NULL;
UPDATE billing_daily_items SET service_month = billing_month WHERE service_month IS NULL;

ALTER TABLE billing_unit_items  ALTER COLUMN service_month SET NOT NULL;
ALTER TABLE billing_daily_items ALTER COLUMN service_month SET NOT NULL;

CREATE INDEX IF NOT EXISTS billing_unit_items_service_month_idx  ON billing_unit_items  (service_month);
CREATE INDEX IF NOT EXISTS billing_daily_items_service_month_idx ON billing_daily_items (service_month);

-- INSERT 時 service_month 未指定なら billing_month をコピーするトリガ
CREATE OR REPLACE FUNCTION billing_items_set_service_month()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.service_month IS NULL THEN
    NEW.service_month := NEW.billing_month;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS billing_unit_items_set_service_month_trg ON billing_unit_items;
CREATE TRIGGER billing_unit_items_set_service_month_trg
  BEFORE INSERT ON billing_unit_items
  FOR EACH ROW
  EXECUTE FUNCTION billing_items_set_service_month();

DROP TRIGGER IF EXISTS billing_daily_items_set_service_month_trg ON billing_daily_items;
CREATE TRIGGER billing_daily_items_set_service_month_trg
  BEFORE INSERT ON billing_daily_items
  FOR EACH ROW
  EXECUTE FUNCTION billing_items_set_service_month();

COMMENT ON COLUMN billing_unit_items.service_month IS 'サービス提供月 YYYYMM';
COMMENT ON COLUMN billing_daily_items.service_month IS 'サービス提供月 YYYYMM';
