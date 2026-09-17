-- Google Distance Matrix API の月間利用上限 (2026-09-17)
-- Google Cloud 側は 日/分 単位の割り当てしか無く、予算アラートは API を止めない。
-- 給与システムが呼んだ件数 (= 課金単位の element 数) をここに記録し、
-- 月の上限 (payroll_app_settings: distance_api_monthly_limit) を超える呼出はしない。
BEGIN;

CREATE TABLE IF NOT EXISTS payroll_distance_api_usage (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usage_month   TEXT NOT NULL CHECK (usage_month ~ '^[0-9]{4}-[0-9]{2}$'),  -- 日本時間の月 YYYY-MM
  elements      INTEGER NOT NULL CHECK (elements >= 0),                    -- Google に課金される件数 (status OK のときの区間数)
  google_status TEXT NOT NULL,                                             -- OK / REQUEST_DENIED / OVER_QUERY_LIMIT ...
  office_number TEXT,                                                      -- どの事業所の計算で呼んだか
  source        TEXT,                                                      -- payroll (給与計算) / distance (距離画面)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payroll_distance_api_usage_month
  ON payroll_distance_api_usage (usage_month);

COMMENT ON TABLE payroll_distance_api_usage IS
  'Google Distance Matrix API の呼出記録。月間上限の判定に使う (lib/distance-usage.ts)';

ALTER TABLE payroll_distance_api_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payroll_distance_api_usage_authenticated_select ON payroll_distance_api_usage;
CREATE POLICY payroll_distance_api_usage_authenticated_select ON payroll_distance_api_usage
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS payroll_distance_api_usage_authenticated_insert ON payroll_distance_api_usage;
CREATE POLICY payroll_distance_api_usage_authenticated_insert ON payroll_distance_api_usage
  FOR INSERT TO authenticated WITH CHECK (true);

-- 月の上限 (件数)。変えるときはこの value を UPDATE する
INSERT INTO payroll_app_settings (key, value, updated_at)
VALUES ('distance_api_monthly_limit', '{"limit": 10000}'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

COMMIT;
