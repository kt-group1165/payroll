-- 事務時給 (2026-09-17)
-- 事務員 (payroll_employees.is_office_worker = true) の本人給 = 出勤簿の出勤時間 × 事務時給
-- 例: さつきが丘 福島可奈 2026-07 126:30 × 1,150円 = 145,475円 (総括表と一致)
-- 給与設定の履歴 (effective_from) に乗せるので、時給改定も月単位で持てる
--
-- ⚠ 画面 (給与設定の保存) がこの列を送るので、push より先に適用すること
BEGIN;

ALTER TABLE payroll_salary_settings
  ADD COLUMN IF NOT EXISTS office_work_hourly_rate INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN payroll_salary_settings.office_work_hourly_rate IS
  '事務時給 (円/時間)。事務員のみ、出勤簿の出勤時間 × この単価を本人給に足す。0 = 計算しない';

COMMIT;
