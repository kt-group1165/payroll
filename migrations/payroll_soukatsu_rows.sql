-- 総括表 (旧システムで実際に払った額) を検証用に持つ (2026-09-23)
--
-- 移行期だけのテーブル。当システムの計算結果と項目ごとに突き合わせて
-- 「どこがどうずれているか」を /verification の画面に出すために使う。
-- 本稼働後は総括表そのものが無くなるので、このテーブルごと落とす。
--
-- 1 行 = 総括表の 1 行 (処理月 × 事業所 × 職員)。
-- 列は事業所・月でぶれる (「勤続手当」「資格or勤続手当」「・勤続手当・資格手当」など) ので
-- 正規化せず jsonb でそのまま持つ。読むときに別名を吸収する。
BEGIN;

CREATE TABLE IF NOT EXISTS payroll_soukatsu_rows (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  processing_month text NOT NULL,                    -- 'YYYYMM'
  office_number    text NOT NULL,
  employee_number  text NOT NULL,                    -- 先頭の 0 を落とした形で入れる
  employee_name    text NOT NULL,
  sheet_kind       text NOT NULL,                    -- 'part' (パート) / 'shaseki' (提責・社員)
  row_data         jsonb NOT NULL,                   -- 総括表の 1 行をそのまま
  source_file      text,                             -- どの xlsm から取ったか
  imported_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payroll_soukatsu_rows_uniq UNIQUE (processing_month, office_number, employee_number, sheet_kind)
);

CREATE INDEX IF NOT EXISTS payroll_soukatsu_rows_month_office
  ON payroll_soukatsu_rows (processing_month, office_number);

-- 検証用のデータなので 読めるのは認証済みだけ。書き込みは取込 script (service_role) から行う
ALTER TABLE payroll_soukatsu_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payroll_soukatsu_rows_select ON payroll_soukatsu_rows;
CREATE POLICY payroll_soukatsu_rows_select ON payroll_soukatsu_rows
  FOR SELECT TO authenticated USING (true);

COMMIT;
