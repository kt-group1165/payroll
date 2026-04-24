-- 請求CSV取り込み時の事業所マッピング別名テーブル
-- 障害事業所番号が別事業所と重複するケース（テスト番号・仮番号・移行期等）で、
-- 「番号＋事業者名」の組で office_id を特定できるようにする。
--
-- resolution strategy（アプリ側の新ロジック）:
--   1. CSV の (number, 事業者名) に対し、(value_norm, value_name_norm) 完全一致で alias を検索
--   2. hit すれば office_id を確定
--   3. hit しなければ未解決扱い → 手動紐付けUI → 確定で alias に新規行を追加
--
-- 既存の offices.shogai_office_number は「その事業所の正式な障害番号」として残す。
-- マイグレーション末尾で、過去の紐付け結果を alias に移行する。

CREATE TABLE IF NOT EXISTS office_billing_aliases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id        uuid NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('shogai_number', 'shogai_name')),
  -- 生の値（UIでの表示・編集用に原文を保持）
  value_raw        text NOT NULL,
  -- 検索用の正規化済み値（小文字・全半角統一・括弧/スペース除去 など）
  value_norm       text NOT NULL,
  -- kind='shogai_number' の時、同時にCSVで現れた事業者名（あれば）を併記
  value_name_raw   text,
  value_name_norm  text,
  note             text,
  created_at       timestamptz DEFAULT now()
);

-- 自動解決の一意性: 同じ (kind, value_norm, value_name_norm) は1行のみ
-- NULL を許容するため、COALESCE で空文字に寄せてユニーク制約を張る
CREATE UNIQUE INDEX IF NOT EXISTS office_billing_aliases_unique_key
  ON office_billing_aliases (kind, value_norm, COALESCE(value_name_norm, ''));

CREATE INDEX IF NOT EXISTS office_billing_aliases_office
  ON office_billing_aliases (office_id);

-- ── 既存データからの移行 ──────────────────────────────────────
-- offices.shogai_office_number に既に値が入っている = ユーザーが過去に紐付け済み
-- それを alias として転記（番号のみの alias, 名前は NULL = "どの名前でも受け入れ" の状態）
--
-- NOTE: 名前部が NULL の alias は「後方互換の fallback」として機能させる。
--       アプリ側のロジックで、完全一致 (number+name) を優先し、
--       ダメなら (number only) を参照する二段構えにする。
INSERT INTO office_billing_aliases (office_id, kind, value_raw, value_norm)
SELECT id, 'shogai_number', shogai_office_number, LOWER(TRIM(shogai_office_number))
FROM offices
WHERE shogai_office_number IS NOT NULL AND TRIM(shogai_office_number) <> ''
ON CONFLICT DO NOTHING;

COMMENT ON TABLE office_billing_aliases IS '請求CSV取り込み時の事業所別名（番号+名前の組で office_id を特定）';
COMMENT ON COLUMN office_billing_aliases.kind IS 'shogai_number: 障害事業所番号 / shogai_name: 事業者名';
COMMENT ON COLUMN office_billing_aliases.value_name_norm IS 'kind=shogai_number 時の対応事業者名（NULL=任意名にマッチ、fallback用）';
