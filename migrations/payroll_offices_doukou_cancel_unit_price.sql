-- 同行キャンセル単価 (円/件) を事業所ごとに持つ (2026-10-06 user「同行キャンセル単価も追加して、金額も入れておいて」)。
-- これまで同行ドタキャン (010999) は payroll-calc.ts に 600 円の直書きだった。
-- 総括表 2026-03〜08: 同行キャンセルは 8 事業所・18 人月すべて 600 円 (通常 800 円と併せて 1,400 の人月 5 件も含め例外 0)。
-- 金額: キャンセル単価が入っている事業所 (= 実在の事業所) は 600 円。本社・ダミー (キャンセル単価 0) は 0 円。
-- 単価の履歴表 payroll_office_unit_prices にも同じ列を足す (NULL = 履歴で上書きしない。他の単価列と同じ扱い)。
-- Supabase SQL Editor で このまま全部を貼って Run (BEGIN 〜 COMMIT)。

BEGIN;

ALTER TABLE payroll_offices
  ADD COLUMN IF NOT EXISTS doukou_cancel_unit_price numeric NOT NULL DEFAULT 0;

UPDATE payroll_offices
SET doukou_cancel_unit_price = 600
WHERE cancel_unit_price > 0;

ALTER TABLE payroll_office_unit_prices
  ADD COLUMN IF NOT EXISTS doukou_cancel_unit_price numeric;

COMMENT ON COLUMN payroll_offices.doukou_cancel_unit_price IS
  '同行キャンセル単価 (円/件)。サービスコード 010999 (同行ドタキャン) に掛ける。総括表② 2026-03〜08 は全事業所 600 円';

COMMIT;

-- 確認: 600 が入った件数 / 0 の件数
-- SELECT doukou_cancel_unit_price, cancel_unit_price, count(*) FROM payroll_offices GROUP BY 1, 2 ORDER BY 1, 2;
