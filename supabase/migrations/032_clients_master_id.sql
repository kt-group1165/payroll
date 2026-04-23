-- 利用者マスタID（グループ全体で一意の連番、1始まり）
-- clients.id(UUID) は機械的キーのまま残す。master_id は人間が参照しやすい連番IDとして使う。

-- 1. 列追加（一旦 NULL 許可で追加）
ALTER TABLE clients ADD COLUMN IF NOT EXISTS master_id integer;

-- 2. 既存レコードに created_at, id 順で 1..N を採番
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn FROM clients
)
UPDATE clients SET master_id = ordered.rn
FROM ordered WHERE clients.id = ordered.id AND clients.master_id IS NULL;

-- 3. NOT NULL & UNIQUE を付与
ALTER TABLE clients ALTER COLUMN master_id SET NOT NULL;
ALTER TABLE clients ADD CONSTRAINT clients_master_id_unique UNIQUE (master_id);

-- 4. 新規 INSERT 用の SEQUENCE 作成（既存の最大値＋1 から採番）
CREATE SEQUENCE IF NOT EXISTS clients_master_id_seq OWNED BY clients.master_id;
SELECT setval('clients_master_id_seq',
  COALESCE((SELECT MAX(master_id) FROM clients), 0) + 1,
  false);

-- 5. デフォルト値に SEQUENCE を設定
ALTER TABLE clients ALTER COLUMN master_id SET DEFAULT nextval('clients_master_id_seq');

COMMENT ON COLUMN clients.master_id IS 'グループ全体で一意の利用者マスタID（1始まり連番）';
