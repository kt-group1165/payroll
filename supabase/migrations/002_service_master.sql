-- サービスマスタ関連テーブル

-- サービス類型（身体, 生活, 身体生活, 重度訪問, 同行援護 等）
CREATE TABLE service_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 初期データ
INSERT INTO service_categories (name, sort_order) VALUES
  ('身体介護', 1),
  ('生活援助', 2),
  ('身体生活', 3),
  ('重度訪問', 4),
  ('同行援護', 5);

-- サービスマッピング（CSVの「サービス型」→ 類型）
CREATE TABLE service_type_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_name TEXT UNIQUE NOT NULL,
  category_id UUID NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 時給設定（事業所 × 類型 → 時給）
CREATE TABLE category_hourly_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id UUID NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
  hourly_rate INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(office_id, category_id)
);

CREATE TRIGGER category_hourly_rates_updated_at BEFORE UPDATE ON category_hourly_rates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS
ALTER TABLE service_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_type_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_hourly_rates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated" ON service_categories FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for authenticated" ON service_type_mappings FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for authenticated" ON category_hourly_rates FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Allow all for anon (dev)" ON service_categories FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon (dev)" ON service_type_mappings FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon (dev)" ON category_hourly_rates FOR ALL TO anon USING (true) WITH CHECK (true);
