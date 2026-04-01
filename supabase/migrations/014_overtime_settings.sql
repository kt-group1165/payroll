-- 訪問種別ごとの残業設定テーブル
-- 残業単価 = Σ(include_xxx の手当) ÷ scheduled_hours_per_month × 1.25
CREATE TABLE IF NOT EXISTS overtime_settings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_type TEXT NOT NULL UNIQUE,
  scheduled_hours_per_month NUMERIC NOT NULL DEFAULT 160,
  -- 残業単価の計算に含める手当フラグ
  include_base_personal_salary          BOOLEAN NOT NULL DEFAULT TRUE,
  include_skill_salary                  BOOLEAN NOT NULL DEFAULT TRUE,
  include_position_allowance            BOOLEAN NOT NULL DEFAULT FALSE,
  include_qualification_allowance       BOOLEAN NOT NULL DEFAULT FALSE,
  include_tenure_allowance              BOOLEAN NOT NULL DEFAULT FALSE,
  include_treatment_improvement         BOOLEAN NOT NULL DEFAULT FALSE,
  include_specific_treatment            BOOLEAN NOT NULL DEFAULT FALSE,
  include_treatment_subsidy             BOOLEAN NOT NULL DEFAULT FALSE,
  include_fixed_overtime_pay            BOOLEAN NOT NULL DEFAULT FALSE,
  include_special_bonus                 BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
