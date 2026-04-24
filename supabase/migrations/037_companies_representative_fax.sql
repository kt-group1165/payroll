-- 請求書の右上に表示する法人情報用のカラムを追加
--   representative: 代表取締役 〇〇 等
--   fax: FAX 番号

ALTER TABLE companies ADD COLUMN IF NOT EXISTS representative text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS fax text;

COMMENT ON COLUMN companies.representative IS '代表者（役職＋氏名。例: 代表取締役 手代木 正儀）';
COMMENT ON COLUMN companies.fax IS 'FAX番号';
