-- 出勤簿 (画面入力) に 通勤距離 を追加 (2026-09-18)
--
-- 訪問介護の出勤簿を kaigo-app の「出勤簿」画面で入力し、給与計算がそれを読めるようにする。
-- Excel 出勤簿にある「通勤km」が画面側に無かったので足す (出張距離 business_km は既にある)。
-- 居宅介護支援は使わない (画面も訪問介護・訪問入浴のときだけ表示する)。
--
-- ⚠ kaigo-app の出勤簿画面が この列を送るので、kaigo-app を push する前に適用すること
BEGIN;

ALTER TABLE payroll_kyotaku_attendance_records
  ADD COLUMN IF NOT EXISTS commute_km NUMERIC(6,1) NULL;

COMMENT ON COLUMN payroll_kyotaku_attendance_records.commute_km IS
  '通勤距離 (km)。訪問介護・訪問入浴の給与計算の通勤費に使う。NULL = 通勤なし/未入力';

COMMIT;
