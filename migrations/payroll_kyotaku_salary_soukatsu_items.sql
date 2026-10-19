-- ケアマネ (居宅) の給与設定に 総括表 (ケアマネ) にある項目を足す (2026-10-19)。
-- 総括表は ②支払用だけで、その式は全 1,369 行で 99〜100% 再現できた (memory payroll_caremane_soukatsu_rules)。
-- 当方の計算 (kyotaku-calc.ts) に無い項目のうち 職員ごと・何月分から の設定になるものを ここに持つ。
-- (月ごとに変わる 認定調査の件数・報奨金・欠勤控除・その他手当 は 既存の payroll_monthly_inputs に持つので 列は足さない)
--
--   care_plan_fixed      ケアプラン固定 (円)。プラン手当 = 粗額 (介護単価×件数+予防単価×件数) が これ以上なら 粗額 − 固定、下回れば 0。
--                        ★ 空 (NULL) = ケアプランの額は払わない (user 2026-10-19「払わない」。時給のケアマネ・管理者)
--                        総括表では 97% が 本人給+職能給+固定残業 と同じ額
--   position_allowance   役職手当 (円)
--   kinzoku_type         勤続手当の型 (1 = 固定だけ / 2 = 固定 + 件数で決まる分)。総括表の「勤続手当対象」
--   kinzoku_unit         件数で決まる勤続手当の単価 (円/件)。変動 = ROUND(単価 × (介護件数 + 予防件数 ÷ 2))
--   kinzoku_care_unit    介護時間で決まる勤続手当の単価 (円/時)。= ROUND(単価 × 介護時間)
--   guarantee_amount     保障額 (円。例 300000)。保障の調整額 = max(0, 保障額 − (本人給+職能給+特定処遇+固定残業+ケアプラン+認定調査+加算))
--                        (user 2026-10-19「とりあえず含める」= 認定調査・加算も含めて 保障額にする)
--   guarantee_until      保障の最後の月 (その月の 1 日)。総括表の氏名欄の「R8.10月分まで」
--   commute_cap          通勤費の上限 (円。例 25000)。超えた分は 出張費として払う。空 = 上限なし
--
-- Supabase SQL Editor で このまま全部を貼って Run (BEGIN 〜 COMMIT)。

BEGIN;

ALTER TABLE public.payroll_kyotaku_salary
  ADD COLUMN IF NOT EXISTS care_plan_fixed integer,
  ADD COLUMN IF NOT EXISTS position_allowance integer,
  ADD COLUMN IF NOT EXISTS kinzoku_type smallint,
  ADD COLUMN IF NOT EXISTS kinzoku_unit integer,
  ADD COLUMN IF NOT EXISTS kinzoku_care_unit integer,
  ADD COLUMN IF NOT EXISTS guarantee_amount integer,
  ADD COLUMN IF NOT EXISTS guarantee_until date,
  ADD COLUMN IF NOT EXISTS commute_cap integer;

ALTER TABLE public.payroll_kyotaku_salary DROP CONSTRAINT IF EXISTS payroll_kyotaku_salary_soukatsu_items_chk;
ALTER TABLE public.payroll_kyotaku_salary ADD CONSTRAINT payroll_kyotaku_salary_soukatsu_items_chk CHECK (
  (kinzoku_type IS NULL OR kinzoku_type IN (1, 2))
  AND (care_plan_fixed IS NULL OR care_plan_fixed >= 0)
  AND (position_allowance IS NULL OR position_allowance >= 0)
  AND (kinzoku_unit IS NULL OR kinzoku_unit >= 0)
  AND (kinzoku_care_unit IS NULL OR kinzoku_care_unit >= 0)
  AND (guarantee_amount IS NULL OR guarantee_amount >= 0)
  AND (commute_cap IS NULL OR commute_cap >= 0)
);

COMMENT ON COLUMN public.payroll_kyotaku_salary.care_plan_fixed IS 'ケアプラン固定 (円)。粗額がこれ以上なら 粗額−固定 をプラン手当に。NULL = ケアプランの額を払わない';
COMMENT ON COLUMN public.payroll_kyotaku_salary.position_allowance IS '役職手当 (円)';
COMMENT ON COLUMN public.payroll_kyotaku_salary.kinzoku_type IS '勤続手当の型 1=固定だけ / 2=固定+件数分';
COMMENT ON COLUMN public.payroll_kyotaku_salary.kinzoku_unit IS '件数で決まる勤続手当の単価 (円/件)。ROUND(単価×(介護件数+予防件数÷2))';
COMMENT ON COLUMN public.payroll_kyotaku_salary.kinzoku_care_unit IS '介護時間で決まる勤続手当の単価 (円/時)';
COMMENT ON COLUMN public.payroll_kyotaku_salary.guarantee_amount IS '保障額 (円)。調整額 = max(0, 保障額 − (本人給+職能給+特定処遇+固定残業+ケアプラン+認定調査+加算))';
COMMENT ON COLUMN public.payroll_kyotaku_salary.guarantee_until IS '保障の最後の月 (1 日)';
COMMENT ON COLUMN public.payroll_kyotaku_salary.commute_cap IS '通勤費の上限 (円)。超えた分は出張費。NULL = 上限なし';

COMMIT;
