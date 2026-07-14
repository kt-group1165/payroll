-- payroll_import_count_functions_v1.sql
--
-- /csv-import の「取り込み済みデータ」件数集計を全件ページング (81k 行 = 82 リクエスト逐次)
-- から 1 RPC に置き換えるための GROUP BY 関数 3 つ。
-- ページ表示が数秒〜タイムアウト級に遅くなっていた問題の対策。
--
-- SECURITY INVOKER (既定) のまま = 呼出元の RLS が適用される (authenticated all 前提)。
--
-- Supabase SQL Editor に全文貼って Run (COMMIT まで一括)。

BEGIN;

CREATE OR REPLACE FUNCTION payroll_service_record_counts()
RETURNS TABLE (processing_month TEXT, office_number TEXT, count BIGINT)
LANGUAGE sql STABLE
AS $$
  SELECT processing_month, office_number, COUNT(*)
  FROM payroll_service_records
  GROUP BY processing_month, office_number;
$$;

CREATE OR REPLACE FUNCTION payroll_attendance_record_counts()
RETURNS TABLE (year INTEGER, month INTEGER, office_number TEXT, count BIGINT)
LANGUAGE sql STABLE
AS $$
  SELECT year, month, office_number, COUNT(*)
  FROM payroll_attendance_records
  GROUP BY year, month, office_number;
$$;

CREATE OR REPLACE FUNCTION payroll_office_form_record_counts()
RETURNS TABLE (processing_month TEXT, office_number TEXT, count BIGINT)
LANGUAGE sql STABLE
AS $$
  SELECT processing_month, office_number, COUNT(*)
  FROM payroll_office_form_records
  GROUP BY processing_month, office_number;
$$;

GRANT EXECUTE ON FUNCTION payroll_service_record_counts() TO authenticated;
GRANT EXECUTE ON FUNCTION payroll_attendance_record_counts() TO authenticated;
GRANT EXECUTE ON FUNCTION payroll_office_form_record_counts() TO authenticated;

COMMIT;
