-- 通信費タイプの適用開始日 (2026-09-21)
--
-- なぜ: payroll_employees.communication_fee_type は「今の値」1 つだけで履歴を持たない。
--   スマホ貸与の負担 (lend_fee = -1,700 円) は人によって始まった月が違う。総括表 2026-03〜07:
--     高品 西田 道子 (230202)  3 月から -1,700
--     高品 菊池 亜希 (4095)   ★ 4 月から (3 月は 0)
--     高品 中村 美果 (4081)   ★ 6 月から (3〜5 月は 0)
--   履歴が無いため 過去月を計算すると 3 月の菊池・3〜5 月の中村からも 1,700 円 引いてしまう
--   (4 人月 / 計 6,800 円 の過少支給)。
-- 使い方: 処理月の末日 < communication_fee_from なら communication_fee_type は "none" として扱う。
--   空なら 従来どおり communication_fee_type のとおり。
BEGIN;
ALTER TABLE payroll_employees ADD COLUMN IF NOT EXISTS communication_fee_from DATE;
COMMENT ON COLUMN payroll_employees.communication_fee_from IS '通信費タイプ (lend / lend_fee) の適用開始日。これより前の月は none 扱い。空なら開始日の制限なし';
COMMIT;
