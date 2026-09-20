-- 旧システムの「従業員契約情報データ」を取り込む器 (2026-09-21)
--
-- なぜ: 給与のルールは 職員ごとに違うのに、当方は事業所単位の設定しか持っていなかった。
--   旧システム (192.168.10.245/test_kyuyo/data_exp.php → 従業員契約情報データダウンロード) に
--   1職員 = 1行 で 63 項目の契約設定が入っている。2026-09-21 に 23 事業所 1,293 名ぶん取得。
--   実測した内訳:
--     出勤時間の算出方法   訪問時間＋移動時間 1,126 / 出勤簿から集計 156
--     育児手当支給限度額   20,000 円 49名 / 30,000 円 20名 / 40,000 円 2名  ← 職員ごとに違う
--     育児手当計算方法     訪問時間で割合を計算 735 / 指定割合 19 (指定割合は 40% が 19名・30% が 1名)
--     通勤費算方法         なし 1,248 / 通勤距離(km)×単価 41              ← 通勤費が出るのは 41 名だけ
--     出張費算方法         出張距離(km)×単価 1,282 (単価は職員ごと)
--     通信手当算方法       稼働時間加算 801 / なし 478 / 固定通信費 10
--     週40時間超残業計算   全員「残業計算する」
--
-- 使い方: 給与計算は この行があれば 事業所の設定より優先する。
--   ⚠ 旧システムの「今の設定」であって履歴ではない。過去月に遡って当てるときは注意する。
-- 置き場: Box\10F内共有\ほのぼのから出力\従業員契約情報データ_<YYYYMMDD>*.csv (Shift-JIS)
BEGIN;

CREATE TABLE IF NOT EXISTS payroll_legacy_contract (
  id                        BIGSERIAL PRIMARY KEY,
  office_number             TEXT NOT NULL,
  employee_number           TEXT NOT NULL,
  employee_name             TEXT,
  job_type                  TEXT,          -- 職種①
  position                  TEXT,          -- 役職①
  scheduled_work_hours      NUMERIC,       -- 所定労働時間
  work_hours_method         TEXT,          -- 出勤時間の算出方法
  overtime_mode             TEXT,          -- 残業計算区分
  weekly40_overtime_mode    TEXT,          -- 週40時間超残業計算区分
  week_start_day            TEXT,          -- 週の起算曜日
  half_leave_threshold_h    NUMERIC,       -- 半休判断時間
  late_early_mode           TEXT,          -- 遅刻早退計算
  travel_method             TEXT,          -- 移動手段
  base_hourly_rate          NUMERIC,       -- 基本時給
  personal_salary           NUMERIC,       -- 本人給
  skill_salary              NUMERIC,       -- 職能給
  position_allowance        NUMERIC,       -- 役職手当
  qualification_allowance   NUMERIC,       -- 資格手当
  other_allowance           NUMERIC,       -- その他手当
  fixed_overtime_pay        NUMERIC,       -- 固定残業手当
  adjustment_allowance      NUMERIC,       -- 調整手当
  treatment_unit_kind       TEXT,          -- 処遇改善加算手当 (単価種別)
  treatment_unit_price      NUMERIC,       -- 処遇改善加算手当 (単価)
  treatment_subsidy         NUMERIC,       -- 処遇改善補助金手当
  commute_method            TEXT,          -- 通勤費算方法
  commute_unit_price        NUMERIC,       -- 通勤費単価
  business_trip_method      TEXT,          -- 出張費算方法
  business_trip_unit_price  NUMERIC,       -- 出張費単価
  communication_method      TEXT,          -- 通信手当算方法
  fixed_communication_fee   NUMERIC,       -- 固定通信費
  childcare_method          TEXT,          -- 育児手当計算方法
  childcare_rate_pct        NUMERIC,       -- 育児手当指定割合 (%)
  childcare_limit           NUMERIC,       -- 育児手当支給限度額
  raw                       JSONB NOT NULL,-- 取り込んだ 1 行ぶん全部 (列が増えても落ちないように)
  source_file               TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (office_number, employee_number)
);

COMMENT ON TABLE payroll_legacy_contract IS '旧システム「従業員契約情報データ」の取込。1行 = 1職員。給与ルールが職員ごとに入っている。★ 履歴ではなく今の設定';

ALTER TABLE payroll_legacy_contract ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS legacy_contract_authenticated ON payroll_legacy_contract;
CREATE POLICY legacy_contract_authenticated ON payroll_legacy_contract
  FOR SELECT TO authenticated USING (true);

COMMIT;
