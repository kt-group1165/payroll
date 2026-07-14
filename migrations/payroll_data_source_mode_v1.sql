-- payroll_data_source_mode_v1.sql
--
-- 実績データの取込元モード切替 (CSV取込モード / kaigo直接モード) の土台。
--   1. payroll_app_settings   … アプリ全体設定 (key/value)。jisseki_source_mode を保持
--   2. payroll_import_batches … import_type に 'kaigo_meisai' を追加
--   3. payroll_kaigo_snapshots … kaigo-app からの snapshot 取込履歴 (いつ・誰が・何件 の監査用)
--
-- 設計根拠: memory project_payroll_kaigo_snapshot_pull.md
--   kaigo 実績は JOIN 直参照せず、「取り込み」ボタン押下時に
--   payroll_service_records へ snapshot コピーする (給与確定後の金額変動事故を防ぐ)。
--
-- Supabase SQL Editor に全文貼って Run (COMMIT まで一括)。

BEGIN;

-- ── 1. payroll_app_settings ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS payroll_app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE payroll_app_settings IS
  'payroll-app 全体設定 (key/value)。jisseki_source_mode = 実績取込元モード {"mode":"csv"|"kaigo"}';

ALTER TABLE payroll_app_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payroll_app_settings_authenticated_all ON payroll_app_settings;
CREATE POLICY payroll_app_settings_authenticated_all ON payroll_app_settings
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

INSERT INTO payroll_app_settings (key, value)
VALUES ('jisseki_source_mode', '{"mode":"csv"}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── 2. import_type に kaigo_meisai を追加 ───────────────────────
ALTER TABLE payroll_import_batches
  DROP CONSTRAINT IF EXISTS payroll_import_batches_import_type_check;
ALTER TABLE payroll_import_batches
  ADD CONSTRAINT payroll_import_batches_import_type_check
  CHECK (import_type IN ('meisai', 'attendance', 'office_form', 'kaigo_meisai'));

-- ── 3. payroll_kaigo_snapshots (取込履歴・監査) ──────────────────
CREATE TABLE IF NOT EXISTS payroll_kaigo_snapshots (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id     UUID REFERENCES payroll_import_batches(id) ON DELETE SET NULL,
  processing_month    TEXT NOT NULL,                  -- YYYYMM
  office_number       TEXT NOT NULL,                  -- payroll_offices.office_number
  office_id           UUID,                           -- 共通 offices.id (kaigo 側フィルタに使った値)
  source              TEXT NOT NULL,                  -- kaigo_visit_schedule / kaigo_bath_visit_records
  source_record_count INTEGER NOT NULL DEFAULT 0,     -- kaigo 側の対象実績件数
  inserted_count      INTEGER NOT NULL DEFAULT 0,     -- payroll_service_records へ INSERT した行数
  skipped             JSONB NOT NULL DEFAULT '[]'::jsonb, -- 突合不能等で除外した明細 [{reason, detail}]
  taken_by            TEXT,                           -- 実行ユーザー email
  taken_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE payroll_kaigo_snapshots IS
  'kaigo-app 実績の snapshot 取込履歴。「いつの時点の実績で給与計算したか」の監査証跡。';

CREATE INDEX IF NOT EXISTS idx_payroll_kaigo_snapshots_month
  ON payroll_kaigo_snapshots(processing_month, office_number);

ALTER TABLE payroll_kaigo_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payroll_kaigo_snapshots_authenticated_all ON payroll_kaigo_snapshots;
CREATE POLICY payroll_kaigo_snapshots_authenticated_all ON payroll_kaigo_snapshots
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMIT;
