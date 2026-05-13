BEGIN;
ALTER TABLE payroll_kyotaku_attendance_records
  ADD COLUMN IF NOT EXISTS business_km NUMERIC(6,1);
COMMENT ON COLUMN payroll_kyotaku_attendance_records.business_km IS '出張距離 (km)、出勤簿で入力、月合計 × payroll_offices.travel_unit_price で出張距離手当算出';
COMMIT;
