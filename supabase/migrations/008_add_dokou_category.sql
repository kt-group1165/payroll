-- 類型「同行」を追加
INSERT INTO service_categories (name, sort_order)
SELECT '同行', COALESCE((SELECT MAX(sort_order) FROM service_categories), 0) + 1
WHERE NOT EXISTS (
  SELECT 1 FROM service_categories WHERE name = '同行'
);
