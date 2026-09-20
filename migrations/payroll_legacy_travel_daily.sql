-- 旧システムの「移動手当・残業時間計算結果（業務者・日計）」を取り込む器 (2026-09-20)
--
-- なぜ: 移動手当・移動時間は 訪問と訪問の間を Google Distance Matrix で推定していたが、
--   総括表 (= 旧システムの出力) との残差の最大要因が この推定差だった (3〜7月で約1,000件)。
--   旧システムの画面から 1職員×1日 の 移動時間・移動手当・残業 を CSV で出せることが分かったので、
--   推定ではなく その確定値を持たせる。
--   出し方: 旧システム → データ出力 → 「移動手当・残業時間計算結果ダウンロード（業務者）」→ 会社 × 出力年月 × 日計
--   置き場: Box\10F内共有\ほのぼのから出力\<YYYYMM>_<法人名>(残業時間・移動手当日計).csv (Shift-JIS)
--   ⚠ 法人は 5 社あるが ムツミ商事 は薬局のみで対象外 (2026-09-20 user 確認)。
--
-- 移動手当の単価: 旧システムの CSV は 一律 20円/分 で出る。総括表と突合すると
--   月給者 981件は全一致、時給者は 1,003件一致 / 114件が ちょうど半額 (= 10円/分)。
--   半額の職員は 月をまたいで固定 (茂原12名・東郷8名ほか計29名) なので 職員ごとの単価。
--   → payroll_employees.travel_allowance_rate_per_min (NULL = 事業所の travel_allowance_rate に従う) を足す。
BEGIN;

CREATE TABLE IF NOT EXISTS payroll_legacy_travel_daily (
  id                       BIGSERIAL PRIMARY KEY,
  work_date                DATE NOT NULL,
  processing_month         TEXT NOT NULL,          -- YYYYMM (出力年月)
  office_number            TEXT NOT NULL,
  employee_number          TEXT NOT NULL,
  employee_name            TEXT,
  pay_type                 TEXT,                   -- 給与形態 時給 / 月給
  service_min              INTEGER NOT NULL DEFAULT 0,  -- サービス
  travel_paid_min          INTEGER NOT NULL DEFAULT 0,  -- 移動 (= 移動手当の対象時間)
  travel_full_min          INTEGER NOT NULL DEFAULT 0,  -- 移動時間 (全量)
  ot_service_min           INTEGER NOT NULL DEFAULT 0,  -- 残業(サービス)
  ot_travel_min            INTEGER NOT NULL DEFAULT 0,  -- 残業(移動)
  night_service_min        INTEGER NOT NULL DEFAULT 0,  -- 深夜勤務(サービス)
  night_travel_min         INTEGER NOT NULL DEFAULT 0,  -- 深夜勤務(移動)
  night_ot_service_min     INTEGER NOT NULL DEFAULT 0,  -- 深夜残業(サービス)
  night_ot_travel_min      INTEGER NOT NULL DEFAULT 0,  -- 深夜残業(移動)
  hol_ot_service_min       INTEGER NOT NULL DEFAULT 0,  -- 法定休日残業(サービス)
  hol_ot_travel_min        INTEGER NOT NULL DEFAULT 0,  -- 法定休日残業(移動)
  night_hol_ot_service_min INTEGER NOT NULL DEFAULT 0,  -- 深夜法定休日残業(サービス)
  night_hol_ot_travel_min  INTEGER NOT NULL DEFAULT 0,  -- 深夜法定休日残業(移動)
  travel_allowance         INTEGER NOT NULL DEFAULT 0,  -- 移動手当 (円。旧システムは一律 20円/分)
  service_total_min        INTEGER NOT NULL DEFAULT 0,  -- サービス合計
  doukou_min               INTEGER NOT NULL DEFAULT 0,  -- 同行
  travel_pay_total_min     INTEGER NOT NULL DEFAULT 0,  -- 移動手当時間合計
  total_min                INTEGER NOT NULL DEFAULT 0,  -- 総合計
  source_corp              TEXT,                        -- どの法人の CSV から来たか
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (work_date, office_number, employee_number)
);

COMMENT ON TABLE payroll_legacy_travel_daily IS '旧システム「移動手当・残業時間計算結果（業務者）日計」CSV の取込。1行 = 1職員 × 1日。移行期の足場で、新システムが移動を自前で出せるようになったら不要になる';
COMMENT ON COLUMN payroll_legacy_travel_daily.travel_paid_min IS '移動 = 移動手当の対象時間 (区間ごとの一定時間超過分。旧システムが確定させた値)';
COMMENT ON COLUMN payroll_legacy_travel_daily.travel_full_min IS '移動時間 = 移動の全量 (手当の対象外も含む)';

CREATE INDEX IF NOT EXISTS idx_legacy_travel_month_office
  ON payroll_legacy_travel_daily (processing_month, office_number);

ALTER TABLE payroll_legacy_travel_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS legacy_travel_authenticated ON payroll_legacy_travel_daily;
CREATE POLICY legacy_travel_authenticated ON payroll_legacy_travel_daily
  FOR SELECT TO authenticated USING (true);

-- 職員ごとの移動手当単価 (円/分)。NULL = 事業所の travel_allowance_rate (円/時) に従う
ALTER TABLE payroll_employees ADD COLUMN IF NOT EXISTS travel_allowance_rate_per_min NUMERIC;
COMMENT ON COLUMN payroll_employees.travel_allowance_rate_per_min IS '移動手当の単価 (円/分)。既定は事業所の travel_allowance_rate÷60 = 20円/分。総括表で半額 (10円/分) の職員が 29 名いる';

COMMIT;
