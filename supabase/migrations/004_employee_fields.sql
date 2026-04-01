-- 職員マスタに職種・役職・給与形態を整理
-- ※ CHECK制約の解除 → データ変換 → 新制約追加 の順で実行する

-- ① 既存の CHECK 制約を先に解除
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_role_type_check;
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_salary_type_check;

-- ② role_type の値を短縮形に統一
UPDATE employees SET role_type = '提責'   WHERE role_type = 'サービス提供責任者';
UPDATE employees SET role_type = '社員'   WHERE role_type = '社員ヘルパー';
UPDATE employees SET role_type = 'パート'  WHERE role_type = 'パートヘルパー';

-- ③ salary_type: '固定給' → '月給'
UPDATE employees SET salary_type = '月給' WHERE salary_type = '固定給';

-- ④ 新しい CHECK 制約を追加
ALTER TABLE employees ADD CONSTRAINT employees_role_type_check
  CHECK (role_type IN ('管理者', '提責', '社員', 'パート', '事務員'));

ALTER TABLE employees ADD CONSTRAINT employees_salary_type_check
  CHECK (salary_type IN ('月給', '時給'));

-- ⑤ job_type（職種）カラムを追加
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS job_type TEXT NOT NULL DEFAULT '訪問介護';

ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_job_type_check;
ALTER TABLE employees ADD CONSTRAINT employees_job_type_check
  CHECK (job_type IN ('訪問介護', '訪問入浴', '訪問看護', '居宅介護支援', '福祉用具貸与', '薬局', '本社'));
