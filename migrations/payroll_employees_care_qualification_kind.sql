-- 勤続手当の資格の種類 (2026-09-17)
-- has_care_qualification (勤続手当の資格要件を満たすか) はそのまま計算に使う。
-- どの資格かが分からない職員でも「要件は満たす」と登録できるように種類を別に持つ。
BEGIN;

ALTER TABLE payroll_employees
  ADD COLUMN IF NOT EXISTS care_qualification_kind TEXT
  CHECK (care_qualification_kind IN ('介護福祉士', '実務者研修修了', '介護支援専門員', '不明（要件は満たす）'));

COMMENT ON COLUMN payroll_employees.care_qualification_kind IS
  '勤続手当の資格の種類。NULL = 資格なし (has_care_qualification=false) または種類未登録。計算は has_care_qualification を見る';

-- 既に「資格あり」で種類が無い人は 不明 にそろえる (計算結果は変わらない)
UPDATE payroll_employees
   SET care_qualification_kind = '不明（要件は満たす）'
 WHERE has_care_qualification = true AND care_qualification_kind IS NULL;

COMMIT;
