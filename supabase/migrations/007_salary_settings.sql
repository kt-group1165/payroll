-- 職員ごとの給与設定テーブル

CREATE TABLE salary_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

  -- ── 固定支給項目 ─────────────────────────────────────────
  base_personal_salary           INTEGER NOT NULL DEFAULT 0,  -- 本人給
  skill_salary                   INTEGER NOT NULL DEFAULT 0,  -- 職能給
  position_allowance             INTEGER NOT NULL DEFAULT 0,  -- 役職手当
  qualification_allowance        INTEGER NOT NULL DEFAULT 0,  -- 資格手当
  tenure_allowance               INTEGER NOT NULL DEFAULT 0,  -- 勤続手当
  treatment_improvement          INTEGER NOT NULL DEFAULT 0,  -- 処遇改善手当
  specific_treatment_improvement INTEGER NOT NULL DEFAULT 0,  -- 特定処遇改善手当
  treatment_subsidy              INTEGER NOT NULL DEFAULT 0,  -- 処遇改善補助金手当
  fixed_overtime_pay             INTEGER NOT NULL DEFAULT 0,  -- 固定残業代
  special_bonus                  INTEGER NOT NULL DEFAULT 0,  -- 特別報奨金

  -- ── 条件付き支給 ─────────────────────────────────────────
  -- 報奨金：金額を設定しておき、毎月の給与計算時に支給/不支給を選択する
  bonus_amount                   INTEGER NOT NULL DEFAULT 0,  -- 報奨金（月額設定値）

  -- ── 変動項目の単価設定 ────────────────────────────────────
  -- 移動費：移動距離(km) × 単価 = 支給額（距離は月次入力）
  travel_unit_price              INTEGER NOT NULL DEFAULT 0,  -- 移動費単価（円/km）

  -- 出張費は月次で金額入力するため設定値なし

  note TEXT NOT NULL DEFAULT '',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(employee_id)
);

CREATE TRIGGER salary_settings_updated_at BEFORE UPDATE ON salary_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS
ALTER TABLE salary_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated" ON salary_settings FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon (dev)"    ON salary_settings FOR ALL TO anon        USING (true) WITH CHECK (true);
