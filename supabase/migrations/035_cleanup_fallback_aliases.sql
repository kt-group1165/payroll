-- office_billing_aliases: fallback alias (value_name_norm='') を全削除
--
-- 034 の初期移行で offices.shogai_office_number の値から生成された
-- `(kind='shogai_number', value_name_norm='')` 行は、
-- 9999999999 のようなダミー番号で複数事業所が登録されていた場合に
-- 誤紐付けを引き起こすことが判明（実際に花見川→さつきが丘 取り込み時に
-- 花見川の既存データ全削除が発生した）。
--
-- 障害番号は必ず「番号 + 事業者名」の組で alias 管理する方針に変更し、
-- fallback alias (名前空) は作成・参照ともに廃止。
--
-- 既に登録されている fallback alias を全て消す。今後の取り込みで
-- 自動解決されるべきケースは、CSVの事業者名と一緒に alias が作られるので
-- そこから再構築される。

DELETE FROM office_billing_aliases
WHERE kind = 'shogai_number'
  AND (value_name_norm = '' OR value_name_norm IS NULL);

-- 参考: 現在残っている alias の確認用
-- SELECT o.name, o.short_name, o.office_number, a.value_raw, a.value_name_raw, a.kind
-- FROM office_billing_aliases a
-- JOIN offices o ON o.id = a.office_id
-- ORDER BY o.office_number;
