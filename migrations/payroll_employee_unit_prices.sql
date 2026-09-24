-- 職員ごとの 通勤単価・出張単価 (2026-09-24 user)
--
-- 既定は 事業所の単価 (payroll_offices.commute_unit_price / travel_unit_price)。
-- 職員に値が入っていれば **そちらを優先**する。
--
-- きっかけ: Ｈａｎａ船橋 金子百恵 の通勤手当は **電車代**で、事業所書式の通勤km 欄に
--   金額 (月 21,390〜25,668) を入れている。総括表もそのまま円で払っている。
--   いまは「月 2,000 以上なら km でなく円」という閾値で当てていたが、
--   本当に月 2,000km 通勤する人が出たら 21,390 円が 2,000 円相当に潰れて気づけない。
--   → 金子の通勤単価を **1 円/km** にすれば、入力値がそのまま円になり 推測が要らなくなる。
--
-- 実データの分布 (2026-09-24): 書式の通勤km は 966 / 1,020.6 の次が 21,390 で、
--   いまは閾値が当たっているだけ。
BEGIN;

ALTER TABLE payroll_employees
  ADD COLUMN IF NOT EXISTS commute_unit_price numeric,
  ADD COLUMN IF NOT EXISTS travel_unit_price  numeric;

COMMENT ON COLUMN payroll_employees.commute_unit_price IS
  '通勤単価 (円/km)。NULL なら事業所の単価を使う。1 にすると 入力値がそのまま円になる (電車代など)';
COMMENT ON COLUMN payroll_employees.travel_unit_price IS
  '出張単価 (円/km)。NULL なら事業所の単価を使う';

COMMIT;
