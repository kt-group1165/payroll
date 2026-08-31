-- apps/payroll-app/migrations/fix_overtime_base_rule21.sql
-- 2026-08-31 全体監査での是正: 割増賃金の算定基礎に法定必須の手当が入っていない。
--
-- 【根拠】労働基準法37条5項 + 労働基準法施行規則21条
--   割増賃金の算定基礎から**除外できる**のは次の 7 つに限られる (限定列挙)。
--     ① 家族手当 ② 通勤手当 ③ 別居手当 ④ 子女教育手当 ⑤ 住宅手当
--     ⑥ 臨時に支払われた賃金 ⑦ 1 か月を超える期間ごとに支払われる賃金
--   役職手当・資格手当・勤続手当・処遇改善手当 は**除外できない**ので
--   算定基礎に入れる義務がある。
--
-- 【現状 (2026-08-31 実測)】
--   job_type      hrs  本人給 職能給 役職 資格 勤続 処遇改善 特定処遇 処遇補助 固定残業 特別賞与
--   訪問介護      168  YES   YES   YES  YES  −    YES     YES     YES     −       −
--   居宅介護支援  160  YES   YES   −    −    −    −       −       −       −       −
--   本社          160  YES   YES   −    −    −    −       −       −       −       −
--   訪問入浴      160  YES   YES   −    −    −    −       −       −       −       −
--   福祉用具貸与  160  YES   YES   −    −    −    −       −       −       −       −
--   訪問看護      160  YES   YES   −    −    −    −       −       −       −       −
--   薬局          160  YES   YES   −    −    −    −       −       −       −       −
--
--   → 訪問介護でも**勤続手当**が抜けている (実例: 小原奈保子 3,500円分 =
--      時給が約 20.8 円/h 低く算定される)。他 6 職種は役職・資格・処遇改善系も抜け。
--
-- 【この migration がやること】
--   include_position_allowance / include_qualification_allowance /
--   include_tenure_allowance / include_treatment_improvement /
--   include_specific_treatment / include_treatment_subsidy を全職種 true にする。
--
--   include_fixed_overtime_pay は **false のまま**。
--     固定残業代は割増賃金そのものなので算定基礎に入れない (入れると二重)。
--   include_special_bonus も **false のまま**。
--     臨時の賃金 = 施行規則21条⑥で除外できる。
--
-- 【影響】
--   算定基礎が増える = 時給単価が上がる = 残業代が増える (労働者有利側)。
--   過去月の再計算をすると金額が変わる点に注意。
--   ⚠ 家族手当・通勤手当・住宅手当に相当する列が payroll_salary_settings に
--     あるかは未確認。あるなら**それらは算定基礎に入れてはいけない**ので、
--     この migration の対象に加えないこと。
--
-- 【実行前にバックアップを取る】(下の BEGIN の中で自動で取る)

BEGIN;

-- ① 変更前スナップショット
DROP TABLE IF EXISTS _backup_payroll_overtime_settings_20260831;
CREATE TABLE _backup_payroll_overtime_settings_20260831 AS
  SELECT * FROM payroll_overtime_settings;

DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM _backup_payroll_overtime_settings_20260831;
  RAISE NOTICE '✓ バックアップ作成: _backup_payroll_overtime_settings_20260831 (% 行)', v_count;
END $$;

-- ② 施行規則21条で除外できない手当を算定基礎に入れる
UPDATE payroll_overtime_settings
   SET include_position_allowance      = true,
       include_qualification_allowance = true,
       include_tenure_allowance        = true,
       include_treatment_improvement   = true,
       include_specific_treatment      = true,
       include_treatment_subsidy       = true;

-- ③ 結果を出す
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '── 適用後 ──';
  FOR r IN
    SELECT job_type, scheduled_hours_per_month AS hrs,
           include_position_allowance AS pos, include_qualification_allowance AS qual,
           include_tenure_allowance AS tenure, include_treatment_improvement AS ti,
           include_specific_treatment AS sti, include_treatment_subsidy AS ts,
           include_fixed_overtime_pay AS fixed_ot, include_special_bonus AS bonus
      FROM payroll_overtime_settings
     ORDER BY job_type
  LOOP
    RAISE NOTICE '  % (%h): 役職=% 資格=% 勤続=% 処遇改善=% 特定=% 補助=% | 固定残業=% 特別賞与=%',
      r.job_type, r.hrs, r.pos, r.qual, r.tenure, r.ti, r.sti, r.ts, r.fixed_ot, r.bonus;
  END LOOP;
END $$;

DO $$
DECLARE v_bad INT;
BEGIN
  SELECT COUNT(*) INTO v_bad FROM payroll_overtime_settings
   WHERE NOT (include_position_allowance AND include_qualification_allowance
              AND include_tenure_allowance AND include_treatment_improvement
              AND include_specific_treatment AND include_treatment_subsidy);
  IF v_bad > 0 THEN
    RAISE EXCEPTION '検証失敗: % 行が未更新', v_bad;
  END IF;
  SELECT COUNT(*) INTO v_bad FROM payroll_overtime_settings
   WHERE include_fixed_overtime_pay OR include_special_bonus;
  IF v_bad > 0 THEN
    RAISE EXCEPTION '検証失敗: 固定残業代/特別賞与 が算定基礎に入っている行が % 件', v_bad;
  END IF;
  RAISE NOTICE '✓ 全職種で施行規則21条どおりの算定基礎になりました';
END $$;

COMMIT;

-- ロールバック:
--   UPDATE payroll_overtime_settings t
--      SET include_position_allowance      = b.include_position_allowance,
--          include_qualification_allowance = b.include_qualification_allowance,
--          include_tenure_allowance        = b.include_tenure_allowance,
--          include_treatment_improvement   = b.include_treatment_improvement,
--          include_specific_treatment      = b.include_specific_treatment,
--          include_treatment_subsidy       = b.include_treatment_subsidy
--     FROM _backup_payroll_overtime_settings_20260831 b
--    WHERE b.id = t.id;
