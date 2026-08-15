-- Separa la categoría "Alitas y Boneless" en dos categorías independientes:
-- 'Alitas' y 'Boneless' (valores exactos, sin acentos, primera mayúscula).
--
-- products.category es texto libre (no hay CHECK/ENUM en el esquema), así
-- que no hace falta alterar ninguna restricción: basta con reclasificar los
-- datos existentes. Cubre tanto el valor literal legacy "Alitas y Boneless"
-- como las claves antiguas en minúsculas 'alitas'/'boneless' que usó una
-- versión previa de esta app (misma reclasificación que corre también, de
-- forma idempotente, en cada arranque desde db.js -> migrateAlitasBonelessCategories()).

DO $$
DECLARE
  r RECORD;
  moved_to_boneless INT := 0;
  moved_to_alitas INT := 0;
BEGIN
  FOR r IN
    SELECT id, name
    FROM products
    WHERE category IN ('Alitas y Boneless', 'alitas', 'boneless')
  LOOP
    IF lower(r.name) LIKE '%boneless%' THEN
      UPDATE products SET category = 'Boneless' WHERE id = r.id;
      moved_to_boneless := moved_to_boneless + 1;
    ELSE
      UPDATE products SET category = 'Alitas' WHERE id = r.id;
      moved_to_alitas := moved_to_alitas + 1;
      RAISE NOTICE 'Producto id=% "%": nombre ambiguo (no contiene "boneless"), se dejó en Alitas por default.', r.id, r.name;
    END IF;
  END LOOP;

  RAISE NOTICE 'Migración Alitas/Boneless: % producto(s) -> Boneless, % producto(s) -> Alitas.', moved_to_boneless, moved_to_alitas;
END $$;

-- Soporte de promociones por categoría: NULL = aplica a todas las
-- categorías; con valor ('Alitas', 'Boneless', 'Hot-Dogs', ...) la promo
-- solo debe ofrecerse/aplicar a productos de esa categoría.
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS applicable_category TEXT;
COMMENT ON COLUMN promotions.applicable_category IS 'NULL = aplica a todas las categorías. Con valor, la promo solo aplica a esa categoría de producto.';
