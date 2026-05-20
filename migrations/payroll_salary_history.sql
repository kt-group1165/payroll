-- ============================================================
-- 給与設定の履歴化 (Phase 1)
-- ============================================================
-- 目的:
--   給与設定の変更を上書きでなく append-only にし、過去月の再計算を
--   常に正確にできるようにする。
--
-- 方式: 「effective_from のみ」(B 案)
--   - 各 row は「いつから有効」を持つ。effective_to は計算で derive。
--   - ある対象月で active な行 = effective_from <= 対象月 のうち最新
--   - 編集は新 row INSERT (UPDATE しない)
--
-- 対象:
--   1) payroll_salary_settings (訪問介護等の本人給/職能給/固定残業代 等)
--      → 既存 table に effective_from 列追加 + UNIQUE 再構築
--   2) payroll_kyotaku_salary (居宅介護支援ケアマネ専用、新規 table)
--      → payroll_employees.kyotaku_* から切り出し、初期 row を backfill
-- ============================================================

BEGIN;

-- ─── 1) payroll_salary_settings に effective_from 追加 ────────────
ALTER TABLE payroll_salary_settings
  ADD COLUMN IF NOT EXISTS effective_from DATE NOT NULL DEFAULT '1970-01-01';

-- 既存 UNIQUE(employee_id) を drop して (employee_id, effective_from) に
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payroll_salary_settings_employee_id_key'
  ) THEN
    ALTER TABLE payroll_salary_settings DROP CONSTRAINT payroll_salary_settings_employee_id_key;
  END IF;
END $$;

ALTER TABLE payroll_salary_settings
  DROP CONSTRAINT IF EXISTS payroll_salary_settings_emp_eff_uk;
ALTER TABLE payroll_salary_settings
  ADD CONSTRAINT payroll_salary_settings_emp_eff_uk UNIQUE (employee_id, effective_from);

CREATE INDEX IF NOT EXISTS idx_payroll_salary_settings_emp_eff
  ON payroll_salary_settings (employee_id, effective_from DESC);

COMMENT ON COLUMN payroll_salary_settings.effective_from IS
  '適用開始月 (DATE)。対象月 >= effective_from の最新行が active。'
  ' 編集時は UPDATE せず新 row を INSERT する (履歴 append-only)。';

-- ─── 2) payroll_kyotaku_salary 新 table ──────────────────────────
CREATE TABLE IF NOT EXISTS payroll_kyotaku_salary (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL DEFAULT 'kt-group',
  employee_id       UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  effective_from    DATE NOT NULL,
  honnin_kyu        INT  NOT NULL DEFAULT 0,
  shokuno_kyu       INT  NOT NULL DEFAULT 0,
  kotei_zangyo      INT  NOT NULL DEFAULT 0,
  shikaku_teate     INT  NOT NULL DEFAULT 0,
  kotei             INT  NOT NULL DEFAULT 0,
  tokutei_shogu     INT  NOT NULL DEFAULT 0,
  kaigo_rate        INT  NOT NULL DEFAULT 0,   -- 要介護単価 (円/件)
  shien_rate        INT  NOT NULL DEFAULT 0,   -- 要支援単価 (円/件)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_payroll_kyotaku_salary_emp_eff
  ON payroll_kyotaku_salary (employee_id, effective_from DESC);

ALTER TABLE payroll_kyotaku_salary ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payroll_kyotaku_salary_authenticated ON payroll_kyotaku_salary;
CREATE POLICY payroll_kyotaku_salary_authenticated
  ON payroll_kyotaku_salary FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMENT ON TABLE payroll_kyotaku_salary IS
  '居宅介護支援ケアマネ給与設定 (履歴付)。'
  ' effective_from で時系列管理。'
  ' 既存 payroll_employees.kyotaku_* は移行用に当面残置、reader は本 table を参照する。';

-- ─── 3) 初期 backfill: 居宅介護支援 employees から 1 row INSERT ───────
INSERT INTO payroll_kyotaku_salary
  (employee_id, effective_from, honnin_kyu, shokuno_kyu, kotei_zangyo,
   shikaku_teate, kotei, tokutei_shogu, kaigo_rate, shien_rate)
SELECT
  e.id, '1970-01-01'::DATE,
  COALESCE(e.kyotaku_honnin_kyu, 0),
  COALESCE(e.kyotaku_shokuno_kyu, 0),
  COALESCE(e.kyotaku_kotei_zangyo, 0),
  COALESCE(e.kyotaku_shikaku_teate, 0),
  COALESCE(e.kyotaku_kotei, 0),
  COALESCE(e.kyotaku_tokutei_shogu, 0),
  COALESCE(e.kyotaku_kaigo_rate, 0),
  COALESCE(e.kyotaku_shien_rate, 0)
FROM payroll_employees e
WHERE e.job_type = '居宅介護支援'
ON CONFLICT (employee_id, effective_from) DO NOTHING;

COMMIT;
