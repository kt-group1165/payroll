-- 時給 (事業所 × 類型) と 通信費タイプ の 月次履歴 (2026-09-22 user「月次の変更の履歴」)
--
-- ① payroll_category_hourly_rates に effective_from (適用開始日) を足す。
--    これまでは (事業所, 類型) に 1 行 = 「今の時給」だけで、時給を変えると 過去の月を計算し直したときも新しい時給になった。
--    既存の行は 2000-01-01 からの行にする (= 今までと同じ動き)。一意は (事業所, 類型, 適用開始日) に広げる。
-- ② payroll_salary_settings に communication_fee_type を足す (給与形態・役職と同じ持ち方)。
--    NULL = 職員マスタ (payroll_employees.communication_fee_type) の値を使う = 今までと同じ動き。
--
-- ⚠ 画面の対応はこの SQL の適用後に push する (適用前でも今の画面は壊れない。列を足すだけ)
BEGIN;

ALTER TABLE payroll_category_hourly_rates
  ADD COLUMN IF NOT EXISTS effective_from DATE NOT NULL DEFAULT DATE '2000-01-01';

-- 旧い一意 (office_id, category_id) を 名前に依らず外す
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'payroll_category_hourly_rates'::regclass AND contype = 'u'
      AND (SELECT array_agg(attname::text ORDER BY attname) FROM pg_attribute
           WHERE attrelid = conrelid AND attnum = ANY(conkey)) = ARRAY['category_id', 'office_id']
  LOOP
    EXECUTE format('ALTER TABLE payroll_category_hourly_rates DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE payroll_category_hourly_rates
  DROP CONSTRAINT IF EXISTS payroll_category_hourly_rates_office_category_from_key;
ALTER TABLE payroll_category_hourly_rates
  ADD CONSTRAINT payroll_category_hourly_rates_office_category_from_key
  UNIQUE (office_id, category_id, effective_from);

COMMENT ON COLUMN payroll_category_hourly_rates.effective_from IS
  'この日 (月初) 以降の時給。計算する月の月初以前で最新の行を使う。2000-01-01 = 移行前からの値';

ALTER TABLE payroll_salary_settings
  ADD COLUMN IF NOT EXISTS communication_fee_type TEXT NULL;
ALTER TABLE payroll_salary_settings
  DROP CONSTRAINT IF EXISTS payroll_salary_settings_communication_fee_type_check;
ALTER TABLE payroll_salary_settings
  ADD CONSTRAINT payroll_salary_settings_communication_fee_type_check
  CHECK (communication_fee_type IS NULL OR communication_fee_type IN ('none', 'lend', 'lend_fee', 'variable'));

COMMENT ON COLUMN payroll_salary_settings.communication_fee_type IS
  'この適用開始月からの通信費タイプ。NULL = 職員マスタの値を使う';

COMMIT;

-- 確認
SELECT count(*) AS rates, count(DISTINCT (office_id, category_id)) AS pairs, min(effective_from), max(effective_from)
FROM payroll_category_hourly_rates;
