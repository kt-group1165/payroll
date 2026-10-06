-- 金額に効く設定に「何月分から」の履歴を持たせる (2026-10-06 user「履歴持つべきものは全部」「全部やって」)。
-- これまで 1 つの値しか持たず、変えると 過去の月まで新しい値で計算されていた。
--   ① アプリ設定 (payroll_app_settings) の単価類   → 履歴表 payroll_app_setting_history を新設
--   ② 居宅の介護報酬の単位数 / 地域単価            → effective_from 列を足し 一意キーに含める
--   ③ サービスコード → 類型 の対応                  → effective_from 列を足し 一意キーに含める
--   ④ 事業所の週起算曜日                           → 事業所の単価の履歴表 (payroll_office_unit_prices) に列を足す
-- 既存の値は すべて 1970-01-01 (= 初期値) からの行として残す。★ 金額は変わらない。
-- Supabase SQL Editor で このまま全部を貼って Run (BEGIN 〜 COMMIT)。

BEGIN;

-- ── ① アプリ設定の履歴 ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payroll_app_setting_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key            text NOT NULL,
  effective_from date NOT NULL,
  value          jsonb NOT NULL,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_app_setting_history_key_eff_uniq UNIQUE (key, effective_from)
);
COMMENT ON TABLE public.payroll_app_setting_history IS
  'payroll_app_settings の値の履歴。対象月で有効な行 = effective_from <= 対象月の1日 の最新。payroll_app_settings は「今の値」(画面表示用)';
ALTER TABLE public.payroll_app_setting_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payroll_app_setting_history_authenticated_all ON public.payroll_app_setting_history;
CREATE POLICY payroll_app_setting_history_authenticated_all ON public.payroll_app_setting_history
  TO authenticated USING (true) WITH CHECK (true);

INSERT INTO public.payroll_app_setting_history (key, effective_from, value, note)
SELECT s.key, DATE '1970-01-01', s.value, '2026-10-06 payroll_app_settings の現在値から初期投入'
FROM public.payroll_app_settings s
ON CONFLICT (key, effective_from) DO NOTHING;

-- ── ② 居宅の単位数 / 地域単価 ─────────────────────────────────────
ALTER TABLE public.payroll_kyotaku_service_units
  ADD COLUMN IF NOT EXISTS effective_from date NOT NULL DEFAULT DATE '1970-01-01';
ALTER TABLE public.payroll_kyotaku_service_units
  DROP CONSTRAINT IF EXISTS payroll_kyotaku_service_units_tenant_id_item_name_key;
ALTER TABLE public.payroll_kyotaku_service_units
  DROP CONSTRAINT IF EXISTS payroll_kyotaku_service_units_item_eff_uniq;
ALTER TABLE public.payroll_kyotaku_service_units
  ADD CONSTRAINT payroll_kyotaku_service_units_item_eff_uniq UNIQUE (tenant_id, item_name, effective_from);

ALTER TABLE public.payroll_kyotaku_regional_rates
  ADD COLUMN IF NOT EXISTS effective_from date NOT NULL DEFAULT DATE '1970-01-01';
ALTER TABLE public.payroll_kyotaku_regional_rates
  DROP CONSTRAINT IF EXISTS payroll_kyotaku_regional_rates_tenant_id_insurer_name_key;
ALTER TABLE public.payroll_kyotaku_regional_rates
  DROP CONSTRAINT IF EXISTS payroll_kyotaku_regional_rates_insurer_eff_uniq;
ALTER TABLE public.payroll_kyotaku_regional_rates
  ADD CONSTRAINT payroll_kyotaku_regional_rates_insurer_eff_uniq UNIQUE (tenant_id, insurer_name, effective_from);

-- ── ③ サービスコード → 類型 ─────────────────────────────────────
ALTER TABLE public.payroll_service_type_mappings
  ADD COLUMN IF NOT EXISTS effective_from date NOT NULL DEFAULT DATE '1970-01-01';
ALTER TABLE public.payroll_service_type_mappings
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.payroll_service_type_mappings
  DROP CONSTRAINT IF EXISTS payroll_service_type_mappings_service_code_key;
ALTER TABLE public.payroll_service_type_mappings
  DROP CONSTRAINT IF EXISTS payroll_service_type_mappings_code_eff_uniq;
ALTER TABLE public.payroll_service_type_mappings
  ADD CONSTRAINT payroll_service_type_mappings_code_eff_uniq UNIQUE (service_code, effective_from);

-- ── ④ 事業所の週起算曜日 ─────────────────────────────────────────
ALTER TABLE public.payroll_office_unit_prices
  ADD COLUMN IF NOT EXISTS work_week_start smallint CHECK (work_week_start BETWEEN 0 AND 6);
UPDATE public.payroll_office_unit_prices up
SET work_week_start = o.work_week_start
FROM public.payroll_offices o
WHERE o.id = up.office_id AND up.work_week_start IS NULL;

COMMIT;

-- 確認 (COMMIT 後に別途):
--   SELECT count(*) FROM payroll_app_setting_history;                       -- = payroll_app_settings の件数
--   SELECT effective_from, count(*) FROM payroll_kyotaku_service_units GROUP BY 1;   -- 1970-01-01 のみ
--   SELECT effective_from, count(*) FROM payroll_service_type_mappings GROUP BY 1;   -- 1970-01-01 のみ
--   SELECT count(*) FILTER (WHERE work_week_start IS NULL) FROM payroll_office_unit_prices;  -- 0
