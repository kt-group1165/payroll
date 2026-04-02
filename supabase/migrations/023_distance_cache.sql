-- 距離キャッシュ（Google Maps API結果を保存してAPI呼び出しコストを削減）
CREATE TABLE IF NOT EXISTS distance_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origin_address text NOT NULL,
  destination_address text NOT NULL,
  distance_meters integer NOT NULL,
  duration_seconds integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(origin_address, destination_address)
);

ALTER TABLE distance_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated" ON distance_cache FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon (dev)" ON distance_cache FOR ALL TO anon USING (true) WITH CHECK (true);
