-- payroll_employees.kyotaku_base_salary の削除。
--
-- 2026-05-13 の6列分解(honnin_kyu/shokuno_kyu/kotei_zangyo/shikaku_teate/
-- kotei/tokutei_shogu)で旧化した1列。payroll_employees_kyotaku_columns_v2.sql
-- に「ロールバック用に当面残置、コード参照のみ新列に切替済み」と明記されて
-- おり、以後実コードからの参照は0件のまま(PERF_CLEANUP_MISSION.md 2026-09-02
-- 調査で確認)。分解から約3.5ヶ月経過し、ロールバック猶予は十分と判断。
--
-- 全1,288行中、非NULLは8行のみ(うち7行はDEFAULT_BASE_SALARY定数=250000と
-- 同値、1行だけ340000という異なる値=天野恵子)。念のため削除前にbackupする。
--
-- Supabase SQL Editor で BEGIN〜COMMIT を1ブロックとして貼って実行してください。
-- (CLAUDE.md 7.2: BEGIN のみで COMMIT を忘れると SQL Editor 終了時に自動 rollback される)

BEGIN;

CREATE TABLE IF NOT EXISTS public._backup_payroll_employees_kyotaku_base_salary_20260902 AS
SELECT id, name, kyotaku_base_salary
FROM public.payroll_employees
WHERE kyotaku_base_salary IS NOT NULL;

-- ⚠ CREATE TABLE AS は RLS を継承しない (feedback_backup_table_no_rls.md、
--   2026-09-01に13 relationがanonに公開されていた事故と同じ経路)。
--   給与額を含む表なので、作成直後に必ず遮断する (policy無し = service_role のみ)。
ALTER TABLE public._backup_payroll_employees_kyotaku_base_salary_20260902 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public._backup_payroll_employees_kyotaku_base_salary_20260902 FORCE ROW LEVEL SECURITY;

ALTER TABLE public.payroll_employees DROP COLUMN kyotaku_base_salary;

COMMIT;

-- 確認用 (Editorで別途流す。上のCOMMIT後に):
-- SELECT * FROM public._backup_payroll_employees_kyotaku_base_salary_20260902;
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='payroll_employees' AND column_name='kyotaku_base_salary'; -- 0行になればOK
