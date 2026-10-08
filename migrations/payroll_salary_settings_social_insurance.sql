-- 社保の加入・未加入を「何月分から」の履歴で持つ (2026-10-08 user「その形で進めて」)。
-- これまでは 月ごとの手入力 (payroll_monthly_inputs の social_insurance) か 職員一覧の社保 (今の値 1 つ) だけで、
-- 職員一覧を変えると 手入力の無い過去の月まで新しい値で計算されていた (通信手当・処遇改善補助金に効く)。
-- 給与設定の行 (effective_from つき) に列を足す。NULL = 職員一覧のまま (給与形態・通信費と同じ扱い)。
-- 判定の優先順: 月ごとの手入力 → 給与設定のその月の行 → 職員一覧。
-- Supabase SQL Editor で このまま全部を貼って Run (BEGIN 〜 COMMIT)。

BEGIN;

ALTER TABLE public.payroll_salary_settings
  ADD COLUMN IF NOT EXISTS social_insurance boolean;

COMMENT ON COLUMN public.payroll_salary_settings.social_insurance IS
  'この適用開始月からの社保加入 (true=加入 / false=未加入 / NULL=職員一覧の値)。月ごとの手入力があればそちらが優先';

COMMIT;
