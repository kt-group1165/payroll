-- 「まとめて再計算」の対象読み込みが statement timeout で落ちるのを直す索引 (2026-10-01)
--
-- ⚠ Supabase SQL Editor に **このブロックごと貼って Run** すること。
--    BEGIN; だけで COMMIT; を忘れると 実行終了で auto rollback される。
--
-- ── 何が起きたか ──────────────────────────────────────────────────────────
-- 202512 / 202601 の実績 78,946 行を取り込んで payroll_service_records が 40 万行規模になった時点で、
-- /payroll の「対象を読み込む」が
--     ★ 対象の読み込みに失敗: payroll_service_records の取得に失敗: canceling statement due to statement timeout
-- で落ちるようになった。
--
-- 古さの判定 (src/lib/payroll/calc-freshness.ts) は
--     「payroll_calc_results.calculated_at の最小値より新しい入力行」
-- を各表から読む。★ 日時列に索引が無いので 毎回 全件走査 + 並べ替えになり、
-- ★ さらに offset ページング (1000 行ずつ) で そのたびに並べ直すため 行数の 2 乗で効いてくる。
--
-- ── 直し方 ────────────────────────────────────────────────────────────────
-- ① コード側: 並び順を 絞り込みに使う日時列に変えた (batch-recalc.tsx。索引が効くようにする)
-- ② DB 側: その日時列に索引を張る ← このファイル
--
-- ⚠ CONCURRENTLY はトランザクションの中で使えないので、ここでは普通の CREATE INDEX にしている。
--   ★ 一瞬 書き込みがブロックされる。★ 取り込み・給与計算を回していないときに実行すること。

BEGIN;

-- 実績 (いちばん大きい。40 万行規模)
CREATE INDEX IF NOT EXISTS idx_payroll_service_records_created_at
  ON payroll_service_records (created_at);

-- 出勤簿・事業所書式・月ごとの手入力 (今は小さいが 同じ経路で読む)
CREATE INDEX IF NOT EXISTS idx_payroll_attendance_records_created_at
  ON payroll_attendance_records (created_at);
CREATE INDEX IF NOT EXISTS idx_payroll_office_form_records_created_at
  ON payroll_office_form_records (created_at);
CREATE INDEX IF NOT EXISTS idx_payroll_monthly_inputs_updated_at
  ON payroll_monthly_inputs (updated_at);

COMMIT;

-- 確認 (Run したあと 別に実行する)
--   SELECT indexname, tablename FROM pg_indexes
--    WHERE indexname LIKE 'idx_payroll_%_created_at' OR indexname LIKE 'idx_payroll_%_updated_at'
--    ORDER BY tablename;
--
-- 戻すとき
--   DROP INDEX IF EXISTS idx_payroll_service_records_created_at;
--   DROP INDEX IF EXISTS idx_payroll_attendance_records_created_at;
--   DROP INDEX IF EXISTS idx_payroll_office_form_records_created_at;
--   DROP INDEX IF EXISTS idx_payroll_monthly_inputs_updated_at;
