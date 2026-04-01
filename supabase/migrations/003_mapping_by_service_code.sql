-- サービスマッピングをサービスコードベースに変更

-- 既存テーブルを削除して再作成
DROP TABLE IF EXISTS service_type_mappings;

-- サービスコード → 類型のマッピング
CREATE TABLE service_type_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_code TEXT UNIQUE NOT NULL,
  service_name TEXT NOT NULL DEFAULT '',
  category_id UUID NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS
ALTER TABLE service_type_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated" ON service_type_mappings FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon (dev)" ON service_type_mappings FOR ALL TO anon USING (true) WITH CHECK (true);
