-- 出勤簿に「振替」情報を追加
-- substitute_for_date: この出勤がいつの振り替えなのか (NULL = 振替ではない)
--   振替出勤 = 元々休日だった日を出勤に振り替えた日。元の休日となる日付を保持する。
BEGIN;
ALTER TABLE payroll_kyotaku_attendance_records
  ADD COLUMN IF NOT EXISTS substitute_for_date DATE;
COMMENT ON COLUMN payroll_kyotaku_attendance_records.substitute_for_date IS
  '振替元となる日付。NULL = 振替ではない通常の出勤。NOT NULL = この日は振替出勤で、当該日付が新たな休日となる。';
COMMIT;
