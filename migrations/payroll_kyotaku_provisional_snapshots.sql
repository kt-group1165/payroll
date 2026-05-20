-- ============================================================
-- payroll_kyotaku_provisional_snapshots
-- 居宅介護支援ケアマネ 仮計算の確定 snapshot
-- ============================================================
-- 設計:
--   月締め前に admin が「この月はこの仮計算結果で支給する」と確定したとき、
--   その時点の仮計算結果 (出勤簿 monthly + kasan inputs → 円換算) を snapshot
--   する。CSV 取込後の確定計算と diff を取って翌月調整に乗せる根拠データになる。
--
--   1 ケアマネ × 1 月 = 1 row (UNIQUE)。
--   snapshot は append-only ではなく upsert で「最新の確定値」を保持する。
--   (= 取消し操作は row DELETE で対応 / 監査ログが必要なら別 phase で audit table)
--
--   month_start = 仮計算の対象月 (出勤簿 monthly_attendance.month_start と同じ意味)。
--   pay_month は month_start + 1 month (= 集計.py の T+1 規約) なので冗長保存しない。
--
--   provisional_amount は INT (円、整数丸め前提)。仮計算ロジック側は
--   小数値も返すが、snapshot 保存時に Math.round して整数化。
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS payroll_kyotaku_provisional_snapshots (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           TEXT NOT NULL,
  office_id           UUID NOT NULL REFERENCES payroll_offices(id) ON DELETE CASCADE,
  employee_id         UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  month_start         DATE NOT NULL,            -- YYYY-MM-01 (仮計算の対象月)
  provisional_amount  INT  NOT NULL,            -- 仮計算結果 (円、整数)
  snapshot_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  snapshot_by         TEXT,                     -- 操作者 (auth.uid() 等。NULL 許容)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, month_start)
);

CREATE INDEX IF NOT EXISTS idx_kyotaku_provsnap_office_month
  ON payroll_kyotaku_provisional_snapshots (office_id, month_start);
CREATE INDEX IF NOT EXISTS idx_kyotaku_provsnap_emp_month
  ON payroll_kyotaku_provisional_snapshots (employee_id, month_start);

ALTER TABLE payroll_kyotaku_provisional_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kyotaku_provsnap_authenticated
  ON payroll_kyotaku_provisional_snapshots;
CREATE POLICY kyotaku_provsnap_authenticated
  ON payroll_kyotaku_provisional_snapshots
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMENT ON TABLE payroll_kyotaku_provisional_snapshots IS
  '居宅介護支援ケアマネ 仮計算 snapshot (出勤簿 inputs → 円換算、月締め前 admin 確定値)';
COMMENT ON COLUMN payroll_kyotaku_provisional_snapshots.provisional_amount IS
  '仮計算結果 (円、整数)。CSV ベース確定計算と diff を取り、翌月の支給調整に乗せる';

COMMIT;
