-- 勤続手当の資格要件を満たした日 (2026-09-19)
--
-- なぜ: 勤続手当は 介護福祉士 / 実務者研修修了 が要件。職員マスタは「今 資格があるか」(has_care_qualification) だけで、
--   途中で資格を取った人の 取る前の月 にも勤続手当が出ていた。
--   総括表 2026-03〜07: 原田(木更津) 5月から / 戸谷(ちはら台) 6月から / 池田(袖ケ浦)・石川(おゆみ野)・細野(市原) 5月から /
--   熊谷千里(おゆみ野)・能戸(いすみ) 7月から 勤続手当が付き始める。
-- 使い方: 給与計算は 処理月の末日 < care_qualification_from なら 勤続手当なし。空なら has_care_qualification のとおり。
BEGIN;
ALTER TABLE payroll_employees ADD COLUMN IF NOT EXISTS care_qualification_from DATE;
COMMENT ON COLUMN payroll_employees.care_qualification_from IS '勤続手当の資格要件 (介護福祉士・実務者研修) を満たした日。これより前の月は勤続手当なし。空なら has_care_qualification のとおり';
COMMIT;
