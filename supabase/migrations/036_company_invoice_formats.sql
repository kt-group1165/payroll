-- 法人ごとの請求書フォーマット設定（format_reg.html サンプルを参考に、現アプリの構造に合わせて作成）
--
-- 現アプリは「請求書」と「領収書」を1つのドキュメントにまとめて表示しているため、
-- 二重定義になっていた 領収書系のフィールド (receipt_title, receipt_greeting 等) は
-- 統合・省略している。
--
-- 既存 companies テーブルとの関係:
--   - companies.invoice_greeting → このテーブルの greeting に移行（初期値コピー）
--   - companies.inquiry_tel      → このテーブルの inquiry_tel に移行（初期値コピー）
--   - companies.seal_image_url   → 画像データ自体は companies 側に残す（この表は on/off 制御のみ）

CREATE TABLE IF NOT EXISTS company_invoice_formats (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,

  -- 見出し・文言
  invoice_title             text DEFAULT 'ご利用料金のご案内',   -- 請求書タイトル
  mark_text                 text DEFAULT 'ご請求書・領収書在中',  -- 在中マーク文言
  greeting                  text,                                 -- 挨拶文

  -- 振替情報テーブルの表示制御（金融機関情報の各項目）
  show_bank_account_number  boolean DEFAULT true,   -- 口座番号
  show_bank_account_holder  boolean DEFAULT true,   -- 口座名義人
  show_bank_name            boolean DEFAULT true,   -- 金融機関・支店名
  show_withdrawal_amount    boolean DEFAULT true,   -- お引落予定金額

  -- 金額テーブルのミニ表表示制御
  show_reduction            boolean DEFAULT true,   -- 減免額
  show_mitigation           boolean DEFAULT true,   -- 軽減額
  show_medical_deduction    boolean DEFAULT true,   -- 医療費控除対象額
  show_tax                  boolean DEFAULT true,   -- 消費税

  -- カレンダー
  show_calendar             boolean DEFAULT true,   -- 利用日カレンダー

  -- 角印
  print_seal                boolean DEFAULT false,  -- 押印を印刷する（companies.seal_image_url が必要）

  -- 過誤・相殺・問合せ
  overbilling_text          text,                   -- 過誤(過大請求)の文言テンプレ
  underbilling_text         text,                   -- 過誤(過小請求)の文言テンプレ
  offset_remaining_text     text,                   -- 相殺残額発生時の文言
  inquiry_tel               text,                   -- お問い合わせ先（書式画面側での独自値、companies.inquiry_tel と別管理可能）

  -- 備考（管理用メモ）
  note                      text,

  created_at                timestamptz DEFAULT now(),
  updated_at                timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS company_invoice_formats_company
  ON company_invoice_formats (company_id);

-- updated_at 自動更新
CREATE OR REPLACE FUNCTION touch_company_invoice_formats_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_company_invoice_formats ON company_invoice_formats;
CREATE TRIGGER trg_touch_company_invoice_formats
  BEFORE UPDATE ON company_invoice_formats
  FOR EACH ROW
  EXECUTE FUNCTION touch_company_invoice_formats_updated_at();

-- 既存 companies の値を初期値として転記
INSERT INTO company_invoice_formats (company_id, greeting, inquiry_tel)
SELECT id, invoice_greeting, inquiry_tel FROM companies
ON CONFLICT (company_id) DO NOTHING;

COMMENT ON TABLE company_invoice_formats IS '法人ごとの請求書フォーマット設定';
