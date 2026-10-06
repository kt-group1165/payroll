-- 事業所一覧の並び順 (2026-10-06 user)。payroll_offices.sort_order (小さいほど上)。
-- 既定の順: 法人 (儀八 → 至誠堂 → ケイ・ティ・サービス → サービスワン → ムツミ → その他 → 未設定)
--           → 種別 (居宅介護支援 → 訪問介護 → 訪問入浴 → 訪問看護 → 福祉用具貸与 → 薬局 → その他)
--           → 事業所番号
-- ★ src/lib/office-order.ts の既定の順と同じ。画面の「並び替え」で後から変えられる。
-- Supabase SQL Editor で このまま全部を貼って Run (BEGIN 〜 COMMIT)。

BEGIN;

ALTER TABLE payroll_offices ADD COLUMN IF NOT EXISTS sort_order integer;

WITH ranked AS (
  SELECT
    po.id,
    ROW_NUMBER() OVER (
      ORDER BY
        CASE
          WHEN c.name IS NULL THEN 7
          WHEN c.name LIKE '%儀八%' THEN 1
          WHEN c.name LIKE '%至誠堂%' THEN 2
          WHEN c.name LIKE '%ケイ・ティ%' OR c.name LIKE '%ケイ･ティ%' THEN 3
          WHEN c.name LIKE '%サービスワン%' THEN 4
          WHEN c.name LIKE '%ムツミ%' THEN 5
          ELSE 6
        END,
        CASE po.office_type
          WHEN '居宅介護支援' THEN 1
          WHEN '訪問介護' THEN 2
          WHEN '訪問入浴' THEN 3
          WHEN '訪問看護' THEN 4
          WHEN '福祉用具貸与' THEN 5
          WHEN '薬局' THEN 6
          ELSE 7
        END,
        po.office_number
    ) AS rn
  FROM payroll_offices po
  LEFT JOIN payroll_companies pc ON pc.id = po.company_id
  LEFT JOIN companies c ON c.id = pc.master_company_id
)
UPDATE payroll_offices po
SET sort_order = ranked.rn * 10            -- 10 刻み (間に差し込みやすくする)
FROM ranked
WHERE po.id = ranked.id;

COMMIT;

-- 確認: 並び順で 先頭から
-- SELECT po.sort_order, c.name AS 法人, po.office_type, po.office_number
-- FROM payroll_offices po
-- LEFT JOIN payroll_companies pc ON pc.id = po.company_id
-- LEFT JOIN companies c ON c.id = pc.master_company_id
-- ORDER BY po.sort_order;
