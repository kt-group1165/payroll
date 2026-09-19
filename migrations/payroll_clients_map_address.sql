-- 給与の利用者マスタに「地図用の住所」を持たせる (2026-09-19)
--
-- なぜ: 移動手当・移動時間は 訪問と訪問の間の区間を Google で測って決まる。
--   旧システムは 利用者ごとに 登録住所とは別の「MAP住所」で区間を測っていた
--   (例: おゆみ野 2113113372 登録住所 東金市宿1658 / MAP住所 千葉市中央区川戸町429-49 スマイル10 = 実際に訪問する場所)。
--   当方は登録住所で測るので、片道 30〜40 分の移動が乗り、移動手当が多く出ていた。
--   座標で登録されている分は map_latitude / map_longitude に入れた (14 件)。文字の MAP住所 を入れる列が無いので足す。
--
-- 使い方: 給与計算は map_latitude/map_longitude → map_address → address の順に使う。
BEGIN;
ALTER TABLE payroll_clients ADD COLUMN IF NOT EXISTS map_address TEXT;
COMMENT ON COLUMN payroll_clients.map_address IS '移動の計算に使う住所 (登録住所と訪問場所が違う利用者だけ)。旧システムの MAP住所';
COMMIT;
