-- 給与の月次ステータスと確定 (2026-09-24 user)
--
-- いままで訪問介護の給与に **確定 (ロック) の概念が無く**、誰でもいつでも再計算で
-- 上書きできた。本稼働では 支給後にマスタを直すと 過去月の金額が黙って変わってしまう。
--
-- 方針 (user 2026-09-24):
--   確定したあとに計算し直して差額が出たら、**翌月・翌々月で 過誤として清算する**。
--   確定した月の金額そのものは 動かさない。
--   (旧システムの総括表も同じ形。「調整手当」「先月の調整手当」「誤差」の列がある)
BEGIN;

-- ① 事業所 × 処理月 の状態
CREATE TABLE IF NOT EXISTS payroll_monthly_status (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_number   text NOT NULL,
  processing_month text NOT NULL,                -- 'YYYYMM'
  status          text NOT NULL DEFAULT '未着手',
  confirmed_at    timestamptz,
  confirmed_by    text,
  reverted_at     timestamptz,
  reverted_by     text,
  -- 確定を解除した理由。解除は必ず理由を残す
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_monthly_status_key UNIQUE (office_number, processing_month),
  CONSTRAINT payroll_monthly_status_status_check
    CHECK (status IN ('未着手', '取込済', '計算済', '確認済', '確定'))
);

-- ② 確定した時点の 1 人ぶんの金額 (ここが「いくら払ったか」の正)
CREATE TABLE IF NOT EXISTS payroll_confirmed_totals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_number   text NOT NULL,
  processing_month text NOT NULL,
  employee_number text NOT NULL,
  employee_name   text,
  -- 'part' (時給) / 'shaseki' (月給)
  pay_kind        text NOT NULL,
  grand_total     numeric NOT NULL,
  -- 確定時の内訳 (あとから「何が変わったか」を見るため)
  breakdown       jsonb,
  confirmed_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_confirmed_totals_key UNIQUE (office_number, processing_month, employee_number)
);

-- ③ 過誤の清算 (確定後に差額が出たぶんを どの月で清算したか)
CREATE TABLE IF NOT EXISTS payroll_discrepancy_settlements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_number      text NOT NULL,
  -- 差額が出た月 (確定済み)
  origin_month       text NOT NULL,
  -- 清算する月 (翌月・翌々月など)
  settlement_month   text NOT NULL,
  employee_number    text NOT NULL,
  employee_name      text,
  confirmed_total    numeric NOT NULL,   -- 確定時の額
  recalculated_total numeric NOT NULL,   -- 計算し直した額
  difference         numeric NOT NULL,   -- recalculated - confirmed (マイナス = 払いすぎ)
  reason             text,
  settled_at         timestamptz,
  settled_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_discrepancy_key UNIQUE (office_number, origin_month, employee_number)
);

CREATE INDEX IF NOT EXISTS payroll_monthly_status_month_idx ON payroll_monthly_status (processing_month);
CREATE INDEX IF NOT EXISTS payroll_confirmed_totals_month_idx ON payroll_confirmed_totals (office_number, processing_month);
CREATE INDEX IF NOT EXISTS payroll_discrepancy_settlement_idx ON payroll_discrepancy_settlements (office_number, settlement_month);

ALTER TABLE payroll_monthly_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_confirmed_totals ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_discrepancy_settlements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payroll_monthly_status_all ON payroll_monthly_status;
CREATE POLICY payroll_monthly_status_all ON payroll_monthly_status
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS payroll_confirmed_totals_all ON payroll_confirmed_totals;
CREATE POLICY payroll_confirmed_totals_all ON payroll_confirmed_totals
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS payroll_discrepancy_all ON payroll_discrepancy_settlements;
CREATE POLICY payroll_discrepancy_all ON payroll_discrepancy_settlements
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
