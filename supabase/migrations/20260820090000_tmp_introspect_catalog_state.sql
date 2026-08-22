-- TEMPORAL -- correr en el SQL Editor y pegar TODO el resultado. Necesito
-- esto para escribir el archivo de sync (20260820000011_catalog_per_branch.sql)
-- con el DDL real que ya corriste, no una reconstrucción mía -- y para
-- saber si categories cambia cómo products.category funciona hoy.

-- 1) Columnas reales de categories y products (¿products tiene category_id
--    ahora, o categories es algo aparte?)
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name IN ('categories', 'products', 'modifiers', 'product_components')
ORDER BY table_name, ordinal_position;

-- 2) FKs de products (para confirmar si hay una a categories)
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.products'::regclass AND contype = 'f';

-- 3) Policies activas en las 4 tablas que tocaste
SELECT tablename, policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('categories', 'products', 'modifiers', 'product_components')
ORDER BY tablename, cmd;

-- 4) Cuerpo real de las 3 funciones que creaste
SELECT p.proname, pg_get_functiondef(p.oid) AS def
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('get_menu_by_branch', 'get_modifiers_by_branch', 'clone_catalog_to_branch')
ORDER BY p.proname;

-- 5) Confirmar que estas NO existen todavía (para saber si de verdad falta
--    construirlas o ya las hiciste y no las mencionaste)
SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace
  AND proname IN (
    'get_products_by_branch', 'create_product', 'update_product', 'remove_product',
    'adjust_product_stock', 'update_modifier', 'migrate_alitas_boneless_categories',
    'get_product_modifier_groups_by_branch', 'set_product_modifier_group',
    'get_components_for_product', 'set_components_for_product', 'get_all_product_components_by_branch',
    'get_recipes_for_product', 'set_recipes_for_product'
  );

-- 6) Confirmar que product_modifier_groups y recipes siguen SIN branch_id
--    y SIN deny_anon_direct (para no asumir de más)
SELECT table_name, column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name IN ('product_modifier_groups', 'recipes') AND column_name = 'branch_id';

SELECT tablename, policyname, cmd FROM pg_policies
WHERE schemaname='public' AND tablename IN ('product_modifier_groups', 'recipes');
