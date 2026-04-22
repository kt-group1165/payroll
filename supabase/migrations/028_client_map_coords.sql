-- 利用者にマップ用座標（ピン止め位置）を追加
-- 通常の住所とは別に、距離計算専用の位置を指定したい場合に使う
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS map_latitude  double precision,
  ADD COLUMN IF NOT EXISTS map_longitude double precision,
  ADD COLUMN IF NOT EXISTS map_note      text;

COMMENT ON COLUMN clients.map_latitude  IS 'マップ用緯度。設定時はこの座標で距離計算する';
COMMENT ON COLUMN clients.map_longitude IS 'マップ用経度';
COMMENT ON COLUMN clients.map_note      IS 'マップ位置のメモ（任意）';
